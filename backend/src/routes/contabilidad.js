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
import {
  REGIMENES,
  TIPOS_EMPRESA,
  CLAVE_TIPO_EMPRESA,
  AVISO_LEGAL,
  combinarConParametros,
  calcularTributosConRegimen,
} from '../config/tributacion.js';

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
           a.nombre AS almacen, resp.nombre AS responsable,
           COALESCE(e.cantidad,0)   AS cantidad,
           COALESCE(p.precio_costo,0) AS costo_unitario,
           COALESCE(p.precio_venta,0) AS precio_venta
    FROM existencias e
    JOIN productos p  ON p.id = e.producto_id
    JOIN almacenes a  ON a.id = e.almacen_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    LEFT JOIN usuarios resp ON resp.id = a.usuario_id
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

// ============================================================
//  TRIBUTACIÓN — estimado de impuestos a partir de lo ya registrado
//
//  IMPORTANTE: esto es un ESTIMADO de referencia (ver aviso legal en
//  backend/src/config/tributacion.js). No sustituye la declaración
//  oficial ante la ONAT.
// ============================================================

// Trae de `parametros` todo lo que empiece con "trib." (porcentajes
// corregidos a mano) más la clave del tipo de empresa elegido, y lo
// devuelve como un objeto simple { clave: valor }.
async function leerParametrosTributarios() {
  const filas = await db.prepare(
    'SELECT clave, valor FROM parametros WHERE clave LIKE ? OR clave = ?'
  ).all('trib.%', CLAVE_TIPO_EMPRESA);
  const mapa = {};
  for (const f of filas) mapa[f.clave] = f.valor;
  return mapa;
}

// Calcula desde/hasta (fechas 'YYYY-MM-DD', huso America/Havana) para
// mes/trimestre/año EN CURSO, del día 1 del período hasta hoy.
function limitesPeriodo(periodo, hoyStr) {
  const [y, m] = hoyStr.split('-').map(Number);
  if (periodo === 'trimestre') {
    const inicioTrim = Math.floor((m - 1) / 3) * 3 + 1;
    return { desde: `${y}-${String(inicioTrim).padStart(2, '0')}-01`, hasta: hoyStr };
  }
  if (periodo === 'ano') {
    return { desde: `${y}-01-01`, hasta: hoyStr };
  }
  // 'mes' (por defecto)
  return { desde: `${y}-${String(m).padStart(2, '0')}-01`, hasta: hoyStr };
}

// Régimenes vigentes (los de tributacion.js ya combinados con lo que
// el dueño haya corregido a mano en `parametros`), para pintarlos en
// la interfaz y para saber qué tipo de empresa tiene guardado.
router.get('/tributacion/regimenes', async (req, res) => {
  const mapa = await leerParametrosTributarios();
  const regimenes = combinarConParametros(mapa);
  res.json({
    regimenes,
    tipos_empresa: TIPOS_EMPRESA,
    tipo_empresa_actual: mapa[CLAVE_TIPO_EMPRESA] || 'microempresa',
    aviso_legal: AVISO_LEGAL,
  });
});

// Guarda el tipo de empresa elegido, para no tener que escogerlo cada
// vez que se entra a la pestaña. Solo un dato de preferencia, no toca
// nada del negocio.
router.put('/tributacion/tipo-empresa', async (req, res) => {
  const { tipo_empresa } = req.body || {};
  if (!TIPOS_EMPRESA.includes(tipo_empresa)) {
    return res.status(400).json({ error: 'Tipo de empresa no válido.' });
  }
  await db.prepare(`
    INSERT INTO parametros (clave, valor, actualizado_en)
    VALUES (?, ?, now())
    ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now()
    RETURNING clave
  `).run(CLAVE_TIPO_EMPRESA, tipo_empresa);
  res.json({ ok: true });
});

// El cálculo en sí: saca todas las bases de lo que YA está registrado
// en el sistema (nada se vuelve a teclear) y aplica los tributos del
// régimen elegido.
router.get('/tributacion', async (req, res) => {
  const mapaParametros = await leerParametrosTributarios();
  const tipoEmpresa = TIPOS_EMPRESA.includes(req.query.tipo_empresa)
    ? req.query.tipo_empresa
    : (mapaParametros[CLAVE_TIPO_EMPRESA] || 'microempresa');

  const periodo = ['mes', 'trimestre', 'ano', 'rango'].includes(req.query.periodo)
    ? req.query.periodo
    : 'mes';

  let desde, hasta;
  if (periodo === 'rango') {
    desde = req.query.desde || null;
    hasta = req.query.hasta || null;
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'Para un rango personalizado indique desde y hasta.' });
    }
  } else {
    const { hoy } = await db.prepare(
      `SELECT (now() AT TIME ZONE 'America/Havana')::date::text AS hoy`
    ).get();
    ({ desde, hasta } = limitesPeriodo(periodo, hoy));
  }

  // ---------- Ventas brutas + ganancia (ingreso - costo) del período ----------
  const ventas = await db.prepare(`
    SELECT COALESCE(SUM(ingreso),0) AS ingreso,
           COALESCE(SUM(costo),0)   AS costo,
           COALESCE(SUM(ganancia),0) AS ganancia
    FROM contabilidad_registros
    WHERE tipo = 'venta'
      AND (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);

  // ---------- Gastos deducibles del período, desglosados por categoría ----------
  const gastosPorCategoria = await db.prepare(`
    SELECT categoria, COALESCE(SUM(monto),0) AS total, array_agg(DISTINCT moneda) AS monedas
    FROM gastos
    WHERE (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
    GROUP BY categoria
    ORDER BY total DESC
  `).all(desde, hasta);

  const gastosTotal = Number(
    gastosPorCategoria.reduce((s, g) => s + Number(g.total), 0).toFixed(2)
  );
  const monedasMezcladas = gastosPorCategoria.some(
    (g) => Array.isArray(g.monedas) && g.monedas.length > 1
  ) || gastosPorCategoria.some((g) => g.monedas && g.monedas[0] && g.monedas[0] !== 'CUP');

  // ---------- Nómina (para la seguridad social): gastos cuya categoría ----------
  // suene a nómina/salario/sueldo, sin importar mayúsculas ni acentos.
  const nomina = await db.prepare(`
    SELECT COALESCE(SUM(monto),0) AS total
    FROM gastos
    WHERE (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
      AND translate(lower(categoria), 'áéíóúñ', 'aeioun') ~ '(nomina|salario|sueldo)'
  `).get(desde, hasta);

  // ---------- Compras (informativo: hoy no hay pantalla que las registre) ----------
  const compras = await db.prepare(`
    SELECT COALESCE(SUM(costo_total),0) AS total, COUNT(*) AS cantidad
    FROM compras
    WHERE (fecha_llegada AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);

  // ---------- Producción (informativo) ----------
  const produccion = await db.prepare(`
    SELECT COALESCE(SUM(costo_total),0) AS total, COUNT(*) AS cantidad
    FROM producciones
    WHERE (fecha AT TIME ZONE 'America/Havana')::date BETWEEN ? AND ?
  `).get(desde, hasta);

  const ventasBrutas = Number(Number(ventas.ingreso).toFixed(2));
  const gananciaVentas = Number(Number(ventas.ganancia).toFixed(2));
  const utilidadNeta = Number((gananciaVentas - gastosTotal).toFixed(2));
  const baseImponible = Number(Math.max(0, utilidadNeta).toFixed(2));
  const nominaTotal = Number(Number(nomina.total).toFixed(2));

  const bases = {
    utilidad_neta: baseImponible,
    ventas_brutas: ventasBrutas,
    nomina: nominaTotal,
  };

  const regimenCombinado = combinarConParametros(mapaParametros)[tipoEmpresa];
  const { tributos, total_tributos } = calcularTributosConRegimen(regimenCombinado, bases);

  // ---------- Advertencias: honestas sobre lo que falta por registrar ----------
  const advertencias = [AVISO_LEGAL];
  if (nominaTotal === 0) {
    advertencias.push(
      'No hay gastos registrados con categoría de nómina/salario/sueldo en este período: ' +
      'la Contribución a la Seguridad Social se está calculando en 0. Para que compute, ' +
      'registre la nómina como gasto (pestaña Gastos) con esa categoría.'
    );
  }
  if (compras.cantidad === 0) {
    advertencias.push(
      'La tabla de compras todavía no se alimenta desde ninguna pantalla del sistema, ' +
      'así que el costo de mercancía comprada en el período no está reflejado aparte ' +
      '(solo se ve indirectamente, vía el costo de lo ya vendido).'
    );
  }
  if (monedasMezcladas) {
    advertencias.push(
      'Hay gastos registrados en más de una moneda; se sumaron los montos sin convertir, ' +
      'lo que puede distorsionar el total de gastos deducibles.'
    );
  }
  if (utilidadNeta < 0) {
    advertencias.push(
      'El período cerró con pérdida (utilidad neta negativa): no se calculan tributos ' +
      'sobre utilidades cuando no hay ganancia.'
    );
  }

  res.json({
    ventas_brutas: ventasBrutas,
    gastos_deducibles: {
      total: gastosTotal,
      por_categoria: gastosPorCategoria.map((g) => ({
        categoria: g.categoria || '(sin categoría)',
        total: Number(Number(g.total).toFixed(2)),
      })),
    },
    utilidad_neta: utilidadNeta,
    base_imponible: baseImponible,
    tributos,
    total_tributos,
    informativo: {
      compras_registradas: Number(Number(compras.total).toFixed(2)),
      produccion_registrada: Number(Number(produccion.total).toFixed(2)),
      nomina_registrada: nominaTotal,
    },
    resumen: {
      periodo,
      desde,
      hasta,
      tipo_empresa: tipoEmpresa,
      regimen_nombre: regimenCombinado.nombre,
    },
    advertencias,
  });
});

export default router;
