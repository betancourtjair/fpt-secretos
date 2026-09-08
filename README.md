# FPT Secretos

Plataforma interna de Fitness Para Todos para compartir información confidencial mediante
**enlaces de un solo uso**. Equivalente a onetimesecret.com, pero en infraestructura propia,
con la marca FPT y sin necesidad de usuario ni contraseña.

---

## Qué hace

Alguien pega una contraseña, un token o unos accesos —y si hace falta adjunta archivos—,
elige un par de opciones y obtiene un enlace. Cuando el destinatario lo abre, ve el contenido
y descarga los archivos **una sola vez**: el registro se borra del servidor en la misma
operación. Si nadie lo abre, se destruye solo al vencer el plazo.

**Opciones al crear el secreto**

| Opción | Qué hace |
|---|---|
| **Duración del enlace** | 5 min · 15 min · 1 h · 4 h · 24 h · 3 días · 7 días. Al vencer, el secreto se destruye aunque nadie lo haya visto. |
| **Permitir copiar el texto** | Encendido: botón *Copiar* en la vista del destinatario. Apagado: el texto no se puede seleccionar ni copiar, hay que transcribirlo. |
| **Contraseña adicional** | Segundo factor fuera de banda. La clave entra en la derivación de la llave: sin ella el contenido no se puede descifrar, ni siquiera desde el servidor. 5 intentos y el secreto se autodestruye. |
| **Aviso por correo** | Correo al creador cuando el secreto se abre, cuando expira sin ser visto, o cuando se destruye por intentos fallidos. Nunca incluye el contenido. |
| **Archivos adjuntos** | Hasta 5 archivos, 5 MB en total. Se cifran igual que el texto y se destruyen con él. Un secreto puede ser solo archivos, sin texto. |
| **Referencia** | Etiqueta opcional (ej. "Accesos SAT — Contabilidad") para identificar el secreto en los avisos. |

---

## Cómo está protegido

El diseño asume el peor caso: **que alguien obtenga un volcado completo de la base de datos**.

1. Al crear un secreto se genera un token aleatorio de 32 bytes que viaja **solo en el enlace**.
   Nunca se guarda.
2. En la base de datos se almacena `HMAC-SHA256(pimienta, token)` como identificador de búsqueda.
   Del identificador no se puede volver al token.
3. La llave AES se deriva con HKDF de: **token + pimienta del servidor + contraseña adicional**
   (esta última pasa antes por `scrypt`). El contenido se cifra con **AES-256-GCM**.
4. Con la base de datos sola falta el token → **el contenido no se puede descifrar**.
   Con la base de datos y la pimienta tampoco: sigue faltando el token, que solo existe en el enlace.
5. AES-GCM autentica: si alguien altera un registro, el descifrado falla en vez de devolver basura.
6. El borrado al revelar ocurre **dentro de la misma transacción** que la lectura
   (`SELECT … FOR UPDATE` → descifrar → `DELETE`), así que dos aperturas simultáneas no pueden
   devolver el contenido dos veces.
7. Los archivos usan la misma llave, cada uno con su propio IV (AES-GCM nunca debe repetir IV
   con la misma llave). **Su nombre y tipo MIME también van cifrados**: un volcado de la base
   no revela qué documentos se compartieron, solo cuántos y cuánto pesan.

Otras medidas:

- Cabeceras `helmet` con CSP estricta, `Referrer-Policy: no-referrer`, `frameAncestors: none`.
- `Cache-Control: no-store` en toda la API y en la página de revelado; `X-Robots-Tag: noindex`
  y `robots.txt` bloqueando `/s/`.
- Límite de tasa: 40 secretos y 100 intentos de apertura por IP cada 15 minutos.
- La página `/s/<token>` **no revela nada al cargar**: pide confirmación explícita. Así los
  antivirus de correo y los previsualizadores de WhatsApp/Teams no queman el enlace por accidente.
- Al revelarse, el token se borra de la barra de direcciones (`history.replaceState`).
- Bitácora sin contenido (`secret_events`): solo registra qué pasó con cada identificador y un
  hash de IP. Se poda automáticamente a los 90 días.
- Los archivos se borran **en cascada** con el secreto: no existe un bucket donde puedan quedar
  huérfanos si algo falla a medias.
- Los nombres de archivo se sanean (sin rutas, sin caracteres de control) antes de guardarse.

### Lo que esta herramienta NO puede evitar

Vale la pena decirlo con claridad antes de que alguien lo asuma de más:

- **Bloquear la copia no impide una captura de pantalla, una foto ni transcribir a mano.**
  Es una fricción para que el dato no acabe pegado en un chat por reflejo, no un control de DLP.
- Quien reciba el enlace puede reenviarlo antes de abrirlo; el primero que lo abra se lleva el
  contenido. Por eso existe la contraseña adicional: compártela por otro canal.
- Mientras el secreto no se abre, el servidor sí puede quedarse con el registro cifrado. La
  garantía es que sin el token del enlace ese registro no sirve de nada.
- **Los archivos se entregan al abrir el enlace, no al pulsar "Descargar".** El servidor
  descifra todo y borra el registro en una sola operación; la descarga ya ocurre en el equipo
  del destinatario, contra una copia en memoria. Si cierra la pestaña sin descargar, el archivo
  se perdió: hay que generar un enlace nuevo. Es el precio de que no quede nada en el servidor.

---

## Puesta en marcha

### 1. Base de datos (Neon)

Crea un proyecto en Neon y copia la cadena de conexión (`postgresql://…?sslmode=require`).

### 2. Variables de entorno

```bash
cp .env.example .env
```

Genera la pimienta **una sola vez** y pégala en `SECRET_PEPPER`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> ⚠️ Si cambias `SECRET_PEPPER` después, **todos los secretos vigentes quedan ilegibles**.
> No es un dato que se rote a la ligera.

### 3. Migraciones y arranque local

```bash
npm install
npm run migrate
npm start          # http://localhost:3000
```

### 4. Despliegue en Render

El repositorio incluye `render.yaml`. Al conectar el repo, Render levanta el servicio con:

- **Build:** `npm install && npm run migrate`
- **Start:** `npm start`
- **Health check:** `/api/health`

Variables a llenar en el panel de Render: `PUBLIC_BASE_URL`, `DATABASE_URL` y —si quieres
avisos— las cuatro de Graph. `SECRET_PEPPER` la genera Render sola la primera vez.

> **Nota sobre el plan gratuito:** el servicio se duerme tras 15 minutos sin tráfico. Eso no
> pierde secretos (viven en Neon), pero la primera visita después de dormir tarda ~30 segundos
> y, mientras duerme, el barrido de expirados no corre: los secretos vencidos se eliminan igual
> en cuanto alguien intenta abrirlos o el servicio despierta. Para uso real conviene el plan
> Starter.

### 5. Avisos por correo (opcional)

En Entra ID:

1. **App registrations → New registration** (solo la organización).
2. **API permissions → Microsoft Graph → Application permissions → `Mail.Send`** →
   *Grant admin consent*.
3. **Certificates & secrets → New client secret**.
4. Llena `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` y `GRAPH_SENDER`
   (el buzón desde el que salen los avisos, ej. `notificaciones@fpt.com.mx`).

Con `Mail.Send` de aplicación, el registro puede enviar como cualquier buzón del tenant. Si
prefieres acotarlo, aplica una **Application Access Policy** en Exchange Online limitada al
buzón de notificaciones.

Si dejas esas variables vacías, la app funciona igual y el interruptor de aviso ni siquiera
aparece en el formulario.

---

## Pruebas

```bash
npm run migrate && npm run test:e2e
```

83 pruebas end-to-end contra una base de datos real: flujo completo, quema de un solo uso,
bloqueo de copia, contraseña adicional, autodestrucción por intentos, expiración, barrido,
confidencialidad frente a un volcado de la base, validaciones y cabeceras HTTP. Para los
adjuntos: integridad byte a byte de un binario con los 256 valores posibles, borrado en
cascada, límites de número y peso, saneo de nombres maliciosos y secretos que son solo archivo.

> Apunta `DATABASE_URL` a una base **desechable**: la suite hace `TRUNCATE` al empezar.

---

## Estructura

```
fpt-secretos/
├── server.js                  Express, cabeceras de seguridad, rutas estáticas
├── src/
│   ├── config.js              Carga y validación de variables de entorno
│   ├── crypto.js              Derivación de llaves y AES-256-GCM
│   ├── db.js                  Pool de PostgreSQL y transacciones
│   ├── migrate.js             Corredor de migraciones
│   ├── mailer.js              Avisos vía Microsoft Graph
│   ├── cleanup.js             Barrido de vencidos y poda de bitácora
│   └── routes/secrets.js      API: crear, consultar, revelar
├── migrations/
│   ├── 001_init.sql
│   └── 002_archivos.sql       Tabla secret_files, borrado en cascada
├── public/
│   ├── index.html             Pantalla de creación
│   ├── secreto.html           Pantalla de revelado
│   └── assets/                Estilos y JS (el logotipo va incrustado en el CSS)
├── test/e2e.js
└── render.yaml
```

## API

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/config` | Límites y opciones disponibles para el frontend |
| `POST` | `/api/secrets` | Crea un secreto. Acepta `files: [{name, type, dataBase64}]`. Devuelve la URL de un solo uso |
| `GET` | `/api/secrets/:token` | Estado del enlace **sin quemarlo** (si pide clave, si permite copia, cuándo vence, cuántos archivos y cuánto pesan — nunca sus nombres) |
| `POST` | `/api/secrets/:token/reveal` | Revela, entrega los archivos en base64 y destruye |
| `GET` | `/api/health` | Health check |

---

## Notas de mantenimiento

- **Tipografías:** las páginas cargan Barlow Condensed y Open Sans desde Google Fonts. Si
  Sistemas prefiere cero peticiones a terceros, basta con descargar los `.woff2`, ponerlos en
  `public/assets/fuentes/`, declarar `@font-face` en `estilos.css` y quitar los `<link>` de
  Google. La CSP ya está preparada para ambos casos.
- **Logotipo:** va incrustado como data URI en `estilos.css` (regla `.barra__logo`) y el favicon
  en el `<link rel="icon">` de cada página. El repositorio no contiene binarios; para cambiar el
  logo, reemplaza esas dos cadenas base64.
- **Retención de la bitácora:** 90 días, en `src/cleanup.js`.
- **Intentos de contraseña:** 5, en `src/routes/secrets.js` (`MAX_PASSPHRASE_ATTEMPTS`).
- **Duraciones ofrecidas:** `TTL_OPTIONS_MINUTES`, en el mismo archivo. `MAX_TTL_HOURS` recorta
  el catálogo desde el entorno sin tocar código.
- **Adjuntos:** `MAX_FILES` y `MAX_FILES_BYTES` en el entorno. Subirlos consume almacenamiento
  de Neon y RAM del servicio (los archivos viajan en base64 y se descifran en memoria); con el
  plan Free de Render, 512 MB de RAM, no conviene pasar de 5 MB.
