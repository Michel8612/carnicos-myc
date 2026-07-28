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

// Un usuario de rol 'almacen' solo ve y mueve SU PROPIO almacén (el
// que tiene asignado en usuarios.almacen_id). El dueño (y roles admin/
// proveedor) ven y mueven todos. Esta función devuelve el almacen_id
// al que hay que limitar las consultas, o null si no hay límite.
function almacenDeLaSesion(req) {
  const rol = req.usuario.rol;
  if (rol === 'almacen' || rol === 'almacenero') {
    return req.usuario.almacen_id || null;
  }
  return null; // dueño / admin / proveedor / otros roles: sin límite
}

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
  // Si es un almacenero, solo se cuenta SU almacén; el dueño ve el total
  // sumando todos los almacenes (como antes).
  const almacenId = almacenDeLaSesion(req);

  const stock = await db.prepare(`
    SELECT p.id, p.nombre, p.stock_minimo, p.tipo, p.unidad_id,
           p.precio_costo, p.precio_venta, u.abreviatura AS unidad,
           COALESCE(SUM(e.cantidad), 0) AS cantidad
    FROM productos p
    LEFT JOIN existencias e ON e.producto_id = p.id ${almacenId ? 'AND e.almacen_id = ?' : ''}
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1
    GROUP BY p.id, u.abreviatura
    ORDER BY p.nombre
  `).all(...(almacenId ? [almacenId] : []));

  // Ritmo de salida: promedio diario de los últimos 30 días.
  const salidas = await db.prepare(`
    SELECT producto_id, SUM(cantidad) AS total
    FROM movimientos
    WHERE tipo = 'salida' AND fecha >= now() - interval '30 days'
    ${almacenId ? 'AND almacen_id = ?' : ''}
    GROUP BY producto_id
  `).all(...(almacenId ? [almacenId] : []));
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

// Suma (o resta) una cantidad a la existencia de un producto en un
// almacén. Se usa tanto para el movimiento principal como para la
// entrada en el almacén de destino cuando hay traslado.
async function moverExistencia(productoId, almacenId, delta) {
  const fila = await db.prepare(
    'SELECT id, cantidad FROM existencias WHERE producto_id = ? AND almacen_id = ?'
  ).get(productoId, almacenId);
  if (fila) {
    const nueva = Number((fila.cantidad + delta).toFixed(3));
    if (nueva < 0) throw new Error('No hay suficiente existencia para esa salida.');
    await db.prepare('UPDATE existencias SET cantidad = ? WHERE id = ?').run(nueva, fila.id);
  } else {
    if (delta < 0) throw new Error('No hay existencia de ese producto en ese almacén.');
    await db.prepare(
      'INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)'
    ).run(productoId, almacenId, delta);
  }
}

// Entrada, salida o ajuste. Actualiza existencias y deja el rastro.
//
// La SALIDA admite, opcionalmente:
//  - destino_almacen_id: además de sacar del almacén de origen, entra
//    esa misma cantidad al almacén de destino (un traslado completo,
//    en una sola transacción).
//  - destino_texto: no mueve nada más, solo queda anotado a dónde fue
//    (ej. "Punto de venta del centro").
// Si no viene ninguno de los dos, es una salida simple.
router.post('/movimientos', async (req, res) => {
  const { producto_id, almacen_id, tipo, cantidad, nota, destino_almacen_id, destino_texto } = req.body;
  if (!producto_id || !almacen_id || !tipo || !cantidad) {
    return res.status(400).json({ error: 'Faltan datos del movimiento.' });
  }
  if (!['entrada', 'salida', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de movimiento no válido.' });
  }
  const cant = Number(cantidad);
  if (cant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor que cero.' });

  // Un almacenero solo puede registrar movimientos en SU propio almacén.
  const limiteAlmacen = almacenDeLaSesion(req);
  if (limiteAlmacen && Number(almacen_id) !== Number(limiteAlmacen)) {
    return res.status(403).json({ error: 'Solo puede registrar movimientos en su propio almacén.' });
  }

  // El traslado a otro almacén (destino_almacen_id) solo tiene sentido
  // para una SALIDA: es lo que sale de aquí y entra allá.
  const destinoId = (tipo === 'salida' && destino_almacen_id) ? Number(destino_almacen_id) : null;
  if (destinoId && destinoId === Number(almacen_id)) {
    return res.status(400).json({ error: 'El almacén de destino debe ser distinto del de origen.' });
  }

  const tx = db.transaction(async () => {
    // 1) Movimiento principal (entrada/salida/ajuste) en el almacén de origen.
    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
      VALUES (?, ?, ?, ?, 'manual', ?, ?)
    `).run(producto_id, almacen_id, tipo, cant, req.usuario.id, nota || null);

    const delta = tipo === 'salida' ? -cant : cant;
    await moverExistencia(producto_id, almacen_id, delta);

    // 2) Si es un traslado completo, dar entrada en el almacén de destino.
    if (destinoId) {
      await db.prepare(`
        INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
        VALUES (?, ?, 'entrada', ?, 'traslado', ?, ?)
      `).run(producto_id, destinoId, cant, req.usuario.id, nota || null);
      await moverExistencia(producto_id, destinoId, cant);
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
      let destinoNombre = null;
      if (destinoId) {
        const d = await db.prepare('SELECT nombre FROM almacenes WHERE id = ?').get(destinoId);
        destinoNombre = d ? d.nombre : null;
      }
      // A dónde fue: traslado a otro almacén, un destino libre en texto, o nada.
      const partesDestino = [];
      if (destinoId) partesDestino.push(`trasladado a ${destinoNombre || 'otro almacén'}`);
      if (destino_texto) partesDestino.push(`destino: ${destino_texto}`);

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
        nota: [info.almacen, ...partesDestino, nota].filter(Boolean).join(' · ') || null,
      });
    }

    res.json({ ok: true, trasladado_a: destinoId || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Lista de almacenes (para los formularios).
// Un almacenero solo ve el suyo por defecto. Pasando ?todos=1 se
// devuelven todos (por ejemplo, para elegir un almacén de DESTINO al
// dar salida con traslado). El dueño siempre ve todos.
router.get('/almacenes', async (req, res) => {
  const limiteAlmacen = almacenDeLaSesion(req);
  if (limiteAlmacen && !req.query.todos) {
    const propio = await db.prepare('SELECT * FROM almacenes WHERE id = ?').get(limiteAlmacen);
    return res.json(propio ? [propio] : []);
  }
  res.json(await db.prepare('SELECT * FROM almacenes ORDER BY nombre').all());
});

// Lista de unidades de medida (para crear productos).
router.get('/unidades', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM unidades ORDER BY id').all());
});

export default router;

