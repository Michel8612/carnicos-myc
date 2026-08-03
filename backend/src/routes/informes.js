// ============================================================
//  INFORMES CONTABLES (§10.2) — Estado de Resultados, Balance
//  General y Flujo de Caja.
//
//  Esta sección SOLO LEE lo que ya está registrado en el resto del
//  sistema (ventas, gastos, bancos, caja, cuentas por cobrar/pagar):
//  no crea ni modifica nada, no hay POST/PUT/DELETE. El montaje en
//  server.js ya trae requiereSesion (`app.use('/api/informes',
//  requiereSesion, informesRoutes)`), así que aquí solo hace falta
//  filtrar por ROL: estas son las cifras completas del negocio
//  (ingresos, gastos, saldos bancarios...), no algo que deba ver
//  cualquiera con sesión abierta.
//
//  Los tres informes terminan en la MISMA forma plana `filas:
//  [{concepto, monto}]`: es lo que se ve en pantalla, lo que se
//  exporta a Excel/CSV y lo que se imprime como PDF. Un solo formato
//  para las tres cosas evita que la pantalla muestre una cosa y el
//  archivo descargado diga otra.
//
//  Sobre monedas: igual que en la tributación (routes/contabilidad.js),
//  los montos se suman como cifras nominales sin convertir entre
//  monedas (se asume operación mayoritariamente en CUP). Si el día de
//  mañana hay mezcla real de monedas en bancos/caja, esto habría que
//  separarlo como ya se hace en costos.js.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';
import { servirDescarga } from '../servicios/exportar.js';

const router = Router();

// Solo quien de verdad necesita ver el negocio completo: el dueño y su
// soporte, más contabilidad. Ventas/almacén/cocina quedan fuera aunque
// tengan sesión válida — no es información de su área.
const PUEDE_VER = (rol) => ['dueno', 'admin', 'proveedor', 'contabilidad'].includes(rol);
router.use((req, res, next) => {
  if (!PUEDE_VER(req.usuario?.rol)) {
    return res.status(403).json({ error: 'Los informes contables son solo para el dueño, contabilidad o soporte.' });
  }
  next();
});

// Los tres informes exportan con las mismas dos columnas.
const COLUMNAS_INFORME = [
  { clave: 'concepto', titulo: 'Concepto', ancho: 42 },
  { clave: 'monto', titulo: 'Importe (CUP)', ancho: 18 },
];

// Redondeo a 2 decimales sin arrastrar el error de coma flotante de
// sumar muchos números pequeños (mismo criterio que el resto del
// sistema, ver contabilidad.js).
const r2 = (n) => Number(Number(n || 0).toFixed(2));

// Fecha de hoy y "mes en curso", calculadas EN LA BASE con hora de
// Cuba (no con `new Date()` de Node): así no importa en qué huso
// horario esté corriendo el servidor.
async function fechaHoyHavana() {
  const { hoy } = await db.prepare(
    `SELECT (now() AT TIME ZONE 'America/Havana')::date::text AS hoy`
  ).get();
  return hoy;
}
async function mesEnCursoHavana() {
  const { desde, hasta } = await db.prepare(`
    SELECT date_trunc('month', (now() AT TIME ZONE 'America/Havana'))::date::text AS desde,
           (now() AT TIME ZONE 'America/Havana')::date::text AS hasta
  `).get();
  return { desde, hasta };
}

// ============================================================
//  ESTADO DE RESULTADOS
// ============================================================
router.get('/estado-resultados', async (req, res) => {
  let { desde, hasta } = req.query;
  if (!desde || !hasta) {
    const mes = await mesEnCursoHavana();
    desde = desde || mes.desde;
    hasta = hasta || mes.hasta;
  }

  // Ingresos y costo de lo vendido: SOLO tipo='venta'.
  const ventas = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0) AS ingreso, COALESCE(SUM(costo),0) AS costo
    FROM contabilidad_registros
    WHERE tipo = 'venta'
      AND (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);

  // Otros ingresos: el resto de tipos (almacén, producción...). En la
  // práctica casi siempre da 0 —esos movimientos son de mercancía, no
  // de dinero— pero se calcula igual por si algún día se usa.
  const otros = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0) AS ingreso
    FROM contabilidad_registros
    WHERE tipo != 'venta'
      AND (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);

  // Gastos de operación por categoría. LEFT JOIN por si algún gasto
  // quedó con una clave de categoría borrada/renombrada: se muestra
  // igual (con su propia clave como etiqueta) en vez de desaparecer.
  const gastosPorCategoria = await db.prepare(`
    SELECT g.categoria AS clave, COALESCE(cg.etiqueta, g.categoria) AS etiqueta,
           COALESCE(SUM(g.monto),0) AS monto
    FROM gastos g
    LEFT JOIN categorias_gasto cg ON cg.clave = g.categoria
    WHERE (g.fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
    GROUP BY g.categoria, cg.etiqueta
    ORDER BY monto DESC
  `).all(desde, hasta);

  const ingresosVentas = r2(ventas.ingreso);
  const costoVentas = r2(ventas.costo);
  const otrosIngresos = r2(otros.ingreso);
  const ingresosTotal = r2(ingresosVentas + otrosIngresos);
  const utilidadBruta = r2(ingresosVentas - costoVentas);

  const lineasGasto = gastosPorCategoria.map((g) => ({
    categoria: g.clave, etiqueta: g.etiqueta, monto: r2(g.monto),
  }));
  const gastosTotal = r2(lineasGasto.reduce((s, l) => s + l.monto, 0));
  const utilidadNeta = r2(utilidadBruta + otrosIngresos - gastosTotal);

  const filas = [
    { concepto: 'Ingresos por ventas', monto: ingresosVentas },
    { concepto: 'Otros ingresos', monto: otrosIngresos },
    { concepto: 'Total de ingresos', monto: ingresosTotal },
    { concepto: 'Costo de la mercancía vendida', monto: costoVentas },
    { concepto: 'Utilidad bruta', monto: utilidadBruta },
    ...lineasGasto.map((l) => ({ concepto: `Gasto — ${l.etiqueta}`, monto: l.monto })),
    { concepto: 'Total de gastos de operación', monto: gastosTotal },
    { concepto: 'Utilidad neta del período', monto: utilidadNeta },
  ];

  if (req.query.formato) {
    await auditar({
      modulo: 'contabilidad', accion: 'exportar', req,
      descripcion: `Exportó el Estado de Resultados del ${desde} al ${hasta} (formato ${req.query.formato}).`,
    });
  }
  if (await servirDescarga(req, res, { base: 'estado-de-resultados', columnas: COLUMNAS_INFORME, filas })) return;

  res.json({
    periodo: { desde, hasta },
    ingresos: { ventas: ingresosVentas, otros: otrosIngresos, total: ingresosTotal },
    costo_ventas: costoVentas,
    utilidad_bruta: utilidadBruta,
    gastos: { lineas: lineasGasto, total: gastosTotal },
    utilidad_neta: utilidadNeta,
    filas,
  });
});

// ============================================================
//  BALANCE GENERAL (una foto a una fecha de corte)
// ============================================================
router.get('/balance', async (req, res) => {
  const fecha = req.query.fecha || await fechaHoyHavana();

  // ACTIVO — inventario valorado al costo. Solo productos activos: uno
  // dado de baja ya no forma parte del negocio en marcha.
  // OJO: `existencias` no guarda historial (es la foto de AHORA), así
  // que este número es SIEMPRE el inventario actual, no el que había
  // exactamente en la fecha de corte si esta es distinta de hoy. Es
  // una limitación conocida del modelo de datos, no un olvido.
  const inv = await db.prepare(`
    SELECT COALESCE(SUM(e.cantidad * p.precio_costo),0) AS total
    FROM existencias e
    JOIN productos p ON p.id = e.producto_id
    WHERE p.activo = 1
  `).get();
  const inventario = r2(inv.total);

  // Saldo de cada cuenta bancaria: entradas menos salidas hasta la
  // fecha de corte (nunca las anuladas). No se filtra por estado de la
  // cuenta (activa/inactiva): una cuenta inactiva pudo quedar con
  // saldo, y ese dinero sigue siendo del negocio.
  const bancos = await db.prepare(`
    SELECT cb.id, cb.banco, cb.alias, cb.moneda,
           COALESCE(SUM(CASE WHEN mb.tipo='ingreso' THEN mb.monto ELSE 0 END),0)
         - COALESCE(SUM(CASE WHEN mb.tipo='egreso'  THEN mb.monto ELSE 0 END),0) AS saldo
    FROM cuentas_bancarias cb
    LEFT JOIN movimientos_bancarios mb
      ON mb.cuenta_id = cb.id AND mb.estado != 'anulado'
     AND (mb.fecha AT TIME ZONE 'America/Havana')::date <= ?
    GROUP BY cb.id, cb.banco, cb.alias, cb.moneda
    ORDER BY cb.banco, cb.alias
  `).all(fecha);
  const bancosFilas = bancos.map((b) => ({ ...b, saldo: r2(b.saldo) }));
  const bancosTotal = r2(bancosFilas.reduce((s, b) => s + b.saldo, 0));

  // Caja: mismo criterio, hasta la fecha de corte.
  const cajaFila = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE 0 END),0)
         - COALESCE(SUM(CASE WHEN tipo='egreso'  THEN monto ELSE 0 END),0) AS saldo
    FROM caja
    WHERE (fecha AT TIME ZONE 'America/Havana')::date <= ?
  `).get(fecha);
  const caja = r2(cajaFila.saldo);

  // Cuentas por cobrar: `saldo` ya es el pendiente actual (no hay
  // historial por fecha en cuentas_terceros), así que no se filtra por
  // fecha de corte — se toma el saldo vigente, no anulado.
  const porCobrar = await db.prepare(`
    SELECT COALESCE(SUM(saldo),0) AS total FROM cuentas_terceros
    WHERE tipo = 'cobrar' AND estado != 'anulada'
  `).get();
  const cuentasPorCobrar = r2(porCobrar.total);

  const activoTotal = r2(inventario + bancosTotal + caja + cuentasPorCobrar);

  // PASIVO — mismo criterio que cuentas por cobrar.
  const porPagar = await db.prepare(`
    SELECT COALESCE(SUM(saldo),0) AS total FROM cuentas_terceros
    WHERE tipo = 'pagar' AND estado != 'anulada'
  `).get();
  const cuentasPorPagar = r2(porPagar.total);
  const pasivoTotal = cuentasPorPagar;

  // PATRIMONIO: aquí no existe un libro de "capital social" ni ningún
  // aporte registrado — es sencillamente lo que queda por diferencia
  // (Activo − Pasivo). Sirve como referencia de cuánto "vale" el
  // negocio en libros a esta fecha, NO como un fondo real disponible
  // ni un capital que alguien aportó. Se explica también en pantalla
  // (ver `nota` abajo) para que nadie lo confunda con lo segundo.
  const patrimonio = r2(activoTotal - pasivoTotal);
  const notaPatrimonio =
    'El patrimonio no es un capital aportado ni registrado en ninguna parte: es un cálculo por diferencia ' +
    '(Activo − Pasivo). Sirve como referencia de cuánto "vale" el negocio en libros a esta fecha, no como ' +
    'dinero disponible.';

  // Filas planas para pantalla/exportación. Las de "ACTIVO"/"PASIVO"
  // llevan monto=null a propósito: son encabezados de sección, no
  // importes (el frontend las pinta como fila divisoria).
  const filas = [
    { concepto: 'ACTIVO', monto: null },
    { concepto: 'Inventario (valorado al costo)', monto: inventario },
    ...bancosFilas.map((b) => ({ concepto: `Banco — ${b.alias || b.banco}`, monto: b.saldo })),
    { concepto: 'Caja', monto: caja },
    { concepto: 'Cuentas por cobrar', monto: cuentasPorCobrar },
    { concepto: 'Total activo', monto: activoTotal },
    { concepto: 'PASIVO', monto: null },
    { concepto: 'Cuentas por pagar', monto: cuentasPorPagar },
    { concepto: 'Total pasivo', monto: pasivoTotal },
    { concepto: 'Patrimonio (Activo − Pasivo)', monto: patrimonio },
  ];

  if (req.query.formato) {
    await auditar({
      modulo: 'contabilidad', accion: 'exportar', req,
      descripcion: `Exportó el Balance General a la fecha ${fecha} (formato ${req.query.formato}).`,
    });
  }
  if (await servirDescarga(req, res, { base: 'balance-general', columnas: COLUMNAS_INFORME, filas })) return;

  res.json({
    fecha,
    activo: {
      inventario,
      bancos: bancosFilas,
      bancos_total: bancosTotal,
      caja,
      cuentas_por_cobrar: cuentasPorCobrar,
      total: activoTotal,
    },
    pasivo: { cuentas_por_pagar: cuentasPorPagar, total: pasivoTotal },
    patrimonio: { monto: patrimonio, nota: notaPatrimonio },
    filas,
  });
});

// ============================================================
//  FLUJO DE CAJA — solo movimientos REALES de dinero
// ============================================================
router.get('/flujo-caja', async (req, res) => {
  let { desde, hasta } = req.query;
  if (!desde || !hasta) {
    const mes = await mesEnCursoHavana();
    desde = desde || mes.desde;
    hasta = hasta || mes.hasta;
  }

  const banco = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE 0 END),0) AS entradas,
           COALESCE(SUM(CASE WHEN tipo='egreso'  THEN monto ELSE 0 END),0) AS salidas
    FROM movimientos_bancarios
    WHERE estado != 'anulado'
      AND (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);

  const cajaTot = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipo='ingreso' THEN monto ELSE 0 END),0) AS entradas,
           COALESCE(SUM(CASE WHEN tipo='egreso'  THEN monto ELSE 0 END),0) AS salidas
    FROM caja
    WHERE (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);

  const entradasBanco = r2(banco.entradas);
  const salidasBanco = r2(banco.salidas);
  const entradasCaja = r2(cajaTot.entradas);
  const salidasCaja = r2(cajaTot.salidas);
  const entradasTotal = r2(entradasBanco + entradasCaja);
  const salidasTotal = r2(salidasBanco + salidasCaja);
  const neto = r2(entradasTotal - salidasTotal);

  // Detalle línea a línea: banco y caja mezclados y ordenados por
  // fecha, que es como de verdad ocurrió el dinero.
  const detalleBanco = await db.prepare(`
    SELECT mb.fecha, 'Banco' AS origen, mb.tipo, COALESCE(mb.concepto, cb.banco) AS concepto, mb.monto
    FROM movimientos_bancarios mb
    JOIN cuentas_bancarias cb ON cb.id = mb.cuenta_id
    WHERE mb.estado != 'anulado'
      AND (mb.fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).all(desde, hasta);
  const detalleCaja = await db.prepare(`
    SELECT fecha, 'Caja' AS origen, tipo, concepto, monto
    FROM caja
    WHERE (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).all(desde, hasta);
  const detalle = [...detalleBanco, ...detalleCaja]
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
    .map((d) => ({ fecha: d.fecha, origen: d.origen, tipo: d.tipo, concepto: d.concepto, monto: r2(d.monto) }));

  // ---- Referencia informativa: cobros/pagos de cuentas por cobrar/pagar ----
  // NO entra en el neto a propósito: si ese cobro ya se registró como
  // movimiento bancario (o en caja), sumarlo aquí también lo contaría
  // DOS VECES. `cuentas_pagos` no distingue por qué vía entró/salió el
  // dinero, así que solo se puede mostrar aparte, como referencia de
  // cuánto se movió por esa vía — nunca sumado al flujo real.
  const cobrosRegistrados = await db.prepare(`
    SELECT COALESCE(SUM(cp.monto),0) AS total
    FROM cuentas_pagos cp
    JOIN cuentas_terceros ct ON ct.id = cp.cuenta_id
    WHERE ct.tipo = 'cobrar' AND cp.fecha BETWEEN ? AND ?
  `).get(desde, hasta);
  const pagosRegistrados = await db.prepare(`
    SELECT COALESCE(SUM(cp.monto),0) AS total
    FROM cuentas_pagos cp
    JOIN cuentas_terceros ct ON ct.id = cp.cuenta_id
    WHERE ct.tipo = 'pagar' AND cp.fecha BETWEEN ? AND ?
  `).get(desde, hasta);
  const refCobros = r2(cobrosRegistrados.total);
  const refPagos = r2(pagosRegistrados.total);

  const filas = [
    { concepto: 'Entradas — banco', monto: entradasBanco },
    { concepto: 'Entradas — caja', monto: entradasCaja },
    { concepto: 'Total entradas', monto: entradasTotal },
    { concepto: 'Salidas — banco', monto: salidasBanco },
    { concepto: 'Salidas — caja', monto: salidasCaja },
    { concepto: 'Total salidas', monto: salidasTotal },
    { concepto: 'Flujo neto del período', monto: neto },
    { concepto: '(Informativo, no incluido en el neto) Cobros registrados en cuentas por cobrar', monto: refCobros },
    { concepto: '(Informativo, no incluido en el neto) Pagos registrados en cuentas por pagar', monto: refPagos },
  ];

  if (req.query.formato) {
    await auditar({
      modulo: 'contabilidad', accion: 'exportar', req,
      descripcion: `Exportó el Flujo de Caja del ${desde} al ${hasta} (formato ${req.query.formato}).`,
    });
  }
  if (await servirDescarga(req, res, { base: 'flujo-de-caja', columnas: COLUMNAS_INFORME, filas })) return;

  res.json({
    periodo: { desde, hasta },
    entradas: { banco: entradasBanco, caja: entradasCaja, total: entradasTotal },
    salidas: { banco: salidasBanco, caja: salidasCaja, total: salidasTotal },
    neto,
    detalle,
    referencia: { cobros_registrados: refCobros, pagos_registrados: refPagos },
    filas,
  });
});

export default router;
