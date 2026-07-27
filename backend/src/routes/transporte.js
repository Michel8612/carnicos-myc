// ============================================================
//  Transporte y entregas (Fase 2)
//
//  Registra las entregas: quién transporta,
//  a dónde, qué venta entrega, y cuánto costó. Como el costo lo
//  paga la empresa, se anota como egreso en caja automáticamente
//  para que ese gasto no se pierda.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion);

// ---------- Registrar una entrega ----------

router.post('/', async (req, res) => {
  const { chofer, destino, venta_id, costo, moneda, nota } = req.body;
  if (!chofer || !destino) {
    return res.status(400).json({ error: 'Indique quién transporta y a dónde.' });
  }
  const costoNum = Number(costo) || 0;
  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';

  const tx = db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO transporte (chofer, destino, venta_id, costo, nota)
      VALUES (?, ?, ?, ?, ?)
    `).run(chofer, destino, venta_id || null, costoNum, nota || null);

    // Si hubo costo, registrarlo como egreso en caja (lo paga la empresa)
    // y como gasto directo (para que cuente en la ganancia neta).
    if (costoNum > 0) {
      await db.prepare(`
        INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
        VALUES ('egreso', ?, ?, ?, 'transporte', ?, ?)
      `).run(`Transporte: ${destino}`, costoNum, mon, r.lastInsertRowid, req.usuario.id);
      await db.prepare(`
        INSERT INTO gastos (categoria, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
        VALUES ('directo', ?, ?, ?, 'transporte', ?, ?)
      `).run(`Transporte: ${destino}`, costoNum, mon, r.lastInsertRowid, req.usuario.id);
    }
    return r.lastInsertRowid;
  });

  res.json({ ok: true, id: await tx() });
});

// ---------- Lista de entregas ----------

router.get('/', async (req, res) => {
  const filas = await db.prepare(`
    SELECT t.*, v.cliente AS venta_cliente
    FROM transporte t
    LEFT JOIN ventas v ON v.id = t.venta_id
    ORDER BY t.fecha DESC LIMIT 100
  `).all();
  res.json(filas);
});

// ---------- Resumen: cuánto se ha gastado en transporte ----------

router.get('/resumen', async (req, res) => {
  const fila = await db.prepare(`
    SELECT COUNT(*) AS entregas, COALESCE(SUM(costo), 0) AS gasto_total
    FROM transporte
    WHERE fecha::date >= (now() - interval '30 days')::date
  `).get();
  res.json(fila);
});

export default router;
