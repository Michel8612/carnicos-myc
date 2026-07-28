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

// Roles que se consideran "almacenero" (el nombre correcto es 'almacen',
// pero se acepta el alias viejo 'almacenero' por si quedó algún dato así).
const ES_ROL_ALMACEN = (rol) => rol === 'almacen' || rol === 'almacenero';

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

  const tx = db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO usuarios (nombre, usuario, clave_hash, rol, almacen_id, debe_cambiar, activo)
      VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run(nombre, usuario, hash, rolFinal, almacen_id || null);
    const nuevoId = r.lastInsertRowid;

    // Si es almacenero y no se le asignó un almacén existente, se le crea
    // uno propio (su área): "Almacén de <nombre>". Así cada almacenero
    // tiene siempre su propia instancia, sin pasos manuales extra.
    if (ES_ROL_ALMACEN(rolFinal) && !almacen_id) {
      const nuevoAlmacen = await db.prepare(
        "INSERT INTO almacenes (nombre, zona, usuario_id) VALUES (?, 'general', ?)"
      ).run(`Almacén de ${nombre}`, nuevoId);
      await db.prepare('UPDATE usuarios SET almacen_id = ? WHERE id = ?')
        .run(nuevoAlmacen.lastInsertRowid, nuevoId);
    }

    return nuevoId;
  });

  res.json({ id: await tx() });
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

// ============================================================
//  ELIMINAR USUARIOS
//
//  Un usuario de rol 'almacen' es dueño de un almacén (su área);
//  uno de rol 'ventas' es dueño de su hoja de ventas (venta_inventario).
//  Antes de borrar hay que decidir qué pasa con esos datos: se pueden
//  transferir a otro usuario (reasignar-area) o se pueden borrar junto
//  con el usuario (borrar_area:true al eliminar).
// ============================================================

// Información del área de un usuario: si tiene una, y cuántos datos
// tiene, para que el frontend muestre el cartel de aviso antes de borrar.
router.get('/:id/area-info', async (req, res) => {
  const id = Number(req.params.id);
  const usuario = await db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

  if (ES_ROL_ALMACEN(usuario.rol)) {
    const almacen = await db.prepare('SELECT * FROM almacenes WHERE usuario_id = ?').get(id);
    if (!almacen) return res.json({ tiene_area: false });
    const productos = await db.prepare(
      'SELECT COUNT(*) AS n FROM existencias WHERE almacen_id = ? AND cantidad <> 0'
    ).get(almacen.id);
    const movimientos = await db.prepare(
      'SELECT COUNT(*) AS n FROM movimientos WHERE almacen_id = ?'
    ).get(almacen.id);
    return res.json({
      tiene_area: true,
      tipo_area: 'almacen',
      area_id: almacen.id,
      area_nombre: almacen.nombre,
      productos_con_existencia: Number(productos.n),
      registros_movimiento: Number(movimientos.n),
      tiene_datos: Number(productos.n) > 0 || Number(movimientos.n) > 0,
    });
  }

  if (usuario.rol === 'ventas') {
    const hoja = await db.prepare(
      'SELECT COUNT(*) AS n FROM venta_inventario WHERE usuario_id = ?'
    ).get(id);
    return res.json({
      tiene_area: Number(hoja.n) > 0,
      tipo_area: 'ventas',
      productos_en_hoja: Number(hoja.n),
      tiene_datos: Number(hoja.n) > 0,
    });
  }

  res.json({ tiene_area: false });
});

// Transferir el área (almacén u hoja de ventas) de un usuario a otro,
// para no perder los datos antes de eliminar al primero.
router.post('/:id/reasignar-area', async (req, res) => {
  const id = Number(req.params.id);
  const nuevoUsuarioId = Number(req.body?.nuevo_usuario_id);
  if (!nuevoUsuarioId) {
    return res.status(400).json({ error: 'Indique a qué usuario transferir el área.' });
  }
  if (nuevoUsuarioId === id) {
    return res.status(400).json({ error: 'Elija un usuario distinto.' });
  }

  const usuario = await db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  const nuevo = await db.prepare('SELECT * FROM usuarios WHERE id = ?').get(nuevoUsuarioId);
  if (!usuario || !nuevo) return res.status(404).json({ error: 'Usuario no encontrado.' });

  const mismoTipoDeRol =
    (ES_ROL_ALMACEN(usuario.rol) && ES_ROL_ALMACEN(nuevo.rol)) ||
    (usuario.rol === nuevo.rol);
  if (!mismoTipoDeRol) {
    return res.status(400).json({ error: 'El área solo puede transferirse a un usuario del mismo rol.' });
  }

  const tx = db.transaction(async () => {
    if (ES_ROL_ALMACEN(usuario.rol)) {
      const almacen = await db.prepare('SELECT * FROM almacenes WHERE usuario_id = ?').get(id);
      if (almacen) {
        await db.prepare('UPDATE almacenes SET usuario_id = ? WHERE id = ?').run(nuevoUsuarioId, almacen.id);
        await db.prepare('UPDATE usuarios SET almacen_id = ? WHERE id = ?').run(almacen.id, nuevoUsuarioId);
      }
    } else if (usuario.rol === 'ventas') {
      await db.prepare('UPDATE venta_inventario SET usuario_id = ? WHERE usuario_id = ?')
        .run(nuevoUsuarioId, id);
    }
  });
  await tx();

  res.json({ ok: true });
});

// Eliminar un usuario de verdad (no se conserva). Reglas:
//  - No puede eliminarse a sí mismo.
//  - Si tiene un área (almacén u hoja de ventas) con datos y no se pide
//    borrar_area:true, se avisa y NO se borra (el frontend debe ofrecer
//    reasignar el área primero, o confirmar el borrado de sus datos).
//  - El historial de otras tablas (movimientos, ventas, caja, el libro,
//    etc.) NO se borra: se desvincula del usuario (queda sin ese enlace)
//    para no perder información del negocio.
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.usuario.id) {
    return res.status(400).json({ error: 'No puede eliminarse a sí mismo.' });
  }
  const usuario = await db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

  const borrarArea = !!(req.body && req.body.borrar_area);
  let aviso = null;

  const tx = db.transaction(async () => {
    // ---------- Área del usuario ----------
    if (ES_ROL_ALMACEN(usuario.rol)) {
      const almacen = await db.prepare('SELECT * FROM almacenes WHERE usuario_id = ?').get(id);
      if (almacen) {
        if (borrarArea) {
          await db.prepare('DELETE FROM movimientos WHERE almacen_id = ?').run(almacen.id);
          await db.prepare('DELETE FROM existencias WHERE almacen_id = ?').run(almacen.id);
          await db.prepare('DELETE FROM almacenes WHERE id = ?').run(almacen.id);
          aviso = `Se borró el almacén "${almacen.nombre}" y todos sus datos.`;
        } else {
          // El área queda huérfana (sin responsable): sus datos NO se pierden.
          await db.prepare('UPDATE almacenes SET usuario_id = NULL WHERE id = ?').run(almacen.id);
          aviso = `El almacén "${almacen.nombre}" quedó sin responsable asignado. Sus productos y movimientos se conservan.`;
        }
      }
    } else if (usuario.rol === 'ventas') {
      const hoja = await db.prepare(
        'SELECT COUNT(*) AS n FROM venta_inventario WHERE usuario_id = ?'
      ).get(id);
      if (Number(hoja.n) > 0) {
        if (borrarArea) {
          await db.prepare('DELETE FROM venta_inventario WHERE usuario_id = ?').run(id);
          aviso = 'Se borró su hoja de ventas y todos sus productos.';
        } else {
          // A diferencia del almacén, la hoja de ventas no puede quedar
          // huérfana (cada producto SIEMPRE pertenece a un usuario): hay
          // que reasignarla o aceptar borrar sus datos.
          throw new Error(
            'Este usuario tiene productos en su hoja de ventas. Reasigne el área a otro usuario (reasignar-area) o confirme el borrado de sus datos (borrar_area).'
          );
        }
      }
    }

    // ---------- Desvincular el historial (se conserva el dato, se pierde el enlace) ----------
    const tablasHistorial = [
      ['movimientos', 'usuario_id'],
      ['caja', 'usuario_id'],
      ['compras', 'usuario_id'],
      ['formulas', 'usuario_id'],
      ['ordenes_produccion', 'usuario_id'],
      ['ventas', 'usuario_id'],
      ['gastos', 'usuario_id'],
      ['combustible', 'usuario_id'],
      ['ipv_diario', 'cerrado_por'],
      ['ipv_correcciones', 'usuario_id'],
      ['recetas', 'usuario_id'],
      ['producciones', 'usuario_id'],
      ['contabilidad_registros', 'usuario_id'],
    ];
    for (const [tabla, columna] of tablasHistorial) {
      await db.prepare(`UPDATE ${tabla} SET ${columna} = NULL WHERE ${columna} = ?`).run(id);
    }

    await db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
  });

  try {
    await tx();
    res.json({ ok: true, aviso });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
