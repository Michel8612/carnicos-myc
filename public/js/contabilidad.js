// ============================================================
//  Contabilidad — Cárnicos M&C
//
//  El contador ve TODO desde aquí:
//   · Almacén: existencias con costo, valor de venta y ganancia
//   · Ventas: lo de cada vendedor con cantidad, costo y ganancia
//   · Libro: historial con fecha y hora, que se guarda por tiempo
//     indefinido y solo se borra si él lo decide (línea por línea
//     o por lotes)
//   · Movimientos del almacén, con su valor
//
//  Solo mira: no puede cambiar nada del negocio. El dueño sí.
// ============================================================

if (!soloRoles(['contabilidad'])) { throw new Error('sin acceso'); }

const money = (n) => Number(n ?? 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => Number(n ?? 0).toLocaleString('es-CU', { maximumFractionDigits: 3 });
const gan = (n) => `<span class="${Number(n) >= 0 ? 'g-pos' : 'g-neg'}">${money(n)}</span>`;
const fechaHora = (f) => {
  if (!f) return '';
  const d = new Date(f);
  return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
};
const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
// Mover mercancía (almacén) o producirla (cocina) no es gasto ni ganancia:
// solo cambia de forma. Esas líneas se muestran como informativas.
const esInformativo = (f) => f.tipo === 'almacen' || f.tipo === 'produccion';

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

// ---------- Pestañas ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('activo'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('activo'));
    b.classList.add('activo');
    document.getElementById(b.dataset.panel).classList.add('activo');
    if (b.dataset.panel === 'pLibro') cargarLibro();
    if (b.dataset.panel === 'pMovs') cargarMovimientos();
  });
});

// ---------- Resumen: almacén + ventas + totales ----------
async function cargarResumen() {
  let d;
  try { d = await API.contabResumen(); }
  catch (e) { alert('No se pudo cargar: ' + e.message); return; }

  // Tarjetas generales
  document.getElementById('kIngreso').textContent = money(d.historico.ingreso);
  document.getElementById('kCosto').textContent = money(d.historico.costo);
  document.getElementById('kGanancia').textContent = money(d.historico.ganancia);
  document.getElementById('kGastos').textContent = money(d.gastos_total);
  document.getElementById('kResultado').textContent = money(d.resultado);
  document.getElementById('kHoy').textContent = money(d.historico.ganancia_hoy);

  // --- Almacén ---
  document.getElementById('aCosto').textContent = money(d.almacen.valor_costo);
  document.getElementById('aVenta').textContent = money(d.almacen.valor_venta);
  document.getElementById('aGanancia').textContent = money(d.almacen.ganancia_potencial);
  document.getElementById('aProductos').textContent = d.almacen.total_productos;

  const tbA = document.getElementById('tbAlmacen');
  tbA.innerHTML = d.almacen.filas.length
    ? d.almacen.filas.map((f) => `
      <tr>
        <td class="izq"><b>${esc(f.nombre)}</b></td>
        <td>${esc(f.tipo === 'materia_prima' ? 'Materia prima' : f.tipo === 'terminado' ? 'Terminado' : 'Reventa')}</td>
        <td>${esc(f.almacen)}</td>
        <td>${num(f.cantidad)}</td>
        <td>${esc(f.unidad)}</td>
        <td>${money(f.costo_unitario)}</td>
        <td>${money(f.precio_venta)}</td>
        <td>${money(f.valor_costo)}</td>
        <td>${f.precio_venta > 0 ? money(f.valor_venta) : '—'}</td>
        <td>${f.ganancia_potencial === null ? '<span style="color:#999">no se vende</span>' : gan(f.ganancia_potencial)}</td>
      </tr>`).join('')
    : '<tr><td colspan="10" class="vacio">No hay existencias en el almacén.</td></tr>';

  // --- Ventas ---
  document.getElementById('vIngreso').textContent = money(d.ventas.ingreso_jornada);
  document.getElementById('vCosto').textContent = money(d.ventas.costo_jornada);
  document.getElementById('vGanancia').textContent = money(d.ventas.ganancia_jornada);
  document.getElementById('vExist').textContent = money(d.ventas.valor_existencia);

  const tbV = document.getElementById('tbVentas');
  tbV.innerHTML = d.ventas.filas.length
    ? d.ventas.filas.map((f) => `
      <tr>
        <td class="izq">${esc(f.vendedor)}</td>
        <td class="izq"><b>${esc(f.nombre)}</b></td>
        <td>${num(f.cantidad)}</td>
        <td>${esc(f.unidad)}</td>
        <td>${money(f.costo_unitario)}</td>
        <td>${money(f.precio_venta)}</td>
        <td>${num(f.vendido)}</td>
        <td>${money(f.total)}</td>
        <td>${gan(f.ganancia)}</td>
        <td>${money(f.valor_existencia)}</td>
      </tr>`).join('')
    : '<tr><td colspan="10" class="vacio">No hay productos en el área de ventas.</td></tr>';
}

// ---------- Libro (historial permanente) ----------
function filtrosActuales() {
  return {
    tipo: document.getElementById('fTipo').value,
    desde: document.getElementById('fDesde').value,
    hasta: document.getElementById('fHasta').value,
  };
}

async function cargarLibro() {
  let d;
  try { d = await API.contabLibro(filtrosActuales()); }
  catch (e) { alert('No se pudo cargar el libro: ' + e.message); return; }

  const tb = document.getElementById('tbLibro');
  tb.innerHTML = d.filas.length
    ? d.filas.map((f) => `
      <tr>
        <td>${fechaHora(f.fecha)}</td>
        <td><span class="etq e-${esc(f.tipo)}">${esc(f.tipo)}</span></td>
        <td class="izq">${esc(f.concepto)}</td>
        <td>${num(f.cantidad)} ${esc(f.unidad || '')}</td>
        <td>${esInformativo(f) ? `<span style="color:#888" title="Movimiento de mercancía: no es gasto ni ganancia">${money(f.valor)} (mercancía)</span>` : money(f.costo)}</td>
        <td>${money(f.ingreso)}</td>
        <td>${esInformativo(f) ? '<span style="color:#999">—</span>' : gan(f.ganancia)}</td>
        <td>${esc(f.usuario_nombre || '')}</td>
        <td><button class="btn-x" data-id="${f.id}">Eliminar</button></td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="vacio">No hay apuntes con ese filtro.</td></tr>';

  document.getElementById('lCosto').textContent = money(d.totales.costo);
  document.getElementById('lIngreso').textContent = money(d.totales.ingreso);
  document.getElementById('lGanancia').textContent = money(d.totales.ganancia);

  tb.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este apunte del libro? No se puede deshacer.')) return;
      try { await API.contabBorrarLinea(Number(b.dataset.id)); await cargarLibro(); await cargarResumen(); }
      catch (e) { alert(e.message); }
    });
  });
}

document.getElementById('btnFiltrar').addEventListener('click', cargarLibro);
document.getElementById('btnBorrarLote').addEventListener('click', async () => {
  const f = filtrosActuales();
  if (f.tipo === 'todos' && !f.desde && !f.hasta) {
    alert('Elija primero un tipo o un rango de fechas: así no se borra todo por error.');
    return;
  }
  if (!confirm('¿Eliminar TODOS los apuntes que coinciden con el filtro? No se puede deshacer.')) return;
  try {
    const r = await API.contabBorrarVarias(f);
    alert(`Se eliminaron ${r.borrados} apuntes.`);
    await cargarLibro(); await cargarResumen();
  } catch (e) { alert(e.message); }
});

// ---------- Movimientos del almacén ----------
async function cargarMovimientos() {
  let filas;
  try { filas = await API.contabMovimientos(); }
  catch (e) { alert('No se pudieron cargar los movimientos: ' + e.message); return; }

  document.getElementById('tbMovs').innerHTML = filas.length
    ? filas.map((m) => `
      <tr>
        <td>${fechaHora(m.fecha)}</td>
        <td><span class="etq e-${m.tipo === 'entrada' ? 'venta' : 'almacen'}">${esc(m.tipo)}</span></td>
        <td class="izq"><b>${esc(m.producto)}</b></td>
        <td>${num(m.cantidad)}</td>
        <td>${esc(m.unidad)}</td>
        <td>${money(m.costo_unitario)}</td>
        <td>${money(m.valor)}</td>
        <td>${esc(m.almacen || '')}</td>
        <td>${esc(m.usuario || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="vacio">Todavía no hay movimientos de almacén.</td></tr>';
}

document.getElementById('btnActualizar').addEventListener('click', (e) => {
  e.preventDefault();
  cargarResumen();
  if (document.getElementById('pLibro').classList.contains('activo')) cargarLibro();
  if (document.getElementById('pMovs').classList.contains('activo')) cargarMovimientos();
});

cargarResumen();
