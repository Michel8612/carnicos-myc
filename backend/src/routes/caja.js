// ============================================================
//  Rutas de caja
//
//  Registra todo el dinero que entra y sale, y entrega el
//  resumen del día (el "cuadre"): cuánto entró, cuánto salió
//  y el saldo, separado por moneda (CUP, USD, MLC).
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion, soloDueno } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion);

// ---------- Registrar un movimiento de dinero ----------

router.post('/movimientos', async (req, res) => {
  const { tipo, concepto, monto, moneda } = req.body;
  if (!tipo || !concepto || !monto) {
    return res.status(400).json({ error: 'Indique tipo, concepto y monto.' });
  }
  if (!['ingreso', 'egreso'].includes(tipo)) {
    return res.status(400).json({ error: 'El tipo debe ser ingreso o egreso.' });
  }
  const m = Number(monto);
  if (m <= 0) return res.status(400).json({ error: 'El monto debe ser mayor que cero.' });

  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';

  await db.prepare(`
    INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, usuario_id)
    VALUES (?, ?, ?, ?, 'manual', ?)
  `).run(tipo, concepto, m, mon, req.usuario.id);

  res.json({ ok: true });
});

// ---------- Resumen del día (el cuadre) ----------

// Devuelve, por cada moneda, cuánto entró, cuánto salió y el saldo.
// Por defecto el día de hoy; admite ?fecha=AAAA-MM-DD.
router.get('/resumen', async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

  const filas = await db.prepare(`
    SELECT moneda, tipo, SUM(monto) AS total
    FROM caja
    WHERE fecha::date = ?::date
    GROUP BY moneda, tipo
  `).all(fecha);

  // Organizar por moneda.
  const porMoneda = {};
  for (const f of filas) {
    if (!porMoneda[f.moneda]) porMoneda[f.moneda] = { moneda: f.moneda, ingresos: 0, egresos: 0, saldo: 0 };
    if (f.tipo === 'ingreso') porMoneda[f.moneda].ingresos = f.total;
    else porMoneda[f.moneda].egresos = f.total;
  }
  for (const k in porMoneda) {
    porMoneda[k].saldo = porMoneda[k].ingresos - porMoneda[k].egresos;
  }

  res.json({ fecha, monedas: Object.values(porMoneda) });
});

// ---------- Lista de movimientos del día ----------

router.get('/movimientos', async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
  const filas = await db.prepare(`
    SELECT c.*, u.nombre AS usuario_nombre
    FROM caja c
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE c.fecha::date = ?::date
    ORDER BY c.fecha DESC
  `).all(fecha);
  res.json(filas);
});

export default router;
