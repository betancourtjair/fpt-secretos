'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');

const config = require('./src/config');
const db = require('./src/db');
const secretsRouter = require('./src/routes/secrets');
const cleanup = require('./src/cleanup');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(compression());

// Los adjuntos viajan en base64 dentro del JSON, que infla ~4/3. Se deja
// holgura sobre el limite real de archivos, que se valida en la ruta.
app.use(
  express.json({
    limit: Math.ceil((config.maxFilesBytes * 4) / 3 / (1024 * 1024)) + 3 + 'mb',
  })
);

// Ninguna respuesta de la API debe quedar en cache.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  next();
});
app.use('/api', secretsRouter);

app.get('/api/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'down', message: err.message });
  }
});

const publicDir = path.join(__dirname, 'public');

// La pagina de revelado nunca debe cachearse ni indexarse.
app.get('/s/:token', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.sendFile(path.join(publicDir, 'secreto.html'));
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /s/\n');
});

// Los nombres de los archivos estaticos no llevan hash, asi que cachearlos
// mucho tiempo hace que tras un despliegue convivan HTML viejo con JS nuevo.
// Con maxAge 0 el navegador revalida y recibe un 304 si nada cambio: cuesta
// un viaje de ida y vuelta y evita paginas rotas.
app.use(express.static(publicDir, { maxAge: 0, etag: true, index: 'index.html' }));

app.use((_req, res) => {
  res.status(404).sendFile(path.join(publicDir, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  res.status(500).json({ error: 'server_error', message: 'Ocurrio un error inesperado.' });
});

async function main() {
  await db.query('SELECT 1');
  cleanup.start();

  const server = app.listen(config.port, () => {
    console.log(`FPT Secretos escuchando en el puerto ${config.port}`);
    console.log(`URL publica: ${config.publicBaseUrl}`);
    console.log(`Avisos por correo: ${config.graph.enabled ? 'activados' : 'desactivados'}`);
  });

  const shutdown = (signal) => {
    console.log(`\n[${signal}] cerrando...`);
    cleanup.stop();
    server.close(() => db.pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('No se pudo iniciar:', err.message);
    process.exit(1);
  });
}

module.exports = app;
