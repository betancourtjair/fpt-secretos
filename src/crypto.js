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
 * 5. Los archivos adjuntos usan la misma llave, cada uno con su propio IV
 *    aleatorio (requisito de AES-GCM: nunca repetir IV con la misma llave).
 *    Su nombre y tipo MIME tambien van cifrados, para que un volcado de la
 *    base no revele que documentos se compartieron.
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

/** Cifra un buffer con una llave ya derivada. Cada llamada usa su propio IV. */
function sealWithKey(key, buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

/** Descifra un buffer con una llave ya derivada. */
function openWithKey(key, { iv, authTag, ciphertext }) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_err) {
    const err = new Error('No se pudo descifrar');
    err.code = 'DECRYPT_FAILED';
    throw err;
  }
}

/**
 * Cifra el contenido y devuelve todo lo que hay que persistir.
 *
 * Si vienen archivos, se cifran con la MISMA llave (cada uno con su propio IV,
 * como exige AES-GCM) y se devuelven listos para insertarse.
 *
 * @param {string} plaintext
 * @param {string|null} passphrase
 * @param {Array<{name:string,type:string,data:Buffer}>} files
 */
function encryptSecret(plaintext, passphrase, files = []) {
  const token = generateToken();
  const salt = crypto.randomBytes(16);
  const key = deriveKey(token, salt, passphrase);

  try {
    const cuerpo = sealWithKey(key, Buffer.from(plaintext, 'utf8'));

    const archivos = files.map((f, i) => {
      const meta = Buffer.from(JSON.stringify({ name: f.name, type: f.type }), 'utf8');
      const metaSellada = sealWithKey(key, meta);
      const datosSellados = sealWithKey(key, f.data);
      return {
        position: i,
        sizeBytes: f.data.length,
        metaIv: metaSellada.iv,
        metaAuthTag: metaSellada.authTag,
        metaCiphertext: metaSellada.ciphertext,
        dataIv: datosSellados.iv,
        dataAuthTag: datosSellados.authTag,
        dataCiphertext: datosSellados.ciphertext,
      };
    });

    return {
      token,
      lookupId: lookupId(token),
      salt,
      iv: cuerpo.iv,
      authTag: cuerpo.authTag,
      ciphertext: cuerpo.ciphertext,
      files: archivos,
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Descifra el secreto y sus archivos de una sola vez, con una unica
 * derivacion de llave (scrypt es caro; no conviene repetirlo por archivo).
 *
 * Lanza un error con code = 'DECRYPT_FAILED' si la contrasena es incorrecta
 * o algun registro fue alterado.
 *
 * @returns {{ text: string, files: Array<{name:string,type:string,data:Buffer}> }}
 */
function decryptBundle({ token, salt, passphrase, body, files = [] }) {
  const key = deriveKey(token, salt, passphrase);
  try {
    const text = openWithKey(key, body).toString('utf8');

    const abiertos = files.map((f) => {
      const meta = JSON.parse(
        openWithKey(key, { iv: f.meta_iv, authTag: f.meta_auth_tag, ciphertext: f.meta_ciphertext })
          .toString('utf8')
      );
      const data = openWithKey(key, {
        iv: f.data_iv,
        authTag: f.data_auth_tag,
        ciphertext: f.data_ciphertext,
      });
      return { name: meta.name, type: meta.type, data };
    });

    return { text, files: abiertos };
  } finally {
    key.fill(0);
  }
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
  decryptBundle,
};
