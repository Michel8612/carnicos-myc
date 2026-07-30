// ============================================================
//  Autenticación
//
//  Cuando alguien entra con su usuario y clave, le damos un
//  "token": una credencial temporal que su dispositivo guarda
//  y presenta en cada acción. Así el sistema sabe quién es y
//  qué puede hacer, sin pedir la clave a cada rato.
// ============================================================

import jwt from 'jsonwebtoken';
import db from '../db/index.js';

// Clave secreta para firmar los tokens. En producción (el VPS)
// se pone una clave larga y única en una variable de entorno.
export const JWT_SECRETO = process.env.JWT_SECRETO || 'cambiar-esta-clave-en-produccion';

// Cuánto tiempo puede estar una sesión SIN actividad antes de expirarla
// (aunque el JWT en sí todavía sea válido por 30 días). Con esto, un
// dispositivo perdido u olvidado con la sesión abierta deja de servir
// pasadas estas horas sin uso.
export const HORAS_INACTIVIDAD_MAXIMA = 12;

// `jti` es opcional: lo llevan los tokens nuevos (emitidos desde que existe
// la tabla `sesiones`), para poder ubicar y cerrar esa sesión concreta.
export function crearToken(usuario, jti = null) {
  const payload = { id: usuario.id, usuario: usuario.usuario, rol: usuario.rol, almacen_id: usuario.almacen_id };
  if (jti) payload.jti = jti;
  return jwt.sign(
    payload,
    JWT_SECRETO,
    { expiresIn: '30d' }   // dura 30 días; cómodo para uso diario
  );
}

// Verifica que quien hace una acción tenga un token válido.
export async function requiereSesion(req, res, next) {
  const cabecera = req.headers.authorization;
  if (!cabecera || !cabecera.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Debe iniciar sesión.' });
  }
  let datos;
  try {
    datos = jwt.verify(cabecera.slice(7), JWT_SECRETO);
  } catch {
    return res.status(401).json({ error: 'Su sesión expiró. Vuelva a entrar.' });
  }
  // El token puede ser de un usuario que ya no existe o fue desactivado
  // (p. ej. tras reinstalar la base). Se comprueba contra la base para no
  // dejar pasar sesiones huérfanas: darían errores raros al guardar.
  try {
    const u = await db.prepare('SELECT id, rol, almacen_id, activo FROM usuarios WHERE id = ?').get(datos.id);
    if (!u || !u.activo) {
      return res.status(401).json({ error: 'Su sesión ya no es válida. Vuelva a entrar.' });
    }

    // COMPATIBILIDAD: los tokens emitidos antes de que existiera la tabla
    // `sesiones` no traen `jti`. Esos siguen entrando como hasta ahora,
    // sin control de sesión/expiración por inactividad (no hay fila que
    // consultar). El día que caduquen solos (a los 30 días), listo.
    if (datos.jti) {
      const s = await db.prepare(
        'SELECT id, cerrada, ultima_actividad FROM sesiones WHERE jti = ?'
      ).get(datos.jti);
      if (!s || s.cerrada) {
        return res.status(401).json({ error: 'Su sesión fue cerrada. Vuelva a entrar.' });
      }
      const inactivaDesdeHoras = (Date.now() - new Date(s.ultima_actividad).getTime()) / 36e5;
      if (inactivaDesdeHoras > HORAS_INACTIVIDAD_MAXIMA) {
        await db.prepare('UPDATE sesiones SET cerrada = 1 WHERE id = ?').run(s.id);
        return res.status(401).json({ error: 'Su sesión expiró por inactividad. Vuelva a entrar.' });
      }
      // No hace falta esperar esta actualización para seguir: es solo
      // para que la pantalla de "Sesiones activas" muestre datos frescos.
      db.prepare('UPDATE sesiones SET ultima_actividad = now() WHERE id = ?').run(s.id)
        .catch((e) => console.error('No se pudo actualizar la actividad de sesión:', e.message));
    }

    // Se usan los datos frescos (rol/almacén pueden haber cambiado).
    req.usuario = { ...datos, rol: u.rol, almacen_id: u.almacen_id };
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo verificar la sesión.' });
  }
  next();
}

// Restringe una acción al dueño o al proveedor (soporte).
export function soloDueno(req, res, next) {
  if (req.usuario?.rol !== 'dueno' && req.usuario?.rol !== 'proveedor') {
    return res.status(403).json({ error: 'No tiene permiso para esta acción.' });
  }
  next();
}

// Control de acceso por rol y sección:
//  - Cualquier usuario con sesión puede LEER (GET).
//  - Solo el dueño/admin y los roles indicados pueden MODIFICAR
//    (POST/PUT/DELETE). Así, p.ej., Contabilidad solo ve; Ventas no
//    edita el Almacén, aunque llame la API directamente.
export function escrituraSoloRoles(...roles) {
  return (req, res, next) => {
    if (req.method === 'GET') return next();
    const rol = req.usuario?.rol;
    if (rol === 'dueno' || rol === 'admin' || rol === 'proveedor') return next();
    if (roles.includes(rol)) return next();
    return res.status(403).json({ error: 'No tiene permiso para modificar esta sección.' });
  };
}
