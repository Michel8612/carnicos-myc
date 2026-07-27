// ============================================================
//  Cálculos y Producción — Cárnicos M&C (sin Firebase)
//
//  El usuario elige una receta y dice CUÁNTAS LIBRAS (o kg/g) de
//  producto final quiere. El sistema:
//   - extrapola cuánto de cada componente hace falta (regla de 3
//     sobre el rinde base de la receta),
//   - lo cruza con lo que hay EN EL ALMACÉN (disponible / falta),
//   - calcula el costo total y por unidad,
//   - y permite PRODUCIR: ahora solo simula, NO descuenta inventario.
// ============================================================

// Solo el Cocinero (o el Dueño) calcula y produce.
if (!soloRoles(['cocinero'])) { throw new Error('sin acceso'); }

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
    avisos.push('No hay suficiente de algún componente en este almacén. Puede simular igual (el stock quedará en negativo en la simulación) y regularizar después.');
  }
  if (previa.hay_sin_costo) {
    avisos.push('Aviso: algún componente no tiene precio de costo, así que el costo mostrado es menor al real.');
  }
  if (avisos.length) { avisoFalta.style.display = 'block'; avisoFalta.textContent = avisos.join(' '); }
  else { avisoFalta.style.display = 'none'; }

  cajaResultado.classList.remove('hidden');
}
// ============================================================
//  Producción simulada — no altera inventario
// ============================================================

async function producir() {
  const r = recetaActual();
  const factor = factorActual();
  const almacenId = selAlmacen.value;

  if (!r || !almacenId || !factor) { 
    alert('Complete receta, cantidad y almacén.'); 
    return; 
  }

  const u = unidadDeReceta();
  const btn = document.getElementById('btnProducir');
  btn.disabled = true; 
  btn.textContent = 'Simulando…';

  try {
    // Simulación de producción: solo muestra resultados
    avisoResultado.style.display = 'block';
    avisoResultado.textContent = `⚠ Simulación: producir ${fmt(Number(inpCantidad.value))} ${u} de ${r.producto_nombre}.
    El costo total estimado sería ${money(factor * (r.costo_base || 0))}.
    El almacén no se modificó.`;

    // Opcional: refrescar cálculos para ver insumos y costos
    await calcular();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false; 
    btn.textContent = 'Simular producción';
  }
}

// ============================================================
//  Eventos de interfaz
// ============================================================

selReceta.addEventListener('change', () => { 
  actualizarUnidad(); 
  cajaResultado.classList.add('hidden'); 
});

document.getElementById('btnCalcular').addEventListener('click', calcular);
document.getElementById('btnProducir').addEventListener('click', producir);

// Inicialización
cargar();
