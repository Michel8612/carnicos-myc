// ============================================================
//  Cliente de API — Cárnicos M&C
//
//  Reemplaza a Firebase. Todas las páginas hablan con el backend
//  (Node + PostgreSQL) a través de estas funciones. Guarda el
//  token de sesión en el navegador y lo adjunta en cada petición.
//
//  Se carga como script normal (no módulo): expone `API`,
//  `requiereSesion`, `logout`, `setToken` y `getUsuario` en window.
// ============================================================

// La dirección del servidor se deduce sola:
//  - En producción (Netlify o servidor propio) usa el mismo origen: /api
//  - En desarrollo con Vite (puerto 5173) apuntaría a :3001 (no se usa aquí,
//    pero se deja por compatibilidad).
const API_BASE =
  location.port === '5173'
    ? `${location.protocol}//${location.hostname}:3001/api`
    : '/api';

const TOKEN_KEY = 'carnicos_token';
const USER_KEY = 'carnicos_usuario';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }
function setUsuario(u) { localStorage.setItem(USER_KEY, JSON.stringify(u || {})); }
function getUsuario() { try { return JSON.parse(localStorage.getItem(USER_KEY) || '{}'); } catch { return {}; } }

async function apiFetch(ruta, opciones = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(API_BASE + ruta, {
      ...opciones,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(opciones.headers || {}),
      },
    });
  } catch (e) {
    throw new Error('No hay conexión con el servidor.');
  }
  const datos = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Sesión vencida o inválida: volver al login.
    clearToken();
    if (!location.pathname.endsWith('index.html')) location.href = 'index.html';
    throw new Error(datos.error || 'Su sesión expiró.');
  }
  if (!res.ok) {
    const err = new Error(datos.error || 'Algo salió mal. Intente de nuevo.');
    // Se adjunta el cuerpo completo del error (p.ej. { faltantes:[...] } al
    // producir sin stock suficiente) sin romper a quien solo usa e.message.
    err.data = datos;
    throw err;
  }
  return datos;
}

// Guard: llamar al inicio de cada página protegida.
function requiereSesion() {
  if (!getToken()) { location.href = 'index.html'; return false; }
  return true;
}
function logout() { clearToken(); location.href = 'index.html'; }

// ============================================================
//  Roles y control de acceso
//
//  Roles del sistema:
//    dueno / admin / proveedor -> acceso TOTAL (usuario supremo)
//    cocinero                  -> Recetas y Cálculos (antes "recetas")
//    almacen / almacenero      -> Almacén
//    ventas                    -> Ventas
//    contabilidad              -> Contabilidad (SOLO ver, no editar)
// ============================================================
const ROL_ETIQUETA = {
  dueno: 'Dueño', admin: 'Dueño', proveedor: 'Soporte',
  cocinero: 'Cocinero', almacen: 'Almacén', almacenero: 'Almacén',
  almacen_central: 'Almacenero Central',
  ventas: 'Ventas', contabilidad: 'Contabilidad',
};
function etiquetaRol(rol) { return ROL_ETIQUETA[rol] || rol || ''; }

// Página de inicio de cada rol (a dónde va al entrar).
const HOME_POR_ROL = {
  dueno: 'admin.html', admin: 'admin.html', proveedor: 'admin.html',
  cocinero: 'recetas.html',
  almacen: 'almacen.html', almacenero: 'almacen.html',
  almacen_central: 'almacen.html',
  ventas: 'ventas.html',
  contabilidad: 'contabilidad.html',
};
function homeDeRol(rol) { return HOME_POR_ROL[rol] || 'admin.html'; }

// ¿El usuario actual es el dueño/admin (acceso total)?
function esDueno() {
  const r = (getUsuario() || {}).rol;
  return r === 'dueno' || r === 'admin' || r === 'proveedor';
}

// Guard por rol para una página: el dueño siempre entra; los demás
// solo si su rol está en `permitidos`. Si no, se le manda a SU área.
function soloRoles(permitidos) {
  if (!requiereSesion()) return false;
  if (esDueno()) return true;
  const rol = (getUsuario() || {}).rol;
  if ((permitidos || []).includes(rol)) return true;
  location.href = homeDeRol(rol);
  return false;
}

// Guard para páginas solo del dueño (panel, usuarios).
function soloDuenoPagina() {
  if (!requiereSesion()) return false;
  if (esDueno()) return true;
  location.href = homeDeRol((getUsuario() || {}).rol);
  return false;
}

const API = {
  // --- Sesión ---
  login: (usuario, clave) => apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ usuario, clave }) }),
  yo: () => apiFetch('/auth/yo'),
  cambiarCredenciales: (d) => apiFetch('/auth/cambiar-credenciales', { method: 'POST', body: JSON.stringify(d) }),
  config: () => apiFetch('/config'),

  // --- Almacén / Inventario ---
  productos: () => apiFetch('/inventario/productos'),
  existencias: () => apiFetch('/inventario/existencias'),
  almacenes: () => apiFetch('/inventario/almacenes'),
  unidades: () => apiFetch('/inventario/unidades'),
  crearProducto: (d) => apiFetch('/inventario/productos', { method: 'POST', body: JSON.stringify(d) }),
  editarProducto: (id, d) => apiFetch('/inventario/productos/' + id, { method: 'PUT', body: JSON.stringify(d) }),
  eliminarProducto: (id) => apiFetch('/inventario/productos/' + id, { method: 'DELETE' }),
  registrarMovimiento: (d) => apiFetch('/inventario/movimientos', { method: 'POST', body: JSON.stringify(d) }),

  // --- Recetas ---
  recetas: () => apiFetch('/recetas'),
  recetaCrear: (d) => apiFetch('/recetas', { method: 'POST', body: JSON.stringify(d) }),
  recetaEditar: (id, d) => apiFetch('/recetas/' + id, { method: 'PUT', body: JSON.stringify(d) }),
  recetaEliminar: (id) => apiFetch('/recetas/' + id, { method: 'DELETE' }),
  recetaPrevia: (id, factor, almacenId) =>
    apiFetch(`/recetas/${id}/previa?factor=${factor}` + (almacenId ? `&almacen_id=${almacenId}` : '')),
  recetaProducir: (id, d) => apiFetch(`/recetas/${id}/producir`, { method: 'POST', body: JSON.stringify(d) }),

  // --- Ventas ---
  ventas: () => apiFetch('/ventas'),
  registrarVenta: (d) => apiFetch('/ventas', { method: 'POST', body: JSON.stringify(d) }),
  deudas: () => apiFetch('/ventas/deudas'),
  // --- Área de ventas (inventario PROPIO del vendedor, aparte del almacén) ---
  ventasHoja: (usuarioId) => apiFetch('/ventas/hoja' + (usuarioId ? `?usuario_id=${usuarioId}` : '')),
  ventaProductoCrear: (d) => apiFetch('/ventas/producto', { method: 'POST', body: JSON.stringify(d) }),
  ventaProductoEditar: (id, d) => apiFetch(`/ventas/producto/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  ventaProductoBorrar: (id) => apiFetch(`/ventas/producto/${id}`, { method: 'DELETE' }),
  ventaVendido: (id, vendido) => apiFetch(`/ventas/vendido/${id}`, { method: 'POST', body: JSON.stringify({ vendido }) }),
  ventasReiniciar: (d) => apiFetch('/ventas/reiniciar', { method: 'POST', body: JSON.stringify(d || {}) }),

  // --- Usuarios: eliminar y reasignar su área ---
  usuarioAreaInfo: (id) => apiFetch(`/usuarios/${id}/area-info`),
  usuarioReasignarArea: (id, nuevoId) =>
    apiFetch(`/usuarios/${id}/reasignar-area`, { method: 'POST', body: JSON.stringify({ nuevo_usuario_id: nuevoId }) }),
  usuarioEliminar: (id, borrarArea) =>
    apiFetch(`/usuarios/${id}`, { method: 'DELETE', body: JSON.stringify({ borrar_area: !!borrarArea }) }),

  // --- Cálculos guardados (historial del área de recetas) ---
  calculoGuardar: (d) => apiFetch('/recetas/calculos', { method: 'POST', body: JSON.stringify(d) }),
  calculosHistorial: () => apiFetch('/recetas/calculos'),
  calculoBorrar: (id) => apiFetch(`/recetas/calculos/${id}`, { method: 'DELETE' }),

  // Crear un componente desde el área de recetas (sin depender del almacén)
  recetaComponenteNuevo: (d) => apiFetch('/recetas/componente', { method: 'POST', body: JSON.stringify(d) }),

  // --- Lo producido en cocina, esperando entrada al almacén ---
  produccionDisponible: () => apiFetch('/recetas/disponibles'),
  produccionAlAlmacen: (id, almacenId) =>
    apiFetch(`/recetas/disponibles/${id}/al-almacen`, { method: 'POST', body: JSON.stringify({ almacen_id: almacenId }) }),
  almacenesTodos: () => apiFetch('/inventario/almacenes?todos=1'),

  // --- Contabilidad (lo ve todo) ---
  contabResumen: () => apiFetch('/contabilidad/resumen'),
  contabLibro: (f) => {
    const q = new URLSearchParams();
    if (f && f.tipo && f.tipo !== 'todos') q.set('tipo', f.tipo);
    if (f && f.desde) q.set('desde', f.desde);
    if (f && f.hasta) q.set('hasta', f.hasta);
    const s = q.toString();
    return apiFetch('/contabilidad/libro' + (s ? '?' + s : ''));
  },
  contabBorrarLinea: (id) => apiFetch(`/contabilidad/libro/${id}`, { method: 'DELETE' }),
  contabBorrarVarias: (d) => apiFetch('/contabilidad/libro/borrar', { method: 'POST', body: JSON.stringify(d) }),
  contabMovimientos: () => apiFetch('/contabilidad/movimientos'),
  cobrar: (id, monto, moneda) => apiFetch(`/ventas/${id}/cobrar`, { method: 'POST', body: JSON.stringify({ monto, moneda }) }),

  // --- Usuarios ---
  usuarios: () => apiFetch('/usuarios'),
  crearUsuario: (d) => apiFetch('/usuarios', { method: 'POST', body: JSON.stringify(d) }),
  usuarioActivo: (id, activo) => apiFetch(`/usuarios/${id}/activo`, { method: 'POST', body: JSON.stringify({ activo }) }),

  // --- Contabilidad / Costos ---
  ganancia: (mes) => apiFetch('/costos/ganancia' + (mes ? `?mes=${mes}` : '')),
  gastos: (mes) => apiFetch('/costos/gastos' + (mes ? `?mes=${mes}` : '')),
  cajaResumen: (fecha) => apiFetch('/caja/resumen' + (fecha ? `?fecha=${fecha}` : '')),
};

// Exponer en window para las páginas (scripts clásicos).
window.API = API;
window.requiereSesion = requiereSesion;
window.logout = logout;
window.setToken = setToken;
window.setUsuario = setUsuario;
window.getUsuario = getUsuario;
window.etiquetaRol = etiquetaRol;
window.homeDeRol = homeDeRol;
window.esDueno = esDueno;
window.soloRoles = soloRoles;
window.soloDuenoPagina = soloDuenoPagina;
