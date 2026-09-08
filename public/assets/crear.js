/* FPT Secretos — pantalla de creacion */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var form = $('formulario');
  var secreto = $('secreto');
  var contador = $('contador');
  var duraciones = $('duraciones');
  var permitirCopia = $('permitirCopia');
  var usarClave = $('usarClave');
  var campoClave = $('campoClave');
  var clave = $('clave');
  var usarAviso = $('usarAviso');
  var campoAviso = $('campoAviso');
  var opcionAviso = $('opcionAviso');
  var correo = $('correo');
  var referencia = $('referencia');
  var errorForm = $('errorForm');
  var botonGenerar = $('botonGenerar');
  var resultado = $('resultado');
  var enlace = $('enlace');
  var btnCopiarEnlace = $('btnCopiarEnlace');
  var btnOtro = $('btnOtro');
  var resumen = $('resumen');

  var ajustes = { maxSecretBytes: 100000, ttlOptions: [5, 15, 60, 240, 1440, 4320, 10080], emailNotificationsAvailable: false };

  var ETIQUETAS_TTL = {
    5: '5 minutos',
    15: '15 minutos',
    60: '1 hora',
    240: '4 horas',
    1440: '24 horas',
    4320: '3 dias',
    10080: '7 dias'
  };

  /* ---------- utilidades ---------- */

  function bytes(str) {
    return new TextEncoder().encode(str).length;
  }

  function mostrarError(mensaje) {
    errorForm.textContent = mensaje;
    errorForm.classList.remove('oculto');
    errorForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function limpiarError() {
    errorForm.textContent = '';
    errorForm.classList.add('oculto');
  }

  function formatoFecha(iso) {
    try {
      return new Intl.DateTimeFormat('es-MX', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Mexico_City'
      }).format(new Date(iso));
    } catch (_e) {
      return new Date(iso).toLocaleString();
    }
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch (_e) {
      var tmp = document.createElement('textarea');
      tmp.value = texto;
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_e2) { ok = false; }
      document.body.removeChild(tmp);
      return ok;
    }
  }

  /* ---------- construir opciones de duracion ---------- */

  function pintarDuraciones() {
    duraciones.innerHTML = '';
    ajustes.ttlOptions.forEach(function (min, i) {
      var wrap = document.createElement('label');
      wrap.className = 'duracion';
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'ttl';
      input.value = String(min);
      if (min === 1440 || (i === ajustes.ttlOptions.length - 1 && !duraciones.querySelector('input:checked'))) {
        input.checked = true;
      }
      var span = document.createElement('span');
      span.textContent = ETIQUETAS_TTL[min] || (min + ' min');
      wrap.appendChild(input);
      wrap.appendChild(span);
      duraciones.appendChild(wrap);
    });
    if (!duraciones.querySelector('input:checked')) {
      var primero = duraciones.querySelector('input');
      if (primero) primero.checked = true;
    }
  }

  function ttlSeleccionado() {
    var sel = duraciones.querySelector('input:checked');
    return sel ? parseInt(sel.value, 10) : 1440;
  }

  /* ---------- contador de caracteres ---------- */

  function actualizarContador() {
    var n = secreto.value.length;
    var b = bytes(secreto.value);
    var excedido = b > ajustes.maxSecretBytes;
    contador.textContent = n.toLocaleString('es-MX') + ' caracteres' +
      (excedido ? ' — excede el limite de ' + Math.round(ajustes.maxSecretBytes / 1000) + ' KB' : '');
    contador.classList.toggle('excedido', excedido);
  }

  /* ---------- eventos ---------- */

  secreto.addEventListener('input', actualizarContador);

  usarClave.addEventListener('change', function () {
    campoClave.hidden = !usarClave.checked;
    if (usarClave.checked) clave.focus(); else clave.value = '';
  });

  usarAviso.addEventListener('change', function () {
    campoAviso.hidden = !usarAviso.checked;
    if (usarAviso.checked) correo.focus(); else { correo.value = ''; }
  });

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    limpiarError();

    if (!secreto.value.trim()) {
      mostrarError('Escribe el contenido que quieres compartir.');
      secreto.focus();
      return;
    }
    if (bytes(secreto.value) > ajustes.maxSecretBytes) {
      mostrarError('El contenido excede el limite de ' + Math.round(ajustes.maxSecretBytes / 1000) + ' KB.');
      return;
    }
    if (usarClave.checked && clave.value.trim().length < 4) {
      mostrarError('La contrasena adicional debe tener al menos 4 caracteres.');
      clave.focus();
      return;
    }
    if (usarAviso.checked && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo.value.trim())) {
      mostrarError('Escribe un correo valido para el aviso, o apaga esa opcion.');
      correo.focus();
      return;
    }

    botonGenerar.disabled = true;
    var textoOriginal = botonGenerar.textContent;
    botonGenerar.innerHTML = '<span class="cargando"></span> Generando';

    try {
      var res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: secreto.value,
          ttlMinutes: ttlSeleccionado(),
          allowCopy: permitirCopia.checked,
          passphrase: usarClave.checked ? clave.value : '',
          notifyEmail: usarAviso.checked ? correo.value.trim() : '',
          label: usarAviso.checked ? referencia.value.trim() : ''
        })
      });

      var datos = await res.json().catch(function () { return {}; });

      if (!res.ok) {
        mostrarError(datos.message || 'No se pudo generar el enlace. Intenta de nuevo.');
        return;
      }

      mostrarResultado(datos);
    } catch (_e) {
      mostrarError('No hay conexion con el servidor. Revisa tu red e intenta de nuevo.');
    } finally {
      botonGenerar.disabled = false;
      botonGenerar.textContent = textoOriginal;
    }
  });

  function fila(clave_, valor) {
    var li = document.createElement('li');
    var a = document.createElement('span');
    a.className = 'clave';
    a.textContent = clave_;
    var b = document.createElement('span');
    b.className = 'valor';
    b.textContent = valor;
    li.appendChild(a);
    li.appendChild(b);
    return li;
  }

  function mostrarResultado(datos) {
    enlace.value = datos.url;

    resumen.innerHTML = '';
    resumen.appendChild(fila('Expira el', formatoFecha(datos.expiresAt)));
    resumen.appendChild(fila('Se puede copiar', datos.allowCopy ? 'Si' : 'No, solo lectura'));
    resumen.appendChild(fila('Contrasena adicional', datos.requiresPassphrase ? 'Si' : 'No'));
    if (usarAviso.checked && correo.value.trim()) {
      resumen.appendChild(fila('Aviso al abrirse', correo.value.trim()));
    }

    form.classList.add('oculto');
    resultado.classList.remove('oculto');
    resultado.scrollIntoView({ behavior: 'smooth', block: 'start' });
    enlace.focus();
    enlace.select();

    // El contenido en claro ya no tiene por que seguir en pantalla.
    secreto.value = '';
    clave.value = '';
    actualizarContador();
  }

  btnCopiarEnlace.addEventListener('click', async function () {
    var ok = await copiar(enlace.value);
    btnCopiarEnlace.textContent = ok ? 'Copiado' : 'Copia manual';
    btnCopiarEnlace.classList.toggle('copiado', ok);
    if (!ok) { enlace.focus(); enlace.select(); }
    setTimeout(function () {
      btnCopiarEnlace.textContent = 'Copiar';
      btnCopiarEnlace.classList.remove('copiado');
    }, 2200);
  });

  btnOtro.addEventListener('click', function () {
    enlace.value = '';
    resultado.classList.add('oculto');
    form.classList.remove('oculto');
    usarClave.checked = false;
    campoClave.hidden = true;
    usarAviso.checked = false;
    campoAviso.hidden = true;
    correo.value = '';
    referencia.value = '';
    permitirCopia.checked = true;
    limpiarError();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    secreto.focus();
  });

  /* ---------- arranque ---------- */

  fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      ajustes = Object.assign(ajustes, cfg);
      pintarDuraciones();
      actualizarContador();
      if (!ajustes.emailNotificationsAvailable) {
        opcionAviso.classList.add('oculto');
        campoAviso.hidden = true;
      }
    })
    .catch(function () {
      pintarDuraciones();
      actualizarContador();
    });
})();
