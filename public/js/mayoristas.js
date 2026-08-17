// ============================================================
//  VENTAS MAYORISTAS — el IPV del almacén
//
//  Funciona como una calculadora: se escribe cantidad y precio de cada
//  producto, se ve el total de cada línea y el total general, y al vender
//  la mercancía sale del almacén de verdad.
//
//  Quién entra: dueño y contabilidad. El almacenero NO, aunque el botón
//  esté en su pantalla: esto es poner precios y cobrar, y a él los precios
//  se le ocultan a propósito. El servidor lo rechaza igual (403), así que
//  esta guarda es comodidad, no la protección.
// ============================================================

if (!soloRoles(['contabilidad'])) { throw new Error('sin acceso'); }

const money = (n) => Number(n || 0).toLocaleString('es-ES', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const num = (n) => Number(n || 0).toLocaleString('es-ES', { maximumFractionDigits: 3 });
const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Los productos tal como los devolvió el servidor, con lo que el usuario
// va escribiendo encima. No se toca la ficha del producto: el precio de
// esta venta puede ser otro y eso no debe cambiarle el precio de catálogo.
let productos = [];

// ------------------------------------------------------------
//  Cargar almacenes y productos
// ------------------------------------------------------------
async function cargarAlmacenes() {
  const sel = document.getElementById('selAlmacen');
  try {
    const r = await API.almacenes();
    const lista = r.almacenes || r || [];
    sel.innerHTML = lista.map((a) => `<option value="${a.id}">${esc(a.nombre)}</option>`).join('')
      || '<option value="">No hay almacenes</option>';

    // El servidor los devuelve por nombre, así que el primero acaba siendo
    // el de algún almacenero. La venta mayorista sale del almacén de la
    // casa, no del de una persona: se preselecciona el más antiguo de los
    // que no son de nadie (usuario_id vacío). Si los renombran, sigue
    // funcionando; si algún día no hay ninguno, queda el primero.
    const deLaCasa = lista.filter((a) => !a.usuario_id);
    if (deLaCasa.length) {
      sel.value = deLaCasa.reduce((m, a) => (a.id < m.id ? a : m)).id;
    }
  } catch (e) {
    sel.innerHTML = '<option value="">No se pudieron cargar</option>';
  }
}

async function cargarProductos() {
  const tb = document.getElementById('tbProductos');
  const almacenId = document.getElementById('selAlmacen').value;
  tb.innerHTML = '<tr><td colspan="7" class="vacio">Cargando…</td></tr>';

  try {
    productos = await API.mayoristasProductos(almacenId);
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="7" class="vacio">${esc(e.message)}</td></tr>`;
    return;
  }

  if (!productos.length) {
    tb.innerHTML = '<tr><td colspan="7" class="vacio">Este almacén no tiene existencias.</td></tr>';
    recalcular();
    return;
  }

  // El precio se propone con el de venta del producto; si no tiene, con su
  // costo, para no dejar la casilla en cero y que se venda regalado por
  // descuido.
  tb.innerHTML = productos.map((p, i) => {
    const propuesto = p.precio_sugerido > 0 ? p.precio_sugerido : p.costo;
    return `<tr data-i="${i}">
      <td class="izq"><b>${esc(p.nombre)}</b></td>
      <td>${esc(p.unidad)}</td>
      <td>${num(p.existencia)}</td>
      <td>${money(p.costo)}</td>
      <td><input type="number" step="0.01" min="0" data-c="precio" value="${propuesto.toFixed(2)}"></td>
      <td><input type="number" step="0.001" min="0" max="${p.existencia}" data-c="cantidad" placeholder="0"></td>
      <td class="subtotal">0.00</td>
    </tr>`;
  }).join('');

  recalcular();
}

// ------------------------------------------------------------
//  La calculadora
// ------------------------------------------------------------
function recalcular() {
  const filas = document.querySelectorAll('#tbProductos tr[data-i]');
  let total = 0, costo = 0, enVenta = 0;

  filas.forEach((tr) => {
    const p = productos[Number(tr.dataset.i)];
    if (!p) return;
    const cantidad = parseFloat(tr.querySelector('[data-c="cantidad"]').value) || 0;
    const precio = parseFloat(tr.querySelector('[data-c="precio"]').value) || 0;
    const subtotal = cantidad * precio;

    tr.querySelector('.subtotal').textContent = money(subtotal);
    tr.classList.toggle('en-venta', cantidad > 0);

    // Se avisa en rojo si pide más de lo que hay, en vez de dejar que lo
    // descubra al pulsar Vender y le rebote toda la venta.
    tr.classList.toggle('sin-stock', cantidad > p.existencia);

    if (cantidad > 0) {
      enVenta += 1;
      total += subtotal;
      costo += cantidad * p.costo;
    }
  });

  document.getElementById('granTotal').textContent = money(total);
  document.getElementById('resTotal').textContent = money(total);
  document.getElementById('resCosto').textContent = money(costo);
  document.getElementById('resGanancia').textContent = money(total - costo);
  document.getElementById('resProductos').textContent = enVenta;

  const haySinStock = document.querySelectorAll('#tbProductos tr.sin-stock').length > 0;
  document.getElementById('btnVender').disabled = enVenta === 0 || haySinStock;
}

document.getElementById('tbProductos').addEventListener('input', recalcular);
document.getElementById('selAlmacen').addEventListener('change', cargarProductos);
document.getElementById('btnRecargar').addEventListener('click', cargarProductos);

document.getElementById('btnLimpiar').addEventListener('click', () => {
  document.querySelectorAll('#tbProductos [data-c="cantidad"]').forEach((i) => { i.value = ''; });
  document.getElementById('cliente').value = '';
  document.getElementById('nota').value = '';
  recalcular();
});

// ------------------------------------------------------------
//  Vender
// ------------------------------------------------------------
document.getElementById('btnVender').addEventListener('click', async () => {
  const lineas = [];
  document.querySelectorAll('#tbProductos tr[data-i]').forEach((tr) => {
    const p = productos[Number(tr.dataset.i)];
    const cantidad = parseFloat(tr.querySelector('[data-c="cantidad"]').value) || 0;
    const precio = parseFloat(tr.querySelector('[data-c="precio"]').value) || 0;
    if (cantidad > 0) lineas.push({ producto_id: p.id, cantidad, precio_unitario: precio });
  });

  if (!lineas.length) { alert('No hay nada que vender: escriba alguna cantidad.'); return; }

  const total = document.getElementById('resTotal').textContent;
  const moneda = (document.getElementById('moneda').value || 'CUP').toUpperCase();
  if (!confirm(
    `Se van a vender ${lineas.length} producto(s) por ${total} ${moneda}.\n\n`
    + 'La mercancía saldrá del almacén y el cobro entrará a Contabilidad.\n\n¿Confirmar?')) return;

  try {
    const r = await API.mayoristasVender({
      almacen_id: Number(document.getElementById('selAlmacen').value),
      cliente: document.getElementById('cliente').value.trim() || undefined,
      forma_pago: document.getElementById('formaPago').value,
      moneda,
      nota: document.getElementById('nota').value.trim() || undefined,
      lineas,
    });
    alert(`Venta registrada.\n\nTotal: ${money(r.total)} ${r.moneda}\n`
        + `Costo: ${money(r.costo_total)}\nGanancia: ${money(r.ganancia)}\n\n`
        + 'Ya salió del almacén y está en Contabilidad.');
    document.getElementById('cliente').value = '';
    document.getElementById('nota').value = '';
    await cargarProductos();     // las existencias cambiaron
    await verHistorial();
  } catch (e) {
    // El servidor devuelve `faltantes` cuando no alcanza la existencia:
    // se enseña tal cual, que dice producto por producto qué falta.
    alert(e.message);
  }
});

// ------------------------------------------------------------
//  Historial
// ------------------------------------------------------------
async function verHistorial() {
  const cont = document.getElementById('historial');
  const params = {};
  const d = document.getElementById('hDesde').value;
  const h = document.getElementById('hHasta').value;
  const c = document.getElementById('hCliente').value.trim();
  if (d) params.desde = d;
  if (h) params.hasta = h;
  if (c) params.cliente = c;

  cont.innerHTML = '<div class="vacio">Cargando…</div>';
  let r;
  try { r = await API.mayoristasHistorial(params); }
  catch (e) { cont.innerHTML = `<div class="vacio">${esc(e.message)}</div>`; return; }

  document.getElementById('hVentas').textContent = r.totales.ventas;
  document.getElementById('hTotal').textContent = money(r.totales.total);
  document.getElementById('hGanancia').textContent = money(r.totales.ganancia);

  if (!r.ventas.length) {
    cont.innerHTML = '<div class="vacio">Todavía no hay ventas mayoristas registradas.</div>';
    return;
  }

  cont.innerHTML = r.ventas.map((v) => {
    const fecha = new Date(v.fecha).toLocaleString('es-CU');
    const lineas = (v.lineas || []).map((l) =>
      `<li>${esc(l.producto_nombre)}: ${num(l.cantidad)} ${esc(l.unidad || '')} × ${money(l.precio_unitario)} = <b>${money(l.subtotal)}</b></li>`,
    ).join('');
    // El botón de borrar solo se pinta para el dueño; el servidor lo
    // vuelve a comprobar de todos modos.
    const borrar = esDueno()
      ? `<button class="btn-x" data-borrar="${v.id}" title="Borrar del historial">✕</button>`
      : '';
    return `<div class="hist-venta">
      <div class="hist-cab">
        <b>${money(v.total)} ${esc(v.moneda)}</b>
        <span class="hist-meta">
          ${fecha} · ${esc(v.almacen_nombre || '')}
          ${v.cliente ? ' · Cliente: ' + esc(v.cliente) : ''}
          · ${esc(v.forma_pago)} · ganancia ${money(v.ganancia)}
          · ${esc(v.usuario_nombre || '')}
        </span>
        ${borrar}
      </div>
      <ul class="hist-lineas">${lineas}</ul>
      ${v.nota ? `<div class="hist-meta">Nota: ${esc(v.nota)}</div>` : ''}
    </div>`;
  }).join('');
}

document.getElementById('btnVerHistorial').addEventListener('click', verHistorial);

document.getElementById('historial').addEventListener('click', async (ev) => {
  const id = ev.target.dataset && ev.target.dataset.borrar;
  if (!id) return;
  if (!confirm(
    '¿Borrar esta venta del historial?\n\n'
    + 'OJO: la mercancía NO vuelve al almacén y el cobro sigue registrado. '
    + 'Esto solo limpia el historial.')) return;
  const motivo = prompt('Motivo (queda en la auditoría):', '');
  try {
    const r = await API.mayoristasBorrar(Number(id), motivo || undefined);
    alert(r.aviso || 'Borrado del historial.');
    await verHistorial();
  } catch (e) { alert('No se pudo borrar: ' + e.message); }
});

// ---- Carga inicial ----
(async () => {
  await cargarAlmacenes();
  await cargarProductos();
  await verHistorial();
})();
