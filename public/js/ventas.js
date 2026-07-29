// ============================================================
//  Área de Ventas — Cárnicos M&C
//
//  Cada vendedor lleva SU PROPIA lista de productos: los agrega él,
//  con su costo y su precio de venta, y se le quedan guardados.
//  NO depende del almacén (son áreas distintas).
//
//  Durante el día anota lo VENDIDO de cada producto y ve al momento
//  su total y su ganancia. Al pulsar "Reiniciar jornada" se descuenta
//  lo vendido de la cantidad y todo pasa al libro de Contabilidad.
//  Los productos que quedan en cero se pueden eliminar con la ✕.
// ============================================================

// Ventas: el rol Ventas y el Dueño (que puede todo, en todas partes).
if (!soloRoles(['ventas'])) { throw new Error('sin acceso'); }

let verUsuarioId = null;   // el dueño puede mirar la hoja de otro vendedor
let productosActuales = []; // última hoja cargada (para pintar el catálogo)
let carrito = [];           // { producto_id, nombre, unidad, precio_venta, existencia, cantidad } — solo en memoria

const hojaBody = document.getElementById('hojaBody');
const tablaHoja = document.getElementById('tablaHoja');
const vacioHoja = document.getElementById('vacioHoja');
const selectorBox = document.getElementById('selectorVendedorBox');
const selectorVendedor = document.getElementById('selectorVendedor');
const modalProd = document.getElementById('modalProd');
const mpError = document.getElementById('mpError');

const money = (n) => Number(n ?? 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ------------------------------------------------------------
// Endpoints nuevos (carrito de venta e historial). Todavía no están
// en api.js (lo edita otro agente), así que los definimos aquí mismo
// reutilizando apiFetch(), la misma función global que usa api.js
// para mandar el token de sesión en cada petición.
// ------------------------------------------------------------
const ventasCarrito = (datos) => apiFetch('/ventas/carrito', { method: 'POST', body: JSON.stringify(datos) });
const ventasHistorial = () => apiFetch('/ventas/historial');
const ventasHistorialBorrar = (id) => apiFetch(`/ventas/historial/${id}`, { method: 'DELETE' });

document.getElementById('fechaHoy').textContent = new Date().toLocaleDateString('es-CU', { weekday: 'long', day: 'numeric', month: 'long' });

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

async function cargar() {
  let d;
  try { d = await API.ventasHoja(verUsuarioId); }
  catch (e) { vacioHoja.style.display = 'block'; vacioHoja.textContent = 'No se pudo cargar: ' + e.message; return; }

  // Totales de arriba.
  document.getElementById('tVenta').textContent = money(d.total_dinero);
  document.getElementById('tCosto').textContent = money(d.total_costo);
  document.getElementById('tGanancia').textContent = money(d.total_ganancia);
  document.getElementById('tExist').textContent = money(d.valor_existencia);

  // El dueño puede cambiar de vendedor.
  const yo = getUsuario() || {};
  if (d.es_jefe && d.vendedores.length) {
    selectorBox.style.display = '';
    selectorVendedor.innerHTML = d.vendedores
      .map((v) => `<option value="${v.id}">${v.nombre}</option>`).join('');
    selectorVendedor.value = String(d.usuario_id);
    const actual = d.vendedores.find((v) => v.id === d.usuario_id);
    document.getElementById('vendedorNombre').textContent = actual ? actual.nombre : (yo.nombre || '');
  } else {
    document.getElementById('vendedorNombre').textContent = yo.nombre || '';
  }

  // Guardamos la lista para pintar el catálogo (misma fuente que la tabla).
  productosActuales = d.productos || [];
  renderCatalogo();

  if (!d.productos.length) {
    tablaHoja.style.display = 'none'; vacioHoja.style.display = 'block'; hojaBody.innerHTML = '';
    return;
  }

  vacioHoja.style.display = 'none'; tablaHoja.style.display = '';
  hojaBody.innerHTML = '';
  d.productos.forEach((p) => {
    const tr = document.createElement('tr');
    if (Number(p.cantidad) <= 0) tr.classList.add('fila-cero');
    tr.innerHTML = `
      <td><input class="nombre campo" data-id="${p.id}" data-campo="nombre" value="${p.nombre}"></td>
      <td><input type="number" step="0.01" class="campo" data-id="${p.id}" data-campo="cantidad" value="${p.cantidad}"></td>
      <td>
        <select class="campo" data-id="${p.id}" data-campo="unidad">
          ${['u','lb','kg','g','L','caja'].map((u) => `<option value="${u}"${p.unidad === u ? ' selected' : ''}>${u}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" step="0.01" class="campo" data-id="${p.id}" data-campo="costo_unitario" value="${p.costo_unitario}"></td>
      <td><input type="number" step="0.01" class="campo" data-id="${p.id}" data-campo="precio_venta" value="${p.precio_venta}"></td>
      <td><input type="number" step="0.01" class="vendido" data-id="${p.id}" value="${p.vendido || ''}" placeholder="0"></td>
      <td class="col-total">${money(p.total)}</td>
      <td class="col-gan ${p.ganancia >= 0 ? 'g-pos' : 'g-neg'}">${money(p.ganancia)}</td>
      <td><button class="btn-x" data-id="${p.id}" data-nombre="${p.nombre}" title="Eliminar producto">×</button></td>`;
    hojaBody.appendChild(tr);
  });

  // Guardar al salir de la casilla; recalcular mientras se escribe.
  hojaBody.querySelectorAll('.campo').forEach((el) => {
    el.addEventListener('change', () => guardarCampo(el));
    el.addEventListener('input', recalcular);
  });
  hojaBody.querySelectorAll('.vendido').forEach((el) => {
    el.addEventListener('change', () => guardarVendido(el));
    el.addEventListener('input', recalcular);
  });
  hojaBody.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', () => eliminar(Number(b.dataset.id), b.dataset.nombre));
  });
}

// Recalcula totales y ganancias en pantalla, sin ir al servidor.
function recalcular() {
  let venta = 0, costo = 0, existencia = 0;
  hojaBody.querySelectorAll('tr').forEach((tr) => {
    const val = (campo) => Number(tr.querySelector(`[data-campo="${campo}"]`)?.value) || 0;
    const vendido = Number(tr.querySelector('.vendido')?.value) || 0;
    const precio = val('precio_venta');
    const costoU = val('costo_unitario');
    const cantidad = val('cantidad');

    const total = vendido * precio;
    const ganancia = total - vendido * costoU;
    venta += total; costo += vendido * costoU; existencia += cantidad * costoU;

    const celdaT = tr.querySelector('.col-total');
    const celdaG = tr.querySelector('.col-gan');
    if (celdaT) celdaT.textContent = money(total);
    if (celdaG) {
      celdaG.textContent = money(ganancia);
      celdaG.className = 'col-gan ' + (ganancia >= 0 ? 'g-pos' : 'g-neg');
    }
  });
  document.getElementById('tVenta').textContent = money(venta);
  document.getElementById('tCosto').textContent = money(costo);
  document.getElementById('tGanancia').textContent = money(venta - costo);
  document.getElementById('tExist').textContent = money(existencia);
}

async function guardarCampo(el) {
  const id = Number(el.dataset.id);
  const campo = el.dataset.campo;
  const valor = (campo === 'nombre' || campo === 'unidad') ? el.value : Number(el.value) || 0;
  try { await API.ventaProductoEditar(id, { [campo]: valor }); }
  catch (e) { alert('No se pudo guardar: ' + e.message); }
}

async function guardarVendido(el) {
  try { await API.ventaVendido(Number(el.dataset.id), Number(el.value) || 0); }
  catch (e) { alert('No se pudo guardar: ' + e.message); }
}

async function eliminar(id, nombre) {
  if (!confirm(`¿Eliminar "${nombre}" de su lista de venta?`)) return;
  try { await API.ventaProductoBorrar(id); await cargar(); }
  catch (e) { alert(e.message); }
}

// ---- Reiniciar jornada ----
document.getElementById('btnReiniciar').addEventListener('click', async () => {
  if (!confirm('¿Reiniciar la jornada?\n\nSe descuenta lo vendido de la cantidad, queda registrado en Contabilidad y el conteo de vendido vuelve a cero.')) return;
  try {
    const r = await API.ventasReiniciar(verUsuarioId ? { usuario_id: verUsuarioId } : {});
    alert(`Jornada cerrada.\n\nVenta: ${money(r.total_dinero)}\nCosto: ${money(r.total_costo)}\nGanancia: ${money(r.total_ganancia)}\n\nYa aparece en Contabilidad.`);
    await cargar();
  } catch (e) { alert(e.message); }
});

// ---- Popup agregar producto ----
function abrirModal() {
  mpError.style.display = 'none';
  ['mpNombre', 'mpCantidad', 'mpCosto', 'mpPrecio'].forEach((id) => { document.getElementById(id).value = ''; });
  modalProd.classList.add('abierto');
  document.getElementById('mpNombre').focus();
}
function cerrarModal() { modalProd.classList.remove('abierto'); }

document.getElementById('btnAgregarProd').addEventListener('click', abrirModal);
document.getElementById('mpCancelar').addEventListener('click', cerrarModal);
modalProd.addEventListener('click', (e) => { if (e.target === modalProd) cerrarModal(); });
document.getElementById('mpGuardar').addEventListener('click', async () => {
  mpError.style.display = 'none';
  const nombre = document.getElementById('mpNombre').value.trim();
  if (!nombre) { mpError.style.display = 'block'; mpError.textContent = 'Escriba el nombre del producto.'; return; }
  const datos = {
    nombre,
    unidad: document.getElementById('mpUnidad').value,
    cantidad: Number(document.getElementById('mpCantidad').value) || 0,
    costo_unitario: Number(document.getElementById('mpCosto').value) || 0,
    precio_venta: Number(document.getElementById('mpPrecio').value) || 0,
  };
  if (verUsuarioId) datos.usuario_id = verUsuarioId;
  try { await API.ventaProductoCrear(datos); cerrarModal(); await cargar(); }
  catch (e) { mpError.style.display = 'block'; mpError.textContent = e.message; }
});

// El dueño cambia de vendedor.
selectorVendedor.addEventListener('change', () => {
  verUsuarioId = selectorVendedor.value ? Number(selectorVendedor.value) : null;
  // El carrito es de UN vendedor a la vez: al cambiar de vendedor se vacía,
  // para no mezclar productos de hojas distintas en una misma venta.
  carrito = [];
  renderCarrito();
  cargar();
});

// ============================================================
//  Pestañas: Hoja del día / Catálogo / Historial
// ============================================================
const tabsVentas = document.getElementById('tabsVentas');
const panelesVista = document.querySelectorAll('.panel-vista');

function cambiarVista(panelId) {
  tabsVentas.querySelectorAll('button').forEach((b) => b.classList.toggle('tv-activo', b.dataset.panel === panelId));
  panelesVista.forEach((p) => p.classList.toggle('activo', p.id === panelId));
  if (panelId === 'pHistorial') cargarHistorial();
}
tabsVentas.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => cambiarVista(b.dataset.panel));
});

// ============================================================
//  Catálogo (tarjetas para vender rápido)
// ============================================================
const catalogoGrid = document.getElementById('catalogoGrid');
const catalogoVacio = document.getElementById('catalogoVacio');

const inicialDe = (nombre) => (nombre || '?').trim().charAt(0).toUpperCase();

function renderCatalogo() {
  const disponibles = productosActuales.filter((p) => Number(p.cantidad) > 0);
  if (!disponibles.length) {
    catalogoGrid.innerHTML = '';
    catalogoVacio.style.display = 'block';
    return;
  }
  catalogoVacio.style.display = 'none';
  catalogoGrid.innerHTML = disponibles.map((p) => `
    <div class="cat-tarjeta" data-id="${p.id}" title="Toque para agregar al carrito">
      <div class="cat-img">
        ${p.imagen ? `<img src="${p.imagen}" alt="${p.nombre}">` : `<span class="cat-inicial">${inicialDe(p.nombre)}</span>`}
      </div>
      <div class="cat-nombre">${p.nombre}</div>
      <div class="cat-precio">${money(p.precio_venta)}</div>
      <div class="cat-exist">Existencia: ${p.cantidad} ${p.unidad}</div>
    </div>`).join('');
  catalogoGrid.querySelectorAll('.cat-tarjeta').forEach((el) => {
    el.addEventListener('click', () => agregarAlCarrito(Number(el.dataset.id)));
  });
}

// ============================================================
//  Carrito
// ============================================================
const carritoLista = document.getElementById('carritoLista');
const carritoVacio = document.getElementById('carritoVacio');
const carritoTotalEl = document.getElementById('carritoTotal');
const carritoAviso = document.getElementById('carritoAviso');
let avisoTimeout = null;

function avisarCarrito(msg) {
  carritoAviso.textContent = msg;
  carritoAviso.classList.add('mostrar');
  clearTimeout(avisoTimeout);
  avisoTimeout = setTimeout(() => carritoAviso.classList.remove('mostrar'), 3000);
}

function agregarAlCarrito(id) {
  const prod = productosActuales.find((p) => p.id === id);
  if (!prod) return;
  const linea = carrito.find((l) => l.producto_id === id);
  const enCarritoYa = linea ? linea.cantidad : 0;
  if (enCarritoYa + 1 > Number(prod.cantidad)) {
    avisarCarrito(`No hay más existencia de "${prod.nombre}" (disponible: ${prod.cantidad}).`);
    return;
  }
  if (linea) {
    linea.cantidad += 1;
  } else {
    carrito.push({
      producto_id: id,
      nombre: prod.nombre,
      unidad: prod.unidad,
      precio_venta: Number(prod.precio_venta) || 0,
      existencia: Number(prod.cantidad) || 0,
      cantidad: 1,
    });
  }
  renderCarrito();
}

function cambiarCantidadCarrito(id, delta) {
  const linea = carrito.find((l) => l.producto_id === id);
  if (!linea) return;
  const nueva = linea.cantidad + delta;
  if (nueva <= 0) {
    carrito = carrito.filter((l) => l.producto_id !== id);
    renderCarrito();
    return;
  }
  if (nueva > linea.existencia) {
    avisarCarrito(`Solo hay ${linea.existencia} ${linea.unidad} de "${linea.nombre}" disponibles.`);
    return;
  }
  linea.cantidad = nueva;
  renderCarrito();
}

function renderCarrito() {
  if (!carrito.length) {
    carritoLista.innerHTML = '';
    carritoVacio.style.display = 'block';
    carritoTotalEl.textContent = money(0);
    return;
  }
  carritoVacio.style.display = 'none';
  let total = 0;
  carritoLista.innerHTML = carrito.map((l) => {
    const subtotal = l.cantidad * l.precio_venta;
    total += subtotal;
    return `
      <div class="carrito-linea" data-id="${l.producto_id}">
        <div class="cl-nombre">${l.nombre}</div>
        <div class="cl-cant">
          <button class="cl-btn cl-menos" data-id="${l.producto_id}" title="Quitar uno">−</button>
          <span>${l.cantidad}</span>
          <button class="cl-btn cl-mas" data-id="${l.producto_id}" title="Agregar uno">+</button>
        </div>
        <div class="cl-precio">${money(l.precio_venta)}</div>
        <div class="cl-subtotal">${money(subtotal)}</div>
      </div>`;
  }).join('');
  carritoTotalEl.textContent = money(total);
  carritoLista.querySelectorAll('.cl-menos').forEach((b) => b.addEventListener('click', () => cambiarCantidadCarrito(Number(b.dataset.id), -1)));
  carritoLista.querySelectorAll('.cl-mas').forEach((b) => b.addEventListener('click', () => cambiarCantidadCarrito(Number(b.dataset.id), 1)));
}

document.getElementById('btnCarritoCancelar').addEventListener('click', () => {
  if (!carrito.length) return;
  if (!confirm('¿Vaciar el carrito? Se perderán los productos agregados (no afecta la existencia).')) return;
  carrito = [];
  renderCarrito();
});

// ---- Popup: confirmar pago del carrito ----
const modalPago = document.getElementById('modalPago');
const pgError = document.getElementById('pgError');

function abrirModalPago() {
  if (!carrito.length) { avisarCarrito('El carrito está vacío.'); return; }
  pgError.style.display = 'none';
  document.getElementById('pgCliente').value = '';
  document.getElementById('pgMetodo').value = 'Efectivo';
  modalPago.classList.add('abierto');
}
function cerrarModalPago() { modalPago.classList.remove('abierto'); }

document.getElementById('btnCarritoPagar').addEventListener('click', abrirModalPago);
document.getElementById('pgCancelar').addEventListener('click', cerrarModalPago);
modalPago.addEventListener('click', (e) => { if (e.target === modalPago) cerrarModalPago(); });

document.getElementById('pgConfirmar').addEventListener('click', async () => {
  pgError.style.display = 'none';
  const body = {
    items: carrito.map((l) => ({ producto_id: l.producto_id, cantidad: l.cantidad })),
  };
  const cliente = document.getElementById('pgCliente').value.trim();
  const metodo = document.getElementById('pgMetodo').value;
  if (cliente) body.cliente = cliente;
  if (metodo) body.metodo_pago = metodo;
  if (verUsuarioId) body.usuario_id = verUsuarioId; // el dueño vendiendo por otro vendedor

  try {
    const r = await ventasCarrito(body);
    cerrarModalPago();
    carrito = [];
    renderCarrito();
    await cargar(); // refresca existencia y totales con lo recién vendido
    alert(`Venta registrada.\n\nTotal cobrado: ${money(r.total)}`);
  } catch (e) {
    // No se vacía el carrito: el usuario puede corregir y reintentar.
    pgError.style.display = 'block';
    pgError.textContent = e.message;
  }
});

// ============================================================
//  Historial de ventas
// ============================================================
const historialLista = document.getElementById('historialLista');
const historialVacio = document.getElementById('historialVacio');

async function cargarHistorial() {
  historialVacio.style.display = 'none';
  historialLista.innerHTML = '<p class="ayuda">Cargando historial…</p>';
  try {
    const ventas = await ventasHistorial();
    renderHistorial(ventas || []);
  } catch (e) {
    historialLista.innerHTML = '';
    historialVacio.style.display = 'block';
    historialVacio.textContent = 'No se pudo cargar el historial: ' + e.message;
  }
}

function renderHistorial(ventas) {
  if (!ventas.length) {
    historialLista.innerHTML = '';
    historialVacio.style.display = 'block';
    historialVacio.textContent = 'Todavía no hay ventas registradas.';
    return;
  }
  historialVacio.style.display = 'none';
  historialLista.innerHTML = ventas.map((v) => `
    <div class="hist-tarjeta" data-id="${v.id}">
      <button class="hist-x" data-id="${v.id}" title="Borrar este registro del historial">×</button>
      <div class="hist-cab">
        <span class="hist-fecha">${new Date(v.fecha).toLocaleString('es-CU', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        <span>${v.usuario_nombre || ''}</span>
      </div>
      ${v.cliente ? `<div class="hist-cliente">Cliente: ${v.cliente}</div>` : ''}
      ${v.metodo_pago ? `<div class="hist-metodo">Pago: ${v.metodo_pago}</div>` : ''}
      <table class="hist-tabla">
        <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr></thead>
        <tbody>
          ${(v.productos || []).map((p) => `
            <tr><td>${p.nombre}</td><td>${p.cantidad}</td><td>${money(p.precio_unitario)}</td><td>${money(p.subtotal)}</td></tr>
          `).join('')}
        </tbody>
      </table>
      <div class="hist-total">Total: <b>${money(v.total)}</b></div>
    </div>`).join('');
  historialLista.querySelectorAll('.hist-x').forEach((b) => {
    b.addEventListener('click', () => borrarHistorial(Number(b.dataset.id)));
  });
}

async function borrarHistorial(id) {
  if (!confirm('¿Borrar este registro del historial?\n\nNo devuelve la existencia ni anula la venta: solo lo quita de esta lista.')) return;
  try {
    await ventasHistorialBorrar(id);
    await cargarHistorial();
  } catch (e) {
    alert('No se pudo borrar: ' + e.message);
  }
}

cargar();
