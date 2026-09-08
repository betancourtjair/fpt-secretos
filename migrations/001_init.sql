-- FPT Secretos — esquema inicial
-- Un solo registro por secreto. El texto claro nunca toca la base de datos.

CREATE TABLE IF NOT EXISTS secrets (
  -- HMAC del token con la pimienta del servidor. El token en si no se guarda.
  lookup_id        CHAR(64)     PRIMARY KEY,

  -- Material criptografico
  salt             BYTEA        NOT NULL,
  iv               BYTEA        NOT NULL,
  auth_tag         BYTEA        NOT NULL,
  ciphertext       BYTEA        NOT NULL,

  -- Opciones elegidas por quien crea el secreto
  allow_copy       BOOLEAN      NOT NULL DEFAULT TRUE,
  has_passphrase   BOOLEAN      NOT NULL DEFAULT FALSE,
  notify_email     TEXT,
  label            TEXT,

  -- Ciclo de vida
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ  NOT NULL,
  failed_attempts  SMALLINT     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS secrets_expires_at_idx ON secrets (expires_at);

-- Bitacora sin contenido: solo para saber que paso con cada enlace.
-- No guarda el secreto ni el token, unicamente el identificador de busqueda.
CREATE TABLE IF NOT EXISTS secret_events (
  id           BIGSERIAL     PRIMARY KEY,
  lookup_id    CHAR(64)      NOT NULL,
  event        TEXT          NOT NULL, -- created | viewed | expired | burned_attempts
  occurred_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  ip_hash      CHAR(64)
);

CREATE INDEX IF NOT EXISTS secret_events_lookup_idx ON secret_events (lookup_id);
CREATE INDEX IF NOT EXISTS secret_events_time_idx ON secret_events (occurred_at);
