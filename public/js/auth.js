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
