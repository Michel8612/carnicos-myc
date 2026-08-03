// ============================================================
//  CONCILIACIÓN DE INVENTARIO — el conteo físico del almacén
//
//  Dos vistas en una sola página (sin recargar): el HISTORIAL de
//  conteos y el CONTEO ABIERTO (o cerrado/anulado, para revisar y
//  reimprimir). Se cambia mostrando/ocultando los bloques, igual que
//  hacen otras pantallas de este sistema.
//
//  Guardado por fila, no por formulario entero: quien cuenta va con el
//  teléfono en la mano por el almacén y la conexión se corta a cada
//  rato — un botón "guardar todo" al final se llevaría media hora de
//  trabajo si falla justo antes de pulsarlo.
// ============================================================

if (!soloRoles(['almacen', 'almacenero', 'almacen_central'])) {
  throw new Error('sin acceso');
}

// El dueño ve el enlace para volver al panel; los almaceneros no.
if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = '';
  nav.href = 'admin.html';
}

// ---------- Elementos ----------
const $vistaHistorial = document.getElementById('vistaHistorial');
const $vistaConteo = document.getElementById('vistaConteo');

const $selAlmacenAbrir = document.getElementById('selAlmacenAbrir');
const $notaAbrir = document.getElementById('notaAbrir');
const $btnAbrirConteo = document.getElementById('btnAbrirConteo');
const $errorAbrir = document.getElementById('errorAbrir');
const $listaHistorial = document.getElementById('listaHistorial');

const $btnVolver = document.getElementById('btnVolver');
const $tituloConteo = document.getElementById('tituloConteo');
const $infoConteo = document.getElementById('infoConteo');
const $resContadas = document.getElementById('resContadas');
const $resDiferencias = document.getElementById('resDiferencias');
const $lineasConteo = document.getElementById('lineasConteo');
const $accionesConteo = document.getElementById('accionesConteo');
const $btnCerrarConteo = document.getElementById('btnCerrarConteo');
const $btnAnularConteo = document.getElementById('btnAnularConteo');
const $errorConteo = document.getElementById('errorConteo');
const $btnExcel = document.getElementById('btnExcel');
const $btnCsv = document.getElementById('btnCsv');
const $btnImprimir = document.getElementById('btnImprimir');
const $fechaEmision = document.getElementById('fechaEmision');

const $modalCerrar = document.getElementById('modalCerrar');
const $btnCerrarAjustando = document.getElementById('btnCerrarAjustando');
const $btnCerrarConstancia = document.getElementById('btnCerrarConstancia');
const $btnCancelarCerrar = document.getElementById('btnCancelarCerrar');
const $errorModalCerrar = document.getElementById('errorModalCerrar');

// Conteo que se está viendo ahora mismo (con sus líneas), para no
// tener que releer el DOM cada vez que hace falta un dato.
let conteoActual = null;

const ESTADO_ETIQUETA = { abierta: 'Abierta', cerrada: 'Cerrada', anulada: 'Anulada' };
const ESTADO_CLASE = { abierta: 'b-abierta', cerrada: 'b-cerrada', anulada: 'b-anulada' };

function fechaLegible(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CU', { dateStyle: 'medium', timeStyle: 'short' });
}

// Redondeo a 3 decimales igual que en el servidor: es solo para la
// vista previa EN VIVO (antes de guardar), para que lo que el usuario
// ve mientras teclea ya coincida con lo que el servidor va a calcular.
function redondear(n) {
  return Math.round(n * 1000) / 1000;
}

function formatearNumero(n) {
  if (n === null || n === undefined) return '';
  // Hasta 3 decimales, sin ceros de relleno inútiles (3.500 -> 3.5).
  return Number(n).toLocaleString('es-CU', { maximumFractionDigits: 3 });
}

function claseDiferencia(dif) {
  if (dif === null || dif === undefined || Number(dif) === 0) return 'dif-cero';
  return Number(dif) > 0 ? 'dif-sobra' : 'dif-falta';
}

function textoDiferencia(dif) {
  if (dif === null || dif === undefined) return '—';
  const n = Number(dif);
  return (n > 0 ? '+' : '') + formatearNumero(n);
}

function mostrarVista(cual) {
  if (cual === 'historial') {
    $vistaConteo.classList.add('oculto');
    $vistaHistorial.classList.remove('oculto');
  } else {
    $vistaHistorial.classList.add('oculto');
    $vistaConteo.classList.remove('oculto');
  }
}

// ============================================================
//  VISTA 1 — Historial
// ============================================================

async function cargarAlmacenesSelect() {
  try {
    const almacenes = await API.almacenes();
    $selAlmacenAbrir.innerHTML = almacenes.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join('')
      || '<option value="">No hay almacenes</option>';
  } catch (e) {
    $selAlmacenAbrir.innerHTML = '<option value="">No se pudo cargar</option>';
  }
}

function pintarHistorial(lista) {
  if (!lista.length) {
    $listaHistorial.innerHTML = '<p class="vacio">Todavía no se ha hecho ningún conteo.</p>';
    return;
  }
  $listaHistorial.innerHTML = lista.map((c) => `
    <div class="hist-fila" data-id="${c.id}">
      <div class="hist-info">
        <strong>${c.almacen_nombre || 'Almacén'}</strong>
        <small>${fechaLegible(c.creado_en)} · Abierto por ${c.usuario_nombre || '—'}</small>
        <small>${Number(c.lineas) || 0} producto(s)</small>
      </div>
      <div class="hist-derecha">
        <span class="badge ${ESTADO_CLASE[c.estado] || ''}">${ESTADO_ETIQUETA[c.estado] || c.estado}</span>
        ${Number(c.lineas_con_diferencia) > 0 ? `<div class="hist-dif">${c.lineas_con_diferencia} con diferencia</div>` : ''}
      </div>
    </div>
  `).join('');
}

async function cargarHistorial() {
  $listaHistorial.innerHTML = '<p class="vacio">Cargando…</p>';
  try {
    pintarHistorial(await API.conciliaciones());
  } catch (e) {
    $listaHistorial.innerHTML = `<p class="vacio">${e.message}</p>`;
  }
}

$listaHistorial.addEventListener('click', (ev) => {
  const fila = ev.target.closest('.hist-fila');
  if (!fila) return;
  verConteo(Number(fila.dataset.id));
});

$btnAbrirConteo.addEventListener('click', async () => {
  $errorAbrir.style.display = 'none';
  const almacenId = Number($selAlmacenAbrir.value);
  if (!almacenId) {
    $errorAbrir.textContent = 'Elija un almacén.';
    $errorAbrir.style.display = '';
    return;
  }
  $btnAbrirConteo.disabled = true;
  try {
    const conteo = await API.conciliacionAbrir({ almacen_id: almacenId, nota: $notaAbrir.value.trim() });
    $notaAbrir.value = '';
    mostrarConteo(conteo);
    mostrarVista('conteo');
  } catch (e) {
    $errorAbrir.textContent = e.message;
    $errorAbrir.style.display = '';
  } finally {
    $btnAbrirConteo.disabled = false;
  }
});

$btnVolver.addEventListener('click', () => {
  mostrarVista('historial');
  cargarHistorial();
});

// ============================================================
//  VISTA 2 — El conteo
// ============================================================

async function verConteo(id) {
  try {
    const conteo = await API.conciliacion(id);
    mostrarConteo(conteo);
    mostrarVista('conteo');
  } catch (e) {
    alert(e.message);
  }
}

function mostrarConteo(conteo) {
  conteoActual = conteo;
  $errorConteo.style.display = 'none';

  $tituloConteo.textContent = `Conteo físico — ${conteo.almacen_nombre || 'Almacén'}`;
  $infoConteo.innerHTML = `
    <div><b>Almacén:</b> ${conteo.almacen_nombre || '—'}</div>
    <div><b>Estado:</b> <span class="badge ${ESTADO_CLASE[conteo.estado] || ''}">${ESTADO_ETIQUETA[conteo.estado] || conteo.estado}</span></div>
    <div><b>Abierto por:</b> ${conteo.usuario_nombre || '—'} — ${fechaLegible(conteo.creado_en)}</div>
    ${conteo.cerrada_en ? `<div><b>Cerrado:</b> ${fechaLegible(conteo.cerrada_en)}</div>` : ''}
    ${conteo.nota ? `<div><b>Nota:</b> ${conteo.nota}</div>` : ''}
  `;
  $fechaEmision.textContent = `Emitido el ${fechaLegible(new Date().toISOString())}`;

  // Solo un conteo ABIERTO admite tocarse; uno cerrado o anulado es acta
  // firmada — se ve, se exporta, se imprime, pero no se toca.
  const editable = conteo.estado === 'abierta';
  $accionesConteo.style.display = editable ? '' : 'none';

  pintarLineas(conteo.lineas || [], editable);
  actualizarResumen();
}

function pintarLineas(lineas, editable) {
  $lineasConteo.innerHTML = lineas.map((l) => `
    <tr data-id="${l.id}">
      <td>${l.producto_nombre}</td>
      <td>${l.unidad || ''}</td>
      <td class="num">${formatearNumero(l.existencia_sistema)}</td>
      <td>
        ${editable
          ? `<input type="number" step="0.001" min="0" class="input-contado" value="${l.existencia_fisica ?? ''}" placeholder="—">`
          : ''}
        <span class="solo-impresion">${formatearNumero(l.existencia_fisica)}</span>
      </td>
      <td class="num">
        <span class="celda-diferencia ${claseDiferencia(l.diferencia)}">${textoDiferencia(l.diferencia)}</span>
      </td>
      <td class="celda-motivo">
        ${editable
          ? `<input type="text" class="input-motivo" value="${l.motivo ? escaparHtml(l.motivo) : ''}" placeholder="Motivo (opcional)">`
          : (l.motivo || '')}
        <span class="solo-impresion">${l.motivo || ''}</span>
        <div class="fila-msg"></div>
      </td>
    </tr>
  `).join('');
}

// Escapa lo mínimo para poder meter el motivo dentro de un atributo
// value="..." sin que un usuario que escriba comillas rompa el HTML.
function escaparHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function actualizarResumen() {
  const lineas = (conteoActual && conteoActual.lineas) || [];
  const total = lineas.length;
  const contadas = lineas.filter((l) => l.existencia_fisica !== null && l.existencia_fisica !== undefined).length;
  const conDiferencia = lineas.filter((l) => l.diferencia !== null && l.diferencia !== undefined && Number(l.diferencia) !== 0).length;
  $resContadas.textContent = `${contadas} / ${total}`;
  $resDiferencias.textContent = conDiferencia;
}

// ---- Vista en vivo mientras se teclea (antes de guardar) ----
$lineasConteo.addEventListener('input', (ev) => {
  if (!ev.target.classList.contains('input-contado')) return;
  const tr = ev.target.closest('tr');
  const id = Number(tr.dataset.id);
  const linea = (conteoActual.lineas || []).find((l) => l.id === id);
  if (!linea) return;

  const crudo = ev.target.value;
  const fisica = crudo === '' ? null : redondear(Number(crudo));
  const dif = fisica === null ? null : redondear(fisica - linea.existencia_sistema);

  const celda = tr.querySelector('.celda-diferencia');
  celda.textContent = textoDiferencia(dif);
  celda.className = `celda-diferencia ${claseDiferencia(dif)}`;
});

// ---- Guardado por fila, al perder el foco (funciona con blur porque
//      se usa 'focusout', que SÍ burbujea hasta el <tbody>) ----
$lineasConteo.addEventListener('focusout', async (ev) => {
  const campo = ev.target;
  if (!campo.classList.contains('input-contado') && !campo.classList.contains('input-motivo')) return;

  const tr = campo.closest('tr');
  const id = Number(tr.dataset.id);
  const $msg = tr.querySelector('.fila-msg');
  const inputContado = tr.querySelector('.input-contado');
  const inputMotivo = tr.querySelector('.input-motivo');

  // Se mandan SIEMPRE los dos campos juntos (aunque solo uno haya
  // cambiado): la ruta PUT /lineas/:id guarda lo que reciba tal cual,
  // así que mandar solo uno pisaría el otro con vacío.
  const cuerpo = {
    existencia_fisica: inputContado ? inputContado.value : undefined,
    motivo: inputMotivo ? inputMotivo.value : undefined,
  };

  $msg.textContent = 'Guardando…';
  $msg.className = 'fila-msg';
  try {
    const actualizada = await API.conciliacionLinea(id, cuerpo);
    const idx = conteoActual.lineas.findIndex((l) => l.id === id);
    if (idx >= 0) conteoActual.lineas[idx] = actualizada;

    const celda = tr.querySelector('.celda-diferencia');
    celda.textContent = textoDiferencia(actualizada.diferencia);
    celda.className = `celda-diferencia ${claseDiferencia(actualizada.diferencia)}`;
    if (inputContado) inputContado.value = actualizada.existencia_fisica ?? '';
    if (inputMotivo) inputMotivo.value = actualizada.motivo ?? '';

    $msg.textContent = 'Guardado ✓';
    $msg.className = 'fila-msg ok';
    actualizarResumen();
    setTimeout(() => { if ($msg.textContent === 'Guardado ✓') $msg.textContent = ''; }, 2000);
  } catch (e) {
    $msg.textContent = e.message || 'No se pudo guardar. Toque el campo de nuevo para reintentar.';
    $msg.className = 'fila-msg malo';
  }
});

// Enter en el teléfono cierra el teclado y dispara el guardado, en vez
// de dejar el cursor esperando ahí.
$lineasConteo.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.target.classList.contains('input-contado') || ev.target.classList.contains('input-motivo'))) {
    ev.target.blur();
  }
});

// ============================================================
//  Cerrar conteo
// ============================================================

$btnCerrarConteo.addEventListener('click', () => {
  $errorModalCerrar.style.display = 'none';
  $modalCerrar.classList.remove('oculto');
});
$btnCancelarCerrar.addEventListener('click', () => $modalCerrar.classList.add('oculto'));

async function cerrarConteo(ajustar) {
  $errorModalCerrar.style.display = 'none';
  $btnCerrarAjustando.disabled = true;
  $btnCerrarConstancia.disabled = true;
  try {
    await API.conciliacionCerrar(conteoActual.id, { ajustar });
    $modalCerrar.classList.add('oculto');
    await verConteo(conteoActual.id);
  } catch (e) {
    $errorModalCerrar.textContent = e.message;
    $errorModalCerrar.style.display = '';
  } finally {
    $btnCerrarAjustando.disabled = false;
    $btnCerrarConstancia.disabled = false;
  }
}
$btnCerrarAjustando.addEventListener('click', () => cerrarConteo(true));
$btnCerrarConstancia.addEventListener('click', () => cerrarConteo(false));

// ============================================================
//  Anular conteo
// ============================================================

$btnAnularConteo.addEventListener('click', async () => {
  const motivo = prompt('Motivo de la anulación (obligatorio):', '');
  if (motivo === null) return; // canceló
  if (!motivo.trim()) {
    alert('Debe indicar un motivo para anular el conteo.');
    return;
  }
  try {
    await API.conciliacionAnular(conteoActual.id, motivo.trim());
    await verConteo(conteoActual.id);
  } catch (e) {
    $errorConteo.textContent = e.message;
    $errorConteo.style.display = '';
  }
});

// ============================================================
//  Exportar e imprimir — este es el papel que se firma
// ============================================================

$btnExcel.addEventListener('click', async () => {
  try {
    await descargarInforme('/conciliaciones/' + conteoActual.id, {}, 'xlsx');
  } catch (e) {
    alert(e.message);
  }
});
$btnCsv.addEventListener('click', async () => {
  try {
    await descargarInforme('/conciliaciones/' + conteoActual.id, {}, 'csv');
  } catch (e) {
    alert(e.message);
  }
});
$btnImprimir.addEventListener('click', () => window.print());

// ============================================================
//  Arranque
// ============================================================
cargarAlmacenesSelect();
cargarHistorial();
