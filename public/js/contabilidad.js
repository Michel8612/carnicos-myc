// Área de Contabilidad — Cárnicos M&C
// SOLO LECTURA. Habla con el backend a través de js/api.js (window.API).
// Las respuestas de ganancia()/gastos() se tratan de forma defensiva
// porque su forma exacta puede variar; si algo no viene, se omite en
// vez de romper la página.

// Contabilidad: solo el rol Contabilidad (o el Dueño). Es SOLO LECTURA.
if (!soloRoles(['contabilidad'])) {
  throw new Error('sin acceso');
}

const resumenGanancia = document.getElementById('resumenGanancia');
const tablaGastos = document.getElementById('tablaGastos');
const mesActualSpan = document.getElementById('mesActual');

function cargarContabilidad() {
  const mesActual = new Date().toISOString().slice(0, 7);
  mesActualSpan.textContent = mesActual;

  // --- Ganancia / gastos, por moneda ---
  API.ganancia()
    .then((data) => {
      console.log('Respuesta de API.ganancia():', data);
      pintarResumen(data);
    })
    .catch((error) => {
      console.error('Error al cargar ganancia:', error);
      resumenGanancia.innerHTML = '<p>No se pudo cargar el resumen de ganancia.</p>';
    });

  // --- Detalle de gastos del mes ---
  API.gastos()
    .then((data) => {
      console.log('Respuesta de API.gastos():', data);
      pintarGastos(data);
    })
    .catch((error) => {
      console.error('Error al cargar gastos:', error);
      tablaGastos.innerHTML = '<tr><td colspan="5">No se pudo cargar el detalle de gastos.</td></tr>';
    });
}

function pintarResumen(data) {
  const porMoneda = (data && data.por_moneda) || {};
  const monedas = Object.keys(porMoneda);

  if (monedas.length === 0) {
    resumenGanancia.innerHTML = '<p>Sin movimientos este mes.</p>';
    return;
  }

  resumenGanancia.innerHTML = monedas.map((m) => {
    const r = porMoneda[m] || {};
    const costos = r.costos || {};
    const detalleCostos = Object.keys(costos)
      .map((cat) => `${cat}: ${Number(costos[cat] || 0).toFixed(2)}`)
      .join(' · ');

    return `
      <div class="resumen-moneda">
        <p><strong>Moneda:</strong> ${m}</p>
        <p><strong>Ventas:</strong> ${Number(r.ventas || 0).toFixed(2)}</p>
        <p><strong>Costos:</strong> ${Number(r.costoTotal || 0).toFixed(2)} (${detalleCostos || 'sin detalle'})</p>
        <p><strong>Ganancia:</strong> ${Number(r.ganancia || 0).toFixed(2)}</p>
        <p><strong>Margen:</strong> ${r.margen != null ? r.margen + '%' : 'N/D'}</p>
      </div>
    `;
  }).join('<hr>');
}

function pintarGastos(data) {
  const filas = (data && data.filas) || [];

  if (filas.length === 0) {
    tablaGastos.innerHTML = '<tr><td colspan="5">Sin gastos registrados este mes.</td></tr>';
    return;
  }

  tablaGastos.innerHTML = filas.map((g) => {
    const fecha = g.fecha ? new Date(g.fecha).toLocaleDateString() : '';
    return `
      <tr>
        <td>${g.categoria || ''}</td>
        <td>${g.concepto || ''}</td>
        <td>${Number(g.monto || 0).toFixed(2)}</td>
        <td>${g.moneda || ''}</td>
        <td>${fecha}</td>
      </tr>
    `;
  }).join('');
}

// Cargar datos al inicio
cargarContabilidad();
