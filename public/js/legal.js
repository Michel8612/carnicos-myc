// ============================================================
//  Documentos legales — Cárnicos M&C
//
//  Este archivo cumple DOS papeles:
//
//  1) Módulo reusable: expone `window.Legal.comprobar()`, que
//     consulta el estado legal del usuario y, si le falta aceptar
//     algo, muestra una ventana modal a pantalla completa y no deja
//     seguir hasta que acepte. Lo usa index.html justo después de
//     que el login tiene éxito (ver el "enganche" al final de este
//     archivo: envuelve API.login sin tocar js/auth.js ni js/api.js,
//     que son de otros agentes).
//
//  2) Script de la página public/legal.html: si detecta el marcador
//     #legalPagina en el documento, inicializa esa pantalla (ver
//     consultar documentos, y si es dueño/admin, publicar una
//     versión nueva y ver el historial).
//
//  Regla dura: si el backend legal falla (base caída, etc.), NO se
//  bloquea al usuario. Ver los catch de abajo: siempre dejan pasar.
// ============================================================

(function () {
  // --------------------------------------------------------
  //  Estilos del modal y de las pestañas. Se inyectan por JS para
  //  no tener que tocar el <head> de index.html (solo se agrega ahí
  //  un <script src="js/legal.js">). Reutiliza los mismos nombres de
  //  clase que ya usa el resto del sistema para sus modales
  //  (ver public/ventas.html): .modal-fondo / .modal-caja / .modal-acc
  //  / .b-cancelar / .b-guardar. Cabecera #37474f, azul #2196F3 para
  //  el botón principal, como pide el patrón visual del sistema.
  // --------------------------------------------------------
  const ESTILOS_LEGAL = `
    .modal-fondo { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:center; justify-content:center; padding:16px; z-index:9999; }
    .modal-fondo.abierto { display:flex; }
    .modal-caja { background:#fff; border-radius:14px; width:100%; max-width:620px; max-height:94vh; box-shadow:0 10px 30px rgba(0,0,0,.35); text-align:left; overflow:hidden; display:flex; flex-direction:column; }
    .legal-cab { background:#37474f; color:#fff; padding:16px 20px; }
    .legal-cab h2 { margin:0 0 4px; font-size:19px; }
    .legal-cab p { margin:0; font-size:12.5px; opacity:.85; }
    .legal-tabs { display:flex; gap:6px; padding:12px 16px 0; flex-wrap:wrap; }
    .legal-tab-btn { background:#eceff1; border:1px solid #cfd8dc; color:#37474f; padding:7px 12px; border-radius:16px; font-size:12.5px; cursor:pointer; }
    .legal-tab-btn.activo { background:#2196F3; color:#fff; border-color:#2196F3; }
    .legal-contenido { padding:14px 20px; overflow-y:auto; flex:1; min-height:160px; font-size:13.5px; line-height:1.55; color:#333; }
    .legal-contenido p { margin:0 0 10px; }
    .legal-check { display:flex; gap:8px; align-items:flex-start; padding:6px 20px 0; font-size:13px; color:#333; }
    .legal-check input { margin-top:3px; width:auto; }
    .modal-err { margin:10px 20px 0; color:#d32f2f; background:#ffebee; border:1px solid #ffcdd2; border-radius:6px; padding:8px; font-size:13px; display:none; }
    .modal-acc { display:flex; gap:10px; padding:16px 20px 20px; }
    .modal-acc button { flex:1; padding:13px; border:none; border-radius:8px; cursor:pointer; font-size:15px; font-weight:bold; }
    .b-guardar { background:#2196F3; color:#fff; }
    .b-guardar:disabled { background:#90caf9; cursor:not-allowed; }
    .b-cancelar { background:#e0e0e0; color:#333; }
    @media (max-width:480px) {
      .modal-caja { max-width:100%; max-height:100vh; border-radius:0; }
      .legal-contenido { font-size:13px; }
    }
    /* --- Página legal.html --- */
    .legal-pag-tabs { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin:14px 0; }
    .legal-pag-caja { background:#fff; border-radius:12px; padding:18px; box-shadow:0 3px 10px rgba(0,0,0,.12); margin:14px 0; }
    .legal-pag-caja h3 { margin:0 0 10px; color:#37474f; }
    .legal-form label { display:block; font-size:13px; font-weight:bold; color:#333; margin:8px 0 4px; }
    .legal-form input, .legal-form select, .legal-form textarea { width:100%; box-sizing:border-box; padding:10px; border:1px solid #ccc; border-radius:8px; font-size:14px; font-family:inherit; }
    .legal-form textarea { min-height:220px; resize:vertical; }
    .legal-form button { margin-top:12px; background:#2196F3; color:#fff; border:none; padding:12px 18px; border-radius:8px; cursor:pointer; font-size:15px; }
    .legal-tabla-scroll { overflow-x:auto; }
    table.legal-tabla { width:100%; border-collapse:collapse; background:#fff; border-radius:10px; overflow:hidden; margin-top:6px; }
    table.legal-tabla th { background:#cfd8dc; padding:8px 6px; font-size:12px; }
    table.legal-tabla td { border-top:1px solid #eceff1; padding:7px 6px; font-size:12.5px; text-align:center; }
    .legal-vig { color:#2e7d32; font-weight:bold; } .legal-novig { color:#999; }
    .legal-msg-ok { color:#2e7d32; background:#e8f5e9; border:1px solid #c8e6c9; border-radius:6px; padding:8px; font-size:13px; margin-top:10px; display:none; }
  `;

  function inyectarEstilos() {
    if (document.getElementById('legalEstilos')) return;
    const s = document.createElement('style');
    s.id = 'legalEstilos';
    s.textContent = ESTILOS_LEGAL;
    document.head.appendChild(s);
  }

  const TITULOS_TIPO = {
    terminos: 'Términos y Condiciones',
    privacidad: 'Política de Privacidad',
    datos: 'Tratamiento de Datos',
  };

  function escapar(t) {
    const d = document.createElement('div');
    d.textContent = t == null ? '' : String(t);
    return d.innerHTML;
  }

  // Convierte texto plano (párrafos separados por línea en blanco) en HTML
  // seguro (todo escapado antes de insertarse).
  function formatearContenido(contenido) {
    return String(contenido || '')
      .split(/\n{2,}/)
      .map((p) => `<p>${escapar(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  // --------------------------------------------------------
  //  Modal de aceptación (pantalla completa, sin forma de cerrar sin
  //  aceptar salvo el "continuar de todas formas" que solo aparece
  //  tras un fallo real del servidor — falla hacia abierto).
  // --------------------------------------------------------
  function mostrarModalAceptacion(documentos, idsPendientes) {
    return new Promise((resolve) => {
      inyectarEstilos();

      const fondo = document.createElement('div');
      fondo.className = 'modal-fondo abierto';
      fondo.innerHTML = `
        <div class="modal-caja">
          <div class="legal-cab">
            <h2>Aviso legal</h2>
            <p>Antes de continuar, lea y acepte los siguientes documentos.</p>
          </div>
          <div class="legal-tabs" id="legalTabs"></div>
          <div class="legal-contenido" id="legalContenidoModal"></div>
          <label class="legal-check">
            <input type="checkbox" id="legalCheck">
            <span>He leído y acepto los documentos anteriores.</span>
          </label>
          <div class="modal-err" id="legalErr"></div>
          <div class="modal-acc">
            <button type="button" class="b-cancelar" id="legalContinuar" style="display:none;">Continuar de todas formas</button>
            <button type="button" class="b-guardar" id="legalOk" disabled>Aceptar y continuar</button>
          </div>
        </div>`;
      document.body.appendChild(fondo);

      const tabsBox = fondo.querySelector('#legalTabs');
      const contenidoBox = fondo.querySelector('#legalContenidoModal');
      const check = fondo.querySelector('#legalCheck');
      const btnOk = fondo.querySelector('#legalOk');
      const btnContinuar = fondo.querySelector('#legalContinuar');
      const errBox = fondo.querySelector('#legalErr');

      let activo = (documentos[0] && documentos[0].tipo) || null;

      function pintar() {
        tabsBox.innerHTML = documentos
          .map((d) => `<button type="button" class="legal-tab-btn${d.tipo === activo ? ' activo' : ''}" data-tipo="${escapar(d.tipo)}">${escapar(TITULOS_TIPO[d.tipo] || d.titulo || d.tipo)}</button>`)
          .join('');
        const doc = documentos.find((d) => d.tipo === activo);
        contenidoBox.innerHTML = doc ? formatearContenido(doc.contenido) : '';
        contenidoBox.scrollTop = 0;
        tabsBox.querySelectorAll('.legal-tab-btn').forEach((b) => {
          b.addEventListener('click', () => { activo = b.dataset.tipo; pintar(); });
        });
      }
      pintar();

      check.addEventListener('change', () => { btnOk.disabled = !check.checked; });

      function cerrar() {
        fondo.remove();
        resolve();
      }

      btnOk.addEventListener('click', async () => {
        errBox.style.display = 'none';
        btnOk.disabled = true;
        const textoOriginal = btnOk.textContent;
        btnOk.textContent = 'Guardando…';
        try {
          await API.aceptarLegal(idsPendientes);
          cerrar();
        } catch (e) {
          errBox.textContent = (e && e.message ? e.message : 'No se pudo registrar la aceptación.') + ' Puede intentarlo de nuevo.';
          errBox.style.display = 'block';
          btnOk.disabled = !check.checked;
          btnOk.textContent = textoOriginal;
          // Tras un fallo real del servidor se ofrece continuar de todas
          // formas: bloquear el acceso al negocio por un problema de este
          // módulo sería peor que el problema (regla dura del encargo).
          btnContinuar.style.display = '';
        }
      });

      btnContinuar.addEventListener('click', () => {
        console.warn('Aviso legal: se continuó sin que quedara registrada la aceptación (fallo del servidor).');
        cerrar();
      });
    });
  }

  // --------------------------------------------------------
  //  Legal.comprobar() — punto de entrada reusable.
  //  Nunca rechaza (no usa throw hacia quien la llama): cualquier
  //  fallo se registra en consola y se resuelve igual, para no
  //  bloquear el acceso al sistema.
  // --------------------------------------------------------
  async function comprobar() {
    let estado;
    try {
      estado = await API.estadoLegal();
    } catch (e) {
      console.warn('Aviso legal: no se pudo comprobar el estado, se continúa sin bloquear.', e && e.message);
      return;
    }
    if (!estado || estado.al_dia || !Array.isArray(estado.pendientes) || estado.pendientes.length === 0) {
      return;
    }

    let documentos;
    try {
      documentos = await API.documentosLegales();
    } catch (e) {
      console.warn('Aviso legal: no se pudieron cargar los textos, se continúa sin bloquear.', e && e.message);
      return;
    }
    if (!Array.isArray(documentos) || documentos.length === 0) return;

    const idsPendientes = estado.pendientes.map((p) => p.documento_id);
    await mostrarModalAceptacion(documentos, idsPendientes);
  }

  window.Legal = { comprobar };

  // --------------------------------------------------------
  //  Enganche en el login (public/index.html)
  //
  //  No se toca js/auth.js (es de otro agente) ni js/api.js. En vez
  //  de eso, si este script se carga en la pantalla de login (existe
  //  #loginForm), se envuelve API.login: cuando el login del negocio
  //  termina bien, se guarda el token (para poder consultar el estado
  //  legal, que exige sesión) y se muestra el aviso ANTES de devolver
  //  el control a auth.js, que sigue haciendo exactamente lo mismo de
  //  siempre (fijar el token/usuario otra vez, sin problema, y
  //  redirigir). Así el login en sí no se toca ni se duplica.
  // --------------------------------------------------------
  if (
    document.getElementById('loginForm') &&
    window.API &&
    typeof API.login === 'function' &&
    !API.login.__legalEnvuelto
  ) {
    const loginOriginal = API.login;
    const loginConAvisoLegal = async function (...args) {
      const r = await loginOriginal.apply(API, args);
      try {
        if (r && r.token && typeof setToken === 'function') setToken(r.token);
        await comprobar();
      } catch (e) {
        // Falla hacia abierto: un fallo inesperado aquí no debe impedir entrar.
        console.error('Aviso legal: fallo inesperado, se continúa sin bloquear.', e);
      }
      return r;
    };
    loginConAvisoLegal.__legalEnvuelto = true;
    API.login = loginConAvisoLegal;
  }

  // --------------------------------------------------------
  //  Página public/legal.html
  // --------------------------------------------------------
  if (document.getElementById('legalPagina')) {
    inicializarPaginaLegal();
  }

  function inicializarPaginaLegal() {
    if (!requiereSesion()) return;

    const usuarioActual = getUsuario() || {};
    const puedePublicar = usuarioActual.rol === 'dueno' || usuarioActual.rol === 'admin';

    if (esDueno()) {
      const nav = document.getElementById('navPanel');
      if (nav) { nav.style.display = ''; nav.href = homeDeRol(usuarioActual.rol); }
    }

    inyectarEstilos();

    const tabsBox = document.getElementById('lpTabs');
    const contenidoBox = document.getElementById('lpContenido');
    const seccionPublicar = document.getElementById('lpSeccionPublicar');
    const seccionHistorial = document.getElementById('lpSeccionHistorial');
    const cargando = document.getElementById('lpCargando');

    let documentosVigentes = [];
    let activo = null;

    function pintarTabs() {
      tabsBox.innerHTML = documentosVigentes
        .map((d) => `<button type="button" class="legal-tab-btn${d.tipo === activo ? ' activo' : ''}" data-tipo="${escapar(d.tipo)}">${escapar(TITULOS_TIPO[d.tipo] || d.titulo || d.tipo)}</button>`)
        .join('');
      const doc = documentosVigentes.find((d) => d.tipo === activo);
      contenidoBox.innerHTML = doc
        ? `<p style="font-size:12px;color:#777;margin-bottom:10px;">Versión vigente: ${escapar(doc.version)} — publicada el ${doc.creado_en ? new Date(doc.creado_en).toLocaleDateString('es-CU') : '—'}</p>` + formatearContenido(doc.contenido)
        : '<p class="legal-vacio">No hay documento vigente de este tipo todavía.</p>';
      tabsBox.querySelectorAll('.legal-tab-btn').forEach((b) => {
        b.addEventListener('click', () => { activo = b.dataset.tipo; pintarTabs(); });
      });
    }

    async function cargarDocumentos() {
      try {
        documentosVigentes = await API.documentosLegales();
      } catch (e) {
        documentosVigentes = [];
        contenidoBox.innerHTML = `<p class="legal-vacio">No se pudieron cargar los documentos (${escapar(e.message || 'error')}).</p>`;
        return;
      }
      activo = (documentosVigentes[0] && documentosVigentes[0].tipo) || 'terminos';
      pintarTabs();
    }

    // --- Publicar nueva versión (solo dueño/admin) ---
    if (puedePublicar && seccionPublicar) {
      seccionPublicar.style.display = '';
      const form = document.getElementById('lpForm');
      const selTipo = document.getElementById('lpTipo');
      const inpVersion = document.getElementById('lpVersion');
      const inpTitulo = document.getElementById('lpTitulo');
      const txtContenido = document.getElementById('lpContenidoNuevo');
      const msgOk = document.getElementById('lpMsgOk');
      const errBox = document.getElementById('lpErr');

      // Al elegir un tipo, se precarga el texto vigente como punto de
      // partida (más fácil corregir que empezar en blanco).
      selTipo.addEventListener('change', () => {
        const doc = documentosVigentes.find((d) => d.tipo === selTipo.value);
        if (doc) {
          inpTitulo.value = doc.titulo || '';
          txtContenido.value = doc.contenido || '';
        } else {
          inpTitulo.value = '';
          txtContenido.value = '';
        }
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errBox.style.display = 'none';
        msgOk.style.display = 'none';
        const boton = form.querySelector('button[type=submit]');
        boton.disabled = true;
        try {
          await API.guardarDocumentoLegal({
            tipo: selTipo.value,
            version: inpVersion.value.trim(),
            titulo: inpTitulo.value.trim(),
            contenido: txtContenido.value,
          });
          msgOk.textContent = 'Versión publicada. Todo el personal deberá volver a aceptarla al entrar.';
          msgOk.style.display = 'block';
          inpVersion.value = '';
          await cargarDocumentos();
          await cargarHistorial();
        } catch (err) {
          errBox.textContent = err.message || 'No se pudo publicar el documento.';
          errBox.style.display = 'block';
        } finally {
          boton.disabled = false;
        }
      });
    }

    // --- Historial de versiones y aceptaciones (solo dueño/admin) ---
    // No hay método en api.js para esto (no se tocó ese archivo): se usa
    // un fetch propio, con el mismo token guardado por el login normal.
    async function legalFetchDirecto(ruta) {
      const base = location.port === '5173'
        ? `${location.protocol}//${location.hostname}:3001/api`
        : '/api';
      const token = localStorage.getItem('carnicos_token');
      const res = await fetch(base + ruta, {
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      });
      const datos = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(datos.error || 'Algo salió mal.');
      return datos;
    }

    async function cargarHistorial() {
      if (!puedePublicar || !seccionHistorial) return;
      seccionHistorial.style.display = '';
      const tbVersiones = document.getElementById('lpTbVersiones');
      const tbAceptaciones = document.getElementById('lpTbAceptaciones');
      try {
        const { documentos, aceptaciones } = await legalFetchDirecto('/legal/historial');
        tbVersiones.innerHTML = (documentos || []).map((d) => `
          <tr>
            <td>${escapar(TITULOS_TIPO[d.tipo] || d.tipo)}</td>
            <td>${escapar(d.version)}</td>
            <td class="${d.vigente ? 'legal-vig' : 'legal-novig'}">${d.vigente ? 'Vigente' : 'Reemplazada'}</td>
            <td>${d.creado_en ? new Date(d.creado_en).toLocaleString('es-CU') : '—'}</td>
          </tr>`).join('') || '<tr><td colspan="4">Sin datos.</td></tr>';

        tbAceptaciones.innerHTML = (aceptaciones || []).map((a) => `
          <tr>
            <td>${escapar(a.usuario_nombre || '—')}</td>
            <td>${escapar(TITULOS_TIPO[a.tipo] || a.tipo)}</td>
            <td>${escapar(a.version)}</td>
            <td>${a.fecha ? new Date(a.fecha).toLocaleString('es-CU') : '—'}</td>
            <td>${escapar(a.ip || '—')}</td>
          </tr>`).join('') || '<tr><td colspan="5">Todavía nadie ha aceptado.</td></tr>';
      } catch (e) {
        tbVersiones.innerHTML = `<tr><td colspan="4">No se pudo cargar (${escapar(e.message)}).</td></tr>`;
        tbAceptaciones.innerHTML = '';
      }
    }

    (async function iniciar() {
      await cargarDocumentos();
      await cargarHistorial();
      if (cargando) cargando.style.display = 'none';
    })();
  }
})();
