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
import { auditar } from '../auditoria.js';

const router = Router();
router.use(requiereSesion);

// Quién puede ESCRIBIR en costos (crear/borrar gastos, categorías...).
// OJO: server.js monta /api/costos con `escrituraSoloRoles()` (sin
// roles extra), que deja pasar solo a dueño/admin/proveedor y bloquea
// a 'contabilidad' ANTES de que la petición llegue aquí. Este chequeo
// de dentro es un candado adicional (por si algún día se llama este
// router desde otro punto de montaje), pero mientras esa línea de
// server.js no incluya 'contabilidad', el rol contabilidad seguirá
// recibiendo 403 en DELETE /gastos/:id y en POST/DELETE /categorias
// aunque el código de aquí ya lo permita. Lo dejo dicho en el informe.
const PUEDE_ESCRIBIR_CONTABLE = (rol) => ['dueno', 'admin', 'proveedor', 'contabilidad'].includes(rol);

// ------------------------------------------------------------
//  Categorías de gasto (configurables)
//
//  Antes vivían fijas en un array de este archivo. Ahora viven en la
//  tabla `categorias_gasto`: el dueño (o contabilidad) puede crear las
//  suyas. Las 13 de siempre se siembran solas la primera vez que hace
//  falta (idempotente, con ON CONFLICT DO NOTHING) y quedan marcadas
//  fija=1 para que no se puedan borrar.
//
//  CRÍTICO: 'nomina' alimenta el cálculo de la Contribución a la
//  Seguridad Social en backend/src/routes/contabilidad.js (ruta
//  /tributacion). Si se pudiera borrar o desactivar, ese tributo
//  volvería a dar siempre 0 sin que nadie lo notara. Por eso lleva un
//  candado extra explícito en DELETE /categorias/:clave, además del
//  candado general de fija=1.
// ------------------------------------------------------------
const CATEGORIAS_FABRICA = [
  ['directo', 'Costo directo'],
  ['indirecto', 'Costo indirecto'],
  ['fijo', 'Gasto fijo'],
  ['combustible', 'Combustible'],
  ['nomina', 'Nómina (salarios)'],
  ['electricidad', 'Electricidad'],
  ['alquiler', 'Alquiler'],
  ['materia_prima', 'Materia prima'],
  ['transporte', 'Transporte'],
  ['servicios', 'Servicios'],
  ['mantenimiento', 'Mantenimiento'],
  ['impuestos', 'Impuestos'],
  ['otros', 'Otros'],
];

let categoriasSembradas = false;
async function asegurarCategoriasSembradas() {
  if (categoriasSembradas) return;
  const fila = await db.prepare('SELECT COUNT(*)::int AS total FROM categorias_gasto').get();
  if (Number(fila?.total) === 0) {
    for (const [clave, etiqueta] of CATEGORIAS_FABRICA) {
      // OJO: categorias_gasto no tiene columna "id" (su PK es "clave").
      // El adaptador de db/index.js añade "RETURNING id" automáticamente
      // a cualquier INSERT sin RETURNING; aquí hay que ponerle uno
      // explícito (RETURNING clave) para que no intente devolver una
      // columna que no existe.
      await db.prepare(`
        INSERT INTO categorias_gasto (clave, etiqueta, deducible, fija, activa)
        VALUES (?, ?, 1, 1, 1)
        ON CONFLICT (clave) DO NOTHING
        RETURNING clave
      `).run(clave, etiqueta);
    }
  }
  categoriasSembradas = true;
}

// Clave sencilla: minúsculas, sin espacios ni acentos, empieza por letra.
const CLAVE_CATEGORIA_VALIDA = /^[a-z][a-z0-9_]*$/;

// Categorías para el <select> del formulario de gastos. Con ?todas=1
// devuelve también las inactivas (para la pantalla de administración).
router.get('/categorias', async (req, res) => {
  await asegurarCategoriasSembradas();
  const todas = req.query.todas === '1';
  const filas = await db.prepare(
    todas
      ? 'SELECT * FROM categorias_gasto ORDER BY fija DESC, activa DESC, etiqueta'
      : 'SELECT * FROM categorias_gasto WHERE activa = 1 ORDER BY fija DESC, etiqueta'
  ).all();
  res.json(filas);
});

// Crear una categoría propia.
router.post('/categorias', async (req, res) => {
  if (!PUEDE_ESCRIBIR_CONTABLE(req.usuario.rol)) {
    return res.status(403).json({ error: 'No tiene permiso para crear categorías de gasto.' });
  }
  await asegurarCategoriasSembradas();
  const { clave, etiqueta, deducible } = req.body || {};
  const claveLimpia = String(clave || '').trim().toLowerCase();
  if (!CLAVE_CATEGORIA_VALIDA.test(claveLimpia)) {
    return res.status(400).json({
      error: 'La clave debe ser sencilla: minúsculas, sin espacios ni acentos, letras/números/guion bajo, empezando por letra.',
    });
  }
  if (!etiqueta || !String(etiqueta).trim()) {
    return res.status(400).json({ error: 'Indique una etiqueta (nombre visible) para la categoría.' });
  }
  const existe = await db.prepare('SELECT 1 FROM categorias_gasto WHERE clave = ?').get(claveLimpia);
  if (existe) return res.status(400).json({ error: 'Ya existe una categoría con esa clave.' });

  // Igual que en la siembra: RETURNING explícito porque esta tabla no
  // tiene columna "id" (ver comentario en asegurarCategoriasSembradas).
  await db.prepare(`
    INSERT INTO categorias_gasto (clave, etiqueta, deducible, fija, activa)
    VALUES (?, ?, ?, 0, 1)
    RETURNING clave
  `).run(claveLimpia, String(etiqueta).trim(), deducible === false ? 0 : 1);

  await auditar({
    modulo: 'gastos', accion: 'crear', req, entidad: 'categorias_gasto', entidad_id: claveLimpia,
    descripcion: `Categoría de gasto creada: ${etiqueta} (${claveLimpia})`,
  });
  res.json({ ok: true, clave: claveLimpia });
});

// Borrar (o, si está en uso, desactivar) una categoría propia.
router.delete('/categorias/:clave', async (req, res) => {
  if (!PUEDE_ESCRIBIR_CONTABLE(req.usuario.rol)) {
    return res.status(403).json({ error: 'No tiene permiso para borrar categorías de gasto.' });
  }
  const clave = req.params.clave;
  const cat = await db.prepare('SELECT * FROM categorias_gasto WHERE clave = ?').get(clave);
  if (!cat) return res.status(404).json({ error: 'No existe esa categoría.' });

  // Candado explícito (aparte de fija=1): 'nomina' nunca se toca.
  if (clave === 'nomina') {
    return res.status(400).json({
      error: 'La categoría "nomina" no se puede borrar ni desactivar: de ella depende el cálculo de la Seguridad Social.',
    });
  }
  if (cat.fija) {
    return res.status(400).json({ error: 'Esta es una categoría de fábrica y no se puede borrar.' });
  }

  const uso = await db.prepare('SELECT COUNT(*)::int AS total FROM gastos WHERE categoria = ?').get(clave);
  if (Number(uso?.total) > 0) {
    // No se borra (dejaría huérfanos los gastos ya registrados con esa
    // categoría): se desactiva para que no siga apareciendo en el
    // formulario, pero el historial ya registrado la sigue mostrando tal cual.
    await db.prepare('UPDATE categorias_gasto SET activa = 0 WHERE clave = ?').run(clave);
    await auditar({
      modulo: 'gastos', accion: 'modificar', req, entidad: 'categorias_gasto', entidad_id: clave,
      descripcion: `Categoría "${clave}" desactivada (tenía ${uso.total} gasto(s) registrados; borrarla habría dejado huérfanos).`,
    });
    return res.json({
      ok: true, desactivada: true,
      mensaje: `Hay ${uso.total} gasto(s) con esta categoría: se desactivó en vez de borrarla.`,
    });
  }

  await db.prepare('DELETE FROM categorias_gasto WHERE clave = ?').run(clave);
  await auditar({
    modulo: 'gastos', accion: 'eliminar', req, entidad: 'categorias_gasto', entidad_id: clave,
    descripcion: `Categoría de gasto eliminada: ${cat.etiqueta} (${clave})`,
    antes: cat,
  });
  res.json({ ok: true, desactivada: false });
});

// ------------------------------------------------------------
//  Registrar un gasto suelto
// ------------------------------------------------------------
router.post('/gastos', async (req, res) => {
  const { categoria, concepto, monto, moneda, nota } = req.body;
  if (!categoria || !concepto || !monto) {
    return res.status(400).json({ error: 'Indique categoría, concepto y monto.' });
  }
  await asegurarCategoriasSembradas();
  const catValida = await db.prepare(
    'SELECT 1 FROM categorias_gasto WHERE clave = ? AND activa = 1'
  ).get(categoria);
  if (!catValida) {
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

// Borra un gasto suelto Y su egreso de caja asociado, en una
// transacción (mismo patrón que DELETE /nomina/:id). Si el gasto vino
// de un pago de nómina, se rechaza: hay que borrarlo desde la pestaña
// Nómina para que se elimine todo junto (nómina, gasto y caja) sin
// dejar la fila de "nomina" huérfana.
router.delete('/gastos/:id', async (req, res) => {
  if (!PUEDE_ESCRIBIR_CONTABLE(req.usuario.rol)) {
    return res.status(403).json({ error: 'No tiene permiso para borrar gastos.' });
  }
  const id = Number(req.params.id);
  const { motivo } = req.body || {};
  if (!motivo || !String(motivo).trim()) {
    return res.status(400).json({ error: 'Debe indicar el motivo del borrado.' });
  }
  const gasto = await db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
  if (!gasto) return res.status(404).json({ error: 'No existe ese gasto.' });
  if (gasto.origen_tipo === 'nomina') {
    return res.status(409).json({
      error: 'Este gasto proviene de un pago de nómina: bórrelo desde la pestaña Nómina, así se elimina todo junto (nómina, gasto y caja) sin dejar huérfanos.',
    });
  }

  await db.transaction(async () => {
    // El egreso de caja se creó con origen_tipo='gasto' y origen_id
    // apuntando a este gasto (ver POST /gastos, /combustible y
    // /fijos/aplicar más abajo): se borra primero para no descuadrar
    // la caja, y solo después el gasto.
    await db.prepare("DELETE FROM caja WHERE origen_tipo = 'gasto' AND origen_id = ?").run(id);
    await db.prepare('DELETE FROM gastos WHERE id = ?').run(id);
  })();

  await auditar({
    modulo: 'gastos', accion: 'eliminar', req, entidad: 'gastos', entidad_id: id,
    descripcion: `Gasto eliminado: ${gasto.concepto} (${gasto.monto} ${gasto.moneda})`,
    antes: gasto, motivo: String(motivo).trim(),
  });
  res.json({ ok: true });
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
      const gasto = await db.prepare(`
        INSERT INTO gastos (categoria, concepto, monto, moneda, origen_tipo, origen_id, nota)
        VALUES ('fijo', ?, ?, ?, 'fijo_auto', ?, 'Gasto fijo mensual')
      `).run(f.concepto, f.monto, f.moneda, f.id);
      // origen_id enlaza el egreso a ESTE gasto (antes no se guardaba y
      // DELETE /gastos/:id no tenía forma fiable de encontrar su caja).
      await db.prepare(`
        INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id)
        VALUES ('egreso', ?, ?, ?, 'gasto', ?)
      `).run(f.concepto, f.monto, f.moneda, gasto.lastInsertRowid);
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
    const gasto = await db.prepare(`
      INSERT INTO gastos (categoria, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
      VALUES ('combustible', ?, ?, ?, 'combustible', ?, ?)
    `).run(`Combustible (${litros} L)`, Number(costo), mon, r.lastInsertRowid, req.usuario.id);
    // origen_id enlaza el egreso a ESTE gasto (antes no se guardaba y
    // DELETE /gastos/:id no tenía forma fiable de encontrar su caja).
    await db.prepare(`
      INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
      VALUES ('egreso', ?, ?, ?, 'gasto', ?, ?)
    `).run(`Combustible (${litros} L)`, Number(costo), mon, gasto.lastInsertRowid, req.usuario.id);
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
