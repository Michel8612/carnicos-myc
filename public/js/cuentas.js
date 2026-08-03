// ============================================================
//  Cuentas por cobrar y por pagar (§10.3)
//
//  Una sola pantalla con dos pestañas (cobrar/pagar) que hablan con
//  las MISMAS rutas del backend, cambiando solo el parámetro `tipo`:
//  la tabla es simétrica (ver comentario en cuentas.js del backend),
//  así que la pantalla también lo es.
// ============================================================

if (!soloRoles(['contabilidad'])) { throw new Error('sin acceso'); }

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = '';
  nav.href = 'admin.html';
}

// ---------- Utilidades de formato ----------
const money = (n) => Number(n ?? 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
function fechaFmt(f) {
  if (!f) return '—';
  // Las fechas llegan como 'YYYY-MM-DD' (columna DATE): se parte a mano
  // en vez de usar `new Date(f)` para no arrastrar el lío de zona
  // horaria que corre "un día" hacia atrás una fecha sin hora.
  const [a, m, d] = String(f).slice(0, 10).split('-');
  return d && m && a ? `${d}/${m}/${a}` : '—';
}
function hoyISO() { return new Date().toISOString().slice(0, 10); }
// Días que faltan para vencer (negativo si ya venció). Mismo criterio
// de "sin horas" que fechaFmt, para que no varíe según la hora del día.
function diasHasta(fechaISO) {
  if (!fechaISO) return null;
  const hoy = new Date(hoyISO() + 'T00:00:00');
  const venc = new Date(String(fechaISO).slice(0, 10) + 'T00:00:00');
  return Math.round((venc - hoy) / 86400000);
}

// ---------- Estado en memoria ----------
let tipoActual = 'cobrar';
let filasActuales = []; // caché de la última tabla pintada: para abrir modales sin pedirle otra vez al servidor
let cuentaModal = null; // id de la cuenta que están usando los modales de pago/edición

// ---------- Pestañas Por cobrar / Por pagar ----------
document.querySelectorAll('#tabsTipo button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tabsTipo button').forEach((x) => x.classList.remove('activo'));
    b.classList.add('activo');
    tipoActual = b.dataset.tipo;
    document.getElementById('panelAntiguedad').classList.add('oculto');
    cargarListado();
  });
});

// ---------- Listado principal ----------
function filtrosActuales() {
  const p = { tipo: tipoActual };
  const tercero = document.getElementById('fTercero').value.trim();
  const estado = document.getElementById('fEstado').value;
  if (tercero) p.tercero = tercero;
  if (estado) p.estado = estado;
  if (document.getElementById('fVencidas').checked) p.vencidas = '1';
  return p;
}

function claseEstado(fila) {
  if (fila.estado === 'anulada') return 'e-anulada';
  if (fila.estado === 'pagada') return 'e-pagada';
  if (Number(fila.dias_vencida) > 0) return 'e-vencida';
  const faltan = diasHasta(fila.fecha_vencimiento);
  if (faltan !== null && faltan >= 0 && faltan <= 7) return 'e-pronto';
  return 'e-aldia';
}

function etiquetaEstado(fila) {
  const BASE = { pendiente: 'Pendiente', parcial: 'Parcial', pagada: 'Pagada', anulada: 'Anulada' };
  if (Number(fila.dias_vencida) > 0) return `Vencida (${fila.dias_vencida} días)`;
  return BASE[fila.estado] || fila.estado;
}

function pintarTarjetas(totales) {
  document.getElementById('kPendiente').textContent = money(totales.saldo);
  document.getElementById('kVencido').textContent = money(totales.vencido);
  document.getElementById('kDocs').textContent = totales.documentos;
}

function pintarTabla(filas) {
  const $tb = document.getElementById('tbCuentas');
  if (!filas.length) {
    $tb.innerHTML = '<tr><td colspan="9" class="vacio">No hay documentos que cumplan el filtro.</td></tr>';
    return;
  }
  $tb.innerHTML = filas.map((f) => {
    const anulada = f.estado === 'anulada';
    const puedePagar = !anulada && f.estado !== 'pagada';
    const puedeEditar = !anulada && f.estado !== 'pagada';
    return `
    <tr class="${anulada ? 'fila-anulada' : ''}" data-id="${f.id}">
      <td class="izq">${esc(f.tercero)}</td>
      <td class="izq">${esc(f.documento) || '—'}</td>
      <td class="izq">${esc(f.concepto) || '—'}</td>
      <td>${money(f.monto)} ${esc(f.moneda)}</td>
      <td>${money(f.pagado)}</td>
      <td>${money(f.saldo)}</td>
      <td>${fechaFmt(f.fecha_vencimiento)}</td>
      <td><span class="etq-estado ${claseEstado(f)}">${etiquetaEstado(f)}</span></td>
      <td>
        <div class="acciones-fila">
          <button class="b-pagar" data-accion="pagar" ${puedePagar ? '' : 'disabled'} type="button">Pagar</button>
          <button class="b-ver" data-accion="ver" type="button">Ver pagos</button>
          <button class="b-editar" data-accion="editar" ${puedeEditar ? '' : 'disabled'} type="button">Editar</button>
          <button class="b-anular" data-accion="anular" ${anulada ? 'disabled' : ''} type="button">Anular</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function cargarListado() {
  document.getElementById('tbCuentas').innerHTML = '<tr><td colspan="9" class="vacio">Cargando…</td></tr>';
  try {
    const { filas, totales } = await API.cuentasTerceros(filtrosActuales());
    filasActuales = filas;
    pintarTarjetas(totales);
    pintarTabla(filas);
  } catch (e) {
    document.getElementById('tbCuentas').innerHTML = `<tr><td colspan="9" class="vacio">${esc(e.message)}</td></tr>`;
  }
}

document.getElementById('btnBuscar').addEventListener('click', cargarListado);
document.getElementById('fTercero').addEventListener('keyup', (ev) => { if (ev.key === 'Enter') cargarListado(); });
document.getElementById('fEstado').addEventListener('change', cargarListado);
document.getElementById('fVencidas').addEventListener('change', cargarListado);

// ---------- Panel plegable: nuevo documento ----------
const $panelNuevo = document.getElementById('panelNuevo');
document.getElementById('btnNuevo').addEventListener('click', () => {
  $panelNuevo.classList.toggle('oculto');
  if (!document.getElementById('nFechaEmision').value) document.getElementById('nFechaEmision').value = hoyISO();
});

document.getElementById('btnGuardarNuevo').addEventListener('click', async () => {
  const $err = document.getElementById('nuevoError');
  $err.textContent = '';

  const datos = {
    tipo: tipoActual,
    tercero: document.getElementById('nTercero').value.trim(),
    documento: document.getElementById('nDocumento').value.trim(),
    concepto: document.getElementById('nConcepto').value.trim(),
    monto: Number(document.getElementById('nMonto').value),
    moneda: document.getElementById('nMoneda').value,
    fecha_emision: document.getElementById('nFechaEmision').value || hoyISO(),
    fecha_vencimiento: document.getElementById('nFechaVencimiento').value || null,
    nota: document.getElementById('nNota').value.trim(),
  };

  if (!datos.tercero) { $err.textContent = 'El cliente o proveedor es obligatorio.'; return; }
  if (!Number.isFinite(datos.monto) || datos.monto <= 0) { $err.textContent = 'El monto debe ser mayor que cero.'; return; }

  try {
    await API.cuentaTerceroCrear(datos);
    ['nTercero', 'nDocumento', 'nConcepto', 'nMonto', 'nFechaVencimiento', 'nNota'].forEach((id) => { document.getElementById(id).value = ''; });
    $panelNuevo.classList.add('oculto');
    cargarListado();
  } catch (e) {
    $err.textContent = e.message;
  }
});

// ---------- Acciones de cada fila (delegado: la tabla se repinta entera en cada carga) ----------
document.getElementById('tbCuentas').addEventListener('click', (ev) => {
  const boton = ev.target.closest('button[data-accion]');
  if (!boton) return;
  const id = Number(boton.closest('tr').dataset.id);
  const fila = filasActuales.find((f) => f.id === id);
  if (!fila) return;

  if (boton.dataset.accion === 'pagar') abrirModalPago(fila);
  if (boton.dataset.accion === 'ver') abrirModalVerPagos(fila);
  if (boton.dataset.accion === 'editar') abrirModalEditar(fila);
  if (boton.dataset.accion === 'anular') anularDocumento(fila);
});

async function anularDocumento(fila) {
  const motivo = prompt(`Motivo de la anulación de "${fila.tercero} — ${fila.documento || 'sin documento'}" (obligatorio):`);
  if (motivo == null) return; // canceló el prompt
  if (!motivo.trim()) { alert('Debe indicar un motivo.'); return; }
  try {
    await API.cuentaTerceroAnular(fila.id, motivo.trim());
    cargarListado();
  } catch (e) {
    alert(e.message);
  }
}

// ---------- Modal: registrar pago ----------
const $modalPago = document.getElementById('modalPago');
function abrirModalPago(fila) {
  cuentaModal = fila.id;
  document.getElementById('pgResumen').textContent =
    `${fila.tercero} — saldo pendiente: ${money(fila.saldo)} ${fila.moneda}`;
  document.getElementById('pgMonto').value = fila.saldo;
  document.getElementById('pgFecha').value = hoyISO();
  document.getElementById('pgMetodo').value = 'efectivo';
  document.getElementById('pgReferencia').value = '';
  document.getElementById('pgNota').value = '';
  document.getElementById('pgError').style.display = 'none';
  $modalPago.classList.add('abierto');
}
function cerrarModalPago() { $modalPago.classList.remove('abierto'); }
document.getElementById('pgCancelar').addEventListener('click', cerrarModalPago);
$modalPago.addEventListener('click', (ev) => { if (ev.target === $modalPago) cerrarModalPago(); });

document.getElementById('pgGuardar').addEventListener('click', async () => {
  const $err = document.getElementById('pgError');
  $err.style.display = 'none';
  const datos = {
    monto: Number(document.getElementById('pgMonto').value),
    fecha: document.getElementById('pgFecha').value || hoyISO(),
    metodo: document.getElementById('pgMetodo').value,
    referencia: document.getElementById('pgReferencia').value.trim(),
    nota: document.getElementById('pgNota').value.trim(),
  };
  if (!Number.isFinite(datos.monto) || datos.monto <= 0) {
    $err.textContent = 'El monto debe ser mayor que cero.'; $err.style.display = 'block'; return;
  }
  try {
    await API.cuentaTerceroPagar(cuentaModal, datos);
    cerrarModalPago();
    cargarListado();
  } catch (e) {
    $err.textContent = e.message; $err.style.display = 'block';
  }
});

// ---------- Modal: ver pagos ----------
const $modalVerPagos = document.getElementById('modalVerPagos');
async function abrirModalVerPagos(fila) {
  cuentaModal = fila.id;
  document.getElementById('vpResumen').textContent = `${fila.tercero} — ${fila.documento || 'sin documento'}`;
  document.getElementById('vpError').style.display = 'none';
  const $tb = document.getElementById('tbPagosModal');
  $tb.innerHTML = '<tr><td colspan="5">Cargando…</td></tr>';
  $modalVerPagos.classList.add('abierto');
  try {
    const pagos = await API.cuentaTerceroPagos(fila.id);
    pintarPagosModal(pagos);
  } catch (e) {
    $tb.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`;
  }
}
function pintarPagosModal(pagos) {
  const $tb = document.getElementById('tbPagosModal');
  if (!pagos.length) {
    $tb.innerHTML = '<tr><td colspan="5">Este documento no tiene pagos registrados.</td></tr>';
    return;
  }
  $tb.innerHTML = pagos.map((p) => `
    <tr data-id="${p.id}">
      <td>${fechaFmt(p.fecha)}</td>
      <td>${money(p.monto)}</td>
      <td>${esc(p.metodo) || '—'}</td>
      <td>${esc(p.usuario_nombre) || '—'}</td>
      <td><button class="btn-borrar-pago" type="button">Borrar</button></td>
    </tr>`).join('');
}
document.getElementById('vpCerrar').addEventListener('click', () => $modalVerPagos.classList.remove('abierto'));
$modalVerPagos.addEventListener('click', (ev) => { if (ev.target === $modalVerPagos) $modalVerPagos.classList.remove('abierto'); });

document.getElementById('tbPagosModal').addEventListener('click', async (ev) => {
  const boton = ev.target.closest('.btn-borrar-pago');
  if (!boton) return;
  const pagoId = Number(boton.closest('tr').dataset.id);
  const motivo = prompt('Motivo del borrado de este pago (obligatorio):');
  if (motivo == null) return;
  if (!motivo.trim()) { alert('Debe indicar un motivo.'); return; }
  const $err = document.getElementById('vpError');
  try {
    await API.cuentaTerceroPagoBorrar(pagoId, motivo.trim());
    const pagos = await API.cuentaTerceroPagos(cuentaModal);
    pintarPagosModal(pagos);
    cargarListado(); // el saldo de la fila cambió
  } catch (e) {
    $err.textContent = e.message; $err.style.display = 'block';
  }
});

// ---------- Modal: editar documento ----------
const $modalEditar = document.getElementById('modalEditar');
function abrirModalEditar(fila) {
  cuentaModal = fila.id;
  document.getElementById('edTercero').value = fila.tercero || '';
  document.getElementById('edDocumento').value = fila.documento || '';
  document.getElementById('edConcepto').value = fila.concepto || '';
  document.getElementById('edMonto').value = fila.monto;
  document.getElementById('edFechaVencimiento').value = fila.fecha_vencimiento ? String(fila.fecha_vencimiento).slice(0, 10) : '';
  document.getElementById('edNota').value = fila.nota || '';
  document.getElementById('edError').style.display = 'none';

  // El importe solo se puede tocar si el documento no tiene pagos: si
  // ya cobró/pagó algo, cambiarlo desordenaría lo que ya se auditó.
  const tienePagos = Number(fila.pagado) > 0;
  document.getElementById('edMonto').disabled = tienePagos;
  document.getElementById('edMontoAviso').style.display = tienePagos ? 'block' : 'none';

  $modalEditar.classList.add('abierto');
}
document.getElementById('edCancelar').addEventListener('click', () => $modalEditar.classList.remove('abierto'));
$modalEditar.addEventListener('click', (ev) => { if (ev.target === $modalEditar) $modalEditar.classList.remove('abierto'); });

document.getElementById('edGuardar').addEventListener('click', async () => {
  const $err = document.getElementById('edError');
  $err.style.display = 'none';

  const tercero = document.getElementById('edTercero').value.trim();
  if (!tercero) { $err.textContent = 'El cliente o proveedor es obligatorio.'; $err.style.display = 'block'; return; }

  const datos = {
    tercero,
    documento: document.getElementById('edDocumento').value.trim(),
    concepto: document.getElementById('edConcepto').value.trim(),
    fecha_vencimiento: document.getElementById('edFechaVencimiento').value || null,
    nota: document.getElementById('edNota').value.trim(),
  };
  if (!document.getElementById('edMonto').disabled) {
    datos.monto = Number(document.getElementById('edMonto').value);
    if (!Number.isFinite(datos.monto) || datos.monto <= 0) {
      $err.textContent = 'El monto debe ser mayor que cero.'; $err.style.display = 'block'; return;
    }
  }

  try {
    await API.cuentaTerceroEditar(cuentaModal, datos);
    $modalEditar.classList.remove('abierto');
    cargarListado();
  } catch (e) {
    $err.textContent = e.message; $err.style.display = 'block';
  }
});

// ---------- Antigüedad de saldos ----------
const $panelAntiguedad = document.getElementById('panelAntiguedad');
document.getElementById('btnAntiguedad').addEventListener('click', () => {
  $panelAntiguedad.classList.toggle('oculto');
  if (!$panelAntiguedad.classList.contains('oculto')) cargarAntiguedad();
});

function pintarTarjetasAntig(tramos) {
  const $t = document.getElementById('tarjetasAntig');
  $t.innerHTML = `
    <div class="tarjeta"><div class="n">${money(tramos.tramo_0_30)}</div><div class="l">0 a 30 días</div></div>
    <div class="tarjeta"><div class="n">${money(tramos.tramo_31_60)}</div><div class="l">31 a 60 días</div></div>
    <div class="tarjeta"><div class="n">${money(tramos.tramo_61_90)}</div><div class="l">61 a 90 días</div></div>
    <div class="tarjeta c-rojo"><div class="n">${money(tramos.tramo_mas_90)}</div><div class="l">Más de 90 días</div></div>
    <div class="tarjeta c-azul"><div class="n">${money(tramos.total)}</div><div class="l">Total adeudado</div></div>
  `;
}

function pintarTablaAntig(detalle) {
  const $tb = document.getElementById('tbAntig');
  if (!detalle.length) {
    $tb.innerHTML = '<tr><td colspan="6" class="vacio">No hay saldos pendientes.</td></tr>';
    return;
  }
  $tb.innerHTML = detalle.map((d) => `
    <tr>
      <td class="izq">${esc(d.tercero)}</td>
      <td>${money(d.tramo_0_30)}</td>
      <td>${money(d.tramo_31_60)}</td>
      <td>${money(d.tramo_61_90)}</td>
      <td>${money(d.tramo_mas_90)}</td>
      <td><b>${money(d.total)}</b></td>
    </tr>`).join('');
}

async function cargarAntiguedad() {
  document.getElementById('tbAntig').innerHTML = '<tr><td colspan="6" class="vacio">Cargando…</td></tr>';
  try {
    const { tramos, detalle } = await API.cuentasAntiguedad({ tipo: tipoActual });
    pintarTarjetasAntig(tramos);
    pintarTablaAntig(detalle);
  } catch (e) {
    document.getElementById('tbAntig').innerHTML = `<tr><td colspan="6" class="vacio">${esc(e.message)}</td></tr>`;
  }
}

// ---------- Exportar (Excel / CSV) ----------
async function exportar(ruta, parametros, formato) {
  try {
    await descargarInforme(ruta, parametros, formato);
  } catch (e) {
    alert('No se pudo generar el archivo: ' + e.message);
  }
}
document.getElementById('btnExcelLista').addEventListener('click', () => exportar('/cuentas', filtrosActuales(), 'xlsx'));
document.getElementById('btnCsvLista').addEventListener('click', () => exportar('/cuentas', filtrosActuales(), 'csv'));
document.getElementById('btnExcelAntig').addEventListener('click', () => exportar('/cuentas/antiguedad', { tipo: tipoActual }, 'xlsx'));
document.getElementById('btnCsvAntig').addEventListener('click', () => exportar('/cuentas/antiguedad', { tipo: tipoActual }, 'csv'));

// ---------- Imprimir / PDF ----------
// No hay generación de PDF en el servidor (ver comentario en
// exportar.js del backend): se prepara la cabecera de impresión y se
// deja que el propio navegador la convierta en PDF con Ctrl+P.
function prepararImpresion(titulo, modo) {
  const ahora = new Date();
  document.getElementById('printTitulo').textContent = titulo;
  document.getElementById('printPeriodo').textContent =
    `${tipoActual === 'pagar' ? 'Por pagar' : 'Por cobrar'} — situación al ${fechaFmt(hoyISO())}`;
  document.getElementById('printPie').textContent =
    `Generado el ${ahora.toLocaleDateString('es-ES')} a las ${ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  // Marca en <body> cuál de las dos tablas va: si el panel de
  // antigüedad estaba abierto y se imprime el listado (o al revés),
  // la regla CSS de @media print usa esta clase para tapar la otra.
  document.body.classList.toggle('imprimir-antiguedad', modo === 'antiguedad');
}
document.getElementById('btnImprimirLista').addEventListener('click', () => {
  prepararImpresion('Cuentas por cobrar y por pagar', 'lista');
  window.print();
});
document.getElementById('btnImprimirAntig').addEventListener('click', () => {
  prepararImpresion('Antigüedad de saldos', 'antiguedad');
  window.print();
});
// Quitar la marca al terminar de imprimir (o cancelar): que no quede
// "pegada" si luego el usuario decide imprimir el otro informe.
window.addEventListener('afterprint', () => document.body.classList.remove('imprimir-antiguedad'));

// ---------- Arranque ----------
cargarListado();
