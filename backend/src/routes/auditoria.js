// ============================================================
//  AUDITORÍA — pantalla de solo lectura
//
//  Aquí se CONSULTA la tabla `auditoria` (quién hizo qué y cuándo).
//  Nunca se escribe ni se borra desde esta ruta: el único punto de
//  entrada para dejar constancia es `auditar()` en backend/src/auditoria.js,
//  llamado desde cada acción real del sistema.
//
//  El montaje en server.js ya exige sesión:
//    app.use('/api/auditoria', requiereSesion, auditoriaRoutes)
//  Aquí solo falta filtrar por rol.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

// Quién puede MIRAR la auditoría. El resto, fuera: es información
// sensible (quién entró, qué se borró, quién autorizó qué).
const PUEDE_VER = ['dueno', 'admin', 'proveedor', 'contabilidad'];

router.use((req, res, next) => {
  if (!PUEDE_VER.includes(req.usuario?.rol)) {
    return res.status(403).json({ error: 'No tiene permiso para ver la auditoría del sistema.' });
  }
  next();
});

// GET /auditoria?usuario_id=&modulo=&accion=&desde=&hasta=&limite=
router.get('/', async (req, res) => {
  const { usuario_id, modulo, accion, desde, hasta } = req.query;

  const cond = [];
  const params = [];
  if (usuario_id) { cond.push('usuario_id = ?'); params.push(Number(usuario_id)); }
  if (modulo)     { cond.push('modulo = ?');     params.push(modulo); }
  if (accion)     { cond.push('accion = ?');     params.push(accion); }
  if (desde)      { cond.push('fecha >= ?');     params.push(desde); }
  if (hasta)      { cond.push('fecha <= ?');     params.push(hasta + ' 23:59:59'); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

  // Límite por defecto 200, tope duro 1000: es una pantalla de consulta,
  // no una descarga masiva.
  const limitePedido = Number(req.query.limite) || 200;
  const limite = Math.min(Math.max(limitePedido, 1), 1000);

  const filas = await db.prepare(`
    SELECT id, fecha, usuario_id, usuario_nombre, rol, modulo, accion, entidad, entidad_id,
           descripcion, valor_anterior, valor_nuevo, motivo, autorizado_por, autorizado_nombre, ip
    FROM auditoria
    ${where}
    ORDER BY fecha DESC
    LIMIT ${limite}
  `).all(...params);

  const { total } = await db.prepare(`
    SELECT COUNT(*) AS total FROM auditoria ${where}
  `).get(...params);

  res.json({ filas, total: Number(total) });
});

// GET /auditoria/filtros — valores distintos presentes en la tabla,
// para poblar los desplegables de la pantalla (solo lo que existe de
// verdad, no la lista completa de MODULOS/ACCIONES posibles).
router.get('/filtros', async (req, res) => {
  const [usuarios, modulos, acciones] = await Promise.all([
    db.prepare(`
      SELECT DISTINCT usuario_id, usuario_nombre
      FROM auditoria
      WHERE usuario_id IS NOT NULL
      ORDER BY usuario_nombre
    `).all(),
    db.prepare(`
      SELECT DISTINCT modulo FROM auditoria WHERE modulo IS NOT NULL ORDER BY modulo
    `).all(),
    db.prepare(`
      SELECT DISTINCT accion FROM auditoria WHERE accion IS NOT NULL ORDER BY accion
    `).all(),
  ]);

  res.json({
    usuarios: usuarios.map((u) => ({ id: u.usuario_id, nombre: u.usuario_nombre })),
    modulos: modulos.map((m) => m.modulo),
    acciones: acciones.map((a) => a.accion),
  });
});

// A propósito NO hay aquí ninguna ruta POST/PUT/DELETE. Un registro de
// auditoría que se puede borrar o cambiar no sirve para auditar nada.
// Si en el futuro hiciera falta "purgar" auditoría vieja por espacio,
// eso debería ser una tarea de mantenimiento fuera de la API HTTP
// (con su propio rastro), no un endpoint que cualquier rol autorizado
// a mirar la pantalla pueda invocar por error.

export default router;
