// Gestión de Almacén — Cárnicos M&C
// Habla con el backend a través de js/api.js (window.API).

// Almacén: el rol Almacén, el Almacenero Central (que atiende todos los
// almacenes) y el Dueño.
if (!soloRoles(['almacen', 'almacenero', 'almacen_central'])) {
  throw new Error('sin acceso');
}

// El dueño ve el enlace para volver al panel; los demás roles no.
if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

// Elementos del DOM
const btnAgregarProducto = document.getElementById('btnAgregarProducto');
const formProducto = document.getElementById('formProducto');
const productoForm = document.getElementById('productoForm');
const almacenList = document.getElementById('almacenList');
const movimientoForm = document.getElementById('movimientoForm');
const movProductoSelect = document.getElementById('movProducto');
const movAlmacenSelect = document.getElementById('movAlmacen');
const unidadProductoSelect = document.getElementById('unidadProducto');
const contadorProductos = document.getElementById('contadorProductos');
const contadorAlmacenes = document.getElementById('contadorAlmacenes');

// En qué moneda tecleó el usuario el costo de la entrada. Es la moneda en
// que se pagó DE VERDAD; la otra casilla es solo su equivalencia. Empieza
// en CUP porque es lo habitual aquí, y así nunca llega sin valor al envío.
let monedaTecleada = 'CUP';

// Destinos con su dirección y teléfono, tal como los devolvió el servidor.
// Se guardan aquí para armar el aviso al transportista al enviar mercancía.
let destinosCache = [];

const TIPO_LABEL = {
  materia_prima: 'Materia prima',
  terminado: 'Terminado',
  reventa: 'Reventa',
};

// Mostrar/ocultar formulario de nuevo producto
btnAgregarProducto.addEventListener('click', () => {
  formProducto.classList.toggle('hidden');
});

// Guardar nuevo producto
productoForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const nombre = document.getElementById('nombreProducto').value.trim();
  const tipo = document.getElementById('tipoProducto').value;
  const unidad_id = Number(unidadProductoSelect.value) || null;
  const precio_costo = parseFloat(document.getElementById('precioCosto').value) || 0;
  const precioVentaVal = document.getElementById('precioVenta').value;
  const stockMinimoVal = document.getElementById('stockMinimo').value;
  const cantidadInicialVal = document.getElementById('cantidadInicial').value;

  const datos = {
    nombre,
    tipo,
    unidad_id,
    precio_costo,
    precio_venta: precioVentaVal ? parseFloat(precioVentaVal) : 0,
    stock_minimo: stockMinimoVal ? parseFloat(stockMinimoVal) : 0,
  };

  // Cantidad inicial (opcional): si se indica, hay que decir también en
  // qué almacén entra. Si el usuario no puede elegir (un solo almacén
  // disponible — ver actualizarSelectorAltaAlmacen), se usa ese
  // directamente sin pedírselo.
  const cantidadInicial = cantidadInicialVal ? parseFloat(cantidadInicialVal) : 0;
  if (cantidadInicial > 0) {
    const selAlmacen = document.getElementById('altaAlmacen');
    const almacenId = (selAlmacen && !selAlmacen.classList.contains('hidden'))
      ? Number(selAlmacen.value)
      : Number(almacenesDisponibles[0]?.id);
    if (!almacenId) {
      alert('Indique en qué almacén entra la cantidad inicial.');
      return;
    }
    datos.cantidad = cantidadInicial;
    datos.almacen_id = almacenId;
  }

  API.crearProducto(datos)
    .then(() => {
      productoForm.reset();
      formProducto.classList.add('hidden');
      cargarTodo();
    })
    .catch((error) => {
      console.error('Error al guardar producto:', error);
      alert('Error: ' + error.message);
    });
});

// El destino solo tiene sentido cuando se da SALIDA: se muestra u oculta.
// Cada vez que se abre (se pasa a "salida") se recarga la lista de
// destinos en vivo, para que salgan almacenes/vendedores creados después.
const tipoMovSelect = document.getElementById('movTipo');
const bloqueDestino = document.getElementById('bloqueDestino');
if (tipoMovSelect && bloqueDestino) {
  const bloqueCompra = document.getElementById('bloqueCompra');
  const refrescarDestino = () => {
    const esSalida = tipoMovSelect.value === 'salida';
    bloqueDestino.classList.toggle('hidden', !esSalida);
    // Proveedor y costo solo tienen sentido cuando ENTRA mercancía.
    if (bloqueCompra) bloqueCompra.classList.toggle('hidden', tipoMovSelect.value !== 'entrada');
    if (esSalida) cargarDestinos();
  };
  tipoMovSelect.addEventListener('change', refrescarDestino);
  refrescarDestino();
}

// Cargar los destinos posibles (almacenes + vendedores) en el select,
// agrupados por optgroup. El value de cada opción va como "tipo:id"
// (ej. "almacen:3" o "ventas:7") para poder partirlo al enviar.
function cargarDestinos() {
  const destino = document.getElementById('movDestinoAlmacen');
  if (!destino) return;
  return API.destinosTransferencia().then((resp) => {
    const destinos = (resp && resp.destinos) || [];
    // Se recuerdan enteros (con dirección y teléfono) para poder armar
    // el aviso de WhatsApp sin volver a preguntarle al servidor.
    destinosCache = destinos;
    const almacenes = destinos.filter((d) => d.tipo === 'almacen');
    const vendedores = destinos.filter((d) => d.tipo === 'ventas');

    let html = '<option value="">¿A dónde va? (opcional)</option>';
    if (almacenes.length) {
      html += '<optgroup label="Almacenes">' +
        almacenes.map((a) => `<option value="almacen:${a.id}">${a.nombre}</option>`).join('') +
        '</optgroup>';
    }
    if (vendedores.length) {
      html += '<optgroup label="Vendedores">' +
        vendedores.map((v) => `<option value="ventas:${v.id}">${v.nombre}</option>`).join('') +
        '</optgroup>';
    }
    destino.innerHTML = html;
  }).catch((error) => console.error('Error al cargar destinos:', error));
}

// Registrar movimiento (entrada/salida)
movimientoForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const tipo = document.getElementById('movTipo').value;
  const datos = {
    producto_id: Number(movProductoSelect.value),
    almacen_id: Number(movAlmacenSelect.value),
    tipo,
    cantidad: parseFloat(document.getElementById('movCantidad').value),
    nota: document.getElementById('movNota').value.trim() || undefined,
  };

  // A dónde va lo que sale (opcional): un almacén/vendedor (queda en
  // tránsito hasta que lo acepten), o un lugar libre escrito (solo nota).
  if (tipo === 'salida') {
    const destSel = document.getElementById('movDestinoAlmacen');
    const destTxt = document.getElementById('movDestinoTexto');
    if (destSel && destSel.value) {
      const [destinoTipo, destinoId] = destSel.value.split(':');
      datos.destino_tipo = destinoTipo;
      datos.destino_id = Number(destinoId);
    }
    if (destTxt && destTxt.value.trim()) datos.destino_texto = destTxt.value.trim();
  }

  // Si la entrada fue una compra, se manda el proveedor (y el costo si
  // se indicó) para dejar rastro en la tabla de compras. Todo opcional.
  if (tipo === 'entrada') {
    const prov = document.getElementById('movProveedor');
    const costoCup = parseFloat((document.getElementById('movCostoUnitario') || {}).value);
    const costoUsd = parseFloat((document.getElementById('movCostoUsd') || {}).value);
    if (prov && prov.value.trim()) datos.proveedor = prov.value.trim();
    if (costoCup > 0) datos.costo_cup = costoCup;
    if (costoUsd > 0) datos.costo_usd = costoUsd;
    // En cuál se pagó DE VERDAD: la que el usuario tecleó primero. Si
    // escribió las dos, manda la que tocó, que quedó marcada al convertir.
    if (costoCup > 0 || costoUsd > 0) datos.moneda_origen = monedaTecleada;
  }

  if (!datos.producto_id || !datos.almacen_id || !datos.cantidad) {
    alert('Complete producto, almacén y cantidad.');
    return;
  }

  API.registrarMovimiento(datos)
    .then(() => {
      // Si la mercancía va a otro sitio, hay que moverla físicamente:
      // se ofrece avisar al transportista antes de limpiar el formulario,
      // que es cuando todavía se sabe qué se envió.
      if (tipo === 'salida' && datos.destino_tipo && datos.destino_id) {
        try { ofrecerAvisoTransporte(datos); } catch (e) { /* el aviso nunca puede tumbar el registro */ }
      }
      movimientoForm.reset();
      if (bloqueDestino) bloqueDestino.classList.add('hidden');
      const bc = document.getElementById('bloqueCompra');
      if (bc) bc.classList.add('hidden');
      cargarTodo();
    })
    .catch((error) => {
      console.error('Error al registrar movimiento:', error);
      alert('Error: ' + error.message);
    });
});

// ============================================================
//  Bandeja de recepción: transferencias pendientes dirigidas a
//  este usuario (su almacén, o él mismo como vendedor).
// ============================================================
function fechaCorta(f) {
  if (!f) return '';
  const d = new Date(f);
  return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
}

async function cargarBandejaRecepcion() {
  const aviso = document.getElementById('avisoPendientes');
  const bloque = document.getElementById('bandejaRecepcion');
  const lista = document.getElementById('bandejaLista');
  if (!bloque || !lista) return;

  let pendientes = [];
  try { pendientes = await API.transferenciasPendientes(); } catch (e) { pendientes = []; }

  if (!pendientes.length) {
    bloque.classList.add('hidden');
    if (aviso) aviso.classList.add('hidden');
    return;
  }

  if (aviso) {
    aviso.classList.remove('hidden');
    aviso.textContent = pendientes.length === 1
      ? 'Tiene 1 entrada por recibir'
      : `Tiene ${pendientes.length} entradas por recibir`;
  }

  bloque.classList.remove('hidden');
  lista.innerHTML = pendientes.map((t) => `
    <div class="tarjeta-pendiente">
      <div class="tarjeta-pendiente-info">
        <b>${t.producto_nombre || 'Producto'}</b>
        — ${Number(t.cantidad).toLocaleString('es-CU', { maximumFractionDigits: 3 })}
        <br>
        <span class="tarjeta-pendiente-detalle">
          Envía: ${t.enviado_nombre || 'alguien'} · Desde: ${t.origen_almacen_nombre || '—'} · ${fechaCorta(t.fecha_envio)}
        </span>
      </div>
      <div class="tarjeta-pendiente-botones">
        <button class="btn-aceptar" onclick="resolverTransferencia(${t.id}, 'aceptar')">Aceptar entrada</button>
        <button class="btn-cancelar" onclick="resolverTransferencia(${t.id}, 'cancelar')">Cancelar recepción</button>
      </div>
    </div>
  `).join('');
}

async function resolverTransferencia(id, accion) {
  if (accion === 'cancelar' && !confirm('¿Cancelar esta recepción? La mercancía volverá al almacén de origen.')) return;
  try {
    if (accion === 'aceptar') await API.aceptarTransferencia(id);
    else await API.cancelarTransferencia(id);
    await cargarTodo();
  } catch (e) {
    alert('No se pudo resolver la transferencia: ' + e.message);
  }
}

// ============================================================
//  Historial de transferencias (estado: pendiente/aceptada/cancelada)
// ============================================================
const ESTADO_LABEL = { pendiente: 'Pendiente', aceptada: 'Aceptada', cancelada: 'Cancelada' };

async function cargarHistorialTransferencias() {
  const cuerpo = document.getElementById('historialTransferenciasList');
  if (!cuerpo) return;

  let filas = [];
  try { filas = await API.transferenciasHistorial(); } catch (e) { filas = []; }

  if (!filas.length) {
    cuerpo.innerHTML = '<tr><td colspan="7" style="color:#888;">Sin transferencias registradas.</td></tr>';
    return;
  }

  cuerpo.innerHTML = filas.map((t) => `
    <tr>
      <td>${t.producto_nombre || ''}</td>
      <td>${Number(t.cantidad).toLocaleString('es-CU', { maximumFractionDigits: 3 })}</td>
      <td>${t.origen_almacen_nombre || ''}</td>
      <td>${t.destino_nombre || ''}</td>
      <td>${t.enviado_nombre || ''}</td>
      <td>${fechaCorta(t.fecha_envio)}</td>
      <td><span class="estado-transf estado-${t.estado}">${ESTADO_LABEL[t.estado] || t.estado}</span></td>
    </tr>`).join('');
}

// ============================================================
//  Historial de movimientos del almacén (entradas, salidas, ajustes,
//  traslados, producción). El borrado (✕) es SOLO administrativo:
//  no toca existencias, solo quita la línea del historial. El backend
//  ya rechaza el borrado a cualquiera que no sea dueño/admin/proveedor
//  aunque se le llame a mano — aquí en el frontend solo se OCULTA el
//  botón para los demás roles, por comodidad, no por seguridad.
//
//  El endpoint de listado (GET /inventario/movimientos) todavía no
//  está en api.js (lo edita otro agente), así que se llama aquí mismo
//  con apiFetch(), la misma función global que usa api.js para mandar
//  el token de sesión en cada petición (mismo patrón que ventas.js).
// ============================================================
const historialMovimientos = (filtros) => {
  const q = new URLSearchParams();
  if (filtros && filtros.almacen_id) q.set('almacen_id', filtros.almacen_id);
  if (filtros && filtros.desde) q.set('desde', filtros.desde);
  if (filtros && filtros.hasta) q.set('hasta', filtros.hasta);
  const s = q.toString();
  return apiFetch('/inventario/movimientos' + (s ? '?' + s : ''));
};

const TIPO_MOV_LABEL = {
  entrada: 'Entrada', salida: 'Salida', traslado: 'Traslado',
  ajuste: 'Ajuste', produccion: 'Producción',
};

function fechaHoraCorta(f) {
  if (!f) return '';
  const d = new Date(f);
  return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
}

// Llena el selector de almacén del filtro. Un almacenero limitado solo
// tiene el suyo (API.almacenes() ya se lo devuelve así); dueño/admin/
// proveedor/almacen_central ven todos.
async function cargarFiltroAlmacenMovimientos() {
  const sel = document.getElementById('hmFiltroAlmacen');
  if (!sel) return;
  let almacenes = [];
  try { almacenes = await API.almacenes(); } catch (e) { almacenes = []; }
  const actual = sel.value;
  sel.innerHTML = '<option value="">Todos los almacenes</option>' +
    almacenes.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join('');
  if (actual) sel.value = actual;
}

async function cargarHistorialMovimientos() {
  const cuerpo = document.getElementById('historialMovimientosList');
  if (!cuerpo) return;

  const filtros = {
    almacen_id: document.getElementById('hmFiltroAlmacen')?.value || '',
    desde: document.getElementById('hmFiltroDesde')?.value || '',
    hasta: document.getElementById('hmFiltroHasta')?.value || '',
  };

  let filas = [];
  try { filas = await historialMovimientos(filtros); } catch (e) { filas = []; }

  const esAdmin = esDueno(); // dueño/admin/proveedor — igual que ES_ADMIN_TOTAL en el backend

  if (!filas.length) {
    cuerpo.innerHTML = '<tr><td colspan="8" style="color:#888;">Sin movimientos registrados.</td></tr>';
    return;
  }

  cuerpo.innerHTML = filas.map((m) => `
    <tr>
      <td>${fechaHoraCorta(m.fecha)}</td>
      <td>${m.producto || ''}</td>
      <td>${m.almacen || ''}</td>
      <td>${TIPO_MOV_LABEL[m.tipo] || m.tipo}</td>
      <td>${Number(m.cantidad).toLocaleString('es-CU', { maximumFractionDigits: 3 })} ${m.unidad || ''}</td>
      <td>${m.usuario_nombre || ''}</td>
      <td>${m.nota || ''}</td>
      <td>${esAdmin ? `<button type="button" class="btn-x" data-id="${m.id}" title="Borrar línea del historial">✕</button>` : ''}</td>
    </tr>`).join('');

  if (esAdmin) {
    cuerpo.querySelectorAll('.btn-x').forEach((b) => {
      b.addEventListener('click', () => borrarMovimientoHistorial(Number(b.dataset.id)));
    });
  }
}

async function borrarMovimientoHistorial(id) {
  const aviso = 'Esto borra SOLO la línea del historial: NO devuelve ni quita mercancía ' +
    'del inventario (la existencia actual no cambia). Úselo únicamente para corregir un ' +
    'registro erróneo, no para "deshacer" un movimiento real.\n\n' +
    '¿Continuar?';
  if (!confirm(aviso)) return;

  const motivo = prompt('Motivo del borrado (obligatorio):', '');
  if (motivo === null) return; // canceló
  if (!motivo.trim()) {
    alert('Debe indicar un motivo para borrar la línea.');
    return;
  }

  try {
    await API.borrarMovimientoAlmacen(id, motivo.trim());
    await cargarHistorialMovimientos();
  } catch (e) {
    alert('No se pudo borrar: ' + e.message);
  }
}

const btnHmFiltrar = document.getElementById('hmBtnFiltrar');
if (btnHmFiltrar) btnHmFiltrar.addEventListener('click', cargarHistorialMovimientos);

// ============================================================
//  Lo que la cocina produjo, esperando entrada al almacén
//
//  El cocinero elabora y eso NO entra solo al almacén: aparece
//  aquí y el almacenero decide cuándo darle entrada.
// ============================================================
async function cargarProducido() {
  const bloque = document.getElementById('bloqueProducido');
  const cuerpo = document.getElementById('producidoList');
  if (!bloque || !cuerpo) return;

  let filas = [];
  try { filas = await API.produccionDisponible(); } catch (e) { filas = []; }

  if (!filas.length) { bloque.classList.add('hidden'); return; }
  bloque.classList.remove('hidden');

  const fecha = (f) => {
    if (!f) return '';
    const d = new Date(f);
    return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit' }) + ' ' +
      d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
  };

  cuerpo.innerHTML = filas.map((f) => `
    <tr>
      <td><b>${f.producto_nombre}</b></td>
      <td>${Number(f.cantidad).toLocaleString('es-CU', { maximumFractionDigits: 3 })}</td>
      <td>${f.unidad || ''}</td>
      <td>${Number(f.costo_unitario || 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td>${fecha(f.fecha)}</td>
      <td><button onclick="darEntradaProducido(${f.id}, '${String(f.producto_nombre).replace(/'/g, "\\'")}')">Dar entrada</button></td>
    </tr>`).join('');
}

async function darEntradaProducido(id, nombre) {
  const almacenId = Number(movAlmacenSelect.value);
  if (!almacenId) { alert('Elija primero el almacén en el formulario de arriba.'); return; }
  if (!confirm(`¿Dar entrada de "${nombre}" al almacén?\n\nA partir de ahora contará como existencia.`)) return;
  try {
    await API.produccionAlAlmacen(id, almacenId);
    await cargarTodo();
  } catch (e) {
    alert('No se pudo dar entrada: ' + e.message);
  }
}

// Cargar unidades para los selects
function cargarUnidades() {
  return API.unidades().then((unidades) => {
    unidadProductoSelect.innerHTML = (unidades || [])
      .map((u) => `<option value="${u.id}">${u.nombre} (${u.abreviatura})</option>`)
      .join('');
  }).catch((error) => console.error('Error al cargar unidades:', error));
}

// Última lista de almacenes cargada. La usa el selector de "Cantidad
// inicial" del alta de producto para saber si hay que ofrecer elegir
// almacén o no: API.almacenes() ya le devuelve solo el suyo a un
// almacenero limitado (ver almacenDeLaSesion en el backend), así que
// "puede elegir almacén" equivale simplemente a "hay más de uno aquí".
let almacenesDisponibles = [];

// Cargar almacenes (para el selector de movimiento y el contador).
// El selector de DESTINO (almacenes + vendedores) se llena aparte con
// cargarDestinos(), cada vez que se abre el bloque de destino.
function cargarAlmacenes() {
  return API.almacenes().then((almacenes) => {
    almacenesDisponibles = almacenes || [];
    movAlmacenSelect.innerHTML = (almacenes || [])
      .map((a) => `<option value="${a.id}">${a.nombre}</option>`)
      .join('');
    contadorAlmacenes.textContent = `${(almacenes || []).length} almacenes`;
    actualizarSelectorAltaAlmacen();
    return almacenes;
  }).catch((error) => console.error('Error al cargar almacenes:', error));
}

// El selector de almacén del alta de producto solo se muestra si hay
// más de uno para elegir. Si el usuario está limitado a un único
// almacén, no tiene sentido preguntarle: se usa ese directamente (ver
// el submit de productoForm).
function actualizarSelectorAltaAlmacen() {
  const sel = document.getElementById('altaAlmacen');
  if (!sel) return;
  if (almacenesDisponibles.length > 1) {
    sel.innerHTML = '<option value="">Almacén para la cantidad inicial</option>' +
      almacenesDisponibles.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join('');
    sel.classList.remove('hidden');
  } else {
    sel.innerHTML = '';
    sel.classList.add('hidden');
  }
}

// Cargar productos (para el selector de movimiento)
function cargarProductosSelect() {
  return API.productos().then((productos) => {
    movProductoSelect.innerHTML = (productos || [])
      .map((p) => `<option value="${p.id}">${p.nombre}</option>`)
      .join('');
    return productos;
  }).catch((error) => console.error('Error al cargar productos:', error));
}

// Cargar y pintar la tabla de existencias
function cargarExistencias() {
  almacenList.innerHTML = '';

  return API.existencias().then((productos) => {
    contadorProductos.textContent = `${(productos || []).length} productos`;

    (productos || []).forEach((producto) => {
      const tr = document.createElement('tr');

      // Miniatura del producto; si no tiene foto, un recuadro neutro (no rompe la fila).
      const miniatura = producto.imagen
        ? `<img src="${producto.imagen}" class="rec-miniatura" alt="">`
        : `<span class="rec-miniatura rec-miniatura-vacia"></span>`;

      tr.innerHTML = `
        <td>${miniatura}</td>
        <td>${producto.nombre}</td>
        <td>${TIPO_LABEL[producto.tipo] || producto.tipo}</td>
        <td>${producto.unidad || ''}</td>
        <td>${producto.cantidad}</td>
        <td>${Number(producto.precio_costo || 0).toFixed(2)}</td>
        <td>
          <button onclick="eliminarProducto(${producto.id})">Eliminar</button>
        </td>
      `;

      if (producto.cantidad <= 0) {
        tr.classList.add('producto-agotado');
      }

      almacenList.appendChild(tr);
    });
  }).catch((error) => {
    console.error('Error al cargar existencias:', error);
  });
}

// Eliminar producto
function eliminarProducto(id) {
  if (!confirm('¿Eliminar este producto?')) return;

  API.eliminarProducto(id)
    .then(() => cargarTodo())
    .catch((error) => {
      console.error('Error al eliminar:', error);
      alert('Error: ' + error.message);
    });
}

// Cargar todo de nuevo (tras crear/eliminar/mover)
function cargarTodo() {
  cargarExistencias();
  cargarProductosSelect();
  cargarAlmacenes();
  cargarProducido();   // lo que la cocina dejó listo para entrar
  cargarBandejaRecepcion();       // transferencias pendientes por recibir
  cargarHistorialTransferencias(); // historial de lo enviado
  cargarHistorialMovimientos();   // historial de entradas/salidas/ajustes
}

// ============================================================
//  COSTO EN LAS DOS MONEDAS (CUP y USD)
//
//  Al escribir en una casilla, la otra se rellena sola con la tasa del
//  día. No es solo comodidad: casi nadie sabe de memoria a cuánto sale
//  en dólares lo que acaba de comprar en pesos, y ese número hace falta
//  para el valor del inventario.
//
//  Se recuerda CUÁL tecleó el usuario (`monedaTecleada`) porque esa es la
//  moneda en que se pagó de verdad; la otra es una equivalencia. El
//  servidor lo necesita para saber, más tarde, cuánto del inventario se
//  compró en dólares y cuánto en pesos.
//
//  Si el usuario corrige las DOS a mano, se respetan tal cual: esa compra
//  se hizo a otro cambio y el sistema no debe "arreglarla".
// ============================================================
let tasaDelDia = null;

async function prepararCostoEnDosMonedas() {
  const cup = document.getElementById('movCostoUnitario');
  const usd = document.getElementById('movCostoUsd');
  const nota = document.getElementById('notaTasa');
  if (!cup || !usd || !nota) return;

  try {
    const t = await API.tasaActual();
    if (t && t.disponible && Number(t.valor) > 0) {
      tasaDelDia = Number(t.valor);
      nota.textContent = `Tasa de hoy: 1 USD = ${tasaDelDia.toLocaleString('es-ES')} CUP`
        + (t.fuente ? ` (${t.fuente})` : '')
        + '. Escriba en una casilla y la otra se calcula sola.';
      nota.className = 'nota-tasa';
    } else {
      throw new Error('sin tasa');
    }
  } catch (e) {
    // Sin tasa NO se inventa una equivalencia: se avisa y se deja que
    // escriba lo que sepa. Un número inventado en contabilidad es peor
    // que un hueco.
    tasaDelDia = null;
    nota.textContent = 'No hay tasa del dólar ahora mismo. Puede escribir el costo en una moneda '
      + 'o en las dos, pero no se calculará la equivalencia.';
    nota.className = 'nota-tasa nota-aviso';
  }

  const convertir = (desde, hacia, factor) => {
    monedaTecleada = desde === cup ? 'CUP' : 'USD';
    if (!tasaDelDia) return;               // sin tasa, no se toca la otra casilla
    if (desde.dataset.manual === '1') return;
    const v = parseFloat(desde.value);
    if (!(v > 0)) { if (hacia.dataset.manual !== '1') hacia.value = ''; return; }
    // La otra casilla es un cálculo, no algo que el usuario escribió: si
    // él la edita después, se marca como manual y se deja en paz.
    if (hacia.dataset.manual !== '1') hacia.value = factor(v).toFixed(2);
  };

  cup.addEventListener('input', () => { cup.dataset.manual = ''; convertir(cup, usd, (v) => v / tasaDelDia); });
  usd.addEventListener('input', () => { usd.dataset.manual = ''; convertir(usd, cup, (v) => v * tasaDelDia); });
  // Marcar como "escrita a mano" la casilla que el usuario toca en segundo
  // lugar, para que la conversión deje de pisarla.
  cup.addEventListener('change', () => { if (usd.value) cup.dataset.manual = '1'; });
  usd.addEventListener('change', () => { if (cup.value) usd.dataset.manual = '1'; });
}

// ============================================================
//  VALOR DEL INVENTARIO (Parte 7)
//
//  Quién lo ve lo decide EL SERVIDOR, no esta pantalla: /inventario/valor
//  responde 403 a quien no sea dueño o contabilidad. Aquí solo se pinta si
//  llegaron datos. Ocultarlo únicamente con CSS no protegería nada: los
//  números habrían viajado igual al navegador y se leerían con dos clics.
// ============================================================
async function cargarValorInventario() {
  const bloque = document.getElementById('bloqueValor');
  if (!bloque) return;

  let d;
  try {
    d = await API.valorInventario();
  } catch (e) {
    // 403 es lo NORMAL para el almacenero: no es un fallo que haya que
    // enseñar. Se deja la sección oculta y a trabajar.
    return;
  }

  const num = (n, dec = 2) => Number(n || 0).toLocaleString('es-ES', {
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  });

  document.getElementById('valInvCup').textContent = num(d.inventario.cup);
  document.getElementById('valInvUsd').textContent = num(d.inventario.usd);
  document.getElementById('valInvProductos').textContent = num(d.inventario.productos, 0);
  document.getElementById('valCriterio').textContent = d.inventario.criterio || '';

  // Si algún producto se valoró por su precio de ficha en vez de por
  // compras reales, hay que decirlo: es la diferencia entre un dato y
  // una estimación, y quien mira la cifra tiene derecho a saberlo.
  const sinCosto = Number(d.inventario.productos_sin_costo) || 0;
  document.getElementById('valInvSinCosto').textContent = sinCosto
    ? `${sinCosto} sin compras registradas`
    : 'todos con compras registradas';

  const filas = d.por_fecha || [];
  document.getElementById('tbValorFechas').innerHTML = filas.length
    ? filas.map((f) => {
        const fecha = String(f.fecha).slice(0, 10).split('-').reverse().join('/');
        // Las entradas viejas no llevan costo (son anteriores a esta
        // función). Se marca en vez de mostrar un cero que engañaría.
        const aviso = f.sin_costo
          ? ` <small class="sin-costo" title="Entradas sin costo declarado">(${f.sin_costo} sin costo)</small>`
          : '';
        return `<tr>
          <td>${fecha}</td>
          <td>${num(f.entradas, 0)}${aviso}</td>
          <td>${num(f.cantidad, 3)}</td>
          <td>${num(f.valor_cup)}</td>
          <td>${num(f.valor_usd)}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5" style="text-align:center;color:#78909c;">Todavía no hay entradas registradas.</td></tr>';

  bloque.classList.remove('hidden');
}

// ============================================================
//  AVISO AL TRANSPORTISTA POR WHATSAPP
//
//  Cuando sale mercancía hacia un punto de venta, alguien tiene que
//  moverla. Este botón arma el mensaje con lo que hay que llevar y a
//  dónde, y abre WhatsApp para mandarlo.
//
//  Por qué NO se envía solo desde el servidor: el sistema vive en
//  Netlify (en la nube) y no puede hablar con un WhatsApp que está en
//  una PC de la casa. Y usar la API oficial de Meta obliga a verificar
//  el negocio y a usar plantillas aprobadas. Abrir WhatsApp con el texto
//  ya escrito funciona hoy, desde el propio teléfono del almacenero, sin
//  depender de nada encendido — y de paso una persona ve el mensaje
//  antes de que salga, que para algo que moviliza a un transportista es
//  una ventaja y no un estorbo.
//
//  Si algún día se automatiza, el texto ya está en un solo sitio
//  (`textoAviso`) y solo cambia quién aprieta el botón.
// ============================================================
function textoAviso({ producto, cantidad, unidad, destino, almacenOrigen }) {
  const lineas = [
    '*ENVÍO DE MERCANCÍA*',
    '',
    `Producto: ${producto}`,
    `Cantidad: ${cantidad}${unidad ? ' ' + unidad : ''}`,
    '',
    `Desde: ${almacenOrigen || 'Almacén'}`,
    `Hacia: ${destino.nombre}`,
  ];
  // La dirección es lo que de verdad necesita el transportista. Si falta,
  // se dice con todas las letras en vez de mandar un mensaje incompleto
  // que obligue a llamar por teléfono para preguntarla.
  lineas.push(destino.direccion
    ? `Dirección: ${destino.direccion}`
    : 'Dirección: (NO REGISTRADA — hace falta ponerla en el sistema)');
  if (destino.telefono) lineas.push(`Teléfono: ${destino.telefono}`);
  lineas.push('', `Fecha: ${new Date().toLocaleString('es-CU')}`);
  return lineas.join(String.fromCharCode(10));
}

function ofrecerAvisoTransporte(datos) {
  const destino = destinosCache.find(
    (d) => d.tipo === datos.destino_tipo && Number(d.id) === Number(datos.destino_id),
  );
  if (!destino) return;

  const producto = movProductoSelect.options[movProductoSelect.selectedIndex]?.text || 'Producto';
  const almacenOrigen = movAlmacenSelect.options[movAlmacenSelect.selectedIndex]?.text || '';

  if (!destino.direccion) {
    const dir = prompt(
      `"${destino.nombre}" no tiene dirección registrada.`
      + ' Escríbala ahora y quedará guardada para los próximos envíos'
      + ' (o deje vacío para mandar el aviso sin ella):', '');
    if (dir && dir.trim()) {
      destino.direccion = dir.trim();
      API.guardarDireccionDestino(destino.tipo, destino.id, { direccion: destino.direccion, telefono: destino.telefono })
        .catch(() => { /* si no se pudo guardar, el aviso se manda igual */ });
    }
  }

  const texto = textoAviso({
    producto, cantidad: datos.cantidad, unidad: '', destino, almacenOrigen,
  });

  if (!confirm('Envío registrado. ¿Quiere avisar al transportista por WhatsApp?')) return;
  // Sin número: WhatsApp abre y el usuario elige a quién se lo manda.
  // Es lo que se quiere aquí, porque el transportista cambia según el día.
  window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
}

// Carga inicial
cargarUnidades();
cargarFiltroAlmacenMovimientos();
cargarTodo();
prepararCostoEnDosMonedas();
cargarValorInventario();
