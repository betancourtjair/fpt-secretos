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

  await db.query('TRUNCATE secrets, secret_events CASCADE');

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
  grupo('Archivos adjuntos');
  {
    // Un binario con los 256 valores de byte posibles, para detectar
    // cualquier corrupcion en el viaje base64 -> cifrado -> base64.
    const binario = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const texto = Buffer.from('contrato,importe\nFPT-001,1200.50\n', 'utf8');

    const { status, datos } = await crear({
      files: [
        { name: 'certificado.cer', type: 'application/x-x509-ca-cert', dataBase64: binario.toString('base64') },
        { name: 'reporte.csv', type: 'text/csv', dataBase64: texto.toString('base64') },
      ],
    });
    ok('crea un secreto con dos adjuntos', status === 201, `status ${status}`);
    ok('informa cuantos archivos lleva', datos.fileCount === 2, String(datos.fileCount));
    ok('informa el peso total', datos.filesBytes === binario.length + texto.length, String(datos.filesBytes));

    const token = tokenDe(datos.url);

    const meta = await api('GET', `/api/secrets/${token}`);
    ok('los metadatos reportan 2 archivos', meta.datos.fileCount === 2);
    ok('los metadatos reportan el peso', meta.datos.filesBytes === binario.length + texto.length);
    ok(
      'los metadatos NO revelan los nombres',
      !JSON.stringify(meta.datos).includes('certificado.cer'),
      JSON.stringify(meta.datos)
    );

    // La base guarda los nombres cifrados
    const dump = await db.query('SELECT * FROM secret_files WHERE lookup_id = $1', [lookupId(token)]);
    ok('hay 2 filas de archivo en la base', dump.rows.length === 2);
    const crudo = dump.rows.map((r) => JSON.stringify(r) + r.data_ciphertext.toString('latin1')).join('');
    ok('el nombre del archivo no esta en claro en la base', !crudo.includes('certificado.cer'));
    ok('el contenido del CSV no esta en claro en la base', !crudo.includes('FPT-001,1200.50'));

    const rev = await api('POST', `/api/secrets/${token}/reveal`);
    ok('el revelado entrega los 2 archivos', (rev.datos.files || []).length === 2);

    const a = rev.datos.files[0];
    const b = rev.datos.files[1];
    ok('conserva el nombre del primero', a.name === 'certificado.cer', a.name);
    ok('conserva el tipo MIME', a.type === 'application/x-x509-ca-cert', a.type);
    ok('conserva el orden', b.name === 'reporte.csv', b.name);
    ok(
      'el binario vuelve byte a byte identico',
      Buffer.from(a.dataBase64, 'base64').equals(binario)
    );
    ok(
      'el CSV vuelve byte a byte identico',
      Buffer.from(b.dataBase64, 'base64').equals(texto)
    );

    const tras = await db.query('SELECT COUNT(*)::int AS n FROM secret_files WHERE lookup_id = $1', [
      lookupId(token),
    ]);
    ok('al revelarse, los archivos se borran en cascada', tras.rows[0].n === 0);

    const otra = await api('POST', `/api/secrets/${token}/reveal`);
    ok('el enlace con archivos tambien es de un solo uso', otra.status === 404);
  }

  /* ---------------------------------------------------------------- */
  grupo('Adjuntos: casos limite');
  {
    // Secreto que es SOLO un archivo, sin texto
    const soloArchivo = await api('POST', '/api/secrets', {
      secret: '',
      ttlMinutes: 60,
      files: [{ name: 'llave.key', type: '', dataBase64: Buffer.from('clave-privada').toString('base64') }],
    });
    ok('acepta un secreto sin texto pero con archivo', soloArchivo.status === 201, `status ${soloArchivo.status}`);
    const revSolo = await api('POST', `/api/secrets/${tokenDe(soloArchivo.datos.url)}/reveal`);
    ok('lo devuelve con texto vacio y un archivo', revSolo.datos.secret === '' && revSolo.datos.files.length === 1);
    ok('un tipo MIME vacio cae en octet-stream', revSolo.datos.files[0].type === 'application/octet-stream');

    // Ni texto ni archivos
    const nada = await api('POST', '/api/secrets', { secret: '  ', ttlMinutes: 60, files: [] });
    ok('rechaza un secreto sin texto y sin archivos', nada.status === 400 && nada.datos.error === 'empty');

    // Demasiados archivos
    const uno = Buffer.from('x').toString('base64');
    const muchos = await api('POST', '/api/secrets', {
      secret: 'x',
      ttlMinutes: 60,
      files: Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.txt`, type: 'text/plain', dataBase64: uno })),
    });
    ok('rechaza mas de 5 archivos', muchos.status === 400 && muchos.datos.error === 'too_many_files');

    // Demasiado peso: dos de 6 MB pasan del limite de 10 MB
    const gordo = Buffer.alloc(6 * 1024 * 1024, 7).toString('base64');
    const pesado = await api('POST', '/api/secrets', {
      secret: 'x',
      ttlMinutes: 60,
      files: [
        { name: 'a.bin', type: 'application/octet-stream', dataBase64: gordo },
        { name: 'b.bin', type: 'application/octet-stream', dataBase64: gordo },
      ],
    });
    ok('rechaza archivos que suman mas del limite', pesado.status === 413 && pesado.datos.error === 'files_too_large');

    // Nombre malicioso
    const trampa = await api('POST', '/api/secrets', {
      secret: 'x',
      ttlMinutes: 60,
      files: [{ name: '../../etc/passwd', type: 'text/plain', dataBase64: uno }],
    });
    const revTrampa = await api('POST', `/api/secrets/${tokenDe(trampa.datos.url)}/reveal`);
    const limpio = revTrampa.datos.files[0].name;
    ok('sanea rutas en el nombre del archivo', !limpio.includes('/') && !limpio.startsWith('.'), limpio);

    // Formato invalido
    const basura = await api('POST', '/api/secrets', {
      secret: 'x',
      ttlMinutes: 60,
      files: [{ name: 'a.txt', type: 'text/plain', dataBase64: 'no-es-base64-!!!' }],
    });
    ok('rechaza base64 invalido', basura.status === 400 && basura.datos.error === 'bad_files');

    const noArreglo = await api('POST', '/api/secrets', { secret: 'x', ttlMinutes: 60, files: 'nope' });
    ok('rechaza un campo files que no es lista', noArreglo.status === 400 && noArreglo.datos.error === 'bad_files');
  }

  /* ---------------------------------------------------------------- */
  grupo('Adjuntos con contrasena y expiracion');
  {
    const dato = Buffer.from('nomina-marzo-2026');
    const { datos } = await crear({
      passphrase: 'clave-adjuntos',
      files: [{ name: 'nomina.xlsx', type: 'application/vnd.ms-excel', dataBase64: dato.toString('base64') }],
    });
    const token = tokenDe(datos.url);

    const mala = await api('POST', `/api/secrets/${token}/reveal`, { passphrase: 'incorrecta' });
    ok('con clave incorrecta no entrega archivos', mala.status === 401 && !mala.datos.files);

    const sigue = await db.query('SELECT COUNT(*)::int AS n FROM secret_files WHERE lookup_id = $1', [
      lookupId(token),
    ]);
    ok('el archivo sigue intacto tras el intento fallido', sigue.rows[0].n === 1);

    const buena = await api('POST', `/api/secrets/${token}/reveal`, { passphrase: 'clave-adjuntos' });
    ok('con la clave correcta entrega el archivo', Buffer.from(buena.datos.files[0].dataBase64, 'base64').equals(dato));

    // Expiracion tambien arrastra los archivos
    const otro = await crear({
      ttlMinutes: 5,
      files: [{ name: 'temp.txt', type: 'text/plain', dataBase64: Buffer.from('temporal').toString('base64') }],
    });
    const t2 = tokenDe(otro.datos.url);
    await db.query("UPDATE secrets SET expires_at = NOW() - INTERVAL '1 hour' WHERE lookup_id = $1", [
      lookupId(t2),
    ]);
    await cleanup.sweep();
    const restan = await db.query('SELECT COUNT(*)::int AS n FROM secret_files WHERE lookup_id = $1', [
      lookupId(t2),
    ]);
    ok('el barrido de vencidos tambien borra los archivos', restan.rows[0].n === 0);
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
