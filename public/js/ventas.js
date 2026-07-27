// ============================================================
//  Ventas del día — Cárnicos M&C (IPV editable)
//
//  Hoja atada al ALMACÉN del vendedor. Columnas: producto, cantidad
//  (existencia), unidad, precio, VENDIDO (editable), total (vendido×
//  precio) y una ✕ para borrar el producto. El total de arriba es la
//  suma de todos los totales. Al pulsar "Reiniciar jornada" se resta
//  lo vendido de la existencia, se registra el dinero, se pone vendido
//  en 0 y los productos que llegan a 0 se borran solos.
// ============================================================

if (!soloRoles(['ventas'])) { throw new Error('sin acceso'); }

let almacenSeleccion = null;   // el dueño puede elegir almacén
let UNIDADES = [];

const hojaBody = document.getElementById('hojaBody');
const tablaHoja = document.getElementById('tablaHoja');
const vacioHoja = document.getElementById('vacioHoja');
const avisoAlmacen = document.getElementById('avisoAlmacen');
const selectorBox = document.getElementById('selectorAlmacenBox');
const selectorAlmacen = document.getElementById('selectorAlmacen');
const modalProd = document.getElementById('modalProd');
const mpError = document.getElementById('mpError');

const money = (n) => Number(n ?? 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n) => Number(n ?? 0).toLocaleString('es-CU', { maximumFractionDigits: 3 });

document.getElementById('fechaHoy').textContent = new Date().toLocaleDateString('es-CU', { weekday: 'long', day: 'numeric', month: 'long' });

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

async function cargarHoja() {
  let data;
  try { data = await API.ventasHoja(almacenSeleccion); }
  catch (e) { vacioHoja.style.display = 'block'; vacioHoja.textContent = 'No se pudo cargar: ' + e.message; return; }

  if (data.requiere_almacen) {
    tablaHoja.style.display = 'none'; vacioHoja.style.display = 'none';
    document.getElementById('cuadreTotal').textContent = '0.00';
    document.getElementById('almacenNombre').textContent = '—';
    if (data.es_jefe) {
      selectorBox.style.display = ''; avisoAlmacen.style.display = 'none';
      selectorAlmacen.innerHTML = '<option value="">Elegir…</option>' +
        (data.almacenes || []).map((a) => `<option value="${a.id}">${a.nombre}</option>`).join('');
    } else {
      avisoAlmacen.style.display = 'block'; selectorBox.style.display = 'none';
    }
    return;
  }

  avisoAlmacen.style.display = 'none';
  document.getElementById('almacenNombre').textContent = data.almacen ? data.almacen.nombre : '—';
  document.getElementById('cuadreTotal').textContent = money(data.total_dinero);

  if (data.es_jefe) {
    selectorBox.style.display = '';
    if (!selectorAlmacen.value && data.almacen) {
      try {
        const alms = await API.almacenes();
        selectorAlmacen.innerHTML = alms.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join('');
        selectorAlmacen.value = String(data.almacen.id);
      } catch {}
    }
  }

  if (!data.productos.length) {
    tablaHoja.style.display = 'none'; vacioHoja.style.display = 'block'; hojaBody.innerHTML = '';
    return;
  }

  vacioHoja.style.display = 'none'; tablaHoja.style.display = '';
  hojaBody.innerHTML = '';
  data.productos.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align:left"><b>${p.nombre}</b></td>
      <td>${fmt(p.existencia)}</td>
      <td>${p.unidad}</td>
      <td>${money(p.precio_venta)}</td>
      <td><input type="number" class="vendido" min="0" step="0.01" value="${p.vendido || ''}" placeholder="0" data-id="${p.producto_id}" data-precio="${p.precio_venta}"></td>
      <td class="tot" data-id="${p.producto_id}">${money(p.total)}</td>
      <td><button class="btn-x" data-id="${p.producto_id}" data-nombre="${p.nombre}" title="Borrar producto">×</button></td>`;
    hojaBody.appendChild(tr);
  });

  // Guardar lo vendido al cambiar; recalcular total de la fila y el cuadre.
  hojaBody.querySelectorAll('input.vendido').forEach((inp) => {
    inp.addEventListener('change', () => guardarVendido(inp));
    inp.addEventListener('input', () => recalcFila(inp));
  });
  hojaBody.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', () => quitar(Number(b.dataset.id), b.dataset.nombre));
  });
}

function recalcFila(inp) {
  const precio = Number(inp.dataset.precio) || 0;
  const vendido = Number(inp.value) || 0;
  const celda = hojaBody.querySelector(`td.tot[data-id="${inp.dataset.id}"]`);
  if (celda) celda.textContent = money(vendido * precio);
  // recalcular cuadre total
  let total = 0;
  hojaBody.querySelectorAll('input.vendido').forEach((i) => { total += (Number(i.value) || 0) * (Number(i.dataset.precio) || 0); });
  document.getElementById('cuadreTotal').textContent = money(total);
}

async function guardarVendido(inp) {
  const vendido = Number(inp.value) || 0;
  const datos = { producto_id: Number(inp.dataset.id), vendido };
  if (esDueno() && almacenSeleccion) datos.almacen_id = almacenSeleccion;
  try { await API.ventasJornada(datos); } catch (e) { alert(e.message); }
}

async function quitar(productoId, nombre) {
  if (!confirm(`¿Borrar "${nombre}" de la lista? Se quita del almacén.`)) return;
  const datos = { producto_id: productoId };
  if (esDueno() && almacenSeleccion) datos.almacen_id = almacenSeleccion;
  try { await API.ventasQuitarProducto(datos); await cargarHoja(); }
  catch (e) { alert(e.message); }
}

// ---- Reiniciar jornada ----
document.getElementById('btnReiniciar').addEventListener('click', async () => {
  if (!confirm('¿Reiniciar la jornada? Se restará lo vendido de la existencia y el conteo de vendido volverá a cero. Los productos que lleguen a cero se borrarán.')) return;
  const datos = {};
  if (esDueno() && almacenSeleccion) datos.almacen_id = almacenSeleccion;
  try {
    const r = await API.ventasReiniciar(datos);
    alert('Jornada reiniciada. Dinero de la jornada: ' + money(r.total_dinero));
    await cargarHoja();
  } catch (e) { alert(e.message); }
});

// ---- Popup agregar producto ----
async function abrirModalProd() {
  mpError.style.display = 'none';
  document.getElementById('mpNombre').value = '';
  document.getElementById('mpCantidad').value = '';
  document.getElementById('mpPrecio').value = '';
  if (!UNIDADES.length) {
    try { UNIDADES = await API.unidades(); } catch { UNIDADES = []; }
  }
  document.getElementById('mpUnidad').innerHTML = UNIDADES.map((u) => `<option value="${u.id}">${u.nombre} (${u.abreviatura})</option>`).join('');
  modalProd.classList.add('abierto');
}
function cerrarModalProd() { modalProd.classList.remove('abierto'); }

document.getElementById('btnAgregarProd').addEventListener('click', abrirModalProd);
document.getElementById('mpCancelar').addEventListener('click', cerrarModalProd);
modalProd.addEventListener('click', (e) => { if (e.target === modalProd) cerrarModalProd(); });
document.getElementById('mpGuardar').addEventListener('click', async () => {
  mpError.style.display = 'none';
  const nombre = document.getElementById('mpNombre').value.trim();
  const cantidad = Number(document.getElementById('mpCantidad').value);
  const unidad_id = Number(document.getElementById('mpUnidad').value) || null;
  const precio_venta = Number(document.getElementById('mpPrecio').value) || 0;
  if (!nombre) { mpError.style.display = 'block'; mpError.textContent = 'Escriba el nombre del producto.'; return; }
  if (!cantidad || cantidad <= 0) { mpError.style.display = 'block'; mpError.textContent = 'Indique la cantidad.'; return; }
  const datos = { nombre, cantidad, unidad_id, precio_venta };
  if (esDueno() && almacenSeleccion) datos.almacen_id = almacenSeleccion;
  try { await API.ventasAgregarProducto(datos); cerrarModalProd(); await cargarHoja(); }
  catch (e) { mpError.style.display = 'block'; mpError.textContent = e.message; }
});

// El dueño cambia de almacén.
selectorAlmacen.addEventListener('change', () => {
  almacenSeleccion = selectorAlmacen.value ? Number(selectorAlmacen.value) : null;
  cargarHoja();
});

cargarHoja();
