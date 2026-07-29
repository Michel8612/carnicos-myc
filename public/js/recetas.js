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

// El dueño ve el enlace para volver al panel; el cocinero no.
if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

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
const imgInput = document.getElementById('recetaImagenInput');
const imgPreview = document.getElementById('recetaImagenPreview');
const btnElegirImagen = document.getElementById('btnElegirImagen');
const btnQuitarImagen = document.getElementById('btnQuitarImagen');

// Imagen (data URL ya comprimida) de la receta que se está creando/editando.
let imagenActual = null;

// --- Utilidades ---
const fmt = (n) => Number(n ?? 0).toLocaleString('es-CU', { maximumFractionDigits: 3 });

// ------------------------------------------------------------
//  Comprimir la foto EN EL NAVEGADOR antes de mandarla al backend.
//  Se escala a un máximo de 400px de lado (mantiene proporción) y
//  se exporta como JPEG al 70%: así no se manda una foto enorme a
//  la base de datos.
// ------------------------------------------------------------
function comprimirImagen(file) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('El archivo elegido no es una imagen válida.'));
      img.onload = () => {
        const MAX = 400;
        let { width, height } = img;
        if (width > height && width > MAX) {
          height = Math.round(height * (MAX / width));
          width = MAX;
        } else if (height >= width && height > MAX) {
          width = Math.round(width * (MAX / height));
          height = MAX;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(file);
  });
}

// Muestra (o quita) la vista previa y guarda el data URL a enviar.
function fijarImagenReceta(dataUrl) {
  imagenActual = dataUrl || null;
  if (imagenActual) {
    imgPreview.src = imagenActual;
    imgPreview.style.display = '';
    btnQuitarImagen.style.display = '';
  } else {
    imgPreview.src = '';
    imgPreview.style.display = 'none';
    btnQuitarImagen.style.display = 'none';
  }
}

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
    // Miniatura: si no tiene foto, un recuadro neutro discreto (no rompe la fila).
    const miniatura = r.imagen
      ? `<img src="${r.imagen}" class="rec-miniatura" alt="">`
      : `<span class="rec-miniatura rec-miniatura-vacia"></span>`;
    li.innerHTML = `
      <div style="width:100%">
        <div class="rec-item-cab">
          <div style="display:flex;align-items:center;gap:10px;">
            ${miniatura}
            <div>
              <strong>${r.nombre}</strong>
              <div class="rec-sub">Rinde ${fmt(r.rinde_cantidad)} ${r.rinde_unidad || ''}</div>
            </div>
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
  fijarImagenReceta(receta && receta.imagen ? receta.imagen : null);
  compBody.innerHTML = '';
  if (receta && receta.ingredientes && receta.ingredientes.length) {
    receta.ingredientes.forEach((i) => filaComponente(i.producto_id, i.cantidad));
  } else {
    filaComponente();
  }
  // Ya no hace falta que el almacén tenga nada: con "+ Componente nuevo"
  // el cocinero puede anotar lo que lleva la receta (azúcar, sal…) aunque
  // el almacenero todavía no lo haya registrado.
  if (COMPONENTES.length === 0) {
    recError.style.display = 'block';
    recError.textContent = 'Todavía no hay componentes. Use “+ Componente nuevo” para anotar los que lleva esta receta (azúcar, sal, sal de nitro…).';
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
    imagen: imagenActual, // null si se quitó o nunca se puso
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

// ---- Elegir / quitar la foto de la receta ----
if (btnElegirImagen && imgInput) {
  btnElegirImagen.addEventListener('click', () => imgInput.click());
  imgInput.addEventListener('change', async () => {
    const file = imgInput.files && imgInput.files[0];
    if (!file) return;
    try {
      const dataUrl = await comprimirImagen(file);
      fijarImagenReceta(dataUrl);
    } catch (e) {
      mostrarError(e.message);
    } finally {
      imgInput.value = ''; // permite elegir el mismo archivo otra vez si hace falta
    }
  });
}
if (btnQuitarImagen) {
  btnQuitarImagen.addEventListener('click', () => fijarImagenReceta(null));
}

// ---- Crear un componente nuevo sin salir de Recetas ----
// El cocinero anota lo que lleva la receta aunque el almacén esté vacío.
const btnCompNuevo = document.getElementById('btnComponenteNuevo');
if (btnCompNuevo) {
  btnCompNuevo.addEventListener('click', async () => {
    const nombre = prompt('Nombre del componente (ej. Azúcar, Sal común, Sal de nitro):', '');
    if (!nombre || !nombre.trim()) return;
    const unidad = prompt('Unidad (lb, kg, g, L, u):', 'lb') || 'lb';
    const costo = prompt('¿Cuánto cuesta cada ' + unidad + '? (puede dejarlo en 0):', '0');
    try {
      const nuevo = await API.recetaComponenteNuevo({
        nombre: nombre.trim(), unidad: unidad.trim(), precio_costo: Number(costo) || 0,
      });
      // Recargar la lista de componentes y dejarlo elegido en una fila nueva.
      PRODUCTOS = await API.productos();
      COMPONENTES = PRODUCTOS.filter((p) => p.tipo === 'materia_prima' || p.tipo === 'reventa');
      recError.style.display = 'none';
      // Rehacer los desplegables ya pintados para que incluyan el nuevo.
      const filas = [...compBody.querySelectorAll('tr')].map((tr) => ({
        pid: tr.querySelector('.c-prod').value,
        cant: tr.querySelector('.c-cant').value,
      }));
      compBody.innerHTML = '';
      filas.forEach((f) => filaComponente(f.pid || '', f.cant || ''));
      filaComponente(nuevo.id, '');
      if (nuevo.ya_existia) alert('Ese componente ya existía: se agregó a la receta.');
    } catch (e) {
      mostrarError(e.message);
    }
  });
}
document.getElementById('btnGuardar').addEventListener('click', guardar);
document.getElementById('btnCancelar').addEventListener('click', cerrarModal);
modal.addEventListener('click', (e) => { if (e.target === modal) cerrarModal(); });

// --- Inicio ---
cargarTodo();
