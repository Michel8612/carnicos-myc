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
const SECRETO = process.env.JWT_SECRETO || 'cambiar-esta-clave-en-produccion';

export function crearToken(usuario) {
  return jwt.sign(
    { id: usuario.id, usuario: usuario.usuario, rol: usuario.rol, almacen_id: usuario.almacen_id },
    SECRETO,
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
    datos = jwt.verify(cabecera.slice(7), SECRETO);
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
