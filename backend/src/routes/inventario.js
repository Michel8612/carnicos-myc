// ============================================================
//  Rutas de inventario
//
//  Maneja productos, existencias y movimientos (entradas/salidas).
//  Incluye el cálculo de "en cuántos días se agota" basado en
//  el ritmo real de salidas de cada producto.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';
import { anotar } from '../libro.js';

const router = Router();
router.use(requiereSesion);

// ---------- Productos ----------

// Lista de productos con su unidad.
router.get('/productos', async (req, res) => {
  const filas = await db.prepare(`
    SELECT p.*, u.abreviatura AS unidad
    FROM productos p
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1
    ORDER BY p.nombre
  `).all();
  res.json(filas);
});

// Crear producto nuevo (el dueño amplía su catálogo sin tocar código).
router.post('/productos', async (req, res) => {
  const { nombre, tipo, categoria, unidad_id, precio_costo, precio_venta, stock_minimo } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'Indique nombre y tipo del producto.' });
  const r = await db.prepare(`
    INSERT INTO productos (nombre, tipo, categoria, unidad_id, precio_costo, precio_venta, stock_minimo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nombre, tipo, categoria || null, unidad_id || null, precio_costo || 0, precio_venta || 0, stock_minimo || 0);
  res.json({ id: r.lastInsertRowid });
});

// Editar un producto existente.
router.put('/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, tipo, categoria, unidad_id, precio_costo, precio_venta, stock_minimo } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'Indique nombre y tipo.' });
  await db.prepare(`
    UPDATE productos
    SET nombre = ?, tipo = ?, categoria = ?, unidad_id = ?, precio_costo = ?, precio_venta = ?, stock_minimo = ?
    WHERE id = ?
  `).run(nombre, tipo, categoria || null, unidad_id || null, precio_costo || 0, precio_venta || 0, stock_minimo || 0, id);
  res.json({ ok: true });
});

// Eliminar un producto. Si ya tiene movimientos, no se borra de
// verdad (se desactiva) para no romper el historial. Si nunca se
// usó, se borra del todo.
router.delete('/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const usado = (await db.prepare(
    'SELECT COUNT(*) AS n FROM movimientos WHERE producto_id = ?'
  ).get(id)).n;
  const enExistencias = (await db.prepare(
    'SELECT COALESCE(SUM(cantidad),0) AS c FROM existencias WHERE producto_id = ?'
  ).get(id)).c;

  if (usado > 0 || enExistencias > 0) {
    // Tiene historial o existencias: solo desactivar.
    await db.prepare('UPDATE productos SET activo = 0 WHERE id = ?').run(id);
    return res.json({ ok: true, desactivado: true });
  }
  // Nunca se usó: borrar del todo.
  await db.prepare('DELETE FROM existencias WHERE producto_id = ?').run(id);
  await db.prepare('DELETE FROM productos WHERE id = ?').run(id);
  res.json({ ok: true, eliminado: true });
});

// ---------- Existencias con predicción ----------

// Devuelve cada producto con su stock total, su estado y los días
// estimados que quedan antes de agotarse.
router.get('/existencias', async (req, res) => {
  // Stock actual por producto (sumando todos los almacenes).
  const stock = await db.prepare(`
    SELECT p.id, p.nombre, p.stock_minimo, p.tipo, p.unidad_id,
           p.precio_costo, p.precio_venta, u.abreviatura AS unidad,
           COALESCE(SUM(e.cantidad), 0) AS cantidad
    FROM productos p
    LEFT JOIN existencias e ON e.producto_id = p.id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1
    GROUP BY p.id, u.abreviatura
    ORDER BY p.nombre
  `).all();

  // Ritmo de salida: promedio diario de los últimos 30 días.
  const salidas = await db.prepare(`
    SELECT producto_id, SUM(cantidad) AS total
    FROM movimientos
    WHERE tipo = 'salida' AND fecha >= now() - interval '30 days'
    GROUP BY producto_id
  `).all();
  const ritmo = {};
  for (const s of salidas) ritmo[s.producto_id] = s.total / 30;  // por día

  const resultado = stock.map((p) => {
    const porDia = ritmo[p.id] || 0;
    let diasRestantes = null;
    let fechaAgotamiento = null;
    if (porDia > 0) {
      diasRestantes = Math.floor(p.cantidad / porDia);
      const f = new Date();
      f.setDate(f.getDate() + diasRestantes);
      fechaAgotamiento = f.toISOString().slice(0, 10);
    }

    // Estado de la tarjeta.
    let estado = 'normal';
    if (p.cantidad <= 0) estado = 'agotado';
    else if (p.stock_minimo > 0 && p.cantidad <= p.stock_minimo) estado = 'critico';
    else if (diasRestantes !== null && diasRestantes <= 7) estado = 'bajo';

    return { ...p, consumo_diario: Number(porDia.toFixed(2)), dias_restantes: diasRestantes, fecha_agotamiento: fechaAgotamiento, estado };
  });

  res.json(resultado);
});

// ---------- Registrar un movimiento ----------

// Entrada o salida. Actualiza existencias y deja el rastro.
router.post('/movimientos', async (req, res) => {
  const { producto_id, almacen_id, tipo, cantidad, nota } = req.body;
  if (!producto_id || !almacen_id || !tipo || !cantidad) {
    return res.status(400).json({ error: 'Faltan datos del movimiento.' });
  }
  if (!['entrada', 'salida', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de movimiento no válido.' });
  }
  const cant = Number(cantidad);
  if (cant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor que cero.' });

  const tx = db.transaction(async () => {
    // Registrar el movimiento (el rastro que evita descuadres).
    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
      VALUES (?, ?, ?, ?, 'manual', ?, ?)
    `).run(producto_id, almacen_id, tipo, cant, req.usuario.id, nota || null);

    // Actualizar existencias en ese almacén.
    const fila = await db.prepare(
      'SELECT id, cantidad FROM existencias WHERE producto_id = ? AND almacen_id = ?'
    ).get(producto_id, almacen_id);

    const delta = tipo === 'salida' ? -cant : cant;
    if (fila) {
      const nueva = fila.cantidad + delta;
      if (nueva < 0) throw new Error('No hay suficiente existencia para esa salida.');
      await db.prepare('UPDATE existencias SET cantidad = ? WHERE id = ?').run(nueva, fila.id);
    } else {
      if (delta < 0) throw new Error('No hay existencia de ese producto en ese almacén.');
      await db.prepare(
        'INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)'
      ).run(producto_id, almacen_id, delta);
    }
  });

  try {
    await tx();

    // Dejar constancia en el libro de contabilidad: el contador debe ver
    // CUALQUIER movimiento económico, venga del área que venga.
    const info = await db.prepare(`
      SELECT p.nombre, COALESCE(p.precio_costo,0) AS costo, COALESCE(u.abreviatura,'') AS unidad,
             a.nombre AS almacen
      FROM productos p
      LEFT JOIN unidades u ON u.id = p.unidad_id
      LEFT JOIN almacenes a ON a.id = ?
      WHERE p.id = ?
    `).get(almacen_id, producto_id);
    if (info) {
      const valor = Number((cant * info.costo).toFixed(2));
      await anotar({
        tipo: 'almacen',
        concepto: `${tipo === 'entrada' ? 'Entrada' : tipo === 'salida' ? 'Salida' : 'Ajuste'} de almacén — ${info.nombre}`,
        producto: info.nombre,
        cantidad: cant,
        unidad: info.unidad,
        // Mover mercancía NO es ganancia ni pérdida: una entrada es cambiar
        // dinero por inventario (una inversión) y una salida es sacarlo del
        // estante. Por eso se guarda su VALOR como referencia, pero no suma
        // ni resta en el resultado del negocio: eso lo hacen las ventas
        // (ingreso) y los gastos.
        costo: 0,
        ingreso: 0,
        valor,
        area: 'almacen',
        usuario: req.usuario,
        nota: [info.almacen, nota].filter(Boolean).join(' · ') || null,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Lista de almacenes (para los formularios).
router.get('/almacenes', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM almacenes ORDER BY nombre').all());
});

// Lista de unidades de medida (para crear productos).
router.get('/unidades', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM unidades ORDER BY id').all());
});

export default router;

