'use strict';

/**
 * Barrido periodico: elimina los secretos vencidos y, si quien los creo
 * pidio aviso, le manda un correo de "expiro sin ser abierto".
 * Tambien poda la bitacora de eventos despues de 90 dias.
 */

const config = require('./config');
const db = require('./db');
const mailer = require('./mailer');

let timer = null;

async function sweep() {
  const { rows } = await db.query(
    `DELETE FROM secrets
      WHERE expires_at <= NOW()
      RETURNING lookup_id, notify_email, label, expires_at`
  );

  if (rows.length) {
    console.log(`[limpieza] ${rows.length} secreto(s) vencido(s) eliminado(s)`);
  }

  for (const row of rows) {
    db.query('INSERT INTO secret_events (lookup_id, event) VALUES ($1, $2)', [
      row.lookup_id,
      'expired',
    ]).catch((err) => console.error('[limpieza] evento:', err.message));

    if (row.notify_email && mailer.enabled) {
      mailer
        .notifyExpired({
          to: row.notify_email,
          label: row.label,
          expiredAt: new Date(row.expires_at),
        })
        .catch((err) => console.error('[limpieza] aviso de expiracion:', err.message));
    }
  }

  await db
    .query("DELETE FROM secret_events WHERE occurred_at < NOW() - INTERVAL '90 days'")
    .catch((err) => console.error('[limpieza] poda de bitacora:', err.message));

  return rows.length;
}

function start() {
  const ms = config.cleanupIntervalMinutes * 60 * 1000;
  const tick = () => sweep().catch((err) => console.error('[limpieza]', err.message));
  tick();
  timer = setInterval(tick, ms);
  if (timer.unref) timer.unref();
  console.log(`[limpieza] activa cada ${config.cleanupIntervalMinutes} minuto(s)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, sweep };
