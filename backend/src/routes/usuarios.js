// ============================================================
//  Gestión de usuarios (solo el dueño)
//
//  El dueño crea los accesos de sus almaceneros, les asigna un
//  almacén y puede activarlos o desactivarlos. Cada usuario
//  nuevo entra con clave temporal y debe crear la suya propia
//  en el primer ingreso.
// ============================================================

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { requiereSesion, soloDueno } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion, soloDueno);   // todo aquí es solo para el dueño

// Lista de usuarios con el nombre de su almacén.
router.get('/', async (req, res) => {
  const filas = await db.prepare(`
    SELECT u.id, u.nombre, u.usuario, u.rol, u.almacen_id, u.activo, u.debe_cambiar,
           a.nombre AS almacen_nombre
    FROM usuarios u
    LEFT JOIN almacenes a ON a.id = u.almacen_id
    ORDER BY u.activo DESC, u.nombre
  `).all();
  res.json(filas);
});

// Crear un usuario nuevo (normalmente un almacenero).
router.post('/', async (req, res) => {
  const { nombre, usuario, rol, almacen_id, clave_temporal } = req.body;
  if (!nombre || !usuario || !clave_temporal) {
    return res.status(400).json({ error: 'Indique nombre, usuario y una clave temporal.' });
  }
  if (clave_temporal.length < 6) {
    return res.status(400).json({ error: 'La clave temporal debe tener al menos 6 caracteres.' });
  }
  // Roles válidos del sistema. Si viene uno desconocido, cae a almacenero.
  const ROLES_VALIDOS = ['dueno', 'cocinero', 'almacen', 'ventas', 'contabilidad'];
  const rolFinal = ROLES_VALIDOS.includes(rol) ? rol : 'almacenero';

  const tomado = await db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(usuario);
  if (tomado) return res.status(400).json({ error: 'Ese nombre de usuario ya existe.' });

  const hash = bcrypt.hashSync(clave_temporal, 10);
  const r = await db.prepare(`
    INSERT INTO usuarios (nombre, usuario, clave_hash, rol, almacen_id, debe_cambiar, activo)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `).run(nombre, usuario, hash, rolFinal, almacen_id || null);

  res.json({ id: r.lastInsertRowid });
});

// Activar o desactivar un usuario (no se borra, se conserva el historial).
router.post('/:id/activo', async (req, res) => {
  const { activo } = req.body;
  const id = Number(req.params.id);
  if (id === req.usuario.id) {
    return res.status(400).json({ error: 'No puede desactivarse a sí mismo.' });
  }
  await db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo ? 1 : 0, id);
  res.json({ ok: true });
});

// Reiniciar la clave de un usuario (vuelve a clave temporal + primer ingreso).
router.post('/:id/reiniciar-clave', async (req, res) => {
  const { clave_temporal } = req.body;
  if (!clave_temporal || clave_temporal.length < 6) {
    return res.status(400).json({ error: 'La clave temporal debe tener al menos 6 caracteres.' });
  }
  const hash = bcrypt.hashSync(clave_temporal, 10);
  await db.prepare('UPDATE usuarios SET clave_hash = ?, debe_cambiar = 1 WHERE id = ?')
    .run(hash, Number(req.params.id));
  res.json({ ok: true });
});

export default router;
