// ============================================================
//  VENTAS MAYORISTAS — vender directo desde el almacén
//
//  Es otra cosa que el punto de venta. Aquí se le vende a un tercero que
//  compra en grande: se arma una lista con precio y cantidad —como un
//  IPV—, se ve el total de cada línea y el total general, y al confirmar
//  la mercancía SALE del almacén.
//
//  QUIÉN ENTRA
//  -----------
//  Solo el dueño y contabilidad. El almacenero no, aunque el botón viva
//  en su pantalla: esto es poner precios y cobrar, y a él los precios se
//  le ocultan a propósito (ver `sinDinero` en inventario.js). Dejarle
//  vender abriría por la puerta de atrás justo lo que se cerró.
//
//  EL HISTORIAL NO SE BORRA SOLO
//  -----------------------------
//  Cada venta queda con su fecha, su hora, quién la hizo y todas sus
//  líneas, hasta que el dueño decida limpiarla. Igual que el libro de
//  contabilidad: un registro que se borra solo no sirve para nada.
//
//  Borrar una venta del historial NO devuelve la mercancía ni deshace el
//  cobro. Son cosas distintas: el movimiento de almacén, el apunte del
//  libro y el dinero ya quedaron registrados por su cuenta, con su propio
//  rastro. Se avisa con todas las letras antes de borrar.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { anotar } from '../libro.js';
import { auditar } from '../auditoria.js';

const router = Router();

const ES_ADMIN_TOTAL = (rol) => rol === 'dueno' || rol === 'admin' || rol === 'proveedor';
const PUEDE_VENDER = (rol) => ES_ADMIN_TOTAL(rol) || rol === 'contabilidad';
const FORMAS_PAGO = ['efectivo', 'transferencia'];

function limpiar(v) {
  const s = (v ?? '').toString().trim();
  return s || null;
}

function normalizaMoneda(m) {
  const s = String(m || 'CUP').trim().toUpperCase().slice(0, 6);
  return /^[A-Z]{2,6}$/.test(s) ? s : 'CUP';
}

// Redondeo a 2 decimales. Comparar importes sin redondear deja saldos de
// 0.0000001 que descuadran todo sin que se vea por qué.
const dinero = (n) => Number((Number(n) || 0).toFixed(2));

router.use((req, res, next) => {
  if (!PUEDE_VENDER(req.usuario?.rol)) {
    return res.status(403).json({
      error: 'Las ventas mayoristas las maneja el dueño o contabilidad: llevan precios y cobro.',
    });
  }
  next();
});

// ------------------------------------------------------------
//  GET /productos — lo que hay para vender, con su costo
// ------------------------------------------------------------
// Devuelve la existencia POR ALMACÉN, no la suma: si se vende de un
// almacén hay que descontar de ese y no de otro.
router.get('/productos', async (req, res) => {
  const almacenId = Number(req.query.almacen_id) || null;

  const filas = await db.prepare(`
    SELECT p.id, p.nombre, p.tipo,
           COALESCE(u.abreviatura, '') AS unidad,
           e.almacen_id, a.nombre AS almacen,
           COALESCE(e.cantidad, 0)     AS existencia,
           COALESCE(p.precio_costo, 0) AS costo,
           COALESCE(p.precio_venta, 0) AS precio_sugerido
      FROM existencias e
      JOIN productos p ON p.id = e.producto_id
      JOIN almacenes a ON a.id = e.almacen_id
      LEFT JOIN unidades u ON u.id = p.unidad_id
     WHERE p.activo = 1
       AND e.cantidad > 0
       ${almacenId ? 'AND e.almacen_id = ?' : ''}
     ORDER BY a.nombre, p.nombre
  `).all(...(almacenId ? [almacenId] : []));

  res.json(filas.map((f) => ({
    ...f,
    existencia: Number(f.existencia),
    costo: Number(f.costo),
    precio_sugerido: Number(f.precio_sugerido),
  })));
});

// ------------------------------------------------------------
//  POST / — registrar la venta
// ------------------------------------------------------------
router.post('/', async (req, res) => {
  const b = req.body || {};
  const almacenId = Number(b.almacen_id);
  const lineasEntrada = Array.isArray(b.lineas) ? b.lineas : [];

  if (!almacenId) return res.status(400).json({ error: 'Indique de qué almacén sale la mercancía.' });
  if (!lineasEntrada.length) return res.status(400).json({ error: 'Añada al menos un producto a la venta.' });

  const almacen = await db.prepare('SELECT id, nombre FROM almacenes WHERE id = ?').get(almacenId);
  if (!almacen) return res.status(400).json({ error: 'Ese almacén no existe.' });

  const moneda = normalizaMoneda(b.moneda);
  const formaPago = FORMAS_PAGO.includes(b.forma_pago) ? b.forma_pago : 'efectivo';
  const cliente = limpiar(b.cliente);
  const nota = limpiar(b.nota);

  // ---- Validación ANTES de tocar nada ----
  // Se comprueban todas las líneas primero. Vender cinco productos y
  // fallar en el sexto dejaría el almacén a medio descontar; es mejor
  // rechazar la venta entera diciendo qué falta.
  const preparadas = [];
  const faltantes = [];

  for (const l of lineasEntrada) {
    const productoId = Number(l?.producto_id);
    const cantidad = Number(l?.cantidad);
    const precio = Number(l?.precio_unitario);

    if (!productoId || !Number.isFinite(cantidad) || cantidad <= 0) {
      return res.status(400).json({ error: 'Cada línea necesita un producto y una cantidad mayor que cero.' });
    }
    if (!Number.isFinite(precio) || precio < 0) {
      return res.status(400).json({ error: 'El precio de cada línea tiene que ser un número.' });
    }

    const info = await db.prepare(`
      SELECT p.id, p.nombre, COALESCE(p.precio_costo, 0) AS costo,
             COALESCE(u.abreviatura, '') AS unidad,
             COALESCE(e.cantidad, 0) AS existencia
        FROM productos p
        LEFT JOIN unidades u ON u.id = p.unidad_id
        LEFT JOIN existencias e ON e.producto_id = p.id AND e.almacen_id = ?
       WHERE p.id = ?
    `).get(almacenId, productoId);

    if (!info) return res.status(400).json({ error: `El producto #${productoId} no existe.` });

    if (Number(info.existencia) < cantidad) {
      faltantes.push({
        producto: info.nombre,
        pedido: cantidad,
        hay: Number(info.existencia),
        unidad: info.unidad,
      });
      continue;
    }

    preparadas.push({
      producto_id: info.id,
      producto_nombre: info.nombre,
      unidad: info.unidad,
      cantidad,
      precio_unitario: dinero(precio),
      costo_unitario: Number(info.costo),
      subtotal: dinero(cantidad * precio),
    });
  }

  if (faltantes.length) {
    return res.status(400).json({
      error: 'No hay existencia suficiente de: '
           + faltantes.map((f) => `${f.producto} (pide ${f.pedido}, hay ${f.hay} ${f.unidad})`).join('; '),
      faltantes,
    });
  }

  const total = dinero(preparadas.reduce((s, l) => s + l.subtotal, 0));
  const costoTotal = dinero(preparadas.reduce((s, l) => s + l.cantidad * l.costo_unitario, 0));
  const ganancia = dinero(total - costoTotal);
  const nombreUsuario = (await db.prepare('SELECT nombre FROM usuarios WHERE id = ?')
    .get(req.usuario.id))?.nombre || req.usuario.usuario;

  let ventaId = null;

  // Todo en una transacción: o sale la mercancía Y queda la venta, o no
  // pasa nada. A medias sería lo peor de los dos mundos.
  const tx = db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO ventas_mayoristas
        (almacen_id, almacen_nombre, cliente, total, costo_total, ganancia,
         moneda, forma_pago, nota, usuario_id, usuario_nombre)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(almacenId, almacen.nombre, cliente, total, costoTotal, ganancia,
           moneda, formaPago, nota, req.usuario.id, nombreUsuario);
    ventaId = r.lastInsertRowid;

    for (const l of preparadas) {
      await db.prepare(`
        INSERT INTO ventas_mayoristas_lineas
          (venta_id, producto_id, producto_nombre, unidad, cantidad, precio_unitario, costo_unitario, subtotal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ventaId, l.producto_id, l.producto_nombre, l.unidad,
             l.cantidad, l.precio_unitario, l.costo_unitario, l.subtotal);

      // Descontar del almacén y dejar el movimiento, igual que una salida
      // normal: el historial de almacén tiene que contarlo todo.
      await db.prepare(`
        UPDATE existencias SET cantidad = cantidad - ?
         WHERE producto_id = ? AND almacen_id = ?
      `).run(l.cantidad, l.producto_id, almacenId);

      await db.prepare(`
        INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, origen_id, usuario_id, nota)
        VALUES (?, ?, 'salida', ?, 'mayorista', ?, ?, ?)
      `).run(l.producto_id, almacenId, l.cantidad, ventaId, req.usuario.id,
             `Venta mayorista${cliente ? ' a ' + cliente : ''}`);
    }
  });

  try {
    await tx();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Fuera de la transacción, igual que en el resto del sistema: si el
  // apunte contable fallara, la venta ya se hizo y la mercancía ya salió.
  // Perder la línea del libro es malo; deshacer la venta sería peor.
  for (const l of preparadas) {
    await anotar({
      tipo: 'venta',
      concepto: `Venta mayorista — ${l.producto_nombre}`,
      producto: l.producto_nombre,
      cantidad: l.cantidad,
      unidad: l.unidad,
      costo: dinero(l.cantidad * l.costo_unitario),
      ingreso: l.subtotal,
      area: 'mayorista',
      usuario: req.usuario,
      nota: cliente ? `Cliente: ${cliente}` : null,
    });
  }

  // El dinero cobrado entra al balance, en la moneda y forma declaradas.
  try {
    await db.prepare(`
      INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
      VALUES ('ingreso', ?, ?, ?, 'mayorista', ?, ?)
    `).run(`Venta mayorista${cliente ? ' a ' + cliente : ''}`, total, moneda, ventaId, req.usuario.id);

    await db.prepare(`
      INSERT INTO dinero_movimientos (forma, moneda, monto, concepto, origen_tipo, origen_id, usuario_id, nota)
      VALUES (?, ?, ?, ?, 'mayorista', ?, ?, ?)
    `).run(formaPago, moneda, total,
           `Venta mayorista${cliente ? ' a ' + cliente : ''}`,
           ventaId, req.usuario.id, `${preparadas.length} producto(s). Ganancia: ${ganancia.toFixed(2)}.`);
  } catch (e) {
    console.error('No se pudo llevar la venta mayorista al dinero disponible:', e.message);
  }

  await auditar({
    modulo: 'ventas', accion: 'crear', req, entidad: 'ventas_mayoristas', entidad_id: ventaId,
    descripcion: `Venta mayorista${cliente ? ' a ' + cliente : ''} por ${total.toFixed(2)} ${moneda}`
               + ` (${preparadas.length} producto/s, ganancia ${ganancia.toFixed(2)})`,
  });

  res.json({
    ok: true, id: ventaId, total, costo_total: costoTotal, ganancia,
    moneda, forma_pago: formaPago, lineas: preparadas.length,
  });
});

// ------------------------------------------------------------
//  GET / — el historial
// ------------------------------------------------------------
router.get('/', async (req, res) => {
  const { desde, hasta, cliente } = req.query;
  const cond = [];
  const params = [];
  if (desde) { cond.push('v.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('v.fecha <= ?'); params.push(`${hasta} 23:59:59`); }
  if (cliente) { cond.push('LOWER(v.cliente) LIKE ?'); params.push(`%${String(cliente).toLowerCase()}%`); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const ventas = await db.prepare(`
    SELECT * FROM ventas_mayoristas v ${where}
     ORDER BY v.fecha DESC, v.id DESC LIMIT 300
  `).all(...params);

  if (!ventas.length) return res.json({ ventas: [], totales: { ventas: 0, total: 0, ganancia: 0 } });

  // Las líneas se traen de una vez y se reparten en memoria: una consulta
  // por venta serían 300 viajes a la base para pintar una tabla.
  const ids = ventas.map((v) => v.id);
  const lineas = await db.prepare(`
    SELECT * FROM ventas_mayoristas_lineas
     WHERE venta_id IN (${ids.map(() => '?').join(',')})
     ORDER BY id
  `).all(...ids);

  const porVenta = new Map();
  for (const l of lineas) {
    if (!porVenta.has(l.venta_id)) porVenta.set(l.venta_id, []);
    porVenta.get(l.venta_id).push(l);
  }

  res.json({
    ventas: ventas.map((v) => ({ ...v, lineas: porVenta.get(v.id) || [] })),
    totales: {
      ventas: ventas.length,
      total: dinero(ventas.reduce((s, v) => s + Number(v.total), 0)),
      ganancia: dinero(ventas.reduce((s, v) => s + Number(v.ganancia), 0)),
    },
  });
});

// ------------------------------------------------------------
//  DELETE /:id — limpiar una venta del historial
// ------------------------------------------------------------
// SOLO el dueño. Y NO devuelve la mercancía ni deshace el cobro: el
// movimiento de almacén, el apunte del libro y el dinero son registros
// aparte, con su propio rastro. Esto es limpieza de historial, no una
// anulación — el mismo criterio que tiene el libro de contabilidad.
router.delete('/:id', async (req, res) => {
  if (!ES_ADMIN_TOTAL(req.usuario.rol)) {
    return res.status(403).json({ error: 'Solo el dueño puede borrar del historial de ventas mayoristas.' });
  }

  const id = Number(req.params.id);
  const venta = await db.prepare('SELECT * FROM ventas_mayoristas WHERE id = ?').get(id);
  if (!venta) return res.status(404).json({ error: 'Esa venta ya no está en el historial.' });

  const lineas = await db.prepare('SELECT * FROM ventas_mayoristas_lineas WHERE venta_id = ?').all(id);

  // Las líneas caen solas por la llave foránea (ON DELETE CASCADE).
  await db.prepare('DELETE FROM ventas_mayoristas WHERE id = ?').run(id);

  // Se guarda la venta ENTERA en la auditoría antes de que desaparezca:
  // si no, borrar dejaría un hueco imposible de reconstruir.
  await auditar({
    modulo: 'ventas', accion: 'eliminar', req, entidad: 'ventas_mayoristas', entidad_id: id,
    descripcion: `Venta mayorista del ${new Date(venta.fecha).toLocaleString('es-CU')}`
               + ` por ${Number(venta.total).toFixed(2)} ${venta.moneda} borrada del historial`,
    antes: { ...venta, lineas },
    motivo: limpiar(req.body?.motivo),
  });

  res.json({
    ok: true,
    aviso: 'Se borró del historial. La mercancía NO volvió al almacén y el cobro sigue registrado: '
         + 'eso son movimientos aparte, con su propio rastro.',
  });
});

export default router;
