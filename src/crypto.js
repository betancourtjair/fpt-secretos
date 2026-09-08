'use strict';

/**
 * Modelo criptografico de FPT Secretos
 * ------------------------------------
 * 1. Al crear un secreto se genera un token aleatorio de 32 bytes. Ese token
 *    viaja UNICAMENTE en el enlace que recibe el destinatario; nunca se guarda.
 * 2. En la base de datos se guarda un identificador derivado del token
 *    (HMAC con la pimienta del servidor), no el token en si. Con la base de
 *    datos sola no se puede reconstruir el enlace.
 * 3. La llave AES se deriva del token + la pimienta del servidor + (opcional)
 *    la contrasena adicional. Es decir: quien tenga un volcado de la base de
 *    datos NO puede descifrar el contenido, porque le falta el token.
 * 4. El contenido se cifra con AES-256-GCM, que ademas autentica: si alguien
 *    altera el registro o la contrasena es incorrecta, el descifrado falla.
 */

const crypto = require('crypto');
const config = require('./config');

const KEY_INFO = Buffer.from('fpt-secretos:v1:content-key');
const LOOKUP_INFO = 'fpt-secretos:v1:lookup';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Token aleatorio en base64url, apto para viajar en una URL. */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenToBuffer(token) {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length !== 32) {
    const err = new Error('Token con formato invalido');
    err.code = 'BAD_TOKEN';
    throw err;
  }
  return buf;
}

/** Identificador de busqueda: determinista, dependiente de la pimienta. */
function lookupId(token) {
  return crypto
    .createHmac('sha256', config.pepper)
    .update(LOOKUP_INFO)
    .update(tokenToBuffer(token))
    .digest('hex');
}

function passphraseKey(passphrase, salt) {
  if (!passphrase) return Buffer.alloc(0);
  return crypto.scryptSync(
    Buffer.from(String(passphrase).normalize('NFKC'), 'utf8'),
    Buffer.concat([salt, config.pepper]),
    32,
    SCRYPT_PARAMS
  );
}

function deriveKey(token, salt, passphrase) {
  const ikm = Buffer.concat([
    tokenToBuffer(token),
    config.pepper,
    passphraseKey(passphrase, salt),
  ]);
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, KEY_INFO, 32));
}

/**
 * Cifra el contenido y devuelve todo lo que hay que persistir.
 * @param {string} plaintext
 * @param {string|null} passphrase
 */
function encryptSecret(plaintext, passphrase) {
  const token = generateToken();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(token, salt, passphrase);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  key.fill(0);

  return {
    token,
    lookupId: lookupId(token),
    salt,
    iv,
    authTag,
    ciphertext,
  };
}

/**
 * Descifra. Lanza un error con code = 'DECRYPT_FAILED' si la contrasena es
 * incorrecta o el registro fue alterado.
 */
function decryptSecret({ token, salt, iv, authTag, ciphertext, passphrase }) {
  const key = deriveKey(token, salt, passphrase);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (_err) {
    const err = new Error('No se pudo descifrar el secreto');
    err.code = 'DECRYPT_FAILED';
    throw err;
  } finally {
    key.fill(0);
  }
}

module.exports = {
  generateToken,
  lookupId,
  encryptSecret,
  decryptSecret,
};
