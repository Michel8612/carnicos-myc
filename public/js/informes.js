// ============================================================
//  INFORMES CONTABLES — pantalla
//
//  Tres pestañas de solo lectura sobre lo que ya está registrado en
//  el resto del sistema: Estado de Resultados, Balance General y
//  Flujo de Caja. Cada una se puede bajar en Excel o CSV, o
//  imprimirse (que es como se saca el PDF: Ctrl+P → "Guardar como PDF").
//
//  Los tres informes comparten la MISMA forma de tabla: `filas`
//  [{concepto, monto}] que manda el servidor (ver
//  backend/src/routes/informes.js) — es exactamente lo que se
//  exporta, así que lo que se ve aquí y lo que se descarga siempre
//  coinciden.
// ============================================================

if (!soloRoles(['contabilidad'])) { throw new Error('sin acceso'); }

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

// ---------- Utilidades de formato ----------
const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Dos decimales, separador de miles, y en rojo si es negativo.
function money(n) {
  if (n === null || n === undefined) return '';
  const num = Number(n);
  const texto = Math.abs(num).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return num < 0 ? `<span class="neg">-${texto}</span>` : texto;
}
// Igual que money() pero sin HTML, para meter en un nodo de texto plano.
function moneyTxt(n) {
  const num = Number(n ?? 0);
  return num.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function hoyISO() { return new Date().toISOString().slice(0, 10); }
function primerDiaMesISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// ---------- Nombre del negocio (para el encabezado impreso) ----------
// Se pide a /empresa (ficha fiscal, §4). Si todavía no está llena o la
// petición falla, se deja el nombre por defecto: esto es solo un dato
// de cabecera, no debe bloquear la pantalla si algo sale mal.
API.empresa()
  .then((e) => {
    const nombre = (e && (e.nombre_fiscal || e.razon_social) || '').trim();
    if (nombre) document.querySelectorAll('.negocio-nombre').forEach((el) => { el.textContent = nombre; });
  })
  .catch(() => {});

document.querySelectorAll('.fecha-emision').forEach((el) => {
  el.textContent = new Date().toLocaleString('es-CU', { dateStyle: 'medium', timeStyle: 'short' });
});

// ---------- Pestañas ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('activo'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('activo'));
    b.classList.add('activo');
    document.getElementById(b.dataset.panel).classList.add('activo');
  });
});

// ---------- Valores de fecha por defecto: el mes en curso ----------
document.getElementById('erDesde').value = primerDiaMesISO();
document.getElementById('erHasta').value = hoyISO();
document.getElementById('fcDesde').value = primerDiaMesISO();
document.getElementById('fcHasta').value = hoyISO();
document.getElementById('balFecha').value = hoyISO();

// ---------- Tabla genérica a partir de "filas" [{concepto, monto}] ----------
// Las filas de total/subtotal (o los encabezados de sección "ACTIVO"/
// "PASIVO" del balance, que llegan con monto=null) se resaltan por el
// TEXTO del concepto, no por un campo aparte en la respuesta: así
// `filas` se queda igual de simple en pantalla que en el archivo
// exportado.
const ES_DESTACADA = /^(total|utilidad|flujo neto|patrimonio)\b/i;
function pintarTablaFilas(idTbody, filas, colspan) {
  const tbody = document.getElementById(idTbody);
  if (!filas || !filas.length) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="vacio">Sin datos para este período.</td></tr>`;
    return;
  }
  tbody.innerHTML = filas.map((f) => {
    const esCabeceraSeccion = f.monto === null || f.monto === undefined;
    const destacada = !esCabeceraSeccion && ES_DESTACADA.test(f.concepto);
    const clase = esCabeceraSeccion ? 'fila-seccion' : (destacada ? 'fila-total' : '');
    return `<tr class="${clase}">
      <td class="izq">${esc(f.concepto)}</td>
      <td class="der">${esCabeceraSeccion ? '' : money(f.monto)}</td>
    </tr>`;
  }).join('');
}

// ============================================================
//  ESTADO DE RESULTADOS
// ============================================================
async function cargarEstadoResultados() {
  const desde = document.getElementById('erDesde').value;
  const hasta = document.getElementById('erHasta').value;
  const aviso = document.getElementById('erAviso');
  aviso.textContent = '';
  try {
    const d = await API.informeEstadoResultados({ desde, hasta });
    document.getElementById('erPeriodoTxt').textContent = `Período: ${d.periodo.desde} al ${d.periodo.hasta}`;
    document.getElementById('erIngresos').textContent = moneyTxt(d.ingresos.total);
    document.getElementById('erCosto').textContent = moneyTxt(d.costo_ventas);
    document.getElementById('erUtilBruta').innerHTML = money(d.utilidad_bruta);
    document.getElementById('erGastos').textContent = moneyTxt(d.gastos.total);
    document.getElementById('erUtilNeta').innerHTML = money(d.utilidad_neta);
    pintarTablaFilas('erTbody', d.filas, 2);
  } catch (e) {
    aviso.textContent = e.message;
  }
}
document.getElementById('erVer').addEventListener('click', cargarEstadoResultados);
document.getElementById('erExcel').addEventListener('click', () => descargarErCsvOExcel('xlsx'));
document.getElementById('erCsv').addEventListener('click', () => descargarErCsvOExcel('csv'));
document.getElementById('erImprimir').addEventListener('click', () => window.print());
async function descargarErCsvOExcel(formato) {
  const aviso = document.getElementById('erAviso');
  aviso.textContent = '';
  try {
    await descargarInforme('/informes/estado-resultados', {
      desde: document.getElementById('erDesde').value,
      hasta: document.getElementById('erHasta').value,
    }, formato);
  } catch (e) {
    aviso.textContent = e.message;
  }
}

// ============================================================
//  BALANCE GENERAL
// ============================================================
async function cargarBalance() {
  const fecha = document.getElementById('balFecha').value;
  const aviso = document.getElementById('balAviso');
  aviso.textContent = '';
  try {
    const d = await API.informeBalance({ fecha });
    document.getElementById('balFechaTxt').textContent = `Corte al: ${d.fecha}`;
    document.getElementById('balActivoTotal').textContent = moneyTxt(d.activo.total);
    document.getElementById('balPasivoTotal').textContent = moneyTxt(d.pasivo.total);
    document.getElementById('balPatrimonio').innerHTML = money(d.patrimonio.monto);
    document.getElementById('balNota').textContent = d.patrimonio.nota;
    pintarTablaFilas('balTbody', d.filas, 2);
  } catch (e) {
    aviso.textContent = e.message;
  }
}
document.getElementById('balVer').addEventListener('click', cargarBalance);
document.getElementById('balExcel').addEventListener('click', () => descargarBalCsvOExcel('xlsx'));
document.getElementById('balCsv').addEventListener('click', () => descargarBalCsvOExcel('csv'));
document.getElementById('balImprimir').addEventListener('click', () => window.print());
async function descargarBalCsvOExcel(formato) {
  const aviso = document.getElementById('balAviso');
  aviso.textContent = '';
  try {
    await descargarInforme('/informes/balance', { fecha: document.getElementById('balFecha').value }, formato);
  } catch (e) {
    aviso.textContent = e.message;
  }
}

// ============================================================
//  FLUJO DE CAJA
// ============================================================
function pintarDetalleFlujo(detalle) {
  const tbody = document.getElementById('fcDetalleTbody');
  if (!detalle || !detalle.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="vacio">Sin movimientos en este período.</td></tr>';
    return;
  }
  tbody.innerHTML = detalle.map((m) => `
    <tr>
      <td>${esc(new Date(m.fecha).toLocaleDateString('es-CU'))}</td>
      <td>${esc(m.origen)}</td>
      <td>${esc(m.tipo)}</td>
      <td class="izq">${esc(m.concepto || '')}</td>
      <td class="der">${money(m.monto)}</td>
    </tr>`).join('');
}

async function cargarFlujoCaja() {
  const desde = document.getElementById('fcDesde').value;
  const hasta = document.getElementById('fcHasta').value;
  const aviso = document.getElementById('fcAviso');
  aviso.textContent = '';
  try {
    const d = await API.informeFlujoCaja({ desde, hasta });
    document.getElementById('fcPeriodoTxt').textContent = `Período: ${d.periodo.desde} al ${d.periodo.hasta}`;
    document.getElementById('fcEntradas').textContent = moneyTxt(d.entradas.total);
    document.getElementById('fcSalidas').textContent = moneyTxt(d.salidas.total);
    document.getElementById('fcNeto').innerHTML = money(d.neto);
    document.getElementById('fcRefTxt').textContent =
      'Aparte, y sin sumar al flujo de arriba (para no contar dos veces el mismo dinero si ya entró por banco o caja): ' +
      `cobros registrados en cuentas por cobrar ${moneyTxt(d.referencia.cobros_registrados)} CUP · ` +
      `pagos registrados en cuentas por pagar ${moneyTxt(d.referencia.pagos_registrados)} CUP.`;
    pintarTablaFilas('fcTbody', d.filas, 2);
    pintarDetalleFlujo(d.detalle);
  } catch (e) {
    aviso.textContent = e.message;
  }
}
document.getElementById('fcVer').addEventListener('click', cargarFlujoCaja);
document.getElementById('fcExcel').addEventListener('click', () => descargarFcCsvOExcel('xlsx'));
document.getElementById('fcCsv').addEventListener('click', () => descargarFcCsvOExcel('csv'));
document.getElementById('fcImprimir').addEventListener('click', () => window.print());
async function descargarFcCsvOExcel(formato) {
  const aviso = document.getElementById('fcAviso');
  aviso.textContent = '';
  try {
    await descargarInforme('/informes/flujo-caja', {
      desde: document.getElementById('fcDesde').value,
      hasta: document.getElementById('fcHasta').value,
    }, formato);
  } catch (e) {
    aviso.textContent = e.message;
  }
}

// ---------- Carga inicial: la primera pestaña activa ----------
cargarEstadoResultados();
