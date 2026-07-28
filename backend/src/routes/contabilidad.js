// ============================================================
//  CONTABILIDAD — la vista completa del negocio
//
//  El contador ve TODO desde una sola ventana:
//   · el almacén completo (existencias, costo y valor)
//   · el área de ventas de TODOS los vendedores (cantidad, costo,
//     ganancia y totales)
//   · todo movimiento económico que ocurra en cualquier área
//   · un libro histórico con fecha y hora, que se conserva por
//     tiempo indefinido hasta que él decida borrar cada línea
//
//  El contador solo MIRA (no edita nada del negocio); lo único que
//  puede hacer es borrar líneas del libro. El dueño puede todo.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion);

const PUEDE_VER = (rol) =>
  ['contabilidad', 'dueno', 'admin', 'proveedor'].includes(rol);

router.use((req, res, next) => {
  if (!PUEDE_VER(req.usuario.rol)) {
    return res.status(403).json({ error: 'Esta sección es de Contabilidad.' });
  }
  next();
});

// ============================================================
//  RESUMEN GENERAL — todo en una sola pantalla
// ============================================================
router.get('/resumen', async (req, res) => {
  // ---------- ALMACÉN ----------
  // Qué hay, cuánto costó y cuánto vale; con su ganancia estimada
  // si se vendiera al precio de venta fijado.
  const almacen = await db.prepare(`
    SELECT p.id, p.nombre, p.tipo, COALESCE(u.abreviatura,'') AS unidad,
           a.nombre AS almacen,
           COALESCE(e.cantidad,0)   AS cantidad,
           COALESCE(p.precio_costo,0) AS costo_unitario,
           COALESCE(p.precio_venta,0) AS precio_venta
    FROM existencias e
    JOIN productos p  ON p.id = e.producto_id
    JOIN almacenes a  ON a.id = e.almacen_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1
    ORDER BY a.nombre, p.nombre
  `).all();

  let almValorCosto = 0, almValorVenta = 0, almGananciaPot = 0;
  const almacenFilas = almacen.map((f) => {
    const valorCosto = Number((f.cantidad * f.costo_unitario).toFixed(2));
    const valorVenta = Number((f.cantidad * f.precio_venta).toFixed(2));
    almValorCosto += valorCosto;
    almValorVenta += valorVenta;
    // La ganancia potencial solo tiene sentido en lo que se VENDE. Una
    // materia prima (o algo sin precio de venta) no se vende tal cual, así
    // que no se le calcula ganancia: si no, saldría un número negativo
    // enorme que asusta y no significa nada.
    const seVende = f.precio_venta > 0;
    const gananciaPotencial = seVende ? Number((valorVenta - valorCosto).toFixed(2)) : null;
    if (gananciaPotencial !== null) almGananciaPot += gananciaPotencial;
    return { ...f, valor_costo: valorCosto, valor_venta: valorVenta, ganancia_potencial: gananciaPotencial };
  });

  // ---------- VENTAS (inventario propio de cada vendedor) ----------
  const ventas = await db.prepare(`
    SELECT v.id, v.nombre, v.unidad, v.cantidad, v.costo_unitario, v.precio_venta, v.vendido,
           u.nombre AS vendedor
    FROM venta_inventario v
    JOIN usuarios u ON u.id = v.usuario_id
    ORDER BY u.nombre, v.nombre
  `).all();

  let vtaIngreso = 0, vtaCosto = 0, vtaValorExistencia = 0;
  const ventasFilas = ventas.map((f) => {
    const total = Number((f.vendido * f.precio_venta).toFixed(2));
    const costoVendido = Number((f.vendido * f.costo_unitario).toFixed(2));
    const ganancia = Number((total - costoVendido).toFixed(2));
    const valorExistencia = Number((f.cantidad * f.costo_unitario).toFixed(2));
    vtaIngreso += total;
    vtaCosto += costoVendido;
    vtaValorExistencia += valorExistencia;
    return { ...f, total, costo_vendido: costoVendido, ganancia, valor_existencia: valorExistencia };
  });

  // ---------- LO YA CERRADO (del libro) ----------
  const hist = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0)  AS ingreso,
           COALESCE(SUM(costo),0)    AS costo,
           COALESCE(SUM(ganancia),0) AS ganancia,
           COUNT(*)                  AS apuntes
    FROM contabilidad_registros
  `).get();

  // Ventas del día de hoy (hora de Cuba) ya cerradas.
  const hoy = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0) AS ingreso, COALESCE(SUM(ganancia),0) AS ganancia
    FROM contabilidad_registros
    WHERE tipo = 'venta'
      AND (fecha AT TIME ZONE 'America/Havana')::date = (now() AT TIME ZONE 'America/Havana')::date
  `).get();

  // ---------- GASTOS ----------
  const gastos = await db.prepare(
    "SELECT COALESCE(SUM(monto),0) AS total FROM gastos"
  ).get();

  // ---------- CAJA ----------
  const caja = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE 0 END),0) AS ingresos,
           COALESCE(SUM(CASE WHEN tipo='egreso'  THEN monto ELSE 0 END),0) AS egresos
    FROM caja
  `).get();

  res.json({
    almacen: {
      filas: almacenFilas,
      total_productos: almacenFilas.length,
      valor_costo: Number(almValorCosto.toFixed(2)),
      valor_venta: Number(almValorVenta.toFixed(2)),
      ganancia_potencial: Number(almGananciaPot.toFixed(2)),
    },
    ventas: {
      filas: ventasFilas,
      total_productos: ventasFilas.length,
      ingreso_jornada: Number(vtaIngreso.toFixed(2)),
      costo_jornada: Number(vtaCosto.toFixed(2)),
      ganancia_jornada: Number((vtaIngreso - vtaCosto).toFixed(2)),
      valor_existencia: Number(vtaValorExistencia.toFixed(2)),
    },
    historico: {
      ingreso: Number(Number(hist.ingreso).toFixed(2)),
      costo: Number(Number(hist.costo).toFixed(2)),
      ganancia: Number(Number(hist.ganancia).toFixed(2)),
      apuntes: Number(hist.apuntes),
      ingreso_hoy: Number(Number(hoy.ingreso).toFixed(2)),
      ganancia_hoy: Number(Number(hoy.ganancia).toFixed(2)),
    },
    gastos_total: Number(Number(gastos.total).toFixed(2)),
    caja: {
      ingresos: Number(Number(caja.ingresos).toFixed(2)),
      egresos: Number(Number(caja.egresos).toFixed(2)),
      saldo: Number((caja.ingresos - caja.egresos).toFixed(2)),
    },
    // Resultado del negocio: lo ganado menos los gastos registrados.
    resultado: Number((Number(hist.ganancia) - Number(gastos.total)).toFixed(2)),
  });
});

// ============================================================
//  LIBRO — historial con fecha y hora, por tiempo indefinido
// ============================================================
router.get('/libro', async (req, res) => {
  const tipo = req.query.tipo && req.query.tipo !== 'todos' ? req.query.tipo : null;
  const desde = req.query.desde || null;
  const hasta = req.query.hasta || null;
  const limite = Math.min(Number(req.query.limite) || 300, 1000);

  const cond = [];
  const params = [];
  if (tipo)  { cond.push('tipo = ?');   params.push(tipo); }
  if (desde) { cond.push('fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('fecha <= ?'); params.push(hasta + ' 23:59:59'); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

  const filas = await db.prepare(`
    SELECT * FROM contabilidad_registros
    ${where}
    ORDER BY fecha DESC
    LIMIT ${limite}
  `).all(...params);

  const totales = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0) AS ingreso,
           COALESCE(SUM(costo),0)   AS costo,
           COALESCE(SUM(ganancia),0) AS ganancia
    FROM contabilidad_registros ${where}
  `).get(...params);

  res.json({
    filas,
    totales: {
      ingreso: Number(Number(totales.ingreso).toFixed(2)),
      costo: Number(Number(totales.costo).toFixed(2)),
      ganancia: Number(Number(totales.ganancia).toFixed(2)),
    },
  });
});

// Borrar una línea del libro (a voluntad del contador o del dueño).
router.delete('/libro/:id', async (req, res) => {
  await db.prepare('DELETE FROM contabilidad_registros WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Borrar varias líneas de una vez (por tipo o por rango de fechas).
router.post('/libro/borrar', async (req, res) => {
  const { ids, tipo, desde, hasta } = req.body || {};
  if (Array.isArray(ids) && ids.length) {
    for (const id of ids) {
      await db.prepare('DELETE FROM contabilidad_registros WHERE id = ?').run(Number(id));
    }
    return res.json({ ok: true, borrados: ids.length });
  }
  const cond = [];
  const params = [];
  if (tipo && tipo !== 'todos') { cond.push('tipo = ?'); params.push(tipo); }
  if (desde) { cond.push('fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('fecha <= ?'); params.push(hasta + ' 23:59:59'); }
  if (!cond.length) {
    return res.status(400).json({ error: 'Indique qué borrar (tipo o fechas).' });
  }
  const r = await db.prepare(
    `DELETE FROM contabilidad_registros WHERE ${cond.join(' AND ')}`
  ).run(...params);
  res.json({ ok: true, borrados: r.changes });
});

// ============================================================
//  MOVIMIENTOS DEL ALMACÉN (entradas y salidas, con su valor)
// ============================================================
router.get('/movimientos', async (req, res) => {
  const filas = await db.prepare(`
    SELECT m.id, m.fecha, m.tipo, m.cantidad, m.nota, m.origen_tipo,
           p.nombre AS producto, COALESCE(u.abreviatura,'') AS unidad,
           COALESCE(p.precio_costo,0) AS costo_unitario,
           a.nombre AS almacen, us.nombre AS usuario
    FROM movimientos m
    JOIN productos p ON p.id = m.producto_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    LEFT JOIN almacenes a ON a.id = m.almacen_id
    LEFT JOIN usuarios us ON us.id = m.usuario_id
    ORDER BY m.fecha DESC
    LIMIT 300
  `).all();
  res.json(filas.map((f) => ({
    ...f,
    valor: Number((f.cantidad * f.costo_unitario).toFixed(2)),
  })));
});

export default router;
