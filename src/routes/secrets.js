'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../db');
const { encryptSecret, decryptSecret, lookupId } = require('../crypto');
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
/* Configuracion publica para el frontend                              */
/* ------------------------------------------------------------------ */
router.get('/config', (_req, res) => {
  res.json({
    maxSecretBytes: config.maxSecretBytes,
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

    if (!trimmed) {
      return res.status(400).json({ error: 'empty', message: 'Escribe el contenido que quieres compartir.' });
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

    const enc = encryptSecret(secret, passphrase || null);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await db.query(
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

    logEvent(null, enc.lookupId, 'created', hashIp(req));

    res.status(201).json({
      url: `${config.publicBaseUrl}/s/${enc.token}`,
      token: enc.token,
      expiresAt: expiresAt.toISOString(),
      allowCopy,
      requiresPassphrase: Boolean(passphrase),
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
      'SELECT has_passphrase, allow_copy, label, expires_at FROM secrets WHERE lookup_id = $1',
      [lookup]
    );
    const row = rows[0];

    if (!row || new Date(row.expires_at) <= new Date()) {
      return res.status(404).json({ error: 'not_found' });
    }

    res.json({
      exists: true,
      requiresPassphrase: row.has_passphrase,
      allowCopy: row.allow_copy,
      label: row.label,
      expiresAt: new Date(row.expires_at).toISOString(),
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

      let plaintext;
      try {
        plaintext = decryptSecret({
          token,
          salt: row.salt,
          iv: row.iv,
          authTag: row.auth_tag,
          ciphertext: row.ciphertext,
          passphrase: row.has_passphrase ? passphrase : null,
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

      // Exito: se destruye en la misma transaccion. Un solo uso, de verdad.
      await client.query('DELETE FROM secrets WHERE lookup_id = $1', [lookup]);
      await logEvent(client, lookup, 'viewed', ipHash);

      return {
        status: 'ok',
        secret: plaintext,
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
