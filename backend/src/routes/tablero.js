// ============================================================
//  TABLERO DE INDICADORES
//
//  Una sola pantalla con los números que le importan al dueño (y a
//  quien lleva las cuentas): ventas, gastos, inventario, bancos, caja
//  y cobros/pagos pendientes, todo junto. Solo LEE — no hay rutas de
//  escritura aquí.
//
//  Todo vive en UN solo endpoint (GET /indicadores) a propósito: la
//  conexión del cliente es mala (Cuba) y ocho llamadas para pintar un
//  tablero se notan mucho más que una sola con todo dentro.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

// Son las cifras completas del negocio (ventas, gastos, bancos,
// deudas...). No es información de UN área como el almacén o las
// ventas: por eso se restringe a quien de verdad maneja el dinero,
// igual que hace contabilidad.js con su PUEDE_VER.
const PUEDE_VER = (rol) => ['dueno', 'admin', 'proveedor', 'contabilidad'].includes(rol);
router.use((req, res, next) => {
  if (!PUEDE_VER(req.usuario.rol)) {
    return res.status(403).json({ error: 'El tablero de indicadores es solo para quien maneja las cifras del negocio.' });
  }
  next();
});

// Redondeo a 2 decimales sin arrastrar errores de coma flotante
// (0.1 + 0.2 en JS da 0.30000000000000004).
const r2 = (n) => Number((Number(n) || 0).toFixed(2));

router.get('/indicadores', async (req, res) => {
  // Hoy en hora de Cuba, no en la hora del servidor (que puede estar
  // en UTC): un cierre de jornada a las 8pm de Cuba no puede aparecer
  // "de mañana" solo porque el servidor vive en otro huso horario.
  const { hoy } = await db.prepare(
    `SELECT (now() AT TIME ZONE 'America/Havana')::date::text AS hoy`
  ).get();

  // Sin fechas = el mes en curso, del día 1 a hoy (hora de Cuba).
  let { desde, hasta } = req.query;
  if (!desde || !hasta) {
    const [y, m] = hoy.split('-');
    desde = `${y}-${m}-01`;
    hasta = hoy;
  }

  // ---------- VENTAS del periodo (desde el libro) ----------
  const ventas = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0) AS ingreso,
           COALESCE(SUM(costo),0)   AS costo,
           COALESCE(SUM(ganancia),0) AS ganancia,
           COUNT(*) AS apuntes
    FROM contabilidad_registros
    WHERE tipo = 'venta'
      AND (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);

  // ---------- HOY vs AYER (hora de Cuba) — para la flecha de tendencia ----------
  const hoyFila = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0) AS ingreso, COALESCE(SUM(ganancia),0) AS ganancia
    FROM contabilidad_registros
    WHERE tipo = 'venta'
      AND (fecha AT TIME ZONE 'America/Havana')::date = (now() AT TIME ZONE 'America/Havana')::date
  `).get();
  const ayerFila = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0) AS ingreso, COALESCE(SUM(ganancia),0) AS ganancia
    FROM contabilidad_registros
    WHERE tipo = 'venta'
      AND (fecha AT TIME ZONE 'America/Havana')::date = (now() AT TIME ZONE 'America/Havana')::date - 1
  `).get();

  // ---------- GASTOS del periodo ----------
  const gastosTotal = await db.prepare(`
    SELECT COALESCE(SUM(monto),0) AS total FROM gastos
    WHERE (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);
  // Top 5 categorías por importe. LEFT JOIN porque una categoría pudo
  // borrarse de categorias_gasto y el gasto histórico se conserva igual
  // (por eso el respaldo con COALESCE a la clave técnica).
  const gastosTop = await db.prepare(`
    SELECT g.categoria, COALESCE(cg.etiqueta, g.categoria) AS etiqueta,
           COALESCE(SUM(g.monto),0) AS monto
    FROM gastos g
    LEFT JOIN categorias_gasto cg ON cg.clave = g.categoria
    WHERE (g.fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
    GROUP BY g.categoria, cg.etiqueta
    ORDER BY monto DESC
    LIMIT 5
  `).all(desde, hasta);

  // ---------- INVENTARIO (foto de HOY, no del periodo: existe una sola cantidad actual) ----------
  const inventario = await db.prepare(`
    SELECT COALESCE(SUM(e.cantidad * p.precio_costo),0) AS valor_costo,
           COALESCE(SUM(e.cantidad * p.precio_venta),0) AS valor_venta,
           COUNT(DISTINCT e.producto_id) AS productos
    FROM existencias e
    JOIN productos p ON p.id = e.producto_id
    WHERE p.activo = 1
  `).get();

  // Productos por debajo del mínimo. Si stock_minimo = 0, nadie lo ha
  // configurado todavía para ese producto: avisar ahí sería puro ruido
  // (todo el mundo aparecería "bajo mínimo" de 0), así que se excluyen.
  const stockBajo = await db.prepare(`
    SELECT p.nombre AS producto, a.nombre AS almacen, COALESCE(u.abreviatura,'') AS unidad,
           e.cantidad, p.stock_minimo
    FROM existencias e
    JOIN productos p ON p.id = e.producto_id
    JOIN almacenes a ON a.id = e.almacen_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1 AND p.stock_minimo > 0 AND e.cantidad < p.stock_minimo
    ORDER BY (p.stock_minimo - e.cantidad) DESC
    LIMIT 15
  `).all();

  // ---------- BANCOS — saldo actual (acumulado, no del periodo: un banco no "reinicia" cada mes) ----------
  const cuentasBancarias = await db.prepare(`
    SELECT cb.id, cb.banco, cb.alias, cb.moneda,
           COALESCE(SUM(CASE
             WHEN mb.tipo = 'ingreso' THEN mb.monto
             WHEN mb.tipo = 'egreso'  THEN -mb.monto
             ELSE 0 END), 0) AS saldo
    FROM cuentas_bancarias cb
    LEFT JOIN movimientos_bancarios mb
      ON mb.cuenta_id = cb.id AND mb.estado <> 'anulado'
    GROUP BY cb.id, cb.banco, cb.alias, cb.moneda
    ORDER BY cb.banco, cb.alias
  `).all();

  // ---------- CAJA — igual que bancos: saldo acumulado, no del periodo ----------
  const caja = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE 0 END),0) AS ingresos,
           COALESCE(SUM(CASE WHEN tipo='egreso'  THEN monto ELSE 0 END),0) AS egresos
    FROM caja
  `).get();

  // ---------- CUENTAS POR COBRAR / PAGAR — deuda vigente, tampoco es "del periodo" ----------
  // (una factura vencida en marzo sigue vencida en abril si nadie la cobró).
  const cuentasFilas = await db.prepare(`
    SELECT tipo,
           COALESCE(SUM(saldo), 0) AS pendiente,
           COALESCE(SUM(CASE
             WHEN fecha_vencimiento IS NOT NULL
              AND fecha_vencimiento < (now() AT TIME ZONE 'America/Havana')::date
              AND saldo > 0
             THEN saldo ELSE 0 END), 0) AS vencido,
           COUNT(*) FILTER (WHERE saldo > 0) AS documentos
    FROM cuentas_terceros
    WHERE estado <> 'anulada'
    GROUP BY tipo
  `).all();
  const filaCobrar = cuentasFilas.find((f) => f.tipo === 'cobrar');
  const filaPagar = cuentasFilas.find((f) => f.tipo === 'pagar');
  const vacioCuentas = { pendiente: 0, vencido: 0, documentos: 0 };

  // ---------- SERIE de los últimos 30 días, RELLENANDO los huecos ----------
  // El GROUP BY solo trae los días que tuvieron venta; si un día no vendió
  // nada, sencillamente no aparece una fila. Si se pintara tal cual, el
  // gráfico juntaría el jueves con el sábado como si fueran consecutivos y
  // mentiría sobre la tendencia real. Por eso se completa aquí en JS con
  // los 30 días exactos, poniendo 0 donde no hubo fila.
  const serieFilas = await db.prepare(`
    SELECT (fecha AT TIME ZONE 'America/Havana')::date::text AS fecha,
           COALESCE(SUM(ingreso),0) AS ingreso,
           COALESCE(SUM(ganancia),0) AS ganancia
    FROM contabilidad_registros
    WHERE tipo = 'venta'
      AND (fecha AT TIME ZONE 'America/Havana')::date >= (now() AT TIME ZONE 'America/Havana')::date - 29
    GROUP BY 1
  `).all();
  const porFecha = new Map(serieFilas.map((f) => [f.fecha, f]));
  const serie = [];
  const cursor = new Date(`${hoy}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 29);
  for (let i = 0; i < 30; i++) {
    const f = cursor.toISOString().slice(0, 10);
    const fila = porFecha.get(f);
    serie.push({
      fecha: f,
      ingreso: r2(fila ? fila.ingreso : 0),
      ganancia: r2(fila ? fila.ganancia : 0),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // ---------- AVISOS SIN LEER ----------
  // Mismo criterio de "leída" que notificaciones.js: `leida_por` es una
  // lista de ids separados por coma y se compara EXACTA (no con
  // "incluye"), para que el id 2 no haga match con el 12. Para destino,
  // aquí basta con destino_rol NULO o el rol del propio usuario: quien
  // entra al tablero es dueño/admin/proveedor/contabilidad, y ninguno de
  // esos roles pertenece a un grupo (GRUPOS_ROL en notificaciones.js solo
  // agrupa 'almacen'), así que no hace falta repetir esa expansión aquí.
  const notifs = await db.prepare(`
    SELECT leida_por FROM notificaciones
    WHERE destino_rol IS NULL OR destino_rol = ?
  `).all(req.usuario.rol);
  const avisosSinLeer = notifs.filter((f) => {
    const leidos = (f.leida_por || '').split(',').map((s) => s.trim()).filter(Boolean);
    return !leidos.includes(String(req.usuario.id));
  }).length;

  res.json({
    periodo: { desde, hasta },
    ventas: {
      ingreso: r2(ventas.ingreso),
      costo: r2(ventas.costo),
      ganancia: r2(ventas.ganancia),
      apuntes: Number(ventas.apuntes),
    },
    hoy: { ingreso: r2(hoyFila.ingreso), ganancia: r2(hoyFila.ganancia) },
    ayer: { ingreso: r2(ayerFila.ingreso), ganancia: r2(ayerFila.ganancia) },
    gastos: {
      total: r2(gastosTotal.total),
      top: gastosTop.map((g) => ({ categoria: g.categoria, etiqueta: g.etiqueta, monto: r2(g.monto) })),
    },
    resultado: r2(Number(ventas.ganancia) - Number(gastosTotal.total)),
    inventario: {
      valor_costo: r2(inventario.valor_costo),
      valor_venta: r2(inventario.valor_venta),
      productos: Number(inventario.productos),
    },
    stock_bajo: stockBajo.map((f) => ({
      producto: f.producto, almacen: f.almacen, unidad: f.unidad,
      cantidad: Number(f.cantidad), stock_minimo: Number(f.stock_minimo),
    })),
    bancos: {
      saldo: r2(cuentasBancarias.reduce((s, c) => s + Number(c.saldo), 0)),
      cuentas: cuentasBancarias.map((c) => ({
        banco: c.banco, alias: c.alias, moneda: c.moneda, saldo: r2(c.saldo),
      })),
    },
    caja: {
      ingresos: r2(caja.ingresos),
      egresos: r2(caja.egresos),
      saldo: r2(Number(caja.ingresos) - Number(caja.egresos)),
    },
    cuentas: {
      por_cobrar: filaCobrar
        ? { pendiente: r2(filaCobrar.pendiente), vencido: r2(filaCobrar.vencido), documentos: Number(filaCobrar.documentos) }
        : vacioCuentas,
      por_pagar: filaPagar
        ? { pendiente: r2(filaPagar.pendiente), vencido: r2(filaPagar.vencido), documentos: Number(filaPagar.documentos) }
        : vacioCuentas,
    },
    serie,
    avisos_sin_leer: avisosSinLeer,
  });
});

export default router;
