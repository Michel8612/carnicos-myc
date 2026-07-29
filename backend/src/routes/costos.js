// ============================================================
//  Costos, gastos y ganancia neta (Fase 2)
//
//  El control de en qué se va cada centavo:
//   - gastos por categoría (directo, indirecto, fijo, combustible)
//   - gastos fijos mensuales que se repiten solos
//   - seguimiento de combustible
//   - GANANCIA NETA = ventas − todos los costos del periodo
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion);

// Las 4 primeras son las de siempre (no se tocan, hay datos viejos con
// esas categorías). Las de abajo se añaden para que el gasto real del
// negocio quepa en el sistema: sin ellas no había dónde meter ni la
// electricidad ni el alquiler, y el motor tributario nunca encontraba
// nómina (así que la Contribución a la Seguridad Social siempre daba 0).
// 'nomina' en particular es la que lee backend/src/routes/contabilidad.js
// (ruta /tributacion) para calcular esa contribución: por eso su clave
// debe seguir siendo exactamente esta cadena.
const CATEGORIAS = [
  'directo', 'indirecto', 'fijo', 'combustible',
  'nomina', 'electricidad', 'alquiler', 'materia_prima',
  'transporte', 'servicios', 'mantenimiento', 'impuestos', 'otros',
];

// Etiquetas legibles para pintar el <select> de la pantalla de Gastos
// sin tener que duplicar esta lista en el HTML.
const ETIQUETAS_CATEGORIA = {
  directo: 'Costo directo',
  indirecto: 'Costo indirecto',
  fijo: 'Gasto fijo',
  combustible: 'Combustible',
  nomina: 'Nómina (salarios)',
  electricidad: 'Electricidad',
  alquiler: 'Alquiler',
  materia_prima: 'Materia prima',
  transporte: 'Transporte',
  servicios: 'Servicios',
  mantenimiento: 'Mantenimiento',
  impuestos: 'Impuestos',
  otros: 'Otros',
};

// Categorías disponibles para el <select> del formulario de gastos.
// Un solo lugar de verdad: si se añade una categoría arriba, aparece
// aquí solo, sin tocar el HTML.
router.get('/categorias', async (req, res) => {
  res.json(CATEGORIAS.map((clave) => ({ clave, etiqueta: ETIQUETAS_CATEGORIA[clave] || clave })));
});

// ------------------------------------------------------------
//  Registrar un gasto suelto
// ------------------------------------------------------------
router.post('/gastos', async (req, res) => {
  const { categoria, concepto, monto, moneda, nota } = req.body;
  if (!categoria || !concepto || !monto) {
    return res.status(400).json({ error: 'Indique categoría, concepto y monto.' });
  }
  if (!CATEGORIAS.includes(categoria)) {
    return res.status(400).json({ error: 'Categoría no válida.' });
  }
  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';

  const tx = db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO gastos (categoria, concepto, monto, moneda, origen_tipo, usuario_id, nota)
      VALUES (?, ?, ?, ?, 'manual', ?, ?)
    `).run(categoria, concepto, Number(monto), mon, req.usuario.id, nota || null);
    // Reflejar también en caja como egreso (es dinero que sale).
    await db.prepare(`
      INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
      VALUES ('egreso', ?, ?, ?, 'gasto', ?, ?)
    `).run(concepto, Number(monto), mon, r.lastInsertRowid, req.usuario.id);
    return r.lastInsertRowid;
  });

  res.json({ ok: true, id: await tx() });
});

// Lista de gastos del mes, por categoría.
// Además devuelve los TOTALES SEPARADOS POR MONEDA — nunca se
// suma CUP con USD/MLC, porque serían cifras falsas.
router.get('/gastos', async (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0, 7); // AAAA-MM
  const filas = await db.prepare(`
    SELECT * FROM gastos
    WHERE to_char(fecha, 'YYYY-MM') = ?
    ORDER BY fecha DESC
  `).all(mes);

  // Totales por moneda (cada una por su lado).
  const porMoneda = await db.prepare(`
    SELECT moneda, COALESCE(SUM(monto), 0) AS total, COUNT(*) AS cantidad
    FROM gastos
    WHERE to_char(fecha, 'YYYY-MM') = ?
    GROUP BY moneda
  `).all(mes);

  res.json({ filas, por_moneda: porMoneda });
});

// ------------------------------------------------------------
//  Nómina
//
//  IMPORTANTE (no cambiarlo sin pensar dos veces): "gastos" es la ÚNICA
//  fuente de lo deducible. La tabla "nomina" solo guarda el detalle por
//  empleado (quién cobró qué). Por eso cada pago de nómina crea, en UNA
//  transacción, su gasto (categoria 'nomina'), su egreso en caja y su
//  fila de detalle en "nomina" enlazada al gasto por gasto_id. Así el
//  mismo salario nunca se cuenta dos veces.
// ------------------------------------------------------------

const FORMATO_PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

async function periodoActualHavana() {
  const { periodo } = await db.prepare(
    `SELECT to_char(now() AT TIME ZONE 'America/Havana', 'YYYY-MM') AS periodo`
  ).get();
  return periodo;
}

router.post('/nomina', async (req, res) => {
  const { empleado, cargo, salario, periodo, moneda, nota } = req.body;

  if (!empleado || !String(empleado).trim()) {
    return res.status(400).json({ error: 'Indique el nombre del empleado.' });
  }
  const salarioNum = Number(salario);
  if (!Number.isFinite(salarioNum) || salarioNum <= 0) {
    return res.status(400).json({ error: 'El salario debe ser un número mayor que cero.' });
  }
  let periodoFinal = periodo;
  if (!periodoFinal) {
    periodoFinal = await periodoActualHavana();
  } else if (!FORMATO_PERIODO.test(periodoFinal)) {
    return res.status(400).json({ error: 'El período debe tener formato AAAA-MM (ej. 2026-07).' });
  }
  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';
  const concepto = `Nómina: ${empleado} (${periodoFinal})`;

  const tx = db.transaction(async () => {
    const gasto = await db.prepare(`
      INSERT INTO gastos (categoria, concepto, monto, moneda, origen_tipo, usuario_id, nota)
      VALUES ('nomina', ?, ?, ?, 'nomina', ?, ?)
    `).run(concepto, salarioNum, mon, req.usuario.id, nota || null);

    // Mismo patrón que POST /gastos: todo gasto se refleja también en caja.
    await db.prepare(`
      INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
      VALUES ('egreso', ?, ?, ?, 'gasto', ?, ?)
    `).run(concepto, salarioNum, mon, gasto.lastInsertRowid, req.usuario.id);

    const fila = await db.prepare(`
      INSERT INTO nomina (empleado, cargo, salario, periodo, moneda, gasto_id, usuario_id, nota)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(empleado, cargo || null, salarioNum, periodoFinal, mon, gasto.lastInsertRowid, req.usuario.id, nota || null);

    return fila.lastInsertRowid;
  });

  res.json({ ok: true, id: await tx() });
});

// Filas del período pedido (o de los últimos 12 meses si no se indica),
// con el total POR MONEDA (mismo criterio que /gastos: nunca se mezclan).
router.get('/nomina', async (req, res) => {
  const periodo = req.query.periodo;
  let filas, porMoneda;

  if (periodo) {
    if (!FORMATO_PERIODO.test(periodo)) {
      return res.status(400).json({ error: 'El período debe tener formato AAAA-MM (ej. 2026-07).' });
    }
    filas = await db.prepare(
      'SELECT * FROM nomina WHERE periodo = ? ORDER BY fecha_pago DESC'
    ).all(periodo);
    porMoneda = await db.prepare(`
      SELECT moneda, COALESCE(SUM(salario), 0) AS total, COUNT(*) AS cantidad
      FROM nomina WHERE periodo = ? GROUP BY moneda
    `).all(periodo);
  } else {
    // Últimos 12 meses: comparación de texto 'YYYY-MM' válida porque el
    // formato es siempre año de 4 dígitos + mes de 2 dígitos con cero.
    const desde = await db.prepare(
      `SELECT to_char((now() AT TIME ZONE 'America/Havana') - interval '11 months', 'YYYY-MM') AS p`
    ).get();
    filas = await db.prepare(
      'SELECT * FROM nomina WHERE periodo >= ? ORDER BY fecha_pago DESC'
    ).all(desde.p);
    porMoneda = await db.prepare(`
      SELECT moneda, COALESCE(SUM(salario), 0) AS total, COUNT(*) AS cantidad
      FROM nomina WHERE periodo >= ? GROUP BY moneda
    `).all(desde.p);
  }

  res.json({ filas, por_moneda: porMoneda });
});

// Borra el pago de nómina Y su gasto asociado Y su egreso de caja, para
// que no quede un gasto fantasma inflando lo deducible (y de paso la
// Contribución a la Seguridad Social, que se calcula sobre esos gastos).
router.delete('/nomina/:id', async (req, res) => {
  const id = Number(req.params.id);
  const fila = await db.prepare('SELECT * FROM nomina WHERE id = ?').get(id);
  if (!fila) return res.status(404).json({ error: 'No existe ese pago de nómina.' });

  await db.transaction(async () => {
    // Orden obligatorio: "nomina" tiene un FK hacia "gastos" (gasto_id),
    // así que hay que borrar primero la fila de nomina y solo después
    // el gasto; si no, Postgres rechaza el DELETE de gastos por la
    // referencia todavía viva.
    await db.prepare('DELETE FROM nomina WHERE id = ?').run(id);
    if (fila.gasto_id) {
      await db.prepare(
        "DELETE FROM caja WHERE origen_tipo = 'gasto' AND origen_id = ?"
      ).run(fila.gasto_id);
      await db.prepare('DELETE FROM gastos WHERE id = ?').run(fila.gasto_id);
    }
  })();

  res.json({ ok: true });
});

// ------------------------------------------------------------
//  Gastos fijos (plantillas mensuales)
// ------------------------------------------------------------
router.get('/fijos', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM gastos_fijos ORDER BY activo DESC, concepto').all());
});

router.post('/fijos', async (req, res) => {
  const { concepto, monto, moneda, dia_del_mes } = req.body;
  if (!concepto || !monto) return res.status(400).json({ error: 'Indique concepto y monto.' });
  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';
  const r = await db.prepare(`
    INSERT INTO gastos_fijos (concepto, monto, moneda, dia_del_mes)
    VALUES (?, ?, ?, ?)
  `).run(concepto, Number(monto), mon, Number(dia_del_mes) || 1);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.post('/fijos/:id/activo', async (req, res) => {
  await db.prepare('UPDATE gastos_fijos SET activo = ? WHERE id = ?')
    .run(req.body.activo ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});

// Aplicar los gastos fijos del mes actual (los que no se hayan aplicado aún).
// Esto se puede llamar al abrir el sistema; solo aplica una vez por mes.
router.post('/fijos/aplicar', async (req, res) => {
  const mesActual = new Date().toISOString().slice(0, 7);
  const fijos = await db.prepare('SELECT * FROM gastos_fijos WHERE activo = 1').all();
  let aplicados = 0;

  const tx = db.transaction(async () => {
    for (const f of fijos) {
      if (f.ultimo_aplicado === mesActual) continue; // ya aplicado este mes
      await db.prepare(`
        INSERT INTO gastos (categoria, concepto, monto, moneda, origen_tipo, origen_id, nota)
        VALUES ('fijo', ?, ?, ?, 'fijo_auto', ?, 'Gasto fijo mensual')
      `).run(f.concepto, f.monto, f.moneda, f.id);
      await db.prepare(`
        INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo)
        VALUES ('egreso', ?, ?, ?, 'gasto')
      `).run(f.concepto, f.monto, f.moneda);
      await db.prepare('UPDATE gastos_fijos SET ultimo_aplicado = ? WHERE id = ?').run(mesActual, f.id);
      aplicados++;
    }
  });
  await tx();
  res.json({ ok: true, aplicados });
});

// ------------------------------------------------------------
//  Combustible
// ------------------------------------------------------------
router.post('/combustible', async (req, res) => {
  const { litros, costo, moneda, nota } = req.body;
  if (!litros || !costo) return res.status(400).json({ error: 'Indique litros y costo.' });
  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';

  const tx = db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO combustible (litros, costo, moneda, nota, usuario_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(Number(litros), Number(costo), mon, nota || null, req.usuario.id);
    // El combustible es un gasto: registrarlo como tal y en caja.
    await db.prepare(`
      INSERT INTO gastos (categoria, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
      VALUES ('combustible', ?, ?, ?, 'combustible', ?, ?)
    `).run(`Combustible (${litros} L)`, Number(costo), mon, r.lastInsertRowid, req.usuario.id);
    await db.prepare(`
      INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, usuario_id)
      VALUES ('egreso', ?, ?, ?, 'gasto', ?)
    `).run(`Combustible (${litros} L)`, Number(costo), mon, req.usuario.id);
  });
  await tx();
  res.json({ ok: true });
});

router.get('/combustible/resumen', async (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0, 7);
  const fila = await db.prepare(`
    SELECT COALESCE(SUM(litros), 0) AS litros_mes,
           COALESCE(SUM(costo), 0) AS costo_mes,
           COUNT(*) AS cargas
    FROM combustible
    WHERE to_char(fecha, 'YYYY-MM') = ?
  `).get(mes);
  res.json(fila);
});

// ------------------------------------------------------------
//  GANANCIA NETA del mes (lo que de verdad gana)
//
//  IMPORTANTE: cada moneda se calcula POR SEPARADO. Sumar
//  CUP + USD + MLC daría un número sin sentido contable. Por eso
//  se devuelve la ganancia de cada moneda por su lado.
// ------------------------------------------------------------
router.get('/ganancia', async (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0, 7);
  const MONEDAS = ['CUP', 'USD', 'MLC'];

  // Ventas del mes por moneda (según la moneda del cobro en caja).
  // Las ventas guardan el total sin moneda explícita; el ingreso real
  // cobrado sí lleva moneda en 'caja'. Usamos caja para no inventar.
  const ventasPorMoneda = {};
  for (const m of MONEDAS) ventasPorMoneda[m] = 0;
  const ingresos = await db.prepare(`
    SELECT moneda, COALESCE(SUM(monto), 0) AS total
    FROM caja
    WHERE tipo = 'ingreso' AND to_char(fecha, 'YYYY-MM') = ?
    GROUP BY moneda
  `).all(mes);
  for (const i of ingresos) if (i.moneda in ventasPorMoneda) ventasPorMoneda[i.moneda] = i.total;

  // Costos del mes por categoría Y por moneda.
  const filas = await db.prepare(`
    SELECT categoria, moneda, COALESCE(SUM(monto), 0) AS total
    FROM gastos
    WHERE to_char(fecha, 'YYYY-MM') = ?
    GROUP BY categoria, moneda
  `).all(mes);

  // Armar la estructura por moneda.
  const resultado = {};
  for (const m of MONEDAS) {
    resultado[m] = {
      ventas: ventasPorMoneda[m],
      costos: { directo: 0, indirecto: 0, fijo: 0, combustible: 0 },
      costoTotal: 0,
      ganancia: 0,
      margen: 0,
    };
  }
  for (const f of filas) {
    if (!(f.moneda in resultado)) continue;
    resultado[f.moneda].costos[f.categoria] = f.total;
    resultado[f.moneda].costoTotal += f.total;
  }
  for (const m of MONEDAS) {
    const r = resultado[m];
    r.ganancia = r.ventas - r.costoTotal;
    r.margen = r.ventas > 0 ? Math.round((r.ganancia / r.ventas) * 1000) / 10 : 0;
  }

  // Solo devolvemos las monedas que tuvieron algún movimiento,
  // para no llenar la pantalla de ceros.
  const conMovimiento = {};
  for (const m of MONEDAS) {
    const r = resultado[m];
    if (r.ventas !== 0 || r.costoTotal !== 0) conMovimiento[m] = r;
  }
  // Si no hubo nada, al menos mostramos CUP en cero.
  if (Object.keys(conMovimiento).length === 0) conMovimiento.CUP = resultado.CUP;

  res.json({ mes, por_moneda: conMovimiento });
});

export default router;
