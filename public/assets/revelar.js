/* FPT Secretos — pantalla de revelado (/s/<token>) */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var vistaCargando = $('vistaCargando');
  var vistaInvalida = $('vistaInvalida');
  var vistaConfirmar = $('vistaConfirmar');
  var vistaRevelada = $('vistaRevelada');
  var motivoInvalido = $('motivoInvalido');
  var cronometro = $('cronometro');
  var referenciaSecreto = $('referenciaSecreto');
  var campoClaveRevelar = $('campoClaveRevelar');
  var claveRevelar = $('claveRevelar');
  var errorRevelar = $('errorRevelar');
  var btnRevelar = $('btnRevelar');
  var contenidoSecreto = $('contenidoSecreto');
  var btnCopiarSecreto = $('btnCopiarSecreto');
  var avisoSinCopia = $('avisoSinCopia');
  var avisoAdjuntos = $('avisoAdjuntos');
  var bloqueAdjuntos = $('bloqueAdjuntos');
  var listaAdjuntos = $('listaAdjuntos');
  var pesoAdjuntos = $('pesoAdjuntos');

  var token = decodeURIComponent((location.pathname.split('/s/')[1] || '').split(/[?#]/)[0]);
  var metadatos = null;
  var temporizador = null;

  function mostrar(vista) {
    [vistaCargando, vistaInvalida, vistaConfirmar, vistaRevelada].forEach(function (v) {
      v.classList.add('oculto');
    });
    vista.classList.remove('oculto');
  }

  function invalido(mensaje) {
    if (mensaje) motivoInvalido.textContent = mensaje;
    if (temporizador) clearInterval(temporizador);
    mostrar(vistaInvalida);
  }

  function error(mensaje) {
    errorRevelar.textContent = mensaje;
    errorRevelar.classList.remove('oculto');
  }

  function limpiarError() {
    errorRevelar.textContent = '';
    errorRevelar.classList.add('oculto');
  }

  function restante(hasta) {
    var ms = new Date(hasta).getTime() - Date.now();
    if (ms <= 0) return null;
    var min = Math.floor(ms / 60000);
    var dias = Math.floor(min / 1440);
    var horas = Math.floor((min % 1440) / 60);
    var mins = min % 60;
    if (dias > 0) return dias + (dias === 1 ? ' dia ' : ' dias ') + horas + ' h';
    if (horas > 0) return horas + ' h ' + mins + ' min';
    if (min > 0) return min + (min === 1 ? ' minuto' : ' minutos');
    return 'menos de 1 minuto';
  }

  function arrancarCronometro(expiresAt) {
    var pintar = function () {
      var texto = restante(expiresAt);
      if (!texto) {
        clearInterval(temporizador);
        invalido('Este secreto expiro antes de que lo abrieras. Pidele a quien te lo envio que genere uno nuevo.');
        return;
      }
      cronometro.textContent = 'Este enlace vence en ' + texto;
    };
    pintar();
    temporizador = setInterval(pintar, 30000);
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

  /* ---------- archivos adjuntos ---------- */

  function formatoPeso(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace('.0', '') + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.0', '') + ' MB';
  }

  function iconoArchivo() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'archivo__icono');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('aria-hidden', 'true');
    var cuerpo = document.createElementNS(ns, 'path');
    cuerpo.setAttribute('d', 'M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5z');
    var doblez = document.createElementNS(ns, 'path');
    doblez.setAttribute('d', 'M14 3v5h5');
    svg.appendChild(cuerpo);
    svg.appendChild(doblez);
    return svg;
  }

  /** base64 -> Blob, sin pasar por cadenas gigantes. */
  function aBlob(base64, tipo) {
    var bin = atob(base64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: tipo || 'application/octet-stream' });
  }

  function pintarAdjuntos(archivos) {
    if (!archivos || !archivos.length) return;

    listaAdjuntos.innerHTML = '';
    var total = 0;

    archivos.forEach(function (f) {
      total += f.size;

      var li = document.createElement('li');
      li.className = 'archivo';
      li.appendChild(iconoArchivo());

      var datos = document.createElement('span');
      datos.className = 'archivo__datos';
      var nombre = document.createElement('span');
      nombre.className = 'archivo__nombre';
      nombre.textContent = f.name;
      nombre.title = f.name;
      var peso = document.createElement('span');
      peso.className = 'archivo__peso';
      peso.textContent = formatoPeso(f.size);
      datos.appendChild(nombre);
      datos.appendChild(peso);
      li.appendChild(datos);

      // El archivo ya vive solo en esta pestana: la descarga es local.
      var url = URL.createObjectURL(aBlob(f.dataBase64, f.type));
      var bajar = document.createElement('a');
      bajar.className = 'archivo__bajar';
      bajar.textContent = 'Descargar';
      bajar.href = url;
      bajar.download = f.name;
      bajar.addEventListener('click', function () {
        bajar.classList.add('descargado');
        bajar.textContent = 'Descargado';
      });
      li.appendChild(bajar);

      listaAdjuntos.appendChild(li);
    });

    pesoAdjuntos.textContent =
      archivos.length + (archivos.length === 1 ? ' archivo · ' : ' archivos · ') + formatoPeso(total);
    bloqueAdjuntos.classList.remove('oculto');
  }

  /* ---------- protecciones cuando la copia esta desactivada ---------- */

  function bloquearCopia() {
    contenidoSecreto.classList.add('secreto-caja--protegida');
    avisoSinCopia.classList.remove('oculto');
    btnCopiarSecreto.classList.add('oculto');

    ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach(function (evento) {
      contenidoSecreto.addEventListener(evento, function (ev) { ev.preventDefault(); });
    });

    document.addEventListener('keydown', function (ev) {
      var tecla = (ev.key || '').toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && (tecla === 'c' || tecla === 'x' || tecla === 'a')) {
        var sel = window.getSelection();
        if (sel && contenidoSecreto.contains(sel.anchorNode)) ev.preventDefault();
      }
    });
  }

  /* ---------- revelar ---------- */

  async function revelar() {
    limpiarError();
    if (metadatos && metadatos.requiresPassphrase && !claveRevelar.value) {
      error('Escribe la contrasena adicional que te compartieron.');
      claveRevelar.focus();
      return;
    }

    btnRevelar.disabled = true;
    var textoOriginal = btnRevelar.textContent;
    btnRevelar.innerHTML = '<span class="cargando"></span> Abriendo';

    try {
      var res = await fetch('/api/secrets/' + encodeURIComponent(token) + '/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: claveRevelar.value || '' })
      });
      var datos = await res.json().catch(function () { return {}; });

      if (res.ok) {
        if (temporizador) clearInterval(temporizador);
        pintarSecreto(datos);
        return;
      }

      if (res.status === 401) {
        error(datos.message || 'Contrasena incorrecta.');
        claveRevelar.value = '';
        claveRevelar.focus();
        return;
      }

      if (res.status === 410) {
        invalido(datos.message || 'Se agotaron los intentos y el secreto fue destruido.');
        return;
      }

      invalido(datos.message || 'Este enlace ya no existe.');
    } catch (_e) {
      error('No hay conexion con el servidor. El secreto sigue intacto; intenta de nuevo.');
    } finally {
      btnRevelar.disabled = false;
      btnRevelar.textContent = textoOriginal;
    }
  }

  function pintarSecreto(datos) {
    contenidoSecreto.textContent = datos.secret;

    // Un secreto puede traer solo archivos: no tiene caso una caja vacia.
    if (!datos.secret) {
      contenidoSecreto.classList.add('oculto');
      document.querySelector('.cabecera-contenido').classList.add('oculto');
    }

    pintarAdjuntos(datos.files);

    if (datos.secret && datos.allowCopy) {
      btnCopiarSecreto.classList.remove('oculto');
      btnCopiarSecreto.addEventListener('click', async function () {
        var ok = await copiar(datos.secret);
        btnCopiarSecreto.textContent = ok ? 'Copiado' : 'Copia manual';
        btnCopiarSecreto.classList.toggle('copiado', ok);
        setTimeout(function () {
          btnCopiarSecreto.textContent = 'Copiar';
          btnCopiarSecreto.classList.remove('copiado');
        }, 2200);
      });
    } else if (datos.secret) {
      bloquearCopia();
    }

    // Quitar el token de la barra de direcciones: el enlace ya esta quemado.
    try { history.replaceState(null, '', '/s/abierto'); } catch (_e) { /* ignorado */ }

    mostrar(vistaRevelada);
    window.scrollTo({ top: 0 });
  }

  /* ---------- arranque ---------- */

  if (!token || token.length < 20) {
    invalido('El enlace esta incompleto. Pide que te lo vuelvan a compartir completo.');
    return;
  }

  btnRevelar.addEventListener('click', revelar);
  claveRevelar.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); revelar(); }
  });

  fetch('/api/secrets/' + encodeURIComponent(token))
    .then(function (r) {
      if (!r.ok) throw new Error('no_existe');
      return r.json();
    })
    .then(function (meta) {
      metadatos = meta;
      if (meta.requiresPassphrase) campoClaveRevelar.classList.remove('oculto');
      if (meta.label) {
        referenciaSecreto.textContent = 'Referencia: ' + meta.label;
        referenciaSecreto.classList.remove('oculto');
      }
      if (meta.fileCount) {
        var uno = meta.fileCount === 1;
        avisoAdjuntos.textContent =
          'Incluye ' + meta.fileCount + (uno ? ' archivo adjunto · ' : ' archivos adjuntos · ') +
          formatoPeso(meta.filesBytes) + '. ' +
          (uno ? 'Podras descargarlo una sola vez.' : 'Podras descargarlos una sola vez.');
        avisoAdjuntos.classList.remove('oculto');
      }
      arrancarCronometro(meta.expiresAt);
      mostrar(vistaConfirmar);
      if (meta.requiresPassphrase) claveRevelar.focus();
    })
    .catch(function () {
      invalido();
    });
})();
