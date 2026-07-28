// Gestión de Usuarios — Cárnicos M&C
// Habla con el backend a través de js/api.js (window.API). Solo dueño.

// Solo el Dueño gestiona usuarios.
if (!soloDuenoPagina()) {
  throw new Error('sin acceso');
}

// El dueño ve el enlace para volver al panel.
if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

// Elementos del DOM
const btnAgregarUsuario = document.getElementById('btnAgregarUsuario');
const formUsuario = document.getElementById('formUsuario');
const usuarioForm = document.getElementById('usuarioForm');
const usuariosList = document.getElementById('usuariosList');
const almacenUsuarioSelect = document.getElementById('almacenUsuario');

// Mostrar/ocultar formulario
btnAgregarUsuario.addEventListener('click', () => {
  formUsuario.classList.toggle('hidden');
});

// Guardar nuevo usuario
usuarioForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const nombre = document.getElementById('nombreUsuario').value.trim();
  const usuario = document.getElementById('loginUsuario').value.trim();
  const clave_temporal = document.getElementById('claveUsuario').value;
  const rol = document.getElementById('rolUsuario').value;
  const almacen_id = almacenUsuarioSelect.value ? Number(almacenUsuarioSelect.value) : null;

  API.crearUsuario({ nombre, usuario, clave_temporal, rol, almacen_id })
    .then(() => {
      usuarioForm.reset();
      formUsuario.classList.add('hidden');
      cargarUsuarios();
    })
    .catch((error) => {
      console.error('Error al crear usuario:', error);
      alert('No se pudo crear el usuario: ' + error.message);
    });
});

// Cargar almacenes para el select del formulario
function cargarAlmacenes() {
  return API.almacenes().then((almacenes) => {
    const opciones = (almacenes || []).map((a) => `<option value="${a.id}">${a.nombre}</option>`).join('');
    almacenUsuarioSelect.innerHTML = '<option value="">-- Sin asignar --</option>' + opciones;
  }).catch((error) => console.error('Error al cargar almacenes:', error));
}

// Lista de usuarios que se tiene a mano (para poder reasignar áreas).
let USUARIOS = [];

// Cargar usuarios desde el backend
function cargarUsuarios() {
  usuariosList.innerHTML = '';

  return API.usuarios().then((usuarios) => {
    USUARIOS = usuarios || [];
    USUARIOS.forEach((usuario) => {
      const tr = document.createElement('tr');
      const activo = !!usuario.activo;
      const yo = (getUsuario() || {}).id === usuario.id;

      tr.innerHTML = `
        <td>${usuario.nombre}</td>
        <td>${usuario.usuario}</td>
        <td>${etiquetaRol(usuario.rol)}</td>
        <td>${activo ? 'Activo' : 'Inactivo'}</td>
        <td>
          <button onclick="cambiarActivo(${usuario.id}, ${activo})">${activo ? 'Desactivar' : 'Activar'}</button>
          ${yo ? '' : `<button class="btn-eliminar-usuario" onclick="eliminarUsuario(${usuario.id})">Eliminar</button>`}
        </td>
      `;

      usuariosList.appendChild(tr);
    });
  }).catch((error) => {
    console.error('Error al cargar usuarios:', error);
  });
}

// ============================================================
//  Eliminar un usuario
//
//  Si el usuario tiene un área con datos (su almacén o su hoja de
//  ventas), NO se borra a la ligera: se le pregunta al dueño qué
//  quiere hacer, para no perder la información del área.
// ============================================================
async function eliminarUsuario(id) {
  const usuario = USUARIOS.find((u) => u.id === id);
  if (!usuario) return;

  let info = {};
  try { info = await API.usuarioAreaInfo(id); } catch (e) { info = {}; }

  // Caso simple: no tiene área con datos.
  if (!info.tiene_datos) {
    if (!confirm(`¿Eliminar a ${usuario.nombre} (${usuario.usuario})?\n\nNo se puede deshacer.`)) return;
    try { await API.usuarioEliminar(id, false); await cargarUsuarios(); }
    catch (e) { alert('No se pudo eliminar: ' + e.message); }
    return;
  }

  // Tiene datos: se le explica y se le dan las dos opciones.
  const queEs = info.tipo_area === 'ventas' ? 'su área de ventas' : 'su almacén';
  const cuanto = info.tipo_area === 'ventas'
    ? `${info.productos_en_hoja} producto(s) en su hoja`
    : `${info.productos_en_almacen || 0} producto(s) y ${info.movimientos || 0} movimiento(s)`;

  const opcion = prompt(
    `${usuario.nombre} tiene ${queEs} con datos:\n  · ${cuanto}\n\n` +
    `¿Qué desea hacer?\n\n` +
    `  1 = Pasar el área a OTRO usuario (no se pierde nada)\n` +
    `  2 = Eliminar el usuario Y todos los datos de esa área\n` +
    `  (deje vacío para cancelar)`,
    '1'
  );
  if (!opcion) return;

  // Opción 1: reasignar a otro usuario del mismo tipo de trabajo.
  if (opcion.trim() === '1') {
    const candidatos = USUARIOS.filter((u) => u.id !== id && u.activo && u.rol === usuario.rol);
    if (!candidatos.length) {
      alert(`No hay otro usuario de tipo "${etiquetaRol(usuario.rol)}" para pasarle el área.\n\nCree primero ese usuario y vuelva a intentarlo.`);
      return;
    }
    const lista = candidatos.map((u, i) => `  ${i + 1} = ${u.nombre} (${u.usuario})`).join('\n');
    const elegido = prompt(`¿A quién le pasa ${queEs}?\n\n${lista}`, '1');
    if (!elegido) return;
    const nuevo = candidatos[Number(elegido.trim()) - 1];
    if (!nuevo) { alert('Opción no válida.'); return; }
    try {
      await API.usuarioReasignarArea(id, nuevo.id);
      if (confirm(`Área pasada a ${nuevo.nombre}.\n\n¿Eliminar ahora a ${usuario.nombre}?`)) {
        await API.usuarioEliminar(id, false);
      }
      await cargarUsuarios();
    } catch (e) { alert('No se pudo reasignar: ' + e.message); }
    return;
  }

  // Opción 2: borrar el usuario y los datos de su área.
  if (opcion.trim() === '2') {
    if (!confirm(`ATENCIÓN: se eliminará a ${usuario.nombre} y TODOS los datos de ${queEs}.\n\nEsto no se puede deshacer. ¿Continuar?`)) return;
    try { await API.usuarioEliminar(id, true); await cargarUsuarios(); }
    catch (e) { alert('No se pudo eliminar: ' + e.message); }
    return;
  }

  alert('Opción no válida.');
}

// Activar / desactivar un usuario
function cambiarActivo(id, activoActual) {
  API.usuarioActivo(id, !activoActual)
    .then(() => cargarUsuarios())
    .catch((error) => {
      console.error('Error al cambiar estado del usuario:', error);
      alert('Error: ' + error.message);
    });
}

// Carga inicial
cargarAlmacenes();
cargarUsuarios();
