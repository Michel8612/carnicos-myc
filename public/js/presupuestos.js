// ============================================================
//  PRESUPUESTOS — previsto vs. real (§10)
//
//  Una sola página con tres vistas (lista / detalle / comparativo)
//  que se muestran y ocultan con la clase "oculto": no hay recarga
//  de página entre una y otra, así que volver atrás no pierde nada
//  que no se haya guardado ya en el servidor.
// ============================================================

if (!soloRoles(['contabilidad'])) { throw new Error('sin acceso'); }

// El dueño ve el enlace para volver al panel; contabilidad entra
// directo a esta pantalla y no lo necesita.
if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

const $ = (id) => document.getElementById(id);
const money = (n) => Number(n ?? 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 'dd/mm/aaaa' a partir de lo que mande el servidor: una fecha DATE
// en texto ('2026-08-01') o, si viene sin formatear, un ISO completo
// ('2026-08-01T00:00:00.000Z'). En los dos casos basta con los
// primeros 10 caracteres.
function fechaCorta(v) {
  if (!v) return '';
  const [a, m, d] = String(v).slice(0, 10).split('-');
  return a && m && d ? `${d}/${m}/${a}` : String(v).slice(0, 10);
}

// Categorías fijas de ingreso, con su explicación: el usuario tiene
// que saber, sin adivinar, a qué corte del libro corresponde cada una
// (ver la regla del REAL comentada en backend/src/routes/presupuestos.js).
const CATEGORIAS_INGRESO = [
  { valor: 'venta', etiqueta: 'Venta (tipo del libro)' },
  { valor: 'almacen', etiqueta: 'Almacén (tipo del libro)' },
  { valor: 'produccion', etiqueta: 'Producción (tipo del libro)' },
  { valor: 'ventas', etiqueta: 'Área Ventas (punto de venta)' },
  { valor: 'cocina', etiqueta: 'Área Cocina' },
];

let categoriasGastoCache = null;
let presupuestoActual = null; // cabecera + líneas que se están viendo/editando

function mostrarVista(nombre) {
  $('vistaLista').classList.toggle('oculto', nombre !== 'lista');
  $('vistaDetalle').classList.toggle('oculto', nombre !== 'detalle');
  $('vistaComparativo').classList.toggle('oculto', nombre !== 'comparativo');
}

// ------------------------------------------------------------
//  Vista 1: lista de presupuestos
// ------------------------------------------------------------

async function cargarLista() {
  $('errLista').textContent = '';
  try {
    pintarLista(await API.presupuestos());
  } catch (e) {
    $('errLista').textContent = e.message;
  }
}

function pintarLista(lista) {
  const $tb = $('tbLista');
  if (!lista.length) {
    $tb.innerHTML = '<tr><td colspan="7" class="vacio">Todavía no hay presupuestos.</td></tr>';
    return;
  }
  $tb.innerHTML = lista.map((p) => `
    <tr>
      <td class="izq"><a href="#" data-abrir="${p.id}">${p.nombre}</a></td>
      <td>${fechaCorta(p.periodo_inicio)} – ${fechaCorta(p.periodo_fin)}</td>
      <td>${p.lineas}</td>
      <td>${money(p.previsto_ingresos)}</td>
      <td>${money(p.previsto_gastos)}</td>
      <td>${money(p.resultado_previsto)}</td>
      <td><button class="btn-x" data-borrar="${p.id}" type="button" title="Borrar">✕</button></td>
    </tr>
  `).join('');
}

$('tbLista').addEventListener('click', async (ev) => {
  const abrir = ev.target.closest('[data-abrir]');
  if (abrir) {
    ev.preventDefault();
    await abrirPresupuesto(Number(abrir.dataset.abrir));
    return;
  }
  const borrar = ev.target.closest('[data-borrar]');
  if (borrar) {
    if (!confirm('¿Borrar este presupuesto? Se pierden también todas sus líneas.')) return;
    try {
      await API.presupuestoBorrar(Number(borrar.dataset.borrar));
      await cargarLista();
    } catch (e) {
      $('errLista').textContent = e.message;
    }
  }
});

$('btnCrear').addEventListener('click', async () => {
  $('errLista').textContent = '';
  const d = {
    nombre: $('nNombre').value.trim(),
    periodo_inicio: $('nDesde').value,
    periodo_fin: $('nHasta').value,
    nota: $('nNota').value.trim(),
  };
  try {
    await API.presupuestoCrear(d);
    $('nNombre').value = ''; $('nDesde').value = ''; $('nHasta').value = ''; $('nNota').value = '';
    await cargarLista();
  } catch (e) {
    $('errLista').textContent = e.message;
  }
});

// ------------------------------------------------------------
//  Vista 2: detalle de un presupuesto (cabecera + líneas)
// ------------------------------------------------------------

async function abrirPresupuesto(id) {
  $('errLista').textContent = '';
  try {
    presupuestoActual = await API.presupuesto(id);
    await pintarDetalle();
    mostrarVista('detalle');
  } catch (e) {
    $('errLista').textContent = e.message;
  }
}

async function pintarDetalle() {
  const p = presupuestoActual;
  $('dTitulo').textContent = `Presupuesto: ${p.nombre}`;
  $('dNombre').value = p.nombre;
  $('dDesde').value = String(p.periodo_inicio).slice(0, 10);
  $('dHasta').value = String(p.periodo_fin).slice(0, 10);
  $('dNota').value = p.nota || '';

  const $tb = $('tbLineas');
  if (!p.lineas.length) {
    $tb.innerHTML = '<tr><td colspan="4" class="vacio">Sin líneas todavía. Añada una abajo.</td></tr>';
  } else {
    $tb.innerHTML = p.lineas.map((l) => `
      <tr>
        <td>${l.tipo === 'ingreso' ? 'Ingreso' : 'Gasto'}</td>
        <td class="izq">${l.tipo === 'gasto' ? (l.categoria_etiqueta || l.categoria) : etiquetaCategoriaIngreso(l.categoria)}</td>
        <td>${money(l.previsto)}</td>
        <td><button class="btn-x" data-borrar-linea="${l.id}" type="button" title="Borrar línea">✕</button></td>
      </tr>
    `).join('');
  }

  await poblarSelectCategoria();
}

function etiquetaCategoriaIngreso(valor) {
  const c = CATEGORIAS_INGRESO.find((x) => x.valor === valor);
  return c ? c.etiqueta : valor;
}

// El desplegable de categoría depende del tipo elegido: en gasto son
// las categorías reales de Contabilidad; en ingreso, las 5 fijas que
// entiende la regla del comparativo.
async function poblarSelectCategoria() {
  const tipo = $('lTipo').value;
  const $sel = $('lCategoria');
  if (tipo === 'gasto') {
    if (!categoriasGastoCache) {
      try { categoriasGastoCache = await API.categoriasGasto(); } catch { categoriasGastoCache = []; }
    }
    $sel.innerHTML = categoriasGastoCache.map((c) => `<option value="${c.clave}">${c.etiqueta}</option>`).join('');
  } else {
    $sel.innerHTML = CATEGORIAS_INGRESO.map((c) => `<option value="${c.valor}">${c.etiqueta}</option>`).join('');
  }
}

$('lTipo').addEventListener('change', poblarSelectCategoria);

$('btnGuardarCabecera').addEventListener('click', async () => {
  $('errDetalle').textContent = '';
  const d = {
    nombre: $('dNombre').value.trim(),
    periodo_inicio: $('dDesde').value,
    periodo_fin: $('dHasta').value,
    nota: $('dNota').value.trim(),
  };
  try {
    const cabecera = await API.presupuestoEditar(presupuestoActual.id, d);
    presupuestoActual = { ...presupuestoActual, ...cabecera };
    await pintarDetalle();
  } catch (e) {
    $('errDetalle').textContent = e.message;
  }
});

$('btnBorrarPresupuesto').addEventListener('click', async () => {
  if (!confirm('¿Borrar este presupuesto y todas sus líneas? No se puede deshacer.')) return;
  try {
    await API.presupuestoBorrar(presupuestoActual.id);
    presupuestoActual = null;
    mostrarVista('lista');
    await cargarLista();
  } catch (e) {
    $('errDetalle').textContent = e.message;
  }
});

$('btnAnadirLinea').addEventListener('click', async () => {
  $('errLinea').textContent = '';
  const categoria = $('lCategoria').value;
  if (!categoria) { $('errLinea').textContent = 'Elija una categoría.'; return; }
  const d = { tipo: $('lTipo').value, categoria, previsto: $('lPrevisto').value };
  try {
    await API.presupuestoLineaCrear(presupuestoActual.id, d);
    $('lPrevisto').value = '';
    presupuestoActual = await API.presupuesto(presupuestoActual.id);
    await pintarDetalle();
  } catch (e) {
    $('errLinea').textContent = e.message;
  }
});

$('tbLineas').addEventListener('click', async (ev) => {
  const borrar = ev.target.closest('[data-borrar-linea]');
  if (!borrar) return;
  if (!confirm('¿Borrar esta línea del presupuesto?')) return;
  try {
    await API.presupuestoLineaBorrar(Number(borrar.dataset.borrarLinea));
    presupuestoActual = await API.presupuesto(presupuestoActual.id);
    await pintarDetalle();
  } catch (e) {
    $('errDetalle').textContent = e.message;
  }
});

$('btnVolverLista').addEventListener('click', async () => {
  presupuestoActual = null;
  mostrarVista('lista');
  await cargarLista();
});

// ------------------------------------------------------------
//  Vista 3: comparativo (previsto vs. real)
// ------------------------------------------------------------

$('btnVerComparativo').addEventListener('click', async () => {
  $('errComparativo').textContent = '';
  try {
    const datos = await API.presupuestoComparativo(presupuestoActual.id);
    pintarComparativo(datos);
    mostrarVista('comparativo');
  } catch (e) {
    $('errDetalle').textContent = e.message;
  }
});

$('btnVolverDetalle').addEventListener('click', () => mostrarVista('detalle'));

// Semáforo: la misma desviación (real − previsto) se lee al revés según
// el tipo de línea. En GASTO, pasarse (desviación > 0) es malo; en
// INGRESO, quedarse corto (desviación < 0) es malo. Sin dato real que
// comparar (sin_correspondencia) no hay semáforo posible: queda neutro.
function claseSemaforo(l) {
  if (l.sin_correspondencia || l.desviacion === 0) return 'sem-neutro';
  const malo = l.tipo === 'gasto' ? l.desviacion > 0 : l.desviacion < 0;
  return malo ? 'sem-mal' : 'sem-bien';
}

// Barra de progreso simple: el ancho es cuánto de lo previsto ya se
// alcanzó (tope 100% para que una desviación grande no rompa el diseño).
function barraProgreso(l) {
  if (l.sin_correspondencia) return '<div class="barra-fondo"></div>';
  const pct = l.previsto > 0 ? Math.min(100, (l.real / l.previsto) * 100) : (l.real > 0 ? 100 : 0);
  const bien = l.tipo === 'gasto' ? l.real <= l.previsto : l.real >= l.previsto;
  return `<div class="barra-fondo"><div class="barra-rel ${bien ? 'b-verde-i' : 'b-roja-i'}" style="width:${pct}%"></div></div>`;
}

function pintarComparativo(datos) {
  const { presupuesto, lineas, totales } = datos;
  $('cTitulo').textContent = `Comparativo — ${presupuesto.nombre}`;
  $('cPeriodo').textContent =
    `Período: ${fechaCorta(presupuesto.periodo_inicio)} – ${fechaCorta(presupuesto.periodo_fin)}` +
    (presupuesto.nota ? ` · ${presupuesto.nota}` : '');

  if (!lineas.length) {
    $('tbComparativo').innerHTML = '<tr><td colspan="7" class="vacio">Este presupuesto no tiene líneas.</td></tr>';
  } else {
    $('tbComparativo').innerHTML = lineas.map((l) => `
      <tr>
        <td class="izq">${l.tipo === 'ingreso' ? 'Ingreso' : 'Gasto'}</td>
        <td class="izq">
          ${l.categoria_etiqueta}
          ${l.sin_correspondencia ? '<span class="sin-datos">Sin datos: esta categoría no corresponde a nada del libro.</span>' : ''}
        </td>
        <td>${money(l.previsto)}</td>
        <td>${money(l.real)}</td>
        <td class="${claseSemaforo(l)}">${money(l.desviacion)}</td>
        <td class="${claseSemaforo(l)}">${l.desviacion_pct === null ? '—' : l.desviacion_pct.toFixed(2) + '%'}</td>
        <td>${barraProgreso(l)}</td>
      </tr>
    `).join('');
  }

  $('rPrevistoIngresos').textContent = money(totales.previsto_ingresos);
  $('rRealIngresos').textContent = money(totales.real_ingresos);
  $('rPrevistoGastos').textContent = money(totales.previsto_gastos);
  $('rRealGastos').textContent = money(totales.real_gastos);
  $('rResultadoPrevisto').textContent = money(totales.resultado_previsto);
  $('rResultadoReal').textContent = money(totales.resultado_real);

  // Solo se ve al imprimir (ver @media print del HTML): dice cuándo se
  // sacó el informe, útil si el papel se guarda o se entrega después.
  $('piePresupuestoImprimir').textContent = `Emitido el ${new Date().toLocaleString('es-ES')}`;
}

$('btnExcel').addEventListener('click', async () => {
  $('errComparativo').textContent = '';
  try {
    await descargarInforme(`/presupuestos/${presupuestoActual.id}/comparativo`, {}, 'xlsx');
  } catch (e) {
    $('errComparativo').textContent = e.message;
  }
});

$('btnCsv').addEventListener('click', async () => {
  $('errComparativo').textContent = '';
  try {
    await descargarInforme(`/presupuestos/${presupuestoActual.id}/comparativo`, {}, 'csv');
  } catch (e) {
    $('errComparativo').textContent = e.message;
  }
});

$('btnImprimir').addEventListener('click', () => window.print());

cargarLista();
