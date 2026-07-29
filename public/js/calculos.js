// ============================================================
//  Cálculos y Producción — Cárnicos M&C (sin Firebase)
//
//  El usuario elige una receta, EL ALMACÉN de donde va a salir todo,
//  y dice CUÁNTAS LIBRAS (o kg/g) de producto final quiere. El sistema:
//   - extrapola cuánto de cada componente hace falta (regla de 3
//     sobre el rinde base de la receta),
//   - lo cruza con lo que hay EN ESE ALMACÉN (disponible / falta),
//   - calcula el costo total y por unidad,
//   - y permite REGISTRAR LA PRODUCCIÓN: queda en el historial de
//     cocina (qué se produjo, qué consumió y cuánto costó) Y AHORA
//     TAMBIÉN descuenta los ingredientes del almacén elegido. Si no
//     alcanza algún componente, el backend rechaza la producción
//     (400) y dice exactamente qué falta.
// ============================================================

// Solo el Cocinero (o el Dueño) calcula y produce.
if (!soloRoles(['cocinero'])) { throw new Error('sin acceso'); }

// El dueño ve el enlace para volver al panel; el cocinero no.
if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

let RECETAS = [];
let ALMACENES = [];

const selReceta = document.getElementById('selectReceta');
const selAlmacen = document.getElementById('selectAlmacen');
const inpCantidad = document.getElementById('cantidadProduccion');
const unidadObjetivo = document.getElementById('unidadObjetivo');
const unidadCosto = document.getElementById('unidadCosto');
const lblObjetivo = document.getElementById('lblObjetivo');
const cajaResultado = document.getElementById('resultadoCalculos');
const tabla = document.getElementById('tablaCalculos');
const avisoFalta = document.getElementById('avisoFalta');
const avisoResultado = document.getElementById('avisoResultado');
const panelHistorial = document.getElementById('panelHistorial');
const listaHistorial = document.getElementById('listaHistorial');

// Último cálculo hecho en pantalla, por si se quiere guardar.
let ULTIMO_CALCULO = null;

const fmt = (n) => Number(n ?? 0).toLocaleString('es-CU', { maximumFractionDigits: 3 });
const money = (n) => Number(n ?? 0).toLocaleString('es-CU', { maximumFractionDigits: 2 });

function recetaActual() {
  return RECETAS.find((r) => String(r.id) === String(selReceta.value));
}
function unidadDeReceta() {
  const r = recetaActual();
  return (r && r.rinde_unidad) || 'u';
}
// factor = cuántas veces la receta base = libras deseadas / rinde base
function factorActual() {
  const r = recetaActual();
  const objetivo = parseFloat(inpCantidad.value);
  if (!r || !objetivo || objetivo <= 0) return 0;
  const base = Number(r.rinde_cantidad) || 1;
  return objetivo / base;
}

async function cargar() {
  try { RECETAS = await API.recetas(); } catch { RECETAS = []; }
  try { ALMACENES = await API.almacenes(); } catch { ALMACENES = []; }

  selReceta.innerHTML = '<option value="">Elegir receta…</option>' +
    RECETAS.map((r) => `<option value="${r.id}">${r.nombre}</option>`).join('');
  selAlmacen.innerHTML = ALMACENES.map((a) => `<option value="${a.id}">${a.nombre}</option>`).join('');

  if (RECETAS.length === 0) {
    selReceta.innerHTML = '<option value="">No hay recetas — cree una primero</option>';
  }
}

function actualizarUnidad() {
  const u = unidadDeReceta();
  unidadObjetivo.textContent = u;
  unidadCosto.textContent = u;
  lblObjetivo.textContent = `¿Cuántas ${u} de producto final?`;
  const r = recetaActual();
  if (r && !inpCantidad.value) inpCantidad.value = r.rinde_cantidad; // sugerir el rinde base
}

async function calcular() {
  avisoResultado.style.display = 'none';
  const r = recetaActual();
  const almacenId = selAlmacen.value;
  const factor = factorActual();

  if (!r) { alert('Elija una receta.'); return; }
  if (!almacenId) { alert('Elija el almacén.'); return; }
  if (!factor || factor <= 0) { alert('Escriba cuántas ' + unidadDeReceta() + ' quiere producir.'); return; }

  let previa;
  try {
    previa = await API.recetaPrevia(r.id, factor, almacenId);
  } catch (e) { alert(e.message); return; }

  tabla.innerHTML = '';
  previa.ingredientes.forEach((ing) => {
    const tr = document.createElement('tr');
    if (!ing.alcanza) tr.classList.add('falta');
    tr.innerHTML = `
      <td>${ing.producto}</td>
      <td>${fmt(ing.necesita)} ${ing.unidad || ''}</td>
      <td>${fmt(ing.disponible)} ${ing.unidad || ''}${!ing.alcanza ? ` (faltan ${fmt(ing.falta)})` : ''}</td>
      <td>${money(ing.costo)}</td>`;
    tabla.appendChild(tr);
  });

  document.getElementById('costoTotal').textContent = money(previa.costo_total);
  const porUnidad = previa.rinde > 0 ? previa.costo_total / previa.rinde : 0;
  document.getElementById('costoUnitario').textContent = money(porUnidad);

  let avisos = [];
  if (previa.hay_faltantes) {
    avisos.push('Según este almacén, no alcanza algún componente. Si intenta registrar la producción, el sistema la rechazará y le dirá qué falta.');
  }
  if (previa.hay_sin_costo) {
    avisos.push('Aviso: algún componente no tiene precio de costo, así que el costo mostrado es menor al real.');
  }
  if (avisos.length) { avisoFalta.style.display = 'block'; avisoFalta.textContent = avisos.join(' '); }
  else { avisoFalta.style.display = 'none'; }

  // Se recuerda el último cálculo por si el usuario quiere guardarlo.
  ULTIMO_CALCULO = {
    receta_id: r.id,
    receta_nombre: r.nombre,
    cantidad_final: Number(inpCantidad.value) || previa.rinde,
    unidad: unidadDeReceta(),
    costo_total: previa.costo_total,
    costo_unitario: Number(porUnidad.toFixed(4)),
    almacen_id: Number(almacenId),
    almacen_nombre: (ALMACENES.find((a) => String(a.id) === String(almacenId)) || {}).nombre || '',
    detalle: previa.ingredientes.map((ing) => ({
      producto: ing.producto, necesita: ing.necesita, unidad: ing.unidad || '',
      disponible: ing.disponible, costo: ing.costo,
    })),
  };

  cajaResultado.classList.remove('hidden');
  panelHistorial.classList.add('hidden');   // al calcular se vuelve al cálculo
}

async function producir() {
  const r = recetaActual();
  const almacenId = selAlmacen.value;
  const factor = factorActual();
  if (!r || !almacenId || !factor) { alert('Complete receta, cantidad y almacén.'); return; }

  const u = unidadDeReceta();
  const cantidad = Number(inpCantidad.value);
  const almacenNombre = (ALMACENES.find((a) => String(a.id) === String(almacenId)) || {}).nombre || 'elegido';
  if (!confirm(`¿Registrar la producción de ${fmt(cantidad)} ${u} de ${r.nombre}?\n\nSe descontarán los ingredientes del almacén "${almacenNombre}".`)) return;

  const btn = document.getElementById('btnProducir');
  btn.disabled = true; btn.textContent = 'Registrando…';
  avisoFalta.style.display = 'none'; // limpiar el aviso de faltantes de un intento anterior
  try {
    // Se manda la cantidad final (lb/kg) que pidió el usuario; el servidor
    // la traduce al rinde de la receta y descuenta del almacén elegido.
    const res = await API.recetaProducir(r.id, { cantidad_final: cantidad, almacen_id: Number(almacenId) });
    avisoResultado.style.display = 'block';
    let msg = `✓ Registrado: ${fmt(res.cantidad_producida)} ${u} de ${r.nombre}. Costo total ${money(res.costo_total)} (${money(res.costo_unitario)} por ${u}). Se descontaron los ingredientes del almacén "${almacenNombre}".`;
    if (res.avisos && res.avisos.length) msg += ' ⚠ ' + res.avisos.join(' · ');
    avisoResultado.textContent = msg;
    await calcular(); // refrescar disponibilidades
  } catch (e) {
    // Si el backend rechazó por falta de ingredientes (400 con `faltantes`),
    // se muestra la lista detallada en el aviso de la pantalla en vez de un alert genérico.
    const faltantes = e.data && Array.isArray(e.data.faltantes) ? e.data.faltantes : null;
    if (faltantes && faltantes.length) {
      avisoFalta.style.display = 'block';
      avisoFalta.textContent = 'No se pudo producir, falta: ' +
        faltantes.map((f) => `${f.producto} (necesita ${fmt(f.necesita)}, hay ${fmt(f.disponible)}, faltan ${fmt(f.falta)})`).join('; ') + '.';
    } else {
      alert(e.message);
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Registrar producción';
  }
}

// ============================================================
//  GUARDAR EL CÁLCULO E HISTORIAL
//
//  El cálculo no se pierde: se guarda con su fecha y hora y se
//  conserva hasta que el usuario decida borrarlo desde aquí.
// ============================================================

async function guardarCalculo() {
  if (!ULTIMO_CALCULO) { alert('Primero haga un cálculo.'); return; }
  const btn = document.getElementById('btnGuardarCalculo');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    const nota = prompt('¿Quiere ponerle una nota a este cálculo? (opcional)', '') || null;
    await API.calculoGuardar({ ...ULTIMO_CALCULO, nota });
    avisoResultado.style.display = 'block';
    avisoResultado.textContent = '✓ Cálculo guardado. Lo puede ver cuando quiera en “Historial”.';
  } catch (e) {
    alert('No se pudo guardar: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '💾 Guardar este cálculo';
  }
}

const fechaHora = (f) => {
  if (!f) return '';
  const d = new Date(f);
  return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
};
const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function cargarHistorial() {
  let filas = [];
  try { filas = await API.calculosHistorial(); }
  catch (e) { listaHistorial.innerHTML = `<p class="hist-vacio">No se pudo cargar: ${esc(e.message)}</p>`; return; }

  if (!filas.length) {
    listaHistorial.innerHTML = '<p class="hist-vacio">Todavía no ha guardado ningún cálculo. Haga uno y pulse “Guardar este cálculo”.</p>';
    return;
  }

  listaHistorial.innerHTML = filas.map((f) => `
    <div class="calc-card">
      <div class="calc-cab">
        <div>
          <div class="calc-titulo">${esc(f.receta_nombre)} — ${fmt(f.cantidad_final)} ${esc(f.unidad || '')}</div>
          <div class="calc-fecha">${fechaHora(f.fecha)}${f.usuario_nombre ? ' · ' + esc(f.usuario_nombre) : ''}${f.almacen_nombre ? ' · ' + esc(f.almacen_nombre) : ''}</div>
        </div>
        <button class="btn-borrar-calc" data-id="${f.id}">Eliminar</button>
      </div>
      <div class="calc-datos">
        Costo total: <b>${money(f.costo_total)}</b> ·
        Costo por ${esc(f.unidad || 'unidad')}: <b>${money(f.costo_unitario)}</b>
      </div>
      ${f.nota ? `<div class="calc-fecha" style="margin-top:4px;">Nota: ${esc(f.nota)}</div>` : ''}
      <div class="calc-chips">
        ${(f.detalle || []).map((d) => `<span class="calc-chip">${esc(d.producto)}: ${fmt(d.necesita)} ${esc(d.unidad || '')}</span>`).join('')}
      </div>
    </div>`).join('');

  listaHistorial.querySelectorAll('.btn-borrar-calc').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este cálculo del historial? No se puede deshacer.')) return;
      try { await API.calculoBorrar(Number(b.dataset.id)); await cargarHistorial(); }
      catch (e) { alert(e.message); }
    });
  });
}

function alternarHistorial(e) {
  if (e) e.preventDefault();
  const oculto = panelHistorial.classList.contains('hidden');
  if (oculto) {
    panelHistorial.classList.remove('hidden');
    cajaResultado.classList.add('hidden');
    cargarHistorial();
  } else {
    panelHistorial.classList.add('hidden');
  }
}

// Eventos
selReceta.addEventListener('change', () => { actualizarUnidad(); cajaResultado.classList.add('hidden'); });
document.getElementById('btnCalcular').addEventListener('click', calcular);
document.getElementById('btnProducir').addEventListener('click', producir);
document.getElementById('btnGuardarCalculo').addEventListener('click', guardarCalculo);
document.getElementById('btnHistorial').addEventListener('click', alternarHistorial);

cargar();
