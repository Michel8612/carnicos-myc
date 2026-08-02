// ============================================================
//  CAMPANITA DE AVISOS
//
//  Se carga en cualquier página que quiera mostrar los avisos
//  pendientes. Basta con añadir <script src="js/avisos.js"></script>
//  DESPUÉS de js/api.js: no hay que llamar a nada, se dibuja sola.
//
//  Va arriba a la derecha a propósito: js/sonidos.js ya ocupa la
//  esquina de abajo a la derecha con su botón flotante, y dos botones
//  flotantes en el mismo sitio se tapan entre ellos.
// ============================================================

(function () {
  // Sin sesión no hay avisos que pedir (y la petición daría 401,
  // que en api.js manda de vuelta al login).
  if (!localStorage.getItem('carnicos_token')) return;

  const caja = document.createElement('div');
  caja.className = 'avisos-caja';
  caja.innerHTML = `
    <button type="button" class="avisos-boton" aria-label="Avisos pendientes" aria-expanded="false">
      🔔<span class="avisos-cuenta" hidden>0</span>
    </button>
    <div class="avisos-lista" hidden role="dialog" aria-label="Avisos"></div>
  `;
  document.body.appendChild(caja);

  const $boton = caja.querySelector('.avisos-boton');
  const $cuenta = caja.querySelector('.avisos-cuenta');
  const $lista = caja.querySelector('.avisos-lista');

  const estilo = document.createElement('style');
  estilo.textContent = `
    .avisos-caja { position:fixed; top:10px; right:12px; z-index:900; }
    .avisos-boton { position:relative; background:#fff; border:1px solid #cfd8dc; border-radius:50%;
      width:42px; height:42px; font-size:19px; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,.2); }
    .avisos-cuenta { position:absolute; top:-4px; right:-4px; background:#c62828; color:#fff;
      border-radius:10px; padding:1px 6px; font-size:11px; font-weight:bold; }
    .avisos-lista { position:absolute; top:50px; right:0; width:min(320px, calc(100vw - 24px));
      max-height:60vh; overflow:auto; background:#fff; border:1px solid #cfd8dc; border-radius:10px;
      box-shadow:0 6px 18px rgba(0,0,0,.25); padding:6px; }
    .aviso-item { padding:9px 10px; border-bottom:1px solid #eceff1; font-size:13.5px; cursor:pointer; }
    .aviso-item:last-child { border-bottom:none; }
    .aviso-item.nuevo { background:#fffde7; }
    .aviso-item strong { display:block; color:#263238; }
    .aviso-item small { color:#78909c; }
    .aviso-urgente strong { color:#c62828; }
    .avisos-vacio { padding:14px; text-align:center; color:#90a4ae; font-size:13px; }
  `;
  document.head.appendChild(estilo);

  // Adónde lleva cada tipo de aviso. Un aviso que no se puede atender
  // desde ningún sitio no sirve de nada: si el tipo es desconocido, la
  // campanita simplemente lo marca leído y no navega a ninguna parte.
  const DESTINO = {
    produccion_recibida: 'almacen.html',
    stock_bajo: 'almacen.html',
    transferencia_pendiente: 'almacen.html',
    cuenta_vencida: 'cuentas.html',
  };

  async function refrescar() {
    try {
      const { total } = await API.avisosContador();
      $cuenta.hidden = !total;
      $cuenta.textContent = total > 99 ? '99+' : total;
    } catch {
      // Un fallo al contar avisos no puede molestar a quien está
      // trabajando: se queda como estaba y se reintenta luego.
    }
  }

  async function abrir() {
    $lista.hidden = false;
    $boton.setAttribute('aria-expanded', 'true');
    $lista.innerHTML = '<p class="avisos-vacio">Cargando…</p>';

    try {
      const avisos = await API.avisos();
      if (!avisos.length) {
        $lista.innerHTML = '<p class="avisos-vacio">No hay avisos pendientes.</p>';
        return;
      }

      $lista.innerHTML = avisos
        .map(
          (a) => `
        <div class="aviso-item ${a.leida ? '' : 'nuevo'} ${a.severidad === 'urgente' ? 'aviso-urgente' : ''}"
             data-id="${a.id}" data-tipo="${a.tipo}">
          <strong>${a.titulo}</strong>
          ${a.mensaje ? `<span>${a.mensaje}</span>` : ''}
          <small>${new Date(a.creada_en).toLocaleString('es-CU')}</small>
        </div>`,
        )
        .join('');
    } catch (e) {
      $lista.innerHTML = `<p class="avisos-vacio">${e.message}</p>`;
    }
  }

  function cerrar() {
    $lista.hidden = true;
    $boton.setAttribute('aria-expanded', 'false');
  }

  $boton.addEventListener('click', () => ($lista.hidden ? abrir() : cerrar()));

  $lista.addEventListener('click', async (ev) => {
    const item = ev.target.closest('.aviso-item');
    if (!item) return;

    try {
      await API.avisoLeido(item.dataset.id);
    } catch {
      // Aunque no se haya podido marcar, se lleva al usuario adonde
      // tenía que ir: el aviso volverá a aparecer, que es lo correcto.
    }

    const destino = DESTINO[item.dataset.tipo];
    if (destino) location.href = destino;
    else {
      item.classList.remove('nuevo');
      refrescar();
    }
  });

  // Cerrar al pulsar fuera.
  document.addEventListener('click', (ev) => {
    if (!caja.contains(ev.target)) cerrar();
  });

  refrescar();
  // Cada dos minutos: lo justo para enterarse de una entrada de
  // producción sin castigar la conexión, que en Cuba no sobra.
  setInterval(refrescar, 120000);
})();
