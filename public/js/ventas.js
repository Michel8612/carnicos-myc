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

const hojaBody = document.getElementById('hojaBody');
const tablaHoja = document.getElementById('tablaHoja');
const vacioHoja = document.getElementById('vacioHoja');
const selectorBox = document.getElementById('selectorVendedorBox');
const selectorVendedor = document.getElementById('selectorVendedor');
const modalProd = document.getElementById('modalProd');
const mpError = document.getElementById('mpError');

const money = (n) => Number(n ?? 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  cargar();
});

cargar();
