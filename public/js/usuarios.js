// Gestión de Usuarios — Cárnicos M&C
// Habla con el backend a través de js/api.js (window.API). Solo dueño.

// Solo el Dueño gestiona usuarios.
if (!soloDuenoPagina()) {
  throw new Error('sin acceso');
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

// Cargar usuarios desde el backend
function cargarUsuarios() {
  usuariosList.innerHTML = '';

  return API.usuarios().then((usuarios) => {
    (usuarios || []).forEach((usuario) => {
      const tr = document.createElement('tr');
      const activo = !!usuario.activo;

      tr.innerHTML = `
        <td>${usuario.nombre}</td>
        <td>${usuario.usuario}</td>
        <td>${etiquetaRol(usuario.rol)}</td>
        <td>${activo ? 'Activo' : 'Inactivo'}</td>
        <td>
          <button onclick="cambiarActivo(${usuario.id}, ${activo})">${activo ? 'Desactivar' : 'Activar'}</button>
        </td>
      `;

      usuariosList.appendChild(tr);
    });
  }).catch((error) => {
    console.error('Error al cargar usuarios:', error);
  });
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
