'use strict';

/**
 * Avisos por correo usando Microsoft Graph (flujo client_credentials).
 * Requiere un App Registration en Entra ID con el permiso de aplicacion
 * Mail.Send y consentimiento de administrador.
 *
 * Si las variables de Graph no estan configuradas, todo el modulo se
 * comporta como un no-op: la aplicacion sigue funcionando sin avisos.
 */

const config = require('./config');

let cachedToken = null; // { value, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.value;
  }

  const url = `https://login.microsoftonline.com/${config.graph.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.graph.clientId,
    client_secret: config.graph.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Graph token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return cachedToken.value;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function template({ title, message, detail }) {
  return `<!DOCTYPE html>
<html lang="es"><body style="margin:0;background:#f4f2f7;padding:28px 12px;font-family:'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e1ee;">
      <tr><td style="background:#7B2482;padding:18px 24px;color:#ffffff;font-size:15px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;">
        FPT Secretos
      </td></tr>
      <tr><td style="padding:26px 24px 8px;">
        <h1 style="margin:0 0 12px;font-size:19px;color:#2c1b33;">${escapeHtml(title)}</h1>
        <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#4a3d53;">${escapeHtml(message)}</p>
        ${detail ? `<p style="margin:0;padding:12px 14px;background:#f7f4fa;border-left:3px solid #7B2482;border-radius:6px;font-size:13px;color:#4a3d53;">${escapeHtml(detail)}</p>` : ''}
      </td></tr>
      <tr><td style="padding:20px 24px 26px;font-size:12px;color:#8b7f95;line-height:1.6;">
        Este es un aviso automatico de FPT Secretos. No contiene el contenido del mensaje,
        que ya fue destruido del servidor.
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

async function sendMail({ to, subject, title, message, detail }) {
  if (!config.graph.enabled) return { skipped: true };

  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
    config.graph.sender
  )}/sendMail`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: template({ title, message, detail }) },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Graph sendMail ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return { sent: true };
}

function fmt(date) {
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(date);
}

/** El destinatario abrio el secreto. */
function notifyViewed({ to, label, viewedAt }) {
  return sendMail({
    to,
    subject: 'Tu secreto fue abierto — FPT Secretos',
    title: 'Tu secreto ya fue abierto',
    message:
      'El enlace de un solo uso que compartiste fue abierto y el contenido se destruyo del servidor. ' +
      'El enlace ya no funciona para nadie mas.',
    detail: `${label ? `Referencia: ${label} · ` : ''}Abierto el ${fmt(viewedAt)} (hora del centro de Mexico)`,
  });
}

/** Vencio sin que nadie lo abriera. */
function notifyExpired({ to, label, expiredAt }) {
  return sendMail({
    to,
    subject: 'Tu secreto expiro sin ser abierto — FPT Secretos',
    title: 'Tu secreto expiro sin ser abierto',
    message:
      'Nadie abrio el enlace antes de la fecha limite, asi que el contenido se destruyo automaticamente. ' +
      'Si la persona todavia necesita la informacion, genera un enlace nuevo.',
    detail: `${label ? `Referencia: ${label} · ` : ''}Expiro el ${fmt(expiredAt)} (hora del centro de Mexico)`,
  });
}

/** Se agotaron los intentos de contrasena y el secreto se destruyo. */
function notifyBurned({ to, label }) {
  return sendMail({
    to,
    subject: 'Tu secreto se destruyo por intentos fallidos — FPT Secretos',
    title: 'Tu secreto se destruyo por seguridad',
    message:
      'Se agotaron los intentos permitidos de contrasena para ese enlace, ' +
      'asi que el contenido se destruyo del servidor como medida de proteccion.',
    detail: label ? `Referencia: ${label}` : null,
  });
}

module.exports = {
  enabled: config.graph.enabled,
  sendMail,
  notifyViewed,
  notifyExpired,
  notifyBurned,
};
