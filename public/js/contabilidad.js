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
    if (b.dataset.panel === 'pGastos') cargarGastos();
    if (b.dataset.panel === 'pNomina') cargarNomina();
    if (b.dataset.panel === 'pTributacion') cargarTributacion();
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
  if (document.getElementById('pGastos').classList.contains('activo')) cargarGastos();
  if (document.getElementById('pNomina').classList.contains('activo')) cargarNomina();
  if (document.getElementById('pTributacion').classList.contains('activo')) cargarTributacion();
});

// ---------- Gastos ----------
const mesActual = () => new Date().toISOString().slice(0, 7); // AAAA-MM, para <input type="month">

let categoriasGastoCache = null; // se pinta una sola vez, viene del backend

// Pinta las tarjetas de "total por moneda" que devuelven /costos/gastos y
// /costos/nomina. Nunca se suman monedas distintas: cada una su tarjeta.
function pintarTotalesPorMoneda(contenedorId, porMoneda, etiquetaCampo) {
  const cont = document.getElementById(contenedorId);
  cont.innerHTML = porMoneda.length
    ? porMoneda.map((f) => `
      <div class="tarjeta c-naranja">
        <div class="n">${money(f.total)} ${esc(f.moneda)}</div>
        <div class="l">${etiquetaCampo} (${f.cantidad} ${f.cantidad === 1 ? 'registro' : 'registros'})</div>
      </div>`).join('')
    : '<p class="sub">Nada registrado todavía en este período.</p>';
}

async function cargarCategoriasGasto() {
  if (categoriasGastoCache) return categoriasGastoCache;
  try { categoriasGastoCache = await API.categoriasGasto(); }
  catch (e) { categoriasGastoCache = []; }
  const sel = document.getElementById('gCategoria');
  sel.innerHTML = categoriasGastoCache.map((c) => `<option value="${esc(c.clave)}">${esc(c.etiqueta)}</option>`).join('');
  return categoriasGastoCache;
}

async function cargarGastos() {
  await cargarCategoriasGasto();
  const mesInput = document.getElementById('gMes');
  if (!mesInput.value) mesInput.value = mesActual();
  const mes = mesInput.value;

  let d;
  try { d = await API.gastos(mes); }
  catch (e) { alert('No se pudieron cargar los gastos: ' + e.message); return; }

  pintarTotalesPorMoneda('gTotalesPorMoneda', d.por_moneda, 'Total gastado');

  const tb = document.getElementById('tbGastos');
  tb.innerHTML = d.filas.length
    ? d.filas.map((f) => `
      <tr>
        <td>${fechaHora(f.fecha)}</td>
        <td class="izq">${esc((categoriasGastoCache.find((c) => c.clave === f.categoria) || {}).etiqueta || f.categoria)}</td>
        <td class="izq">${esc(f.concepto)}</td>
        <td>${money(f.monto)}</td>
        <td>${esc(f.moneda)}</td>
        <td class="izq">${esc(f.nota || '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="vacio">No hay gastos registrados en este mes.</td></tr>';
}

document.getElementById('btnVerGastos').addEventListener('click', cargarGastos);

document.getElementById('btnRegistrarGasto').addEventListener('click', async () => {
  const d = {
    categoria: document.getElementById('gCategoria').value,
    concepto: document.getElementById('gConcepto').value.trim(),
    monto: Number(document.getElementById('gMonto').value),
    moneda: document.getElementById('gMoneda').value,
    nota: document.getElementById('gNota').value.trim() || null,
  };
  if (!d.concepto || !d.monto || d.monto <= 0) {
    alert('Indique concepto y un monto mayor que cero.');
    return;
  }
  try {
    await API.crearGasto(d);
    document.getElementById('gConcepto').value = '';
    document.getElementById('gMonto').value = '';
    document.getElementById('gNota').value = '';
    await cargarGastos();
    await cargarResumen();
  } catch (e) { alert('No se pudo registrar el gasto: ' + e.message); }
});

document.getElementById('btnActualizarTasa').addEventListener('click', async () => {
  const p = document.getElementById('gTasaResultado');
  p.textContent = 'Actualizando...';
  try {
    const r = await API.actualizarTasa();
    const partes = [];
    if (r.tasa != null) partes.push(`Tasa: ${r.tasa}`);
    if (r.fuente) partes.push(`Fuente: ${r.fuente}`);
    if (r.fecha) partes.push(`Fecha: ${r.fecha}`);
    if (r.pendiente) partes.push('Quedó pendiente (no se pudo confirmar del todo).');
    p.textContent = partes.length ? partes.join(' · ') : 'Tasa actualizada.';
  } catch (e) {
    p.textContent = 'No se pudo actualizar la tasa: ' + e.message;
  }
});

// ---------- Nómina ----------
async function cargarNomina() {
  const inputVer = document.getElementById('nPeriodoVer');
  if (!inputVer.value) inputVer.value = mesActual();
  const periodo = inputVer.value;

  let d;
  try { d = await API.nomina(periodo); }
  catch (e) { alert('No se pudo cargar la nómina: ' + e.message); return; }

  pintarTotalesPorMoneda('nTotalesPorMoneda', d.por_moneda, 'Total nómina');

  const tb = document.getElementById('tbNomina');
  tb.innerHTML = d.filas.length
    ? d.filas.map((f) => `
      <tr>
        <td>${fechaHora(f.fecha_pago)}</td>
        <td class="izq"><b>${esc(f.empleado)}</b></td>
        <td class="izq">${esc(f.cargo || '')}</td>
        <td>${money(f.salario)}</td>
        <td>${esc(f.moneda)}</td>
        <td class="izq">${esc(f.nota || '')}</td>
        <td><button class="btn-x" data-id="${f.id}">✕</button></td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="vacio">No hay pagos de nómina en ese período.</td></tr>';

  tb.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('¿Borrar este pago de nómina? También se borra su gasto y su egreso de caja asociados. No se puede deshacer.')) return;
      try {
        await API.borrarNomina(Number(b.dataset.id));
        await cargarNomina();
        await cargarResumen();
      } catch (e) { alert(e.message); }
    });
  });
}

document.getElementById('btnVerNomina').addEventListener('click', cargarNomina);

document.getElementById('btnRegistrarNomina').addEventListener('click', async () => {
  const d = {
    empleado: document.getElementById('nEmpleado').value.trim(),
    cargo: document.getElementById('nCargo').value.trim() || null,
    salario: Number(document.getElementById('nSalario').value),
    periodo: document.getElementById('nPeriodo').value || undefined,
    moneda: document.getElementById('nMoneda').value,
    nota: document.getElementById('nNota').value.trim() || null,
  };
  if (!d.empleado) { alert('Indique el nombre del empleado.'); return; }
  if (!d.salario || d.salario <= 0) { alert('El salario debe ser mayor que cero.'); return; }
  try {
    await API.crearNomina(d);
    document.getElementById('nEmpleado').value = '';
    document.getElementById('nCargo').value = '';
    document.getElementById('nSalario').value = '';
    document.getElementById('nNota').value = '';
    await cargarNomina();
    await cargarResumen();
  } catch (e) { alert('No se pudo registrar la nómina: ' + e.message); }
});

// ---------- Tributación (estimado, a partir de lo ya registrado) ----------
let regimenesTributariosCache = null; // se llena una vez con GET /tributacion/regimenes

// Muestra u oculta los campos de fecha según el período elegido.
document.getElementById('tPeriodo').addEventListener('change', () => {
  const esRango = document.getElementById('tPeriodo').value === 'rango';
  document.getElementById('tRangoDesdeWrap').classList.toggle('oculto', !esRango);
  document.getElementById('tRangoHastaWrap').classList.toggle('oculto', !esRango);
});

// Guarda el tipo de empresa elegido (para no tener que escogerlo cada
// vez) llamando directamente a apiFetch: no es un método de API.* porque
// api.js no se toca en este módulo, pero apiFetch ya está disponible en
// el ámbito global (ambos scripts se cargan como <script> clásico).
document.getElementById('tTipoEmpresa').addEventListener('change', async () => {
  const tipo_empresa = document.getElementById('tTipoEmpresa').value;
  try { await apiFetch('/contabilidad/tributacion/tipo-empresa', { method: 'PUT', body: JSON.stringify({ tipo_empresa }) }); }
  catch (e) { /* si falla el guardado, no impide seguir viendo el cálculo */ }
  await cargarTributacion();
});

document.getElementById('btnCalcularTributacion').addEventListener('click', cargarTributacion);

const nombreBase = (b) => ({
  utilidad_neta: 'Utilidad neta',
  ventas_brutas: 'Ventas brutas',
  nomina: 'Nómina',
}[b] || b);

async function cargarTributacion() {
  // Primero, los regímenes vigentes (una sola vez): sirve para
  // inicializar el selector de tipo de empresa con lo ya guardado y
  // para mostrar el aviso legal tal como lo define el backend.
  if (!regimenesTributariosCache) {
    try {
      regimenesTributariosCache = await API.regimenesTributarios();
      document.getElementById('tTipoEmpresa').value = regimenesTributariosCache.tipo_empresa_actual || 'microempresa';
      document.getElementById('tribAvisoLegal').textContent = regimenesTributariosCache.aviso_legal;
    } catch (e) { /* si falla, seguimos con los valores por defecto del HTML */ }
  }

  const periodo = document.getElementById('tPeriodo').value;
  const params = { periodo, tipo_empresa: document.getElementById('tTipoEmpresa').value };
  if (periodo === 'rango') {
    params.desde = document.getElementById('tDesde').value;
    params.hasta = document.getElementById('tHasta').value;
    if (!params.desde || !params.hasta) {
      alert('Elija las dos fechas del rango personalizado.');
      return;
    }
  }

  let d;
  try { d = await API.tributacion(params); }
  catch (e) { alert('No se pudo calcular la tributación: ' + e.message); return; }

  document.getElementById('tVentasBrutas').textContent = money(d.ventas_brutas);
  document.getElementById('tGastosDeducibles').textContent = money(d.gastos_deducibles.total);
  document.getElementById('tUtilidadNeta').textContent = money(d.utilidad_neta);
  document.getElementById('tBaseImponible').textContent = money(d.base_imponible);
  document.getElementById('tTotalTributar').textContent = money(d.total_tributos);
  document.getElementById('tribRegimenNombre').textContent = d.resumen.regimen_nombre;
  document.getElementById('tribResumenPeriodo').textContent =
    `Período: ${esc(d.resumen.periodo)} · del ${d.resumen.desde} al ${d.resumen.hasta}`;

  const tbT = document.getElementById('tbTributos');
  tbT.innerHTML = d.tributos.length
    ? d.tributos.map((t) => `
      <tr>
        <td class="izq"><b>${esc(t.nombre)}</b>${t.sobrescrito ? ' <span class="etq e-gasto" title="Porcentaje corregido a mano en Parámetros">editado</span>' : ''}</td>
        <td>${esc(nombreBase(t.base))}</td>
        <td>${money(t.base_valor)}</td>
        <td>${t.porcentaje}%</td>
        <td>${money(t.importe)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="vacio">Sin tributos configurados.</td></tr>';

  const tbG = document.getElementById('tbGastosCategoria');
  tbG.innerHTML = d.gastos_deducibles.por_categoria.length
    ? d.gastos_deducibles.por_categoria.map((g) => `
      <tr><td class="izq">${esc(g.categoria)}</td><td>${money(g.total)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="vacio">No hay gastos registrados en este período.</td></tr>';

  const ul = document.getElementById('tribAdvertencias');
  ul.innerHTML = d.advertencias.length
    ? d.advertencias.map((a) => `<li>${esc(a)}</li>`).join('')
    : '<li>Sin advertencias.</li>';
}

cargarResumen();
