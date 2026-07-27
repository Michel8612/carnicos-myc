// ============================================================
//  Rutas de licencia
//
//  - GET  /estado   → cuántos días quedan o si está vencida
//  - POST /activar  → introducir la clave de activación
//
//  Y el middleware que bloquea el acceso a los datos cuando la
//  licencia está vencida (sin borrar nada).
// ============================================================

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { estadoLicencia, activarLicencia } from './licencia.js';

const router = Router();

// Estado de la licencia (no requiere sesión: la pantalla de
// bloqueo necesita consultarlo antes de entrar).
router.get('/estado', async (req, res) => {
  res.json(await estadoLicencia());
});

// Activar con la clave del proveedor.
router.post('/activar', async (req, res) => {
  const ok = await activarLicencia(req.body?.clave);
  if (ok) {
    res.json({ ok: true, mensaje: 'Sistema activado. ¡Gracias!' });
  } else {
    res.status(400).json({ ok: false, error: 'Clave de activación incorrecta.' });
  }
});

export default router;

// Middleware: si la licencia está vencida, bloquea el acceso a
// los datos. Deja pasar: las rutas de licencia (para activar),
// el login (para que el proveedor pueda entrar), y a cualquiera
// que ya tenga sesión de PROVEEDOR (la llave maestra).
export async function bloqueoPorLicencia(req, res, next) {
  const ruta = req.path;

  // Rutas siempre permitidas, incluso con licencia vencida.
  if (
    ruta.startsWith('/api/licencia') ||
    ruta === '/api/salud' ||
    ruta === '/api/auth/login'
  ) {
    return next();
  }

  const estado = await estadoLicencia();
  if (estado.estado !== 'vencida') return next();

  // Licencia vencida: solo el proveedor puede seguir.
  const cabecera = req.headers.authorization;
  if (cabecera && cabecera.startsWith('Bearer ')) {
    try {
      const SECRETO = process.env.JWT_SECRETO || 'cambiar-esta-clave-en-produccion';
      const datos = jwt.verify(cabecera.slice(7), SECRETO);
      if (datos.rol === 'proveedor') return next();   // la llave maestra pasa
    } catch {
      // token inválido: cae al bloqueo
    }
  }

  return res.status(423).json({
    bloqueado: true,
    error: 'El periodo de prueba ha finalizado. Contacte al proveedor para activar el sistema.',
  });
}
