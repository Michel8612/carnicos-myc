// ============================================================
//  Ventas y deudas (Fase 2)
//
//  Al registrar una venta, el sistema:
//   1) descuenta los productos del inventario
//   2) registra el ingreso en caja (lo que se pagó)
//   3) si quedó algo sin pagar, lo deja como deuda
//
//  Todo en una acción, sin doble trabajo.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion);

// ---------- Registrar una venta ----------

router.post('/', async (req, res) => {
  const { cliente, almacen_id, items, pagado, moneda } = req.body;
  // items = [{ producto_id, cantidad, precio_unitario }]

  if (!almacen_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Indique el almacén y al menos un producto.' });
  }

  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';
  const total = items.reduce((s, it) => s + Number(it.cantidad) * Number(it.precio_unitario), 0);
  const pagadoNum = Number(pagado) || 0;

  if (pagadoNum > total) {
    return res.status(400).json({ error: 'Lo pagado no puede ser mayor que el total.' });
  }

  let estado = 'pendiente';
  if (pagadoNum >= total) estado = 'pagada';
  else if (pagadoNum > 0) estado = 'parcial';

  const tx = db.transaction(async () => {
    // 1) Verificar y descontar inventario de cada producto.
    for (const it of items) {
      const ex = await db.prepare(
        'SELECT id, cantidad FROM existencias WHERE producto_id = ? AND almacen_id = ?'
      ).get(it.producto_id, almacen_id);
      if (!ex || ex.cantidad < Number(it.cantidad)) {
        const prod = await db.prepare('SELECT nombre FROM productos WHERE id = ?').get(it.producto_id);
        const nombreProd = prod?.nombre || 'producto';
        const hayAqui = ex ? ex.cantidad : 0;

        // Buscar en QUÉ OTROS almacenes sí hay este producto, para
        // que el usuario sepa de dónde puede venderlo en vez de solo
        // recibir "no hay". Esto evita el bug de "no hay" cuando en
        // realidad el producto existe en otro almacén.
        const enOtros = await db.prepare(`
          SELECT a.nombre AS almacen, e.cantidad
          FROM existencias e
          JOIN almacenes a ON a.id = e.almacen_id
          WHERE e.producto_id = ? AND e.almacen_id != ? AND e.cantidad > 0
          ORDER BY e.cantidad DESC
        `).all(it.producto_id, almacen_id);

        let msg = `No hay suficiente "${nombreProd}" en ese almacén (hay ${hayAqui}, necesita ${it.cantidad}).`;
        if (enOtros.length > 0) {
          const lista = enOtros.map((o) => `${o.almacen}: ${o.cantidad}`).join(', ');
          msg += ` Sí hay en otro almacén → ${lista}. Cambie el almacén de la venta o traslade el producto.`;
        }
        throw new Error(msg);
      }
      await db.prepare('UPDATE existencias SET cantidad = cantidad - ? WHERE id = ?')
        .run(Number(it.cantidad), ex.id);
      await db.prepare(`
        INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
        VALUES (?, ?, 'salida', ?, 'venta', ?, 'Venta')
      `).run(it.producto_id, almacen_id, Number(it.cantidad), req.usuario.id);
    }

    // 2) Crear la venta.
    const r = await db.prepare(`
      INSERT INTO ventas (cliente, total, pagado, estado, usuario_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(cliente || 'Cliente', total, pagadoNum, estado, req.usuario.id);
    const ventaId = r.lastInsertRowid;

    // 3) Guardar el detalle.
    for (const it of items) {
      await db.prepare(`
        INSERT INTO ventas_detalle (venta_id, producto_id, cantidad, precio_unitario)
        VALUES (?, ?, ?, ?)
      `).run(ventaId, it.producto_id, Number(it.cantidad), Number(it.precio_unitario));
    }

    // 4) Registrar en caja lo que se pagó (si algo se pagó).
    if (pagadoNum > 0) {
      await db.prepare(`
        INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
        VALUES ('ingreso', ?, ?, ?, 'venta', ?, ?)
      `).run(`Venta a ${cliente || 'Cliente'}`, pagadoNum, mon, ventaId, req.usuario.id);
    }

    return { ventaId, total, estado };
  });

  try {
    res.json({ ok: true, ...(await tx()) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Lista de ventas ----------

router.get('/', async (req, res) => {
  const ventas = await db.prepare(`
    SELECT v.*, u.nombre AS usuario_nombre
    FROM ventas v LEFT JOIN usuarios u ON u.id = v.usuario_id
    ORDER BY v.fecha DESC LIMIT 100
  `).all();
  res.json(ventas);
});

// ---------- Deudas (ventas no pagadas del todo) ----------

router.get('/deudas', async (req, res) => {
  const deudas = await db.prepare(`
    SELECT cliente,
           SUM(total - pagado) AS debe,
           COUNT(*) AS ventas_pendientes
    FROM ventas
    WHERE estado IN ('pendiente', 'parcial')
    GROUP BY cliente
    ORDER BY debe DESC
  `).all();
  const totalDeuda = deudas.reduce((s, d) => s + d.debe, 0);
  res.json({ deudas, totalDeuda });
});

// ---------- Ventas pendientes de un cliente (para cobrar) ----------

router.get('/pendientes/:cliente', async (req, res) => {
  const ventas = await db.prepare(`
    SELECT id, fecha, total, pagado, (total - pagado) AS pendiente, estado
    FROM ventas
    WHERE cliente = ? AND estado IN ('pendiente', 'parcial')
    ORDER BY fecha
  `).all(req.params.cliente);
  res.json(ventas);
});

// ---------- Registrar un cobro (abonar a una deuda) ----------

router.post('/:id/cobrar', async (req, res) => {
  const id = Number(req.params.id);
  const { monto, moneda } = req.body;
  const m = Number(monto);
  if (!m || m <= 0) return res.status(400).json({ error: 'Indique el monto a cobrar.' });

  const venta = await db.prepare('SELECT * FROM ventas WHERE id = ?').get(id);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const pendiente = venta.total - venta.pagado;
  if (m > pendiente) return res.status(400).json({ error: `Solo quedan ${pendiente} por cobrar.` });

  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';
  const nuevoPagado = venta.pagado + m;
  const nuevoEstado = nuevoPagado >= venta.total ? 'pagada' : 'parcial';

  const tx = db.transaction(async () => {
    await db.prepare('UPDATE ventas SET pagado = ?, estado = ? WHERE id = ?')
      .run(nuevoPagado, nuevoEstado, id);
    await db.prepare(`
      INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
      VALUES ('ingreso', ?, ?, ?, 'venta', ?, ?)
    `).run(`Cobro a ${venta.cliente}`, m, mon, id, req.usuario.id);
  });
  await tx();

  res.json({ ok: true, estado: nuevoEstado });
});

// ============================================================
//  PUNTO DE VENTA DEL DÍA (hoja del vendedor, atada a su almacén)
//
//  Cada vendedor vende SOLO de su almacén asignado. La hoja muestra
//  los productos con existencia, su precio, lo vendido HOY y el dinero
//  recogido, con un total (cuadre). Lo vendido/dinero es de HOY: al
//  cambiar el día se muestra en cero solo (no hay que borrar nada),
//  pero la existencia se conserva. Los productos agotados no aparecen.
//  El corte del día usa la hora de Cuba (America/Havana).
// ============================================================

const ES_JEFE = (rol) => rol === 'dueno' || rol === 'admin' || rol === 'proveedor';

// Almacén de trabajo: el del vendedor (del token) o el que el dueño elija.
function almacenDeTrabajo(req, fuente) {
  let almacenId = req.usuario.almacen_id || null;
  if (ES_JEFE(req.usuario.rol) && fuente && fuente.almacen_id) {
    almacenId = Number(fuente.almacen_id);
  }
  return almacenId;
}

// ---------- Hoja de venta del día ----------
router.get('/hoja', async (req, res) => {
  const esJefe = ES_JEFE(req.usuario.rol);
  const almacenId = almacenDeTrabajo(req, req.query);

  if (!almacenId) {
    // Vendedor sin almacén asignado, o dueño que aún no eligió uno.
    const almacenes = esJefe
      ? await db.prepare('SELECT id, nombre FROM almacenes ORDER BY nombre').all()
      : [];
    return res.json({ almacen: null, requiere_almacen: true, es_jefe: esJefe, almacenes, productos: [], total_dinero: 0 });
  }

  const almacen = await db.prepare('SELECT id, nombre FROM almacenes WHERE id = ?').get(almacenId);

  // Productos con existencia > 0 en ese almacén + lo vendido (jornada).
  const productos = await db.prepare(`
    SELECT p.id AS producto_id, p.nombre, u.abreviatura AS unidad,
           p.precio_venta, e.cantidad AS existencia,
           COALESCE(j.vendido, 0) AS vendido
    FROM existencias e
    JOIN productos p ON p.id = e.producto_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    LEFT JOIN jornada_ventas j ON j.producto_id = p.id AND j.almacen_id = e.almacen_id
    WHERE e.almacen_id = ? AND e.cantidad > 0 AND p.activo = 1
      AND p.tipo IN ('terminado', 'reventa')
    ORDER BY p.nombre
  `).all(almacenId);

  let total = 0;
  const filas = productos.map((p) => {
    const totalFila = Number(((p.vendido || 0) * (p.precio_venta || 0)).toFixed(2));
    total += totalFila;
    return {
      producto_id: p.producto_id, nombre: p.nombre, unidad: p.unidad || '',
      existencia: p.existencia, precio_venta: p.precio_venta || 0,
      vendido: p.vendido || 0, total: totalFila,
    };
  });

  res.json({ almacen, requiere_almacen: false, es_jefe: esJefe, productos: filas, total_dinero: Number(total.toFixed(2)) });
});

// ---------- Guardar cuánto se ha vendido de un producto (NO toca el stock) ----------
router.post('/jornada', async (req, res) => {
  const almacenId = almacenDeTrabajo(req, req.body);
  const productoId = Number(req.body.producto_id);
  const vendido = Number(req.body.vendido);
  if (!almacenId) return res.status(400).json({ error: 'No tiene un almacén asignado.' });
  if (!productoId || Number.isNaN(vendido) || vendido < 0) {
    return res.status(400).json({ error: 'Cantidad vendida no válida.' });
  }
  await db.prepare(`
    INSERT INTO jornada_ventas (almacen_id, producto_id, vendido) VALUES (?, ?, ?)
    ON CONFLICT (almacen_id, producto_id) DO UPDATE SET vendido = EXCLUDED.vendido
  `).run(almacenId, productoId, vendido);
  res.json({ ok: true });
});

// ---------- Agregar un producto a la hoja (crea si es nuevo y suma existencia) ----------
router.post('/agregar-producto', async (req, res) => {
  const almacenId = almacenDeTrabajo(req, req.body);
  let { producto_id, nombre, unidad_id, cantidad, precio_venta } = req.body;
  cantidad = Number(cantidad);
  precio_venta = Number(precio_venta) || 0;
  if (!almacenId) return res.status(400).json({ error: 'No tiene un almacén asignado.' });
  if (!cantidad || cantidad <= 0) return res.status(400).json({ error: 'Indique la cantidad (existencia).' });

  const tx = db.transaction(async () => {
    let pid = producto_id ? Number(producto_id) : null;
    if (!pid) {
      if (!nombre) throw new Error('Indique el nombre del producto.');
      const ex = await db.prepare("SELECT id FROM productos WHERE lower(nombre) = lower(?) AND activo = 1").get(nombre);
      if (ex) {
        pid = ex.id;
        await db.prepare('UPDATE productos SET precio_venta = ? WHERE id = ?').run(precio_venta, pid);
      } else {
        const nuevo = await db.prepare(
          'INSERT INTO productos (nombre, tipo, unidad_id, precio_venta) VALUES (?, ?, ?, ?)'
        ).run(nombre, 'reventa', unidad_id || null, precio_venta);
        pid = nuevo.lastInsertRowid;
      }
    } else if (precio_venta > 0) {
      await db.prepare('UPDATE productos SET precio_venta = ? WHERE id = ?').run(precio_venta, pid);
    }
    const exi = await db.prepare('SELECT id FROM existencias WHERE producto_id = ? AND almacen_id = ?').get(pid, almacenId);
    if (exi) await db.prepare('UPDATE existencias SET cantidad = cantidad + ? WHERE id = ?').run(cantidad, exi.id);
    else await db.prepare('INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)').run(pid, almacenId, cantidad);
    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
      VALUES (?, ?, 'entrada', ?, 'manual', ?, 'Alta desde Ventas')
    `).run(pid, almacenId, cantidad, req.usuario.id);
    return pid;
  });
  res.json({ ok: true, id: await tx() });
});

// Quita un producto de un almacén; si ya no queda en ningún lado, lo desactiva.
async function eliminarProductoDeAlmacen(productoId, almacenId) {
  await db.prepare('DELETE FROM jornada_ventas WHERE producto_id = ? AND almacen_id = ?').run(productoId, almacenId);
  await db.prepare('DELETE FROM existencias WHERE producto_id = ? AND almacen_id = ?').run(productoId, almacenId);
  const resto = await db.prepare('SELECT COALESCE(SUM(cantidad),0) AS c FROM existencias WHERE producto_id = ?').get(productoId);
  if (!resto.c || resto.c <= 0) {
    await db.prepare('UPDATE productos SET activo = 0 WHERE id = ?').run(productoId);
  }
}

// ---------- Quitar un producto de la hoja (la X roja) ----------
router.post('/quitar-producto', async (req, res) => {
  const almacenId = almacenDeTrabajo(req, req.body);
  const productoId = Number(req.body.producto_id);
  if (!almacenId || !productoId) return res.status(400).json({ error: 'Falta el producto.' });
  await eliminarProductoDeAlmacen(productoId, almacenId);
  res.json({ ok: true });
});

// ---------- Reiniciar jornada: resta lo vendido de la existencia, registra el
//            dinero, deja vendido en 0 y borra los productos que llegan a 0 ----------
router.post('/reiniciar', async (req, res) => {
  const almacenId = almacenDeTrabajo(req, req.body);
  if (!almacenId) return res.status(400).json({ error: 'No tiene un almacén asignado.' });

  const tx = db.transaction(async () => {
    const filas = await db.prepare(`
      SELECT j.producto_id, j.vendido, p.nombre, p.precio_venta,
             COALESCE(e.cantidad, 0) AS existencia, e.id AS ex_id
      FROM jornada_ventas j
      JOIN productos p ON p.id = j.producto_id
      LEFT JOIN existencias e ON e.producto_id = j.producto_id AND e.almacen_id = j.almacen_id
      WHERE j.almacen_id = ? AND j.vendido > 0
    `).all(almacenId);

    let totalDinero = 0;
    for (const f of filas) {
      const resta = Math.min(f.vendido, f.existencia); // no dejar negativo
      const monto = Number((f.vendido * (f.precio_venta || 0)).toFixed(2));
      totalDinero += monto;
      if (f.ex_id) await db.prepare('UPDATE existencias SET cantidad = cantidad - ? WHERE id = ?').run(resta, f.ex_id);
      await db.prepare(`
        INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
        VALUES (?, ?, 'salida', ?, 'venta', ?, 'Cierre de jornada')
      `).run(f.producto_id, almacenId, resta, req.usuario.id);
      if (monto > 0) {
        const v = await db.prepare(`
          INSERT INTO ventas (cliente, total, pagado, estado, usuario_id) VALUES ('Mostrador', ?, ?, 'pagada', ?)
        `).run(monto, monto, req.usuario.id);
        await db.prepare(`
          INSERT INTO ventas_detalle (venta_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)
        `).run(v.lastInsertRowid, f.producto_id, f.vendido, f.precio_venta || 0);
        await db.prepare(`
          INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
          VALUES ('ingreso', ?, ?, 'CUP', 'venta', ?, ?)
        `).run('Venta ' + f.nombre, monto, v.lastInsertRowid, req.usuario.id);
      }
    }

    // Dejar la jornada en cero.
    await db.prepare('UPDATE jornada_ventas SET vendido = 0 WHERE almacen_id = ?').run(almacenId);

    // Borrar del almacén los productos que quedaron en cero (o menos).
    const enCero = await db.prepare('SELECT producto_id FROM existencias WHERE almacen_id = ? AND cantidad <= 0').all(almacenId);
    for (const p of enCero) await eliminarProductoDeAlmacen(p.producto_id, almacenId);

    return Number(totalDinero.toFixed(2));
  });

  const total = await tx();
  res.json({ ok: true, total_dinero: total });
});

export default router;
