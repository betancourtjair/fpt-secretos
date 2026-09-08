'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../db');
const { encryptSecret, decryptBundle, lookupId } = require('../crypto');
const mailer = require('../mailer');

const router = express.Router();

const MAX_PASSPHRASE_ATTEMPTS = 5;
const TTL_OPTIONS_MINUTES = [5, 15, 60, 240, 1440, 4320, 10080];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limit', message: 'Demasiados secretos creados. Intenta de nuevo en unos minutos.' },
});

const revealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limit', message: 'Demasiados intentos. Espera unos minutos.' },
});

function hashIp(req) {
  const ip = req.ip || '';
  return crypto.createHmac('sha256', config.pepper).update('ip').update(ip).digest('hex');
}

function logEvent(client, lookup, event, ipHash) {
  const runner = client || db;
  return runner
    .query('INSERT INTO secret_events (lookup_id, event, ip_hash) VALUES ($1, $2, $3)', [
      lookup,
      event,
      ipHash || null,
    ])
    .catch((err) => console.error('[eventos] no se pudo registrar:', err.message));
}

function fireAndForget(promise, context) {
  Promise.resolve(promise).catch((err) => console.error(`[correo] ${context}:`, err.message));
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* Archivos adjuntos                                                   */
/* ------------------------------------------------------------------ */

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Deja un nombre de archivo seguro para guardar en disco. */
function limpiarNombre(nombre) {
  const base = String(nombre)
    .replace(/[\\/]/g, '_') // sin separadores de ruta
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '') // sin caracteres de control
    .replace(/^\.+/, '') // sin nombres ocultos ni ".."
    .trim();
  return (base || 'archivo').slice(0, 200);
}

function limpiarTipo(tipo) {
  const t = String(tipo || '').trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(t) && t.length <= 128
    ? t
    : 'application/octet-stream';
}

/**
 * Valida y decodifica los adjuntos que llegan en el cuerpo de la peticion.
 * Devuelve { files } o { error, message } listo para responder.
 */
function prepararArchivos(entrada) {
  if (entrada === undefined || entrada === null) return { files: [] };
  if (!Array.isArray(entrada)) {
    return { error: 'bad_files', message: 'El formato de los archivos no es valido.' };
  }
  if (entrada.length > config.maxFiles) {
    return {
      error: 'too_many_files',
      message: `Puedes adjuntar como maximo ${config.maxFiles} archivo(s).`,
    };
  }

  const files = [];
  let total = 0;

  for (const item of entrada) {
    if (!item || typeof item !== 'object') {
      return { error: 'bad_files', message: 'El formato de los archivos no es valido.' };
    }
    const b64 = typeof item.dataBase64 === 'string' ? item.dataBase64.trim() : null;
    if (b64 === null || !BASE64_RE.test(b64)) {
      return { error: 'bad_files', message: 'Uno de los archivos llego dañado. Vuelve a adjuntarlo.' };
    }

    const data = Buffer.from(b64, 'base64');
    total += data.length;
    if (total > config.maxFilesBytes) {
      return {
        error: 'files_too_large',
        message: `Los archivos suman mas de ${Math.round(config.maxFilesBytes / 1024 / 1024)} MB.`,
      };
    }

    files.push({ name: limpiarNombre(item.name), type: limpiarTipo(item.type), data });
  }

  return { files };
}

/* ------------------------------------------------------------------ */
/* Configuracion publica para el frontend                              */
/* ------------------------------------------------------------------ */
router.get('/config', (_req, res) => {
  res.json({
    maxSecretBytes: config.maxSecretBytes,
    maxFiles: config.maxFiles,
    maxFilesBytes: config.maxFilesBytes,
    maxTtlHours: config.maxTtlHours,
    ttlOptions: TTL_OPTIONS_MINUTES.filter((m) => m <= config.maxTtlHours * 60),
    emailNotificationsAvailable: mailer.enabled,
  });
});

/* ------------------------------------------------------------------ */
/* Crear un secreto                                                    */
/* ------------------------------------------------------------------ */
router.post(
  '/secrets',
  createLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const secret = typeof body.secret === 'string' ? body.secret : '';
    const trimmed = secret.trim();

    const prep = prepararArchivos(body.files);
    if (prep.error) {
      return res.status(prep.error === 'files_too_large' ? 413 : 400).json(prep);
    }
    const archivos = prep.files;

    // Basta con una de las dos cosas: texto o archivos.
    if (!trimmed && archivos.length === 0) {
      return res.status(400).json({
        error: 'empty',
        message: 'Escribe el contenido o adjunta al menos un archivo.',
      });
    }
    if (Buffer.byteLength(secret, 'utf8') > config.maxSecretBytes) {
      return res.status(413).json({
        error: 'too_large',
        message: `El contenido excede el limite de ${Math.round(config.maxSecretBytes / 1000)} KB.`,
      });
    }

    const ttlMinutes = Number.parseInt(body.ttlMinutes, 10);
    if (!TTL_OPTIONS_MINUTES.includes(ttlMinutes) || ttlMinutes > config.maxTtlHours * 60) {
      return res.status(400).json({ error: 'bad_ttl', message: 'La duracion seleccionada no es valida.' });
    }

    const allowCopy = body.allowCopy !== false;
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : null;

    let passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
    passphrase = passphrase.trim() ? passphrase : '';
    if (passphrase && passphrase.length < 4) {
      return res.status(400).json({ error: 'weak_passphrase', message: 'La contrasena debe tener al menos 4 caracteres.' });
    }
    if (passphrase.length > 256) {
      return res.status(400).json({ error: 'weak_passphrase', message: 'La contrasena es demasiado larga.' });
    }

    let notifyEmail = typeof body.notifyEmail === 'string' ? body.notifyEmail.trim().toLowerCase() : '';
    if (notifyEmail && !EMAIL_RE.test(notifyEmail)) {
      return res.status(400).json({ error: 'bad_email', message: 'El correo para el aviso no es valido.' });
    }
    if (notifyEmail && !mailer.enabled) notifyEmail = '';

    const enc = encryptSecret(secret, passphrase || null, archivos);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    // El secreto y sus archivos entran juntos o no entra nada.
    await db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO secrets
           (lookup_id, salt, iv, auth_tag, ciphertext, allow_copy, has_passphrase, notify_email, label, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          enc.lookupId,
          enc.salt,
          enc.iv,
          enc.authTag,
          enc.ciphertext,
          allowCopy,
          Boolean(passphrase),
          notifyEmail || null,
          label,
          expiresAt,
        ]
      );

      for (const f of enc.files) {
        await client.query(
          `INSERT INTO secret_files
             (lookup_id, position, meta_iv, meta_auth_tag, meta_ciphertext,
              data_iv, data_auth_tag, data_ciphertext, size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            enc.lookupId,
            f.position,
            f.metaIv,
            f.metaAuthTag,
            f.metaCiphertext,
            f.dataIv,
            f.dataAuthTag,
            f.dataCiphertext,
            f.sizeBytes,
          ]
        );
      }
    });

    logEvent(null, enc.lookupId, 'created', hashIp(req));

    res.status(201).json({
      url: `${config.publicBaseUrl}/s/${enc.token}`,
      token: enc.token,
      expiresAt: expiresAt.toISOString(),
      allowCopy,
      requiresPassphrase: Boolean(passphrase),
      fileCount: archivos.length,
      filesBytes: archivos.reduce((n, f) => n + f.data.length, 0),
    });
  })
);

/* ------------------------------------------------------------------ */
/* Consultar el estado de un enlace SIN quemarlo                       */
/* ------------------------------------------------------------------ */
router.get(
  '/secrets/:token',
  revealLimiter,
  asyncHandler(async (req, res) => {
    let lookup;
    try {
      lookup = lookupId(req.params.token);
    } catch (_err) {
      return res.status(404).json({ error: 'not_found' });
    }

    const { rows } = await db.query(
      `SELECT s.has_passphrase, s.allow_copy, s.label, s.expires_at,
              COUNT(f.id)::int                       AS file_count,
              COALESCE(SUM(f.size_bytes), 0)::bigint AS files_bytes
         FROM secrets s
         LEFT JOIN secret_files f ON f.lookup_id = s.lookup_id
        WHERE s.lookup_id = $1
        GROUP BY s.lookup_id`,
      [lookup]
    );
    const row = rows[0];

    if (!row || new Date(row.expires_at) <= new Date()) {
      return res.status(404).json({ error: 'not_found' });
    }

    // A proposito no se devuelven los nombres de los archivos: solo cuantos
    // y cuanto pesan. Los nombres viajan cifrados y solo se descifran al
    // revelar, en el mismo paso que destruye el secreto.
    res.json({
      exists: true,
      requiresPassphrase: row.has_passphrase,
      allowCopy: row.allow_copy,
      label: row.label,
      expiresAt: new Date(row.expires_at).toISOString(),
      fileCount: row.file_count,
      filesBytes: Number(row.files_bytes),
    });
  })
);

/* ------------------------------------------------------------------ */
/* Revelar y destruir                                                  */
/* ------------------------------------------------------------------ */
router.post(
  '/secrets/:token/reveal',
  revealLimiter,
  asyncHandler(async (req, res) => {
    const token = req.params.token;
    const passphrase =
      typeof (req.body || {}).passphrase === 'string' ? req.body.passphrase : '';

    let lookup;
    try {
      lookup = lookupId(token);
    } catch (_err) {
      return res.status(404).json({ error: 'not_found', message: 'Este enlace no existe o ya fue utilizado.' });
    }

    const ipHash = hashIp(req);

    const outcome = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM secrets WHERE lookup_id = $1 FOR UPDATE',
        [lookup]
      );
      const row = rows[0];
      if (!row) return { status: 'not_found' };

      if (new Date(row.expires_at) <= new Date()) {
        await client.query('DELETE FROM secrets WHERE lookup_id = $1', [lookup]);
        await logEvent(client, lookup, 'expired', ipHash);
        return { status: 'not_found', row };
      }

      if (row.has_passphrase && !passphrase) {
        return { status: 'passphrase_required' };
      }

      const { rows: archivos } = await client.query(
        'SELECT * FROM secret_files WHERE lookup_id = $1 ORDER BY position, id',
        [lookup]
      );

      let paquete;
      try {
        paquete = decryptBundle({
          token,
          salt: row.salt,
          passphrase: row.has_passphrase ? passphrase : null,
          body: { iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
          files: archivos,
        });
      } catch (err) {
        if (err.code !== 'DECRYPT_FAILED') throw err;

        const attempts = row.failed_attempts + 1;
        if (attempts >= MAX_PASSPHRASE_ATTEMPTS) {
          await client.query('DELETE FROM secrets WHERE lookup_id = $1', [lookup]);
          await logEvent(client, lookup, 'burned_attempts', ipHash);
          return { status: 'burned', row };
        }
        await client.query('UPDATE secrets SET failed_attempts = $2 WHERE lookup_id = $1', [
          lookup,
          attempts,
        ]);
        return { status: 'bad_passphrase', attemptsLeft: MAX_PASSPHRASE_ATTEMPTS - attempts };
      }

      // Exito: se destruye en la misma transaccion, y con el secreto se van
      // sus archivos por la clave foranea en cascada. Un solo uso, de verdad:
      // lo que el navegador descargue despues ya no existe en el servidor.
      await client.query('DELETE FROM secrets WHERE lookup_id = $1', [lookup]);
      await logEvent(client, lookup, 'viewed', ipHash);

      return {
        status: 'ok',
        secret: paquete.text,
        files: paquete.files,
        allowCopy: row.allow_copy,
        label: row.label,
        row,
      };
    });

    switch (outcome.status) {
      case 'ok':
        if (outcome.row.notify_email) {
          fireAndForget(
            mailer.notifyViewed({
              to: outcome.row.notify_email,
              label: outcome.row.label,
              viewedAt: new Date(),
            }),
            'aviso de apertura'
          );
        }
        return res.json({
          secret: outcome.secret,
          allowCopy: outcome.allowCopy,
          label: outcome.label,
          files: outcome.files.map((f) => ({
            name: f.name,
            type: f.type,
            size: f.data.length,
            dataBase64: f.data.toString('base64'),
          })),
        });

      case 'passphrase_required':
        return res.status(401).json({
          error: 'passphrase_required',
          message: 'Este secreto esta protegido con una contrasena adicional.',
        });

      case 'bad_passphrase':
        return res.status(401).json({
          error: 'bad_passphrase',
          attemptsLeft: outcome.attemptsLeft,
          message: `Contrasena incorrecta. Te ${
            outcome.attemptsLeft === 1 ? 'queda 1 intento' : `quedan ${outcome.attemptsLeft} intentos`
          } antes de que el secreto se destruya.`,
        });

      case 'burned':
        if (outcome.row.notify_email) {
          fireAndForget(
            mailer.notifyBurned({ to: outcome.row.notify_email, label: outcome.row.label }),
            'aviso de destruccion'
          );
        }
        return res.status(410).json({
          error: 'burned',
          message: 'Se agotaron los intentos de contrasena y el secreto fue destruido.',
        });

      default:
        return res.status(404).json({
          error: 'not_found',
          message: 'Este enlace no existe, ya fue utilizado o expiro.',
        });
    }
  })
);

module.exports = router;
module.exports.TTL_OPTIONS_MINUTES = TTL_OPTIONS_MINUTES;
module.exports.MAX_PASSPHRASE_ATTEMPTS = MAX_PASSPHRASE_ATTEMPTS;
