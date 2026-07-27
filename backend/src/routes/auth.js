// ============================================================
//  Rutas de acceso (login)
// ============================================================

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { crearToken, requiereSesion } from '../middleware/auth.js';
import { esLoginProveedor, verificarProveedor, usuarioProveedor } from '../licencia/proveedor.js';

const router = Router();

// Iniciar sesión: recibe usuario y clave, devuelve un token.
router.post('/login', async (req, res) => {
  const { usuario, clave } = req.body;
  if (!usuario || !clave) {
    return res.status(400).json({ error: 'Escriba usuario y contraseña.' });
  }

  // ¿Es el acceso de proveedor (llave maestra)? Se verifica primero,
  // fuera de la base de datos. Entra siempre, incluso con licencia vencida.
  if (esLoginProveedor(usuario)) {
    if (verificarProveedor(usuario, clave)) {
      const prov = usuarioProveedor();
      return res.json({ token: crearToken(prov), usuario: { ...prov, debe_cambiar: 0 } });
    }
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const fila = await db.prepare(
    'SELECT * FROM usuarios WHERE usuario = ? AND activo = 1'
  ).get(usuario);

  // Mismo mensaje para usuario inexistente o clave mala: no revelar cuál falló.
  if (!fila || !bcrypt.compareSync(clave, fila.clave_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const token = crearToken(fila);
  res.json({
    token,
    usuario: { id: fila.id, nombre: fila.nombre, usuario: fila.usuario, rol: fila.rol, debe_cambiar: fila.debe_cambiar },
  });
});

// Cambiar usuario y/o clave (obligatorio en el primer ingreso).
router.post('/cambiar-credenciales', requiereSesion, async (req, res) => {
  const { nuevo_usuario, nueva_clave } = req.body;
  if (!nueva_clave || nueva_clave.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
  }

  // Si cambia el usuario, verificar que no esté tomado.
  if (nuevo_usuario) {
    const tomado = await db.prepare(
      'SELECT 1 FROM usuarios WHERE usuario = ? AND id != ?'
    ).get(nuevo_usuario, req.usuario.id);
    if (tomado) return res.status(400).json({ error: 'Ese nombre de usuario ya existe.' });
  }

  const hash = bcrypt.hashSync(nueva_clave, 10);
  await db.prepare(`
    UPDATE usuarios
    SET clave_hash = ?, usuario = COALESCE(?, usuario), debe_cambiar = 0
    WHERE id = ?
  `).run(hash, nuevo_usuario || null, req.usuario.id);

  res.json({ ok: true });
});

// Saber quién es el usuario de la sesión actual.
router.get('/yo', requiereSesion, async (req, res) => {
  const fila = await db.prepare(
    'SELECT id, nombre, usuario, rol, almacen_id, debe_cambiar FROM usuarios WHERE id = ?'
  ).get(req.usuario.id);
  res.json(fila);
});

export default router;
