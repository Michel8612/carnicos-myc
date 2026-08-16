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
// Cerrar sesión: primero se avisa al servidor para que marque la sesión
// como cerrada y quede el rastro en auditoría; después se limpia aquí.
// Si el aviso falla (sin red, token ya vencido) se limpia igual y se sale:
// al usuario NUNCA se le puede quedar la sesión pegada por un fallo de
// conexión — aquí la conexión se cae a menudo.
async function logout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch (e) {
    // Da igual por qué falló: la salida no se puede bloquear.
  }
  clearToken();
  location.href = 'index.html';
}

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
  // Si el producto esta usado en recetas, producciones o ventas, el borrado
  // responde 409 explicando donde; entonces se puede OCULTAR conservando el
  // historial. Borrar ese historial seria borrar contabilidad.
  ocultarProducto: (id) => apiFetch('/inventario/productos/' + id + '?ocultar=1', { method: 'DELETE' }),
  productosOcultos: () => apiFetch('/inventario/productos/ocultos'),
  mostrarProducto: (id) => apiFetch('/inventario/productos/' + id + '/mostrar', { method: 'POST' }),
  registrarMovimiento: (d) => apiFetch('/inventario/movimientos', { method: 'POST', body: JSON.stringify(d) }),
  // Valor del inventario y entradas por fecha. Devuelve 403 a quien no sea
  // dueño o contabilidad: el almacenero trabaja con cantidades, no con dinero.
  valorInventario: (p) => apiFetch('/inventario/valor?' + new URLSearchParams(p || {}).toString()),

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
  // El cierre admite con qué se cobró: { forma_pago:'efectivo'|'transferencia', moneda:'CUP' }.
  // Sin esos datos se asume efectivo en CUP, como funcionaba antes.
  ventasReiniciar: (d) => apiFetch('/ventas/reiniciar', { method: 'POST', body: JSON.stringify(d || {}) }),
  ingresosPorPunto: (p) => apiFetch('/ventas/ingresos-por-punto?' + new URLSearchParams(p || {}).toString()),

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
  // Márgenes separados: centro de elaboración (por fecha de producción) y
  // cada punto de venta (por día de venta). No se mezclan a propósito.
  margenes: (p) => apiFetch('/contabilidad/margenes?' + new URLSearchParams(p || {}).toString()),
  cobrar: (id, monto, moneda) => apiFetch(`/ventas/${id}/cobrar`, { method: 'POST', body: JSON.stringify({ monto, moneda }) }),

  // --- Usuarios ---
  usuarios: () => apiFetch('/usuarios'),
  crearUsuario: (d) => apiFetch('/usuarios', { method: 'POST', body: JSON.stringify(d) }),
  usuarioActivo: (id, activo) => apiFetch(`/usuarios/${id}/activo`, { method: 'POST', body: JSON.stringify({ activo }) }),

  // --- Contabilidad / Costos ---
  ganancia: (mes) => apiFetch('/costos/ganancia' + (mes ? `?mes=${mes}` : '')),
  gastos: (mes) => apiFetch('/costos/gastos' + (mes ? `?mes=${mes}` : '')),
  cajaResumen: (fecha) => apiFetch('/caja/resumen' + (fecha ? `?fecha=${fecha}` : '')),

  // --- Transferencias entre áreas (almacén → almacén / → vendedor) ---
  destinosTransferencia: () => apiFetch('/inventario/destinos'),
  // Dirección y teléfono del destino, para el aviso al transportista.
  guardarDireccionDestino: (tipo, id, d) =>
    apiFetch(`/inventario/destinos/${tipo}/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  transferenciasPendientes: () => apiFetch('/inventario/transferencias/pendientes'),
  transferenciasHistorial: () => apiFetch('/inventario/transferencias'),
  aceptarTransferencia: (id) => apiFetch(`/inventario/transferencias/${id}/aceptar`, { method: 'POST' }),
  cancelarTransferencia: (id) => apiFetch(`/inventario/transferencias/${id}/cancelar`, { method: 'POST' }),

  // --- Gastos y nómina (alimentan lo deducible de la tributación) ---
  categoriasGasto: () => apiFetch('/costos/categorias'),
  crearGasto: (d) => apiFetch('/costos/gastos', { method: 'POST', body: JSON.stringify(d) }),
  nomina: (periodo) => apiFetch('/costos/nomina' + (periodo ? `?periodo=${periodo}` : '')),
  crearNomina: (d) => apiFetch('/costos/nomina', { method: 'POST', body: JSON.stringify(d) }),
  borrarNomina: (id) => apiFetch(`/costos/nomina/${id}`, { method: 'DELETE' }),

  // --- Tasa del dólar (elTOQUE) ---
  tasaActual: () => apiFetch('/tasas/actual'),
  actualizarTasa: () => apiFetch('/tasas/actualizar', { method: 'POST' }),
  fijarTasaManual: (valor) => apiFetch('/tasas/manual', { method: 'PUT', body: JSON.stringify({ valor }) }),

  // --- Tributación ---
  tributacion: (p) => apiFetch('/contabilidad/tributacion?' + new URLSearchParams(p).toString()),
  regimenesTributarios: () => apiFetch('/contabilidad/tributacion/regimenes'),
  // Régimen "Otro": porcentajes que define el propio usuario.
  regimenPersonalizado: () => apiFetch('/contabilidad/tributacion/personalizado'),
  guardarRegimenPersonalizado: (d) => apiFetch('/contabilidad/tributacion/personalizado', { method: 'PUT', body: JSON.stringify(d) }),
  // Correcciones manuales sobre cifras calculadas (quedan auditadas).
  correccionesTributacion: (p) => apiFetch('/contabilidad/tributacion/correcciones?' + new URLSearchParams(p || {}).toString()),
  corregirTributacion: (d) => apiFetch('/contabilidad/tributacion/correcciones', { method: 'POST', body: JSON.stringify(d) }),
  anularCorreccionTributacion: (id) => apiFetch(`/contabilidad/tributacion/correcciones/${id}`, { method: 'DELETE' }),

  // --- Gastos: borrado y categorías configurables ---
  borrarGasto: (id, motivo) => apiFetch(`/costos/gastos/${id}`, { method: 'DELETE', body: JSON.stringify({ motivo }) }),
  crearCategoriaGasto: (d) => apiFetch('/costos/categorias', { method: 'POST', body: JSON.stringify(d) }),
  borrarCategoriaGasto: (clave) => apiFetch(`/costos/categorias/${encodeURIComponent(clave)}`, { method: 'DELETE' }),

  // --- Historiales protegidos ---
  // El libro contable lo puede borrar el dueño; contabilidad necesita
  // que un administrador preste su permiso (reautenticación).
  borrarLibroAutorizado: (d) => apiFetch('/contabilidad/libro/borrar-autorizado', { method: 'POST', body: JSON.stringify(d) }),
  borrarMovimientoAlmacen: (id, motivo) => apiFetch(`/inventario/movimientos/${id}`, { method: 'DELETE', body: JSON.stringify({ motivo }) }),
  reautenticar: (usuario, clave) => apiFetch('/auth/reautenticar', { method: 'POST', body: JSON.stringify({ usuario, clave }) }),

  // --- Sesiones ---
  sesiones: () => apiFetch('/auth/sesiones'),
  cerrarSesionDe: (id) => apiFetch(`/auth/sesiones/${id}/cerrar`, { method: 'POST' }),

  // --- Auditoría ---
  auditoria: (f) => apiFetch('/auditoria?' + new URLSearchParams(f || {}).toString()),
  auditoriaFiltros: () => apiFetch('/auditoria/filtros'),

  // --- Configuración fiscal de la empresa ---
  empresa: () => apiFetch('/empresa'),
  guardarEmpresa: (d) => apiFetch('/empresa', { method: 'PUT', body: JSON.stringify(d) }),

  // --- Cuentas bancarias y conciliación ---
  cuentasBancarias: () => apiFetch('/bancos/cuentas'),
  crearCuentaBancaria: (d) => apiFetch('/bancos/cuentas', { method: 'POST', body: JSON.stringify(d) }),
  actualizarCuentaBancaria: (id, d) => apiFetch(`/bancos/cuentas/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  borrarCuentaBancaria: (id) => apiFetch(`/bancos/cuentas/${id}`, { method: 'DELETE' }),
  movimientosBancarios: (f) => apiFetch('/bancos/movimientos?' + new URLSearchParams(f || {}).toString()),
  crearMovimientoBancario: (d) => apiFetch('/bancos/movimientos', { method: 'POST', body: JSON.stringify(d) }),
  conciliarMovimientoBancario: (id, d) => apiFetch(`/bancos/movimientos/${id}/conciliar`, { method: 'POST', body: JSON.stringify(d) }),
  pasarelasPago: () => apiFetch('/bancos/pasarelas'),

  // --- Documentos legales ---
  estadoLegal: () => apiFetch('/legal/estado'),
  documentosLegales: () => apiFetch('/legal/documentos'),
  aceptarLegal: (versiones) => apiFetch('/legal/aceptar', { method: 'POST', body: JSON.stringify({ versiones }) }),
  guardarDocumentoLegal: (d) => apiFetch('/legal/documentos', { method: 'POST', body: JSON.stringify(d) }),

  // ---- Conexiones externas (tasa del dólar, pagos) ----
  // El servidor nunca devuelve el valor guardado, solo si está puesto y
  // sus últimos caracteres; por eso no hay un "leerCredencial".
  credenciales: () => apiFetch('/credenciales'),
  guardarCredencial: (clave, valor) =>
    apiFetch(`/credenciales/${clave}`, { method: 'PUT', body: JSON.stringify({ valor }) }),
  borrarCredencial: (clave) => apiFetch(`/credenciales/${clave}`, { method: 'DELETE' }),

  // ---- Dinero disponible del negocio (efectivo y transferencias) ----
  dineroBalance: () => apiFetch('/dinero'),
  dineroMovimientos: (p) => apiFetch('/dinero/movimientos?' + new URLSearchParams(p || {}).toString()),
  dineroRegistrar: (d) => apiFetch('/dinero', { method: 'POST', body: JSON.stringify(d) }),
  dineroAjustar: (d) => apiFetch('/dinero/ajustar', { method: 'PUT', body: JSON.stringify(d) }),

  // ---- Avisos ----
  avisos: () => apiFetch('/notificaciones'),
  avisosContador: () => apiFetch('/notificaciones/contador'),
  avisoLeido: (id) => apiFetch(`/notificaciones/${id}/leida`, { method: 'POST' }),
  avisosLeerTodas: () => apiFetch('/notificaciones/leer-todas', { method: 'POST' }),

  // ============================================================
  //  SEGUNDA ENTREGA DE LA SECCIÓN 10
  // ============================================================

  // ---- Informes contables (§10.2) ----
  // Los tres devuelven JSON para pintar en pantalla. Para descargar el
  // archivo NO se usan estas funciones: se abre `urlDescarga(...)` en una
  // pestaña, porque un fetch con token no dispara la descarga del navegador.
  informeEstadoResultados: (p) => apiFetch('/informes/estado-resultados?' + new URLSearchParams(p || {}).toString()),
  informeBalance: (p) => apiFetch('/informes/balance?' + new URLSearchParams(p || {}).toString()),
  informeFlujoCaja: (p) => apiFetch('/informes/flujo-caja?' + new URLSearchParams(p || {}).toString()),

  // ---- Tablero de indicadores (§10.5) ----
  indicadores: (p) => apiFetch('/tablero/indicadores?' + new URLSearchParams(p || {}).toString()),

  // ---- Cuentas por cobrar y por pagar (§10.3) ----
  cuentasTerceros: (p) => apiFetch('/cuentas?' + new URLSearchParams(p || {}).toString()),
  cuentaTerceroCrear: (d) => apiFetch('/cuentas', { method: 'POST', body: JSON.stringify(d) }),
  cuentaTerceroEditar: (id, d) => apiFetch(`/cuentas/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  cuentaTerceroAnular: (id, motivo) => apiFetch(`/cuentas/${id}/anular`, { method: 'POST', body: JSON.stringify({ motivo }) }),
  cuentaTerceroPagos: (id) => apiFetch(`/cuentas/${id}/pagos`),
  cuentaTerceroPagar: (id, d) => apiFetch(`/cuentas/${id}/pagos`, { method: 'POST', body: JSON.stringify(d) }),
  cuentaTerceroPagoBorrar: (pagoId, motivo) => apiFetch(`/cuentas/pagos/${pagoId}`, { method: 'DELETE', body: JSON.stringify({ motivo }) }),
  cuentasAntiguedad: (p) => apiFetch('/cuentas/antiguedad?' + new URLSearchParams(p || {}).toString()),

  // ---- Presupuestos (§10.4) ----
  presupuestos: () => apiFetch('/presupuestos'),
  presupuesto: (id) => apiFetch(`/presupuestos/${id}`),
  presupuestoCrear: (d) => apiFetch('/presupuestos', { method: 'POST', body: JSON.stringify(d) }),
  presupuestoEditar: (id, d) => apiFetch(`/presupuestos/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  presupuestoBorrar: (id) => apiFetch(`/presupuestos/${id}`, { method: 'DELETE' }),
  presupuestoLineaCrear: (id, d) => apiFetch(`/presupuestos/${id}/lineas`, { method: 'POST', body: JSON.stringify(d) }),
  presupuestoLineaEditar: (lineaId, d) => apiFetch(`/presupuestos/lineas/${lineaId}`, { method: 'PUT', body: JSON.stringify(d) }),
  presupuestoLineaBorrar: (lineaId) => apiFetch(`/presupuestos/lineas/${lineaId}`, { method: 'DELETE' }),
  presupuestoComparativo: (id) => apiFetch(`/presupuestos/${id}/comparativo`),

  // ---- Conciliación de inventario (§10.4) ----
  conciliaciones: (p) => apiFetch('/conciliaciones?' + new URLSearchParams(p || {}).toString()),
  conciliacion: (id) => apiFetch(`/conciliaciones/${id}`),
  conciliacionAbrir: (d) => apiFetch('/conciliaciones', { method: 'POST', body: JSON.stringify(d) }),
  conciliacionLinea: (lineaId, d) => apiFetch(`/conciliaciones/lineas/${lineaId}`, { method: 'PUT', body: JSON.stringify(d) }),
  conciliacionCerrar: (id, d) => apiFetch(`/conciliaciones/${id}/cerrar`, { method: 'POST', body: JSON.stringify(d || {}) }),
  conciliacionAnular: (id, motivo) => apiFetch(`/conciliaciones/${id}/anular`, { method: 'POST', body: JSON.stringify({ motivo }) }),
};

// ============================================================
//  Descargas (Excel / CSV)
//
//  Un `fetch` con la cabecera Authorization devuelve los bytes, pero no
//  hace que el navegador guarde el archivo, y aquí no se puede meter el
//  token en la URL (quedaría en el historial y en los registros del
//  servidor). Solución: se pide el archivo con fetch, se convierte en un
//  enlace temporal en memoria (blob) y se "pulsa" solo. El archivo se
//  guarda con el nombre que manda el servidor.
// ============================================================
async function descargarInforme(ruta, parametros, formato) {
  const q = new URLSearchParams(parametros || {});
  q.set('formato', formato);
  const token = getToken();
  const res = await fetch(`${API_BASE}${ruta}?${q.toString()}`, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  if (!res.ok) {
    const datos = await res.json().catch(() => ({}));
    throw new Error(datos.error || 'No se pudo generar el archivo.');
  }
  // El servidor manda el nombre en Content-Disposition; si por lo que sea
  // no llega (algún proxy lo quita), se usa uno genérico con la fecha.
  const cabecera = res.headers.get('Content-Disposition') || '';
  const coincide = /filename="?([^";]+)"?/i.exec(cabecera);
  const nombre = coincide ? coincide[1] : `informe-${new Date().toISOString().slice(0, 10)}.${formato === 'xlsx' ? 'xlsx' : 'csv'}`;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Liberar la memoria del blob; sin esto, descargar varios informes
  // seguidos va dejando copias del archivo retenidas en la pestaña.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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
window.descargarInforme = descargarInforme;
window.soloRoles = soloRoles;
window.soloDuenoPagina = soloDuenoPagina;
