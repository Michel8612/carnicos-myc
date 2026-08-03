// ============================================================
//  TABLERO DE INDICADORES
//
//  Pinta en una sola pantalla los números que da /api/tablero/indicadores
//  (un solo viaje al servidor: la conexión en Cuba no aguanta ocho
//  peticiones para dibujar un panel). Todo lo demás — sumar, agrupar,
//  rellenar huecos de fechas — ya lo hizo el backend; aquí solo se
//  formatea y se dibuja.
// ============================================================

// NOTA: no se usa "return" aquí (sería un SyntaxError a este nivel del
// archivo: es un script clásico, no un módulo). Se sigue el mismo patrón
// que el resto de páginas guardadas por rol (ver contabilidad.js,
// empresa.js, etc.): lanzar y salir corta el script igual de en seco.
if (!soloRoles(['contabilidad'])) { throw new Error('sin acceso'); }

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = '';
  nav.href = 'admin.html';
}

// ---------- Formato ----------
const money = (n) => Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fechaLarga = (f) => {
  // f llega como 'YYYY-MM-DD'; se arma la fecha a mano (no con `new
  // Date('YYYY-MM-DD')`) porque ese constructor la interpreta en UTC y,
  // según la hora del día, puede mostrar el día anterior.
  const [y, m, d] = f.split('-');
  return `${d}/${m}/${y}`;
};

// ---------- Fechas locales (el usuario está físicamente en Cuba) ----------
function hoyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function sumarDias(fechaStr, dias) {
  const [y, m, d] = fechaStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + dias);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

const $desde = document.getElementById('fDesde');
const $hasta = document.getElementById('fHasta');
const $rango = document.getElementById('rangoTexto');
const $rejilla = document.getElementById('rejilla');
const $grafico = document.getElementById('grafico');
const $alertas = document.getElementById('listaAlertas');

// ---------- Tarjetas ----------
function tarjeta(clase, numero, etiqueta, sub) {
  return `<div class="tarjeta ${clase || ''}">
    <div class="n">${numero}</div>
    <div class="l">${etiqueta}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;
}

// Flecha de tendencia de "hoy" contra "ayer". Si ayer fue 0, un
// porcentaje no dice nada (dividir por cero), así que se avisa aparte
// en vez de mostrar un número sin sentido.
function tendenciaHtml(hoy, ayer) {
  if (ayer === 0 && hoy === 0) return '<div class="tendencia igual">= Igual que ayer</div>';
  if (ayer === 0) return '<div class="tendencia sube">▲ Ayer no hubo ventas</div>';
  const pct = ((hoy - ayer) / ayer) * 100;
  if (pct > 0) return `<div class="tendencia sube">▲ ${pct.toFixed(1)}% vs ayer</div>`;
  if (pct < 0) return `<div class="tendencia baja">▼ ${Math.abs(pct).toFixed(1)}% vs ayer</div>`;
  return '<div class="tendencia igual">= Igual que ayer</div>';
}

function pintarRejilla(d) {
  const resultadoClase = d.resultado >= 0 ? 'c-verde' : 'c-rojo';
  $rejilla.innerHTML = [
    `<div class="tarjeta destacada">
       <div class="n">${money(d.hoy.ingreso)}</div>
       <div class="l">Ventas de hoy</div>
       ${tendenciaHtml(d.hoy.ingreso, d.ayer.ingreso)}
     </div>`,
    tarjeta('c-azul', money(d.ventas.ingreso), 'Ventas del periodo', `${d.ventas.apuntes} apunte(s)`),
    tarjeta('c-verde', money(d.ventas.ganancia), 'Ganancia del periodo'),
    tarjeta('c-rojo', money(d.gastos.total), 'Gastos del periodo'),
    tarjeta(resultadoClase, money(d.resultado), 'Resultado (ganancia − gastos)'),
    tarjeta('c-morado', money(d.inventario.valor_venta), 'Valor del inventario', `Costo: ${money(d.inventario.valor_costo)} · ${d.inventario.productos} producto(s)`),
    tarjeta('c-azul', money(d.bancos.saldo), 'Saldo en bancos', `${d.bancos.cuentas.length} cuenta(s)`),
    tarjeta('c-azul', money(d.caja.saldo), 'Saldo en caja'),
    tarjeta('c-naranja', money(d.cuentas.por_cobrar.pendiente), 'Por cobrar',
      d.cuentas.por_cobrar.vencido > 0 ? `<span class="vencido-aviso">${money(d.cuentas.por_cobrar.vencido)} vencido</span>` : 'Al día'),
    tarjeta('c-naranja', money(d.cuentas.por_pagar.pendiente), 'Por pagar',
      d.cuentas.por_pagar.vencido > 0 ? `<span class="vencido-aviso">${money(d.cuentas.por_pagar.vencido)} vencido</span>` : 'Al día'),
  ].join('');
}

// ---------- Gráfico SVG (a mano, sin librerías) ----------
function construirGrafico(serie) {
  const ANCHO = 600, ALTO = 190;
  const PAD = 4;
  const BASE_Y = 148;     // línea base de las barras
  const ALTO_MAX = 128;   // alto máximo de una barra (deja aire arriba para el número más alto)
  const n = serie.length || 1;
  const slot = (ANCHO - PAD * 2) / n;
  const anchoIngreso = Math.max(2, slot * 0.62);
  const anchoGanancia = Math.max(1, slot * 0.28);

  // Escala según el ingreso más alto de los 30 días (la ganancia nunca
  // debería superarlo, así que comparten la misma escala).
  const maxIngreso = Math.max(1, ...serie.map((f) => f.ingreso));

  let barras = '';
  let etiquetas = '';
  serie.forEach((f, i) => {
    const cx = PAD + i * slot + slot / 2;
    const hIngreso = (f.ingreso / maxIngreso) * ALTO_MAX;
    // La ganancia de un día puede salir negativa (se vendió por debajo del
    // costo). Una barra de alto negativo no se puede dibujar, así que para
    // el dibujo se recorta a 0 — el número exacto sigue en el "title".
    const hGanancia = (Math.max(0, f.ganancia) / maxIngreso) * ALTO_MAX;
    barras += `
      <rect x="${(cx - anchoIngreso / 2).toFixed(1)}" y="${(BASE_Y - hIngreso).toFixed(1)}" width="${anchoIngreso.toFixed(1)}" height="${hIngreso.toFixed(1)}" fill="#90caf9" rx="1.5">
        <title>${fechaLarga(f.fecha)} — Ingreso: ${money(f.ingreso)}</title>
      </rect>
      <rect x="${(cx - anchoGanancia / 2).toFixed(1)}" y="${(BASE_Y - hGanancia).toFixed(1)}" width="${anchoGanancia.toFixed(1)}" height="${hGanancia.toFixed(1)}" fill="#2e7d32" rx="1">
        <title>${fechaLarga(f.fecha)} — Ganancia: ${money(f.ganancia)}</title>
      </rect>`;
    // Una etiqueta cada cinco días (y la última): con las 30 fechas
    // seguidas no se leería ninguna, se pisarían unas a otras.
    if (i % 5 === 0 || i === n - 1) {
      const [, m, dd] = f.fecha.split('-');
      etiquetas += `<text x="${cx.toFixed(1)}" y="${BASE_Y + 16}" font-size="9" fill="#607d8b" text-anchor="middle">${dd}/${m}</text>`;
    }
  });

  return `<svg viewBox="0 0 ${ANCHO} ${ALTO}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Ventas de los últimos 30 días">
    <line x1="${PAD}" y1="${BASE_Y}" x2="${ANCHO - PAD}" y2="${BASE_Y}" stroke="#cfd8dc" stroke-width="1"/>
    ${barras}
    ${etiquetas}
  </svg>`;
}

// ---------- Alertas ----------
// El endpoint no manda un listado de documentos vencidos uno por uno
// (solo el total y cuántos), así que la alerta de cuentas se muestra
// como resumen; la de stock sí es por producto porque el backend manda
// las filas completas.
function pintarAlertas(d) {
  const filas = [];

  for (const p of d.stock_bajo) {
    filas.push(`<li class="al-aviso">
      <span>📦 <b>${p.producto}</b> bajo mínimo en ${p.almacen}: ${p.cantidad}${p.unidad} (mínimo ${p.stock_minimo}${p.unidad})</span>
      <a class="al-link" href="almacen.html">Ver almacén →</a>
    </li>`);
  }
  if (d.cuentas.por_cobrar.vencido > 0) {
    filas.push(`<li class="al-urgente">
      <span>💰 ${d.cuentas.por_cobrar.documentos} documento(s) por cobrar, ${money(d.cuentas.por_cobrar.vencido)} vencido</span>
      <a class="al-link" href="cuentas.html">Ver cuentas →</a>
    </li>`);
  }
  if (d.cuentas.por_pagar.vencido > 0) {
    filas.push(`<li class="al-urgente">
      <span>💸 ${d.cuentas.por_pagar.documentos} documento(s) por pagar, ${money(d.cuentas.por_pagar.vencido)} vencido</span>
      <a class="al-link" href="cuentas.html">Ver cuentas →</a>
    </li>`);
  }

  $alertas.innerHTML = filas.length ? filas.join('') : '<li class="vacio" style="background:none;">Sin alertas por ahora. Todo en orden.</li>';
}

// ---------- Carga ----------
async function cargar(params) {
  $rejilla.innerHTML = '<p class="vacio">Cargando…</p>';
  try {
    const d = await API.indicadores(params || {});
    $desde.value = d.periodo.desde;
    $hasta.value = d.periodo.hasta;
    $rango.textContent = `Periodo: ${fechaLarga(d.periodo.desde)} — ${fechaLarga(d.periodo.hasta)} · ${d.avisos_sin_leer} aviso(s) sin leer`;
    pintarRejilla(d);
    $grafico.innerHTML = construirGrafico(d.serie);
    pintarAlertas(d);
  } catch (e) {
    $rejilla.innerHTML = `<p class="vacio">${e.message}</p>`;
  }
}

// ---------- Atajos de periodo ----------
document.getElementById('bEsteMes').addEventListener('click', () => {
  const hoy = hoyLocal();
  const [y, m] = hoy.split('-');
  cargar({ desde: `${y}-${m}-01`, hasta: hoy });
});
document.getElementById('bMesPasado').addEventListener('click', () => {
  const hoy = hoyLocal();
  const [y, m] = hoy.split('-').map(Number);
  const mesAnterior = m === 1 ? 12 : m - 1;
  const anoAnterior = m === 1 ? y - 1 : y;
  const desde = `${anoAnterior}-${String(mesAnterior).padStart(2, '0')}-01`;
  // Último día del mes anterior = día 0 del mes actual.
  const ultimoDia = new Date(y, m - 1, 0).getDate();
  const hasta = `${anoAnterior}-${String(mesAnterior).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
  cargar({ desde, hasta });
});
document.getElementById('bUltimos30').addEventListener('click', () => {
  const hoy = hoyLocal();
  cargar({ desde: sumarDias(hoy, -29), hasta: hoy });
});
document.getElementById('bFiltrar').addEventListener('click', () => {
  if (!$desde.value || !$hasta.value) {
    alert('Elija ambas fechas (desde y hasta).');
    return;
  }
  if ($desde.value > $hasta.value) {
    alert('La fecha "desde" no puede ser posterior a "hasta".');
    return;
  }
  cargar({ desde: $desde.value, hasta: $hasta.value });
});
document.getElementById('bImprimir').addEventListener('click', () => window.print());

cargar();
