'use strict';

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Falta la variable de entorno ${name}. Revisa el archivo .env (ver .env.example).`
    );
  }
  return value.trim();
}

function optional(name, fallback = '') {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function int(name, fallback) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const graph = {
  tenantId: optional('GRAPH_TENANT_ID'),
  clientId: optional('GRAPH_CLIENT_ID'),
  clientSecret: optional('GRAPH_CLIENT_SECRET'),
  sender: optional('GRAPH_SENDER'),
};
graph.enabled = Boolean(graph.tenantId && graph.clientId && graph.clientSecret && graph.sender);

const config = {
  port: int('PORT', 3000),
  env: optional('NODE_ENV', 'development'),
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  databaseUrl: required('DATABASE_URL'),
  pepper: Buffer.from(required('SECRET_PEPPER'), 'base64'),
  maxSecretBytes: int('MAX_SECRET_BYTES', 100000),
  maxFiles: int('MAX_FILES', 5),
  maxFilesBytes: int('MAX_FILES_BYTES', 10 * 1024 * 1024),
  maxTtlHours: int('MAX_TTL_HOURS', 168),
  cleanupIntervalMinutes: int('CLEANUP_INTERVAL_MINUTES', 5),
  graph,
};

if (config.pepper.length < 32) {
  throw new Error(
    'SECRET_PEPPER debe tener al menos 32 bytes en base64. Genera uno con: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
  );
}

module.exports = config;
