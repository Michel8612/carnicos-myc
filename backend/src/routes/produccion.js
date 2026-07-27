// ============================================================
//  Motor de fórmulas guiadas (Fase 2)
//
//  El dueño no escribe matemática libre: elige uno de tres
//  cálculos ya programados y probados aquí, y solo rellena los
//  números. Imposible que rompa nada.
//
//  Los tres cálculos:
//   1) rendimiento     → peso + merma  ⇒ unidades reales y pérdida
//   2) costo_importacion→ costo + arancel + cambio + peso ⇒ costo/kg
//   3) precio_venta    → costo + margen ⇒ precio sugerido
//
//  Además, al producir, el sistema descuenta la materia prima y
//  suma el producto terminado al inventario, en una sola acción.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion);

// ------------------------------------------------------------
//  LOS TRES CÁLCULOS (la matemática segura vive aquí)
// ------------------------------------------------------------

// Factor de conversión de peso. Estándar internacional.
// Si en el negocio usan una libra local distinta, cambiar
// SOLO este número y todo el sistema queda consistente.
const LB_POR_KG = 2.20462;

function calcular(tipo, v) {
  // v = valores numéricos que mandó el usuario
  if (tipo === 'rendimiento') {
    // Cuánto entra de materia prima, qué % se pierde, cuánto sale por unidad.
    // 'unidad_peso' indica en qué unidad vienen 'peso' y 'peso_por_unidad':
    // 'kg', 'lb' o 'L' (litros, para productos líquidos). Internamente
    // trabajamos en la misma unidad, así que solo deben coincidir.
    const peso = Number(v.peso) || 0;            // ej. 100
    const merma = Number(v.merma) || 0;          // ej. 8 (%)
    const peso_por_unidad = Number(v.peso_por_unidad) || 0; // ej. 0.22 lb por hamburguesa
    const unidadesValidas = ['kg', 'lb', 'L'];
    const unidad = unidadesValidas.includes(v.unidad_peso) ? v.unidad_peso : 'kg';

    const peso_util = peso * (1 - merma / 100);  // lo que queda tras la merma
    const unidades = peso_por_unidad > 0 ? Math.floor(peso_util / peso_por_unidad) : 0;
    const perdida = peso - peso_util;

    return {
      peso_util: redondear(peso_util),
      perdida_peso: redondear(perdida),
      unidades,
      unidad_peso: unidad,
      resumen: `De ${peso} ${unidad} se obtienen ${unidades} unidades (se pierden ${redondear(perdida)} ${unidad} por merma).`,
    };
  }

  if (tipo === 'costo_importacion') {
    // Costo real por kg de algo importado, con arancel y cambio de moneda
    const costo = Number(v.costo) || 0;          // costo de la mercancía (en divisa)
    const arancel = Number(v.arancel) || 0;      // arancel de aduana (en divisa)
    const tasa = Number(v.tasa_cambio) || 1;     // cuántos CUP por unidad de divisa
    const peso = Number(v.peso) || 0;            // kg recibidos

    const costo_total_divisa = costo + arancel;
    const costo_total_cup = costo_total_divisa * tasa;
    const costo_por_kg = peso > 0 ? costo_total_cup / peso : 0;

    return {
      costo_total_divisa: redondear(costo_total_divisa),
      costo_total_cup: redondear(costo_total_cup),
      costo_por_kg: redondear(costo_por_kg),
      resumen: `Cada kg le sale a ${redondear(costo_por_kg)} CUP (incluye arancel y cambio).`,
    };
  }

  if (tipo === 'precio_venta') {
    // Precio sugerido a partir del costo y el margen deseado
    const costo = Number(v.costo) || 0;          // costo unitario
    const margen = Number(v.margen) || 0;        // % de ganancia deseado

    const precio = costo * (1 + margen / 100);
    const ganancia = precio - costo;

    return {
      precio_sugerido: redondear(precio),
      ganancia_unidad: redondear(ganancia),
      resumen: `Venda a ${redondear(precio)} para ganar ${redondear(ganancia)} por unidad.`,
    };
  }

  throw new Error('Tipo de cálculo no reconocido.');
}

function redondear(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ------------------------------------------------------------
//  CALCULAR AL MOMENTO (sin guardar nada)
// ------------------------------------------------------------

router.post('/calcular', (req, res) => {
  const { tipo, valores } = req.body;
  try {
    res.json(calcular(tipo, valores || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------
//  FÓRMULAS GUARDADAS (para reusar con valores fijos)
// ------------------------------------------------------------

router.get('/', async (req, res) => {
  const formulas = await db.prepare('SELECT * FROM formulas ORDER BY nombre').all();
  const valores = await db.prepare('SELECT * FROM formula_valores').all();
  // Adjuntar a cada fórmula sus valores guardados.
  const conValores = formulas.map((f) => ({
    ...f,
    valores: valores.filter((v) => v.formula_id === f.id),
  }));
  res.json(conValores);
});

router.post('/', async (req, res) => {
  const { nombre, tipo, valores } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'Indique nombre y tipo de la fórmula.' });

  const tx = db.transaction(async () => {
    const r = await db.prepare(
      'INSERT INTO formulas (nombre, tipo, guardada, usuario_id) VALUES (?, ?, 1, ?)'
    ).run(nombre, tipo, req.usuario.id);
    const fid = r.lastInsertRowid;
    for (const [variable, valor_fijo] of Object.entries(valores || {})) {
      await db.prepare(
        'INSERT INTO formula_valores (formula_id, variable, valor_fijo) VALUES (?, ?, ?)'
      ).run(fid, variable, valor_fijo === '' ? null : Number(valor_fijo));
    }
    return fid;
  });

  res.json({ id: await tx() });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await db.prepare('DELETE FROM formula_valores WHERE formula_id = ?').run(id);
  await db.prepare('DELETE FROM formulas WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ------------------------------------------------------------
//  PRODUCIR: calcula el rendimiento Y mueve el inventario
// ------------------------------------------------------------

router.post('/producir', async (req, res) => {
  const {
    producto_origen_id, producto_final_id, almacen_id,
    peso, merma, peso_por_unidad, nota,
  } = req.body;

  if (!producto_origen_id || !producto_final_id || !almacen_id || !peso) {
    return res.status(400).json({ error: 'Indique materia prima, producto final, almacén y peso.' });
  }

  // 1) Calcular cuántas unidades salen.
  const r = calcular('rendimiento', { peso, merma, peso_por_unidad, unidad_peso: req.body.unidad_peso });
  if (r.unidades <= 0) {
    return res.status(400).json({ error: 'Con esos datos no sale ninguna unidad. Revise el peso por unidad.' });
  }

  const pesoUsado = Number(peso);

  const tx = db.transaction(async () => {
    // 2) Verificar que haya suficiente materia prima.
    const ex = await db.prepare(
      'SELECT id, cantidad FROM existencias WHERE producto_id = ? AND almacen_id = ?'
    ).get(producto_origen_id, almacen_id);
    if (!ex || ex.cantidad < pesoUsado) {
      throw new Error('No hay suficiente materia prima en ese almacén.');
    }

    // 3) Descontar materia prima.
    await db.prepare('UPDATE existencias SET cantidad = cantidad - ? WHERE id = ?').run(pesoUsado, ex.id);
    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
      VALUES (?, ?, 'produccion', ?, 'produccion', ?, ?)
    `).run(producto_origen_id, almacen_id, pesoUsado, req.usuario.id, 'Consumo en producción');

    // 4) Sumar producto terminado.
    const exFinal = await db.prepare(
      'SELECT id FROM existencias WHERE producto_id = ? AND almacen_id = ?'
    ).get(producto_final_id, almacen_id);
    if (exFinal) {
      await db.prepare('UPDATE existencias SET cantidad = cantidad + ? WHERE id = ?').run(r.unidades, exFinal.id);
    } else {
      await db.prepare('INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)')
        .run(producto_final_id, almacen_id, r.unidades);
    }
    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
      VALUES (?, ?, 'produccion', ?, 'produccion', ?, ?)
    `).run(producto_final_id, almacen_id, r.unidades, req.usuario.id, 'Producto obtenido');

    // 5) Registrar la orden de producción (con la merma).
    await db.prepare(`
      INSERT INTO ordenes_produccion
        (producto_origen_id, producto_final_id, cantidad_usada, cantidad_obtenida, merma, usuario_id, nota)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(producto_origen_id, producto_final_id, pesoUsado, r.unidades, r.perdida_peso, req.usuario.id, nota || null);
  });

  try {
    await tx();
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
