// ============================================================
//  Autenticación — Cárnicos M&C (sin Firebase)
//
//  Envía usuario y contraseña al backend, guarda el token de
//  sesión y entra al panel.
// ============================================================

const loginForm = document.getElementById('loginForm');
const errorMessage = document.getElementById('error-message');

// Si ya hay sesión guardada, entrar directo a su área.
if (localStorage.getItem('carnicos_token')) {
  location.href = homeDeRol((getUsuario() || {}).rol);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMessage.textContent = '';

  const usuario = document.getElementById('email').value.trim();
  const clave = document.getElementById('password').value;

  const boton = loginForm.querySelector('button');
  boton.disabled = true;
  const textoOriginal = boton.textContent;
  boton.textContent = 'Entrando…';

  try {
    const r = await API.login(usuario, clave);
    setToken(r.token);
    setUsuario(r.usuario);
    // Cada rol entra a SU área; el dueño/admin al panel completo.
    location.href = homeDeRol(r.usuario.rol);
  } catch (err) {
    errorMessage.textContent = err.message || 'Usuario o contraseña incorrectos.';
    boton.disabled = false;
    boton.textContent = textoOriginal;
  }
});

// ============================================================
//  Cerrar sesión — avisando al servidor
//
//  Antes, "Salir" solo borraba el token en el navegador: la sesión
//  seguía viva en la base y el cierre no quedaba auditado. Ahora se
//  avisa primero al backend (POST /auth/logout, ver auth.js del
//  servidor) para que marque la sesión como cerrada y quede registro
//  en auditoría.
//
//  Si ese aviso falla — sin conexión, token ya vencido, lo que sea:
//  cosas normales trabajando desde Cuba — el navegador se limpia y
//  redirige lo mismo. A nadie se le puede quedar la sesión "pegada"
//  por un fallo de red: eso sería peor que no auditar el cierre.
//
//  API.logout se agrega aquí (sin tocar js/api.js, que es de otro
//  agente) igual que legal.js hace con API.login.
// ============================================================
API.logout = () => apiFetch('/auth/logout', { method: 'POST' });

async function logout() {
  try {
    await API.logout();
  } catch (err) {
    console.error('No se pudo avisar el cierre de sesión al servidor:', err.message);
  }
  clearToken();
  location.href = 'index.html';
}
window.logout = logout;
