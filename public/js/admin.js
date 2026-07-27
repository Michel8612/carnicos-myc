// Panel de Administración — Cárnicos M&C
// La navegación entre páginas ya está resuelta con onclick en admin.html.
// Aquí solo protegemos la página, mostramos el nombre del negocio y
// resolvemos el cambio de usuario/contraseña del admin.

// El panel completo es solo del Dueño/Admin. Los demás roles van a su área.
if (!soloDuenoPagina()) {
  throw new Error('sin acceso');
}

document.addEventListener('DOMContentLoaded', () => {
  API.config()
    .then((c) => {
      const titulo = document.getElementById('tituloAdmin');
      if (titulo && c && c.nombre) {
        titulo.textContent = `Panel de Administración - ${c.nombre}`;
      }
    })
    .catch((err) => console.error('No se pudo cargar la configuración del negocio:', err));
});

// Cambiar usuario/contraseña del admin logueado.
// El backend siempre requiere la nueva contraseña (mínimo 6 caracteres);
// el nuevo usuario es opcional (si se deja vacío, no se cambia).
function cambiarCredenciales() {
  const nuevoUsuario = prompt('Nuevo usuario (deja vacío para no cambiarlo):', '');
  if (nuevoUsuario === null) return; // Canceló

  const nuevaClave = prompt('Nueva contraseña (mínimo 6 caracteres):', '');
  if (nuevaClave === null) return; // Canceló
  if (!nuevaClave || nuevaClave.length < 6) {
    alert('Debe indicar una nueva contraseña de al menos 6 caracteres.');
    return;
  }

  const datos = { nueva_clave: nuevaClave };
  if (nuevoUsuario) datos.nuevo_usuario = nuevoUsuario;

  API.cambiarCredenciales(datos)
    .then(() => alert('Credenciales actualizadas correctamente.'))
    .catch((err) => alert('Error: ' + err.message));
}
