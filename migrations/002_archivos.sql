-- FPT Secretos — archivos adjuntos
--
-- Un secreto puede llevar archivos. Se guardan cifrados con la MISMA llave
-- derivada del token del enlace, cada uno con su propio IV, en dos partes:
--   * metadatos (nombre y tipo MIME) — tambien cifrados, para que la base de
--     datos no revele que documentos se compartieron.
--   * contenido binario.
--
-- El borrado es en cascada: al destruirse el secreto desaparecen sus archivos
-- en la misma transaccion. No hay forma de que queden huerfanos.

CREATE TABLE IF NOT EXISTS secret_files (
  id                BIGSERIAL   PRIMARY KEY,
  lookup_id         CHAR(64)    NOT NULL
                                REFERENCES secrets (lookup_id) ON DELETE CASCADE,
  position          SMALLINT    NOT NULL DEFAULT 0,

  -- Nombre y tipo MIME, cifrados como un JSON compacto
  meta_iv           BYTEA       NOT NULL,
  meta_auth_tag     BYTEA       NOT NULL,
  meta_ciphertext   BYTEA       NOT NULL,

  -- Contenido del archivo
  data_iv           BYTEA       NOT NULL,
  data_auth_tag     BYTEA       NOT NULL,
  data_ciphertext   BYTEA       NOT NULL,

  -- Tamano en claro, para mostrarlo y para aplicar limites
  size_bytes        INTEGER     NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS secret_files_lookup_idx ON secret_files (lookup_id);
