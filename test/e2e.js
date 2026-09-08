'use strict';

/**
 * Pruebas end-to-end de FPT Secretos.
 * Requiere DATABASE_URL apuntando a una base de datos DESECHABLE.
 *   npm run migrate && npm run test:e2e
 */

const app = require('../server');
const db = require('../src/db');
const cleanup = require('../src/cleanup');
const { lookupId } = require('../src/crypto');

let base = '';
let pasadas = 0;
let fallidas = 0;

function ok(nombre, condicion, detalle) {
  if (condicion) {
    pasadas++;
    console.log(`  \x1b[32m✓\x1b[0m ${nombre}`);
  } else {
    fallidas++;
    console.log(`  \x1b[31m✗\x1b[0m ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

function grupo(nombre) {
  console.log(`\n\x1b[35m▸ ${nombre}\x1b[0m`);
}

async function api(metodo, ruta, cuerpo) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let datos = null;
  try {
    datos = await res.json();
  } catch (_e) {
    datos = null;
  }
  return { status: res.status, datos };
}

function crear(extra = {}) {
  return api('POST', '/api/secrets', {
    secret: 'usuario: admin\npassword: Sup3r-S3cr3t0-FPT!',
    ttlMinutes: 60,
    allowCopy: true,
    ...extra,
  });
}

function tokenDe(url) {
  return url.split('/s/')[1];
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await db.query('TRUNCATE secrets, secret_events');

  /* ---------------------------------------------------------------- */
  grupo('Flujo basico: crear, consultar, revelar, quemar');
  {
    const { status, datos } = await crear({ label: 'Prueba basica' });
    ok('crea el secreto (201)', status === 201, `status ${status}`);
    ok('devuelve una URL con token', /\/s\/[A-Za-z0-9_-]{43}$/.test(datos.url || ''), datos.url);

    const token = tokenDe(datos.url);

    const meta1 = await api('GET', `/api/secrets/${token}`);
    ok('la consulta de metadatos responde 200', meta1.status === 200);
    ok('los metadatos no incluyen el contenido', !('secret' in (meta1.datos || {})));
    ok('reporta que se puede copiar', meta1.datos.allowCopy === true);
    ok('reporta que no pide contrasena', meta1.datos.requiresPassphrase === false);
    ok('conserva la referencia', meta1.datos.label === 'Prueba basica');

    const meta2 = await api('GET', `/api/secrets/${token}`);
    ok('consultar dos veces NO quema el secreto', meta2.status === 200);

    const rev1 = await api('POST', `/api/secrets/${token}/reveal`);
    ok('revela el contenido exacto', rev1.datos.secret === 'usuario: admin\npassword: Sup3r-S3cr3t0-FPT!');
    ok('devuelve la opcion de copia', rev1.datos.allowCopy === true);

    const rev2 = await api('POST', `/api/secrets/${token}/reveal`);
    ok('el segundo intento devuelve 404 (un solo uso)', rev2.status === 404, `status ${rev2.status}`);

    const meta3 = await api('GET', `/api/secrets/${token}`);
    ok('los metadatos tambien desaparecen', meta3.status === 404);

    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM secrets WHERE lookup_id = $1', [
      lookupId(token),
    ]);
    ok('el registro se borro de la base de datos', rows[0].n === 0);

    const ev = await db.query(
      "SELECT event FROM secret_events WHERE lookup_id = $1 ORDER BY id",
      [lookupId(token)]
    );
    ok(
      'la bitacora registro created + viewed',
      ev.rows.map((r) => r.event).join(',') === 'created,viewed',
      ev.rows.map((r) => r.event).join(',')
    );
  }

  /* ---------------------------------------------------------------- */
  grupo('Opcion: bloquear la copia del texto');
  {
    const { datos } = await crear({ allowCopy: false });
    const token = tokenDe(datos.url);
    ok('la respuesta de creacion refleja allowCopy=false', datos.allowCopy === false);

    const meta = await api('GET', `/api/secrets/${token}`);
    ok('los metadatos avisan que no se puede copiar', meta.datos.allowCopy === false);

    const rev = await api('POST', `/api/secrets/${token}/reveal`);
    ok('el revelado tambien marca allowCopy=false', rev.datos.allowCopy === false);
  }

  /* ---------------------------------------------------------------- */
  grupo('Opcion: contrasena adicional');
  {
    const { datos } = await crear({ passphrase: 'clave-fpt-2026' });
    const token = tokenDe(datos.url);
    ok('la creacion marca requiresPassphrase', datos.requiresPassphrase === true);

    const meta = await api('GET', `/api/secrets/${token}`);
    ok('los metadatos avisan que pide contrasena', meta.datos.requiresPassphrase === true);

    const sinClave = await api('POST', `/api/secrets/${token}/reveal`, {});
    ok('sin contrasena responde 401', sinClave.status === 401, `status ${sinClave.status}`);
    ok('el motivo es passphrase_required', sinClave.datos.error === 'passphrase_required');

    const mala = await api('POST', `/api/secrets/${token}/reveal`, { passphrase: 'incorrecta' });
    ok('contrasena incorrecta responde 401', mala.status === 401);
    ok('informa 4 intentos restantes', mala.datos.attemptsLeft === 4, String(mala.datos.attemptsLeft));

    const tras = await api('GET', `/api/secrets/${token}`);
    ok('un intento fallido NO destruye el secreto', tras.status === 200);

    const buena = await api('POST', `/api/secrets/${token}/reveal`, { passphrase: 'clave-fpt-2026' });
    ok('la contrasena correcta revela el contenido', buena.status === 200 && buena.datos.secret.includes('Sup3r'));

    const despues = await api('GET', `/api/secrets/${token}`);
    ok('tras revelarse queda destruido', despues.status === 404);
  }

  /* ---------------------------------------------------------------- */
  grupo('Autodestruccion tras 5 intentos fallidos');
  {
    const { datos } = await crear({ passphrase: 'clave-correcta' });
    const token = tokenDe(datos.url);

    let ultima = null;
    for (let i = 0; i < 5; i++) {
      ultima = await api('POST', `/api/secrets/${token}/reveal`, { passphrase: `mala-${i}` });
    }
    ok('el quinto intento devuelve 410', ultima.status === 410, `status ${ultima.status}`);

    const bien = await api('POST', `/api/secrets/${token}/reveal`, { passphrase: 'clave-correcta' });
    ok('ya no sirve ni con la contrasena correcta', bien.status === 404);

    const ev = await db.query('SELECT event FROM secret_events WHERE lookup_id = $1', [lookupId(token)]);
    ok('la bitacora registro burned_attempts', ev.rows.some((r) => r.event === 'burned_attempts'));
  }

  /* ---------------------------------------------------------------- */
  grupo('Expiracion');
  {
    const { datos } = await crear({ ttlMinutes: 5 });
    const token = tokenDe(datos.url);
    await db.query("UPDATE secrets SET expires_at = NOW() - INTERVAL '1 minute' WHERE lookup_id = $1", [
      lookupId(token),
    ]);

    const meta = await api('GET', `/api/secrets/${token}`);
    ok('un secreto vencido ya no aparece en metadatos', meta.status === 404);

    const rev = await api('POST', `/api/secrets/${token}/reveal`);
    ok('un secreto vencido no se puede revelar', rev.status === 404);

    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM secrets WHERE lookup_id = $1', [
      lookupId(token),
    ]);
    ok('el intento de revelado tambien lo borra', rows[0].n === 0);
  }

  /* ---------------------------------------------------------------- */
  grupo('Barrido de limpieza');
  {
    const { datos } = await crear({ ttlMinutes: 5 });
    const token = tokenDe(datos.url);
    await db.query("UPDATE secrets SET expires_at = NOW() - INTERVAL '2 hours' WHERE lookup_id = $1", [
      lookupId(token),
    ]);

    const borrados = await cleanup.sweep();
    ok('el barrido elimina los vencidos', borrados >= 1, `borrados: ${borrados}`);

    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM secrets WHERE lookup_id = $1', [
      lookupId(token),
    ]);
    ok('el registro ya no existe', rows[0].n === 0);
  }

  /* ---------------------------------------------------------------- */
  grupo('Confidencialidad frente a un volcado de la base de datos');
  {
    const frase = 'CADENA-TESTIGO-QUE-NO-DEBE-APARECER-EN-CLARO';
    const { datos } = await crear({ secret: frase, label: 'volcado' });
    const token = tokenDe(datos.url);

    const { rows } = await db.query('SELECT * FROM secrets WHERE lookup_id = $1', [lookupId(token)]);
    const fila = rows[0];
    const volcado = JSON.stringify(fila) + fila.ciphertext.toString('utf8');

    ok('el texto en claro no esta en el registro', !volcado.includes(frase));
    ok('el token no esta guardado en el registro', !volcado.includes(token));
    ok('el lookup_id no revela el token', fila.lookup_id !== token);
    ok('hay salt, iv y auth_tag', fila.salt.length === 16 && fila.iv.length === 12 && fila.auth_tag.length === 16);

    const alterado = Buffer.from(fila.ciphertext);
    alterado[0] = alterado[0] ^ 0xff;
    await db.query('UPDATE secrets SET ciphertext = $2 WHERE lookup_id = $1', [fila.lookup_id, alterado]);
    const rev = await api('POST', `/api/secrets/${token}/reveal`);
    ok('un registro alterado no se descifra (AES-GCM autentica)', rev.status !== 200, `status ${rev.status}`);
  }

  /* ---------------------------------------------------------------- */
  grupo('Validaciones de entrada');
  {
    const vacio = await api('POST', '/api/secrets', { secret: '   ', ttlMinutes: 60 });
    ok('rechaza contenido vacio', vacio.status === 400 && vacio.datos.error === 'empty');

    const ttlMalo = await api('POST', '/api/secrets', { secret: 'x', ttlMinutes: 99 });
    ok('rechaza una duracion fuera del catalogo', ttlMalo.status === 400 && ttlMalo.datos.error === 'bad_ttl');

    const grande = await api('POST', '/api/secrets', { secret: 'x'.repeat(200000), ttlMinutes: 60 });
    ok('rechaza contenido demasiado grande', grande.status === 413);

    const claveCorta = await api('POST', '/api/secrets', { secret: 'x', ttlMinutes: 60, passphrase: 'ab' });
    ok('rechaza contrasenas de menos de 4 caracteres', claveCorta.status === 400);

    const correoMalo = await api('POST', '/api/secrets', {
      secret: 'x', ttlMinutes: 60, notifyEmail: 'no-es-correo',
    });
    ok('rechaza un correo invalido', correoMalo.status === 400 && correoMalo.datos.error === 'bad_email');

    const tokenBasura = await api('GET', '/api/secrets/abc');
    ok('un token con formato invalido responde 404', tokenBasura.status === 404);

    const inexistente = await api(
      'POST',
      '/api/secrets/' + Buffer.alloc(32, 7).toString('base64url') + '/reveal'
    );
    ok('un token bien formado pero inexistente responde 404', inexistente.status === 404);
  }

  /* ---------------------------------------------------------------- */
  grupo('Paginas y cabeceras');
  {
    const inicio = await fetch(base + '/');
    const html = await inicio.text();
    ok('la portada carga', inicio.status === 200 && html.includes('FPT'));

    const pagina = await fetch(base + '/s/' + Buffer.alloc(32, 1).toString('base64url'));
    ok('la pagina de revelado carga', pagina.status === 200);
    ok('la pagina de revelado no se cachea', /no-store/.test(pagina.headers.get('cache-control') || ''));
    ok('la pagina de revelado no se indexa', /noindex/.test(pagina.headers.get('x-robots-tag') || ''));

    const salud = await fetch(base + '/api/health');
    ok('el healthcheck responde ok', salud.status === 200);
    ok('la API no se cachea', /no-store/.test(salud.headers.get('cache-control') || ''));

    const robots = await (await fetch(base + '/robots.txt')).text();
    ok('robots.txt bloquea /s/', robots.includes('Disallow: /s/'));
  }

  /* ---------------------------------------------------------------- */
  console.log(
    `\n\x1b[1m${pasadas} pruebas pasadas, ${fallidas} fallidas\x1b[0m\n`
  );

  server.close();
  await db.pool.end();
  process.exit(fallidas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nError en las pruebas:', err);
  process.exit(1);
});
