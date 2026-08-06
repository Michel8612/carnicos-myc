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

// ---------- Selector de área (punto de venta / almacén concreto / cocina) ----------
// Pedido del cliente: poder elegir qué área se está viendo. Afecta a los
// listados donde tiene sentido (Almacén del resumen y Movimientos de
// almacén); Ventas ya ES el punto de venta, así que no se filtra aparte.
// Se usa apiFetch directamente (como ya se hace en este archivo para
// /costos/categorias y otras rutas sin método propio en API.*) para poder
// mandar la query string con origen/almacen_id sin tocar public/js/api.js.
function origenQueryString() {
  const origen = document.getElementById('selOrigen').value;
  const almacenId = document.getElementById('selAlmacenId').value;
  const params = new URLSearchParams();
  if (origen) params.set('origen', origen);
  if (origen === 'almacen' && almacenId) params.set('almacen_id', almacenId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// Llena el <select> de almacenes una sola vez, con los almacenes vistos en
// la primera carga SIN filtrar (para que aparezcan todos, no solo los del
// filtro actual).
function poblarSelectorAlmacenes(filasAlmacen) {
  const sel = document.getElementById('selAlmacenId');
  if (sel.dataset.poblado) return;
  const vistos = new Map();
  filasAlmacen.forEach((f) => { if (f.almacen_id && !vistos.has(f.almacen_id)) vistos.set(f.almacen_id, f.almacen); });
  if (!vistos.size) return; // todavía no hay datos: se intenta de nuevo en la próxima carga
  sel.innerHTML = [...vistos.entries()].map(([id, nombre]) => `<option value="${id}">${esc(nombre)}</option>`).join('');
  sel.dataset.poblado = '1';
}

function mensajeSinDatosAlmacen() {
  const origen = document.getElementById('selOrigen').value;
  if (origen === 'venta') return 'El punto de venta no tiene existencias de almacén propias: véalas en la pestaña "Ventas".';
  if (origen === 'cocina') return 'No hay existencias en ningún almacén llamado "Cocina".';
  if (origen === 'almacen') return 'No hay existencias para el almacén seleccionado.';
  return 'No hay existencias en el almacén.';
}

function mensajeSinDatosMovs() {
  const origen = document.getElementById('selOrigen').value;
  if (origen === 'venta') return 'El punto de venta no genera movimientos de almacén.';
  if (origen === 'cocina') return 'No hay movimientos en ningún almacén llamado "Cocina".';
  if (origen === 'almacen') return 'No hay movimientos para el almacén seleccionado.';
  return 'Todavía no hay movimientos de almacén.';
}

document.getElementById('selOrigen').addEventListener('change', () => {
  const esAlmacen = document.getElementById('selOrigen').value === 'almacen';
  document.getElementById('wrapAlmacenId').classList.toggle('oculto', !esAlmacen);
  cargarResumen();
  if (document.getElementById('pMovs').classList.contains('activo')) cargarMovimientos();
});
document.getElementById('selAlmacenId').addEventListener('change', () => {
  cargarResumen();
  if (document.getElementById('pMovs').classList.contains('activo')) cargarMovimientos();
});

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
    if (b.dataset.panel === 'pDinero') cargarDinero();
    if (b.dataset.panel === 'pMargenes') cargarMargenes();
    if (b.dataset.panel === 'pTributacion') cargarTributacion();
  });
});

// ---------- Resumen: almacén + ventas + totales ----------
async function cargarResumen() {
  let d;
  try { d = await apiFetch(`/contabilidad/resumen${origenQueryString()}`); }
  catch (e) { alert('No se pudo cargar: ' + e.message); return; }

  // La primera carga (sin filtro de área todavía elegido) sirve para
  // llenar el selector de almacenes con todos los que existan.
  if (!document.getElementById('selOrigen').value) poblarSelectorAlmacenes(d.almacen.filas);

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
    : `<tr><td colspan="10" class="vacio">${esc(mensajeSinDatosAlmacen())}</td></tr>`;

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
        <td><button class="btn-x" data-id="${f.id}" title="Eliminar apunte del libro">✕</button></td>
      </tr>`).join('')
    : '<tr><td colspan="9" class="vacio">No hay apuntes con ese filtro.</td></tr>';

  document.getElementById('lCosto').textContent = money(d.totales.costo);
  document.getElementById('lIngreso').textContent = money(d.totales.ingreso);
  document.getElementById('lGanancia').textContent = money(d.totales.ganancia);

  tb.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', () => borrarLineaLibro(Number(b.dataset.id)));
  });
}

// ---------- Borrado del libro: dueño/admin directo, contabilidad con
// permiso prestado de un administrador (reautenticación). ----------
const rolEsAdmin = () => ['dueno', 'admin', 'proveedor'].includes((getUsuario() || {}).rol);

async function pedirAutorizacionAdmin() {
  const usuario = prompt('Para borrar del libro hace falta autorización de un administrador.\nUsuario del administrador:');
  if (!usuario || !usuario.trim()) return null;
  const clave = prompt('Contraseña del administrador:');
  if (!clave) return null;
  try {
    const r = await API.reautenticar(usuario.trim(), clave);
    // POST /auth/reautenticar devuelve { tokenAutorizacion, expiraEn, autorizadoPor }.
    const token = r && r.tokenAutorizacion;
    if (!token) { alert('El servidor no devolvió un permiso de autorización utilizable.'); return null; }
    return token;
  } catch (e) {
    alert('No se pudo autorizar: ' + e.message);
    return null;
  }
}

async function borrarLineaLibro(id) {
  if (!confirm('¿Eliminar este apunte del libro? No se puede deshacer.')) return;
  const motivo = prompt('Motivo del borrado (obligatorio):');
  if (!motivo || !motivo.trim()) { alert('Debe indicar un motivo.'); return; }
  try {
    if (rolEsAdmin()) {
      await apiFetch(`/contabilidad/libro/${id}`, { method: 'DELETE', body: JSON.stringify({ motivo: motivo.trim() }) });
    } else {
      const autorizacion = await pedirAutorizacionAdmin();
      if (!autorizacion) return;
      await API.borrarLibroAutorizado({ ids: [id], motivo: motivo.trim(), autorizacion });
    }
    await cargarLibro(); await cargarResumen();
  } catch (e) { alert(e.message); }
}

document.getElementById('btnFiltrar').addEventListener('click', cargarLibro);
document.getElementById('btnBorrarLote').addEventListener('click', async () => {
  const f = filtrosActuales();
  if (f.tipo === 'todos' && !f.desde && !f.hasta) {
    alert('Elija primero un tipo o un rango de fechas: así no se borra todo por error.');
    return;
  }
  if (!confirm('¿Eliminar TODOS los apuntes que coinciden con el filtro? No se puede deshacer.')) return;
  const motivo = prompt('Motivo del borrado (obligatorio):');
  if (!motivo || !motivo.trim()) { alert('Debe indicar un motivo.'); return; }
  try {
    let r;
    if (rolEsAdmin()) {
      r = await API.contabBorrarVarias({ ...f, motivo: motivo.trim() });
    } else {
      const autorizacion = await pedirAutorizacionAdmin();
      if (!autorizacion) return;
      r = await API.borrarLibroAutorizado({ ...f, motivo: motivo.trim(), autorizacion });
    }
    alert(`Se eliminaron ${r.borrados} apuntes.`);
    await cargarLibro(); await cargarResumen();
  } catch (e) { alert(e.message); }
});

// ---------- Movimientos del almacén ----------
async function cargarMovimientos() {
  let filas;
  try { filas = await apiFetch(`/contabilidad/movimientos${origenQueryString()}`); }
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
    : `<tr><td colspan="9" class="vacio">${esc(mensajeSinDatosMovs())}</td></tr>`;
}

document.getElementById('btnActualizar').addEventListener('click', (e) => {
  e.preventDefault();
  cargarResumen();
  if (document.getElementById('pLibro').classList.contains('activo')) cargarLibro();
  if (document.getElementById('pMovs').classList.contains('activo')) cargarMovimientos();
  if (document.getElementById('pGastos').classList.contains('activo')) cargarGastos();
  if (document.getElementById('pNomina').classList.contains('activo')) cargarNomina();
  // La pestaña de Tributación se retiró de la vista: si no está en el HTML,
  // no hay nada que recargar. Sin esta comprobación, getElementById devuelve
  // null y el punto siguiente tumbaba el botón "Actualizar" entero.
  const panelTrib = document.getElementById('pTributacion');
  if (panelTrib && panelTrib.classList.contains('activo')) cargarTributacion();
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
  // "Nómina" NO se ofrece aquí, aunque la categoría siga existiendo. Los pagos
  // de nómina se registran en su propia pestaña, y esa pestaña YA crea el gasto
  // correspondiente por dentro. Si además se pudiera teclear a mano como gasto
  // suelto, el mismo sueldo entraría dos veces y el resultado del negocio
  // saldría más bajo de lo real. Por eso se filtra de la lista, en vez de
  // borrar la categoría: el historial de gastos viejos la sigue necesitando
  // para mostrar su etiqueta.
  const paraElegir = categoriasGastoCache.filter((c) => c.clave !== 'nomina');
  sel.innerHTML = paraElegir.map((c) => `<option value="${esc(c.clave)}">${esc(c.etiqueta)}</option>`).join('');
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
        <td><button class="btn-x" data-id="${f.id}" title="Eliminar gasto">✕</button></td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="vacio">No hay gastos registrados en este mes.</td></tr>';

  tb.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este gasto? También se elimina su egreso de caja asociado. No se puede deshacer.')) return;
      const motivo = prompt('Motivo del borrado (obligatorio):');
      if (!motivo || !motivo.trim()) { alert('Debe indicar un motivo.'); return; }
      try {
        await API.borrarGasto(Number(b.dataset.id), motivo.trim());
        await cargarGastos();
        await cargarResumen();
      } catch (e) { alert('No se pudo borrar: ' + e.message); }
    });
  });

  await cargarCategoriasAdmin();
}

document.getElementById('btnVerGastos').addEventListener('click', cargarGastos);

// ---------- Categorías de gasto (ver, crear, desactivar) ----------
async function cargarCategoriasAdmin() {
  let filas;
  try { filas = await apiFetch('/costos/categorias?todas=1'); }
  catch (e) { document.getElementById('tbCategorias').innerHTML = `<tr><td colspan="5" class="vacio">${esc(e.message)}</td></tr>`; return; }

  const tb = document.getElementById('tbCategorias');
  tb.innerHTML = filas.length
    ? filas.map((c) => `
      <tr class="${c.activa ? '' : 'cat-inactiva'} ${c.fija ? 'cat-fija' : ''}">
        <td class="izq">${esc(c.clave)}</td>
        <td class="izq">${esc(c.etiqueta)}</td>
        <td>${c.deducible ? 'Sí' : 'No'}</td>
        <td>${c.fija ? 'De fábrica' : (c.activa ? 'Activa' : 'Desactivada')}</td>
        <td>${c.fija ? '' : (c.activa ? `<button class="btn-x" data-clave="${esc(c.clave)}" title="Borrar categoría">✕</button>` : '')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="vacio">No hay categorías.</td></tr>';

  tb.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm(`¿Borrar la categoría "${b.dataset.clave}"? Si tiene gastos registrados, se desactivará en vez de borrarse.`)) return;
      try {
        const r = await API.borrarCategoriaGasto(b.dataset.clave);
        if (r.desactivada) alert(r.mensaje || 'La categoría se desactivó (tenía gastos asociados).');
        categoriasGastoCache = null; // se refresca el <select> del formulario
        await cargarCategoriasGasto();
        await cargarCategoriasAdmin();
      } catch (e) { alert('No se pudo borrar: ' + e.message); }
    });
  });
}

document.getElementById('btnCrearCategoria').addEventListener('click', async () => {
  const clave = document.getElementById('cClave').value.trim().toLowerCase();
  const etiqueta = document.getElementById('cEtiqueta').value.trim();
  const deducible = document.getElementById('cDeducible').value === '1';
  if (!clave || !etiqueta) { alert('Indique clave y etiqueta.'); return; }
  try {
    await API.crearCategoriaGasto({ clave, etiqueta, deducible });
    document.getElementById('cClave').value = '';
    document.getElementById('cEtiqueta').value = '';
    categoriasGastoCache = null;
    await cargarCategoriasGasto();
    await cargarCategoriasAdmin();
  } catch (e) { alert('No se pudo crear la categoría: ' + e.message); }
});

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

// ============================================================
//  DINERO DISPONIBLE (Parte 2)
//
//  Muestra un bloque por moneda con su efectivo y sus transferencias.
//  NO hay un "total general" a propósito: sumar 300 USD con 41 500 CUP
//  daría un número sin significado, y convertirlo todo a una moneda haría
//  que el dinero del negocio pareciera subir o bajar solo cada vez que se
//  mueve el dólar, sin que nadie hubiera cobrado ni pagado nada.
// ============================================================
const num2 = (n) => Number(n || 0).toLocaleString('es-ES', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

async function cargarDinero() {
  const cont = document.getElementById('dineroBalance');
  if (!cont) return;
  try {
    const d = await API.dineroBalance();
    document.getElementById('dineroAviso').textContent = d.aviso || '';
    cont.innerHTML = (d.monedas || []).length
      ? d.monedas.map((m) => `
        <div class="dinero-moneda">
          <div class="dinero-titulo">${esc(m.moneda)}</div>
          <div class="dinero-cifras">
            <div><span>Efectivo</span><strong>${num2(m.efectivo)}</strong></div>
            <div><span>Transferencias</span><strong>${num2(m.transferencia)}</strong></div>
            <div class="dinero-total"><span>Total en ${esc(m.moneda)}</span><strong>${num2(m.total)}</strong></div>
          </div>
        </div>`).join('')
      : '<p class="vacio">Todavía no se ha registrado dinero. Use el formulario de abajo.</p>';
  } catch (e) {
    cont.innerHTML = `<p class="vacio">No se pudo cargar: ${esc(e.message)}</p>`;
  }

  try {
    const movs = await API.dineroMovimientos({});
    document.getElementById('tbDinero').innerHTML = movs.length
      ? movs.map((f) => `<tr>
          <td>${new Date(f.fecha).toLocaleDateString('es-CU')}</td>
          <td class="izq">${esc(f.concepto)}</td>
          <td>${esc(f.forma)}</td>
          <td>${esc(f.moneda)}</td>
          <td class="${Number(f.monto) < 0 ? 'g-neg' : 'g-pos'}">${num2(f.monto)}</td>
          <td class="izq">${esc(f.usuario_nombre || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="vacio">Sin movimientos.</td></tr>';
  } catch (e) { /* la tabla es secundaria: si falla, el balance ya se vio */ }
}

document.getElementById('btnDineroRegistrar').addEventListener('click', async () => {
  const datos = {
    forma: document.getElementById('dForma').value,
    moneda: document.getElementById('dMoneda').value.trim().toUpperCase(),
    monto: parseFloat(document.getElementById('dMonto').value),
    concepto: document.getElementById('dConcepto').value.trim(),
  };
  try {
    await API.dineroRegistrar(datos);
    document.getElementById('dMonto').value = '';
    document.getElementById('dConcepto').value = '';
    await cargarDinero();
  } catch (e) { alert(e.message); }
});

document.getElementById('btnDineroAjustar').addEventListener('click', async () => {
  const datos = {
    forma: document.getElementById('aForma').value,
    moneda: document.getElementById('aMoneda').value.trim().toUpperCase(),
    saldo: parseFloat(document.getElementById('aSaldo').value),
    motivo: document.getElementById('aMotivo').value.trim(),
  };
  try {
    const r = await API.dineroAjustar(datos);
    alert(r.sin_cambios
      ? 'El saldo ya coincidía: no hizo falta ningún ajuste.'
      : `Cuadrado. Se anotó una diferencia de ${num2(r.diferencia)}.`);
    document.getElementById('aSaldo').value = '';
    document.getElementById('aMotivo').value = '';
    await cargarDinero();
  } catch (e) { alert(e.message); }
});

// ============================================================
//  MÁRGENES (Parte 4)
//
//  Se muestran SEPARADOS a propósito: el centro de elaboración y cada
//  punto de venta son negocios distintos. Un total único escondería si
//  el que gana es uno y el otro está perdiendo, que es justo lo que hay
//  que poder ver.
// ============================================================
async function cargarMargenes() {
  const params = {};
  const d1 = document.getElementById('mgDesde').value;
  const d2 = document.getElementById('mgHasta').value;
  if (d1) params.desde = d1;
  if (d2) params.hasta = d2;

  let d;
  try { d = await API.margenes(params); }
  catch (e) { alert('No se pudieron cargar los márgenes: ' + e.message); return; }

  document.getElementById('margenCriterio').textContent = d.criterio || '';
  document.getElementById('mgCentro').textContent = money(d.centro.total_margen);
  document.getElementById('mgPuntos').textContent = money(d.puntos.total_margen);
  document.getElementById('mgTotal').textContent = money(d.total_negocio);

  document.getElementById('tbMgPuntos').innerHTML = d.puntos.resumen.length
    ? d.puntos.resumen.map((p) => `<tr>
        <td class="izq"><b>${esc(p.punto)}</b></td><td>${p.dias}</td>
        <td>${money(p.ingreso)}</td><td>${money(p.costo)}</td><td>${gan(p.margen)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="vacio">Todavía no hay ventas registradas.</td></tr>';

  document.getElementById('tbMgDias').innerHTML = d.puntos.filas.length
    ? d.puntos.filas.map((f) => `<tr>
        <td>${String(f.dia).slice(0, 10).split('-').reverse().join('/')}</td>
        <td class="izq">${esc(f.punto)}</td>
        <td>${money(f.ingreso)}</td><td>${money(f.costo)}</td><td>${gan(f.margen)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="vacio">Sin ventas en el período.</td></tr>';

  document.getElementById('tbMgCentro').innerHTML = d.centro.filas.length
    ? d.centro.filas.map((f) => `<tr>
        <td>${String(f.dia).slice(0, 10).split('-').reverse().join('/')}</td>
        <td>${f.producciones}</td><td>${num(f.cantidad)}</td>
        <td>${money(f.costo)}</td><td>${money(f.valor_traspaso)}</td><td>${gan(f.margen)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="vacio">Sin producciones en el período.</td></tr>';
}

document.getElementById('btnMargenes').addEventListener('click', cargarMargenes);

// ---------- Tributación (estimado) — RETIRADA DE LA VISTA (agosto 2026) ----------
// El cliente la lleva con VERSAT, así que su pestaña se quitó del HTML. El
// código se conserva entero y se enciende solo si algún día vuelve la pestaña.
//
// Va dentro de una función con salida temprana por un motivo concreto: aquí
// abajo hay varios addEventListener sobre elementos de esa pestaña. Al no
// existir ya, el primero lanzaría un TypeError y, como es un script clásico,
// ese error detendría la ejecución del resto del archivo — dejando la pantalla
// de Contabilidad entera sin funcionar.
(function inicializarTributacion() {
  if (!document.getElementById('pTributacion')) return;

let regimenesTributariosCache = null; // se llena una vez con GET /tributacion/regimenes
let ultimoPeriodoTributacion = null;  // { desde, hasta } del último cálculo mostrado

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
  document.getElementById('panelRegimenOtro').classList.toggle('oculto', tipo_empresa !== 'otro');
  if (tipo_empresa === 'otro') await cargarRegimenOtro();
  await cargarTributacion();
});

document.getElementById('btnCalcularTributacion').addEventListener('click', cargarTributacion);

// "ventas_brutas" es el nombre interno histórico de la clave (se conserva
// por las correcciones ya guardadas y el régimen "Otro"), pero desde el
// cambio de base ya no mide ventas: mide ingresos bancarios (ver backend).
const nombreBase = (b) => ({
  utilidad_neta: 'Utilidad neta',
  ventas_brutas: 'Ingresos bancarios',
  nomina: 'Nómina',
}[b] || b);

// ---------- Régimen "Otro": editor de tributos propios ----------
let basesValidasCache = ['utilidad_neta', 'ventas_brutas', 'nomina'];

function filaRegimenOtro(t) {
  const tr = document.createElement('tr');
  const opciones = basesValidasCache.map((b) => `<option value="${b}" ${t.base === b ? 'selected' : ''}>${nombreBase(b)}</option>`).join('');
  tr.innerHTML = `
    <td class="izq"><input type="text" class="ro-nombre" value="${esc(t.nombre || '')}" placeholder="Nombre del tributo"></td>
    <td><select class="ro-base">${opciones}</select></td>
    <td><input type="number" class="ro-porcentaje" min="0" step="0.01" value="${t.porcentaje ?? 0}"></td>
    <td><input type="number" class="ro-minimo" min="0" step="0.01" value="${t.minimo_exento ?? 0}"></td>
    <td><button class="btn-x ro-quitar" type="button">✕</button></td>`;
  tr.querySelector('.ro-quitar').addEventListener('click', () => tr.remove());
  return tr;
}

async function cargarRegimenOtro() {
  let d;
  try { d = await API.regimenPersonalizado(); }
  catch (e) { alert('No se pudo cargar el régimen "Otro": ' + e.message); return; }
  basesValidasCache = d.bases_validas && d.bases_validas.length ? d.bases_validas : basesValidasCache;
  const tb = document.getElementById('tbRegimenOtro');
  tb.innerHTML = '';
  (d.tributos || []).forEach((t) => tb.appendChild(filaRegimenOtro(t)));
}

document.getElementById('btnAnadirTributoOtro').addEventListener('click', () => {
  document.getElementById('tbRegimenOtro').appendChild(
    filaRegimenOtro({ nombre: '', base: basesValidasCache[0], porcentaje: 0, minimo_exento: 0 })
  );
});

document.getElementById('btnGuardarRegimenOtro').addEventListener('click', async () => {
  const filas = [...document.querySelectorAll('#tbRegimenOtro tr')];
  const tributos = filas.map((tr) => ({
    clave: tr.querySelector('.ro-nombre').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
    nombre: tr.querySelector('.ro-nombre').value.trim(),
    base: tr.querySelector('.ro-base').value,
    porcentaje: Number(tr.querySelector('.ro-porcentaje').value),
    minimo_exento: Number(tr.querySelector('.ro-minimo').value) || 0,
  }));
  if (tributos.some((t) => !t.nombre)) { alert('Todos los tributos necesitan un nombre.'); return; }
  try {
    await API.guardarRegimenPersonalizado({ tributos });
    alert('Régimen "Otro" guardado.');
    await cargarTributacion();
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
});

// ---------- Corrección manual de cifras calculadas ----------
// Dos prompts sencillos (valor nuevo, luego motivo) en vez de un modal:
// mismo estilo minimalista que el resto de la pantalla (confirm/prompt).
async function corregirCifra(clave, etiqueta, valorActual) {
  const nuevo = prompt(`Nuevo valor para "${etiqueta}" (actual: ${money(valorActual)}):`, valorActual);
  if (nuevo === null) return;
  const nuevoNum = Number(nuevo);
  if (!Number.isFinite(nuevoNum)) { alert('El valor debe ser un número.'); return; }
  const motivo = prompt('Motivo de la corrección (obligatorio):');
  if (!motivo || !motivo.trim()) { alert('Debe indicar un motivo.'); return; }
  if (!ultimoPeriodoTributacion) { alert('Calcule primero la tributación del período.'); return; }
  try {
    await API.corregirTributacion({
      periodo_desde: ultimoPeriodoTributacion.desde,
      periodo_hasta: ultimoPeriodoTributacion.hasta,
      clave, etiqueta,
      valor_anterior: valorActual,
      valor_nuevo: nuevoNum,
      motivo: motivo.trim(),
    });
    await cargarTributacion();
  } catch (e) { alert('No se pudo guardar la corrección: ' + e.message); }
}

document.querySelectorAll('#pTributacion .btn-lapiz').forEach((b) => {
  b.addEventListener('click', () => {
    // El valor real se guarda en data-valor del <span> (nunca se parsea
    // el texto formateado con money(): "1.234,56" rompería con un
    // parseo ingenuo por el separador de miles/decimales de es-CU).
    const valorSpan = b.previousElementSibling;
    const valorActual = Number(valorSpan.dataset.valor) || 0;
    corregirCifra(b.dataset.clave, b.dataset.etiqueta, valorActual);
  });
});

// Pinta el "corregido" (marca roja + tooltip) de una tarjeta, o lo
// oculta si no hay corrección vigente para esa cifra.
function marcarCorreccion(idTarjeta, idMarca, correccion) {
  const tarj = document.getElementById(idTarjeta);
  const marca = document.getElementById(idMarca);
  if (correccion) {
    tarj.classList.add('corregida');
    marca.classList.remove('oculto');
    marca.title = `Corregido por ${correccion.usuario_nombre || '—'} el ${fechaHora(correccion.fecha)}. Motivo: ${correccion.motivo}`;
    marca.textContent = `Corregido: ${correccion.motivo}`;
  } else {
    tarj.classList.remove('corregida');
    marca.classList.add('oculto');
  }
}

async function cargarTributacion() {
  // Primero, los regímenes vigentes (una sola vez): sirve para
  // inicializar el selector de tipo de empresa con lo ya guardado y
  // para mostrar el aviso legal tal como lo define el backend.
  if (!regimenesTributariosCache) {
    try {
      regimenesTributariosCache = await API.regimenesTributarios();
      document.getElementById('tTipoEmpresa').value = regimenesTributariosCache.tipo_empresa_actual || 'microempresa';
      document.getElementById('tribAvisoLegal').textContent = regimenesTributariosCache.aviso_legal;
      const esOtro = document.getElementById('tTipoEmpresa').value === 'otro';
      document.getElementById('panelRegimenOtro').classList.toggle('oculto', !esOtro);
      if (esOtro) await cargarRegimenOtro();
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

  ultimoPeriodoTributacion = { desde: d.resumen.desde, hasta: d.resumen.hasta };

  // Además del texto formateado, se guarda el número crudo en
  // data-valor: lo usa el lapicito de corrección para no tener que
  // parsear "1.234,56" (formato es-CU) desde el texto ya formateado.
  const pintarCifra = (id, valor) => {
    const el = document.getElementById(id);
    el.textContent = money(valor);
    el.dataset.valor = valor;
  };
  pintarCifra('tVentasBrutas', d.ventas_brutas);
  pintarCifra('tGastosDeducibles', d.gastos_deducibles.total);
  pintarCifra('tUtilidadNeta', d.utilidad_neta);
  pintarCifra('tBaseImponible', d.base_imponible);
  document.getElementById('tTotalTributar').textContent = money(d.total_tributos);
  document.getElementById('tribRegimenNombre').textContent = d.resumen.regimen_nombre;
  document.getElementById('tribResumenPeriodo').textContent =
    `Período: ${esc(d.resumen.periodo)} · del ${d.resumen.desde} al ${d.resumen.hasta}`;

  const cv = d.correcciones_vigentes || {};
  marcarCorreccion('tarjVentasBrutas', 'mVentasBrutas', cv.ventas_brutas);
  marcarCorreccion('tarjGastosDeducibles', 'mGastosDeducibles', cv.gastos_deducibles || d.gastos_deducibles.correccion);
  marcarCorreccion('tarjUtilidadNeta', 'mUtilidadNeta', cv.utilidad_neta);
  marcarCorreccion('tarjBaseImponible', 'mBaseImponible', cv.base_imponible);

  const tbT = document.getElementById('tbTributos');
  tbT.innerHTML = d.tributos.length
    ? d.tributos.map((t) => `
      <tr>
        <td class="izq"><b>${esc(t.nombre)}</b>${t.sobrescrito ? ' <span class="etq e-gasto" title="Porcentaje corregido a mano en Parámetros">editado</span>' : ''}</td>
        <td>${esc(nombreBase(t.base))}</td>
        <td>${money(t.base_valor)}</td>
        <td>${t.porcentaje}%</td>
        <td>
          ${money(t.importe)}
          <button class="btn-lapiz" data-clave="tributo.${esc(t.clave)}" data-etiqueta="${esc(t.nombre)}" data-valor="${t.importe}" title="Corregir este importe">✎</button>
          ${t.corregido ? `<span class="marca-corregido" title="Corregido por ${esc(t.correccion.usuario_nombre || '—')} el ${fechaHora(t.correccion.fecha)}. Motivo: ${esc(t.correccion.motivo)}">Corregido: ${esc(t.correccion.motivo)}</span>` : ''}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="vacio">Sin tributos configurados.</td></tr>';

  tbT.querySelectorAll('.btn-lapiz').forEach((b) => {
    b.addEventListener('click', () => corregirCifra(b.dataset.clave, b.dataset.etiqueta, Number(b.dataset.valor) || 0));
  });

  const tbG = document.getElementById('tbGastosCategoria');
  tbG.innerHTML = d.gastos_deducibles.por_categoria.length
    ? d.gastos_deducibles.por_categoria.map((g) => `
      <tr><td class="izq">${esc(g.categoria)}</td><td>${money(g.total)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="vacio">No hay gastos registrados en este período.</td></tr>';

  // Ingresos por cuenta bancaria (desglose informativo del nuevo total de
  // ingresos: ver comentario grande en routes/contabilidad.js).
  const tbI = document.getElementById('tbIngresosCuenta');
  if (tbI) {
    tbI.innerHTML = (d.ingresos_por_cuenta || []).length
      ? d.ingresos_por_cuenta.map((c) => `
        <tr><td class="izq">${esc(c.cuenta)}</td><td>${money(c.total)}</td></tr>`).join('')
      : '<tr><td colspan="2" class="vacio">No hay entradas bancarias registradas en este período.</td></tr>';
  }

  const ul = document.getElementById('tribAdvertencias');
  ul.innerHTML = d.advertencias.length
    ? d.advertencias.map((a) => `<li>${esc(a)}</li>`).join('')
    : '<li>Sin advertencias.</li>';

  await cargarCorreccionesVigentes();
  await cargarHistorialTributacion();
}

// ---------- Historial de tributación (tabla tributacion_historial) ----------
// Cada cálculo que el contador decide guardar deja una línea fija con
// fecha y hora (pedido del cliente, punto 2). El borrado es solo para
// dueño/admin/proveedor (lo aplica también el backend con 403; aquí solo
// se oculta el botón para no ofrecer una acción que el servidor va a
// rechazar).
async function cargarHistorialTributacion() {
  const tb = document.getElementById('tbHistorialTrib');
  if (!tb) return;
  let filas;
  try { filas = await apiFetch('/contabilidad/tributacion/historial'); }
  catch (e) { tb.innerHTML = `<tr><td colspan="8" class="vacio">${esc(e.message)}</td></tr>`; return; }

  tb.innerHTML = filas.length
    ? filas.map((f) => `
      <tr>
        <td>${fechaHora(f.creado_en)}</td>
        <td class="izq">${esc(f.periodo)}</td>
        <td>${money(f.base_ingresos)}</td>
        <td>${money(f.base_gastos)}</td>
        <td>${money(f.base_imponible)}</td>
        <td>${money(f.tributo)}</td>
        <td class="izq">${esc(f.usuario_nombre || '')}</td>
        <td>${rolEsAdmin() ? `<button class="btn-x" data-id="${f.id}" title="Eliminar línea del historial">✕</button>` : ''}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="vacio">Todavía no hay cálculos guardados en el historial.</td></tr>';

  tb.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta línea del historial de tributación? No se puede deshacer.')) return;
      const motivo = prompt('Motivo del borrado (obligatorio):');
      if (!motivo || !motivo.trim()) { alert('Debe indicar un motivo.'); return; }
      try {
        await apiFetch(`/contabilidad/tributacion/historial/${b.dataset.id}`, {
          method: 'DELETE', body: JSON.stringify({ motivo: motivo.trim() }),
        });
        await cargarHistorialTributacion();
      } catch (e) { alert('No se pudo borrar: ' + e.message); }
    });
  });
}

document.getElementById('btnGuardarHistorial').addEventListener('click', async () => {
  if (!ultimoPeriodoTributacion) { alert('Calcule primero la tributación del período.'); return; }
  const periodo = document.getElementById('tPeriodo').value;
  const params = { periodo, tipo_empresa: document.getElementById('tTipoEmpresa').value };
  if (periodo === 'rango') {
    params.desde = document.getElementById('tDesde').value;
    params.hasta = document.getElementById('tHasta').value;
  }
  try {
    await apiFetch('/contabilidad/tributacion/historial', { method: 'POST', body: JSON.stringify(params) });
    alert('Cálculo guardado en el historial.');
    await cargarHistorialTributacion();
  } catch (e) { alert('No se pudo guardar en el historial: ' + e.message); }
});

// ---------- Tabla de correcciones vigentes (con opción de anular) ----------
async function cargarCorreccionesVigentes() {
  if (!ultimoPeriodoTributacion) return;
  let filas;
  try {
    filas = await API.correccionesTributacion({
      desde: ultimoPeriodoTributacion.desde,
      hasta: ultimoPeriodoTributacion.hasta,
    });
  } catch (e) {
    document.getElementById('tbCorrecciones').innerHTML = `<tr><td colspan="7" class="vacio">${esc(e.message)}</td></tr>`;
    return;
  }
  const tb = document.getElementById('tbCorrecciones');
  tb.innerHTML = filas.length
    ? filas.map((c) => `
      <tr>
        <td class="izq">${esc(c.etiqueta || c.clave)}</td>
        <td>${c.valor_anterior == null ? '—' : money(c.valor_anterior)}</td>
        <td>${money(c.valor_nuevo)}</td>
        <td class="izq">${esc(c.motivo)}</td>
        <td>${esc(c.usuario_nombre || '')}</td>
        <td>${fechaHora(c.fecha)}</td>
        <td><button class="btn-x" data-id="${c.id}">Anular</button></td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="vacio">No hay correcciones vigentes en este período.</td></tr>';

  tb.querySelectorAll('.btn-x').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('¿Anular esta corrección? Volverá a mostrarse el cálculo automático para esa cifra.')) return;
      try {
        await API.anularCorreccionTributacion(Number(b.dataset.id));
        await cargarTributacion();
      } catch (e) { alert('No se pudo anular: ' + e.message); }
    });
  });
}

})();

cargarResumen();
