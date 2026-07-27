// ============================================================
//  Recetas — Cárnicos M&C (backend PostgreSQL, sin Firebase)
//
//  Una receta = producto terminado + rinde (peso) + componentes,
//  donde cada componente es un PRODUCTO REAL del almacén (no texto
//  libre). Así, al producir, el sistema puede descontar del
//  inventario y calcular el costo real.
// ============================================================

// Solo el Cocinero (o el Dueño) gestiona recetas.
if (!soloRoles(['cocinero'])) { throw new Error('sin acceso'); }

// --- Estado ---
let PRODUCTOS = [];      // todos los productos del almacén
let TERMINADOS = [];     // tipo 'terminado'
let COMPONENTES = [];    // materia_prima + reventa
let RECETAS = [];
let editandoId = null;   // id de la receta en edición (o null = nueva)

// --- DOM ---
const modal = document.getElementById('modalReceta');
const compBody = document.getElementById('compBody');
const recError = document.getElementById('recError');
const nombreInput = document.getElementById('nombreReceta');
const nombreEco = document.getElementById('nombreEco');

// --- Utilidades ---
const fmt = (n) => Number(n ?? 0).toLocaleString('es-CU', { maximumFractionDigits: 3 });

// --- Cargar productos y recetas ---
async function cargarTodo() {
  try {
    PRODUCTOS = await API.productos();
  } catch (e) { PRODUCTOS = []; }
  COMPONENTES = PRODUCTOS.filter((p) => p.tipo === 'materia_prima' || p.tipo === 'reventa');
  await cargarRecetas();
}

async function cargarRecetas() {
  const cont = document.getElementById('recetasList');
  cont.innerHTML = '<li>Cargando…</li>';
  try {
    RECETAS = await API.recetas();
  } catch (e) { RECETAS = []; }
  if (RECETAS.length === 0) {
    cont.innerHTML = '<li>Todavía no hay recetas. Cree la primera con “Agregar Receta”.</li>';
    return;
  }
  cont.innerHTML = '';
  RECETAS.forEach((r) => {
    const li = document.createElement('li');
    const chips = (r.ingredientes || [])
      .map((i) => `<span class="rec-chip">${i.producto_nombre}: ${fmt(i.cantidad)} ${i.unidad || ''}</span>`)
      .join('');
    li.innerHTML = `
      <div style="width:100%">
        <div class="rec-item-cab">
          <div>
            <strong>${r.nombre}</strong>
            <div class="rec-sub">Rinde ${fmt(r.rinde_cantidad)} ${r.rinde_unidad || ''}</div>
          </div>
          <div class="acc">
            <button onclick="editarReceta(${r.id})">Editar</button>
            <button onclick="eliminarReceta(${r.id})">Eliminar</button>
          </div>
        </div>
        <div class="rec-chips">${chips}</div>
      </div>`;
    cont.appendChild(li);
  });
}

// --- Filas de componentes en el popup ---
function filaComponente(producto_id = '', cantidad = '') {
  const tr = document.createElement('tr');
  const opciones = '<option value="">Elegir componente…</option>' +
    COMPONENTES.map((p) => `<option value="${p.id}" ${String(p.id) === String(producto_id) ? 'selected' : ''}>${p.nombre}</option>`).join('');
  tr.innerHTML = `
    <td><select class="c-prod">${opciones}</select></td>
    <td><input type="number" class="c-cant" inputmode="decimal" placeholder="0" value="${cantidad}"></td>
    <td><button type="button" class="btn-x">×</button></td>`;
  tr.querySelector('.btn-x').addEventListener('click', () => tr.remove());
  compBody.appendChild(tr);
}

// --- Abrir / cerrar popup ---
function abrirModal(receta) {
  recError.style.display = 'none';
  editandoId = receta ? receta.id : null;
  document.getElementById('modalTitulo').textContent = receta ? 'Editar Receta' : 'Nueva Receta';
  nombreInput.value = receta ? receta.nombre : '';
  actualizarEco();
  document.getElementById('rindeCantidad').value = receta ? receta.rinde_cantidad : '';
  document.getElementById('rindeUnidad').value = (receta && receta.rinde_unidad) || 'lb';
  compBody.innerHTML = '';
  if (receta && receta.ingredientes && receta.ingredientes.length) {
    receta.ingredientes.forEach((i) => filaComponente(i.producto_id, i.cantidad));
  } else {
    filaComponente();
  }
  if (COMPONENTES.length === 0) {
    recError.style.display = 'block';
    recError.textContent = 'Primero registre en el Almacén las materias primas que usa (azúcar, sal, etc.) con tipo "Materia prima".';
  }
  modal.classList.add('abierto');
}
function actualizarEco() {
  if (nombreEco) nombreEco.textContent = (nombreInput.value || '').trim() || '…';
}
function cerrarModal() { modal.classList.remove('abierto'); }

// --- Guardar ---
async function guardar() {
  recError.style.display = 'none';
  const nombre = nombreInput.value.trim();
  const rinde = parseFloat(document.getElementById('rindeCantidad').value);
  const rindeUnidad = document.getElementById('rindeUnidad').value;

  if (!nombre) return mostrarError('Póngale un nombre a la receta (será también el nombre del producto).');
  if (!rinde || rinde <= 0) return mostrarError('Indique cuánto rinde la receta (el peso que sale).');

  const ingredientes = [];
  compBody.querySelectorAll('tr').forEach((tr) => {
    const pid = tr.querySelector('.c-prod').value;
    const cant = parseFloat(tr.querySelector('.c-cant').value);
    if (pid && cant > 0) ingredientes.push({ producto_id: Number(pid), cantidad: cant });
  });
  if (ingredientes.length === 0) return mostrarError('Agregue al menos un componente con su cantidad.');

  const datos = {
    nombre,
    rinde_cantidad: rinde,
    rinde_unidad: rindeUnidad,
    ingredientes,
  };

  const btn = document.getElementById('btnGuardar');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    if (editandoId) await API.recetaEditar(editandoId, datos);
    else await API.recetaCrear(datos);
    cerrarModal();
    await cargarRecetas();
  } catch (e) {
    mostrarError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar Receta';
  }
}
function mostrarError(msg) { recError.style.display = 'block'; recError.textContent = msg; }

// --- Editar / eliminar (globales para los onclick) ---
window.editarReceta = function (id) {
  const r = RECETAS.find((x) => x.id === id);
  if (r) abrirModal(r);
};
window.eliminarReceta = async function (id) {
  if (!confirm('¿Eliminar esta receta?')) return;
  try { await API.recetaEliminar(id); await cargarRecetas(); }
  catch (e) { alert(e.message); }
};

// --- Eventos ---
document.getElementById('btnAgregarReceta').addEventListener('click', () => abrirModal(null));
document.getElementById('btnListaRecetas').addEventListener('click', () => {
  document.getElementById('listaRecetas').scrollIntoView({ behavior: 'smooth' });
  cargarRecetas();
});
nombreInput.addEventListener('input', actualizarEco);
document.getElementById('btnAgregarComp').addEventListener('click', () => filaComponente());
document.getElementById('btnGuardar').addEventListener('click', guardar);
document.getElementById('btnCancelar').addEventListener('click', cerrarModal);
modal.addEventListener('click', (e) => { if (e.target === modal) cerrarModal(); });

// --- Inicio ---
cargarTodo();
