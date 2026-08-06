// ============================================================
//  DINERO DISPONIBLE DEL NEGOCIO (Parte 2)
//
//  Responde a una pregunta muy concreta del dueño: "¿cuánto dinero
//  tengo ahora mismo y dónde está?". Separado por forma (efectivo o
//  transferencia) y por moneda (CUP, USD, EUR, MLC…).
//
//  EL SALDO NO SE GUARDA, SE CALCULA
//  ---------------------------------
//  Cada cambio deja su línea en `dinero_movimientos` y el saldo es la
//  suma. Si se guardara un número editable, cada corrección borraría la
//  anterior y nadie podría explicar por qué el efectivo bajó de 50 000 a
//  30 000. Es la misma regla del libro contable: los saldos se derivan.
//
//  LAS MONEDAS NO SE SUMAN ENTRE ELLAS
//  -----------------------------------
//  No hay un "total general". Sumar 100 USD con 40 000 CUP daría un
//  número que no significa nada, y convertir a una moneda común haría
//  que el patrimonio del negocio cambiara solo cada mañana con el
//  dólar. Cada moneda lleva su propia cuenta.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';

const router = Router();

const FORMAS = ['efectivo', 'transferencia'];

function limpiar(v) {
  const s = (v ?? '').toString().trim();
  return s || null;
}

// Las monedas no están en una lista cerrada a propósito: el cliente
// pidió "dólares, euros y demás monedas", y mañana puede aparecer otra.
// Se normaliza a mayúsculas y se limita el largo para que no entren
// cosas raras, pero no se rechaza una moneda por no conocerla.
function normalizarMoneda(v) {
  const m = String(v || 'CUP').trim().toUpperCase().slice(0, 6);
  return /^[A-Z]{2,6}$/.test(m) ? m : null;
}

// ---------- GET / : el balance, agrupado por moneda ----------
router.get('/', async (req, res) => {
  const filas = await db.prepare(`
    SELECT moneda, forma, COALESCE(SUM(monto), 0) AS saldo, COUNT(*) AS apuntes
      FROM dinero_movimientos
     GROUP BY moneda, forma
  `).all();

  // Se arma un bloque por moneda con sus dos formas. Aunque una moneda
  // solo tenga efectivo, se devuelve también la transferencia en cero:
  // la pantalla necesita las dos casillas siempre, y un hueco vacío se
  // lee peor que un cero explícito.
  const porMoneda = new Map();
  for (const f of filas) {
    if (!porMoneda.has(f.moneda)) {
      porMoneda.set(f.moneda, { moneda: f.moneda, efectivo: 0, transferencia: 0, total: 0, apuntes: 0 });
    }
    const m = porMoneda.get(f.moneda);
    m[f.forma] = Number(Number(f.saldo).toFixed(2));
    m.apuntes += Number(f.apuntes);
  }
  for (const m of porMoneda.values()) {
    // El total SÍ se puede sumar dentro de una misma moneda: son pesos
    // con pesos. Lo que no se suma es entre monedas distintas.
    m.total = Number((m.efectivo + m.transferencia).toFixed(2));
  }

  const monedas = [...porMoneda.values()].sort((a, b) => {
    if (a.moneda === 'CUP') return -1;          // la del país, primero
    if (b.moneda === 'CUP') return 1;
    return a.moneda.localeCompare(b.moneda);
  });

  res.json({
    monedas,
    aviso: 'Cada moneda lleva su propia cuenta. No se suman entre ellas: convertirlas a una '
         + 'sola haría que el dinero del negocio cambiara solo cada vez que se mueve el dólar.',
  });
});

// ---------- GET /movimientos : el detalle, para explicar un saldo ----------
router.get('/movimientos', async (req, res) => {
  const { moneda, forma, desde, hasta } = req.query;
  const cond = [];
  const params = [];
  if (moneda) { cond.push('d.moneda = ?'); params.push(normalizarMoneda(moneda)); }
  if (forma && FORMAS.includes(forma)) { cond.push('d.forma = ?'); params.push(forma); }
  if (desde) { cond.push('d.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('d.fecha <= ?'); params.push(`${hasta} 23:59:59`); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const filas = await db.prepare(`
    SELECT d.*, u.nombre AS usuario_nombre
      FROM dinero_movimientos d
      LEFT JOIN usuarios u ON u.id = d.usuario_id
      ${where}
     ORDER BY d.fecha DESC, d.id DESC
     LIMIT 300
  `).all(...params);

  res.json(filas);
});

// ---------- POST / : declarar una entrada o salida de dinero ----------
router.post('/', async (req, res) => {
  const b = req.body || {};
  const forma = limpiar(b.forma);
  const moneda = normalizarMoneda(b.moneda);
  const monto = Number(b.monto);
  const concepto = limpiar(b.concepto);

  if (!FORMAS.includes(forma)) {
    return res.status(400).json({ error: 'Indique si es efectivo o transferencia.' });
  }
  if (!moneda) return res.status(400).json({ error: 'Indique una moneda válida (CUP, USD, EUR…).' });
  if (!Number.isFinite(monto) || monto === 0) {
    return res.status(400).json({ error: 'El monto debe ser un número distinto de cero.' });
  }
  if (!concepto) return res.status(400).json({ error: 'Escriba de qué se trata este movimiento.' });

  const r = await db.prepare(`
    INSERT INTO dinero_movimientos (forma, moneda, monto, concepto, origen_tipo, usuario_id, nota)
    VALUES (?, ?, ?, ?, 'ajuste', ?, ?)
  `).run(forma, moneda, Number(monto.toFixed(2)), concepto, req.usuario?.id ?? null, limpiar(b.nota));

  await auditar({
    modulo: 'contabilidad', accion: 'crear', req,
    entidad: 'dinero_movimientos', entidad_id: r.lastInsertRowid,
    descripcion: `${monto > 0 ? 'Entrada' : 'Salida'} de ${Math.abs(monto)} ${moneda} en ${forma}: ${concepto}`,
  });

  const fila = await db.prepare('SELECT * FROM dinero_movimientos WHERE id = ?').get(r.lastInsertRowid);
  res.json(fila);
});

// ---------- PUT /ajustar : poner un saldo en una cifra concreta ----------
// El dueño cuenta el dinero que tiene en la mano y dice "hay 30 000".
// En vez de sobrescribir nada, se calcula la diferencia con lo que el
// sistema creía y se anota como un ajuste. Así el saldo queda donde
// tiene que quedar Y se conserva el rastro de la corrección, con su
// motivo: sin eso, un descuadre no se podría investigar nunca.
router.put('/ajustar', async (req, res) => {
  const b = req.body || {};
  const forma = limpiar(b.forma);
  const moneda = normalizarMoneda(b.moneda);
  const saldoReal = Number(b.saldo);
  const motivo = limpiar(b.motivo);

  if (!FORMAS.includes(forma)) {
    return res.status(400).json({ error: 'Indique si es efectivo o transferencia.' });
  }
  if (!moneda) return res.status(400).json({ error: 'Indique una moneda válida.' });
  if (!Number.isFinite(saldoReal) || saldoReal < 0) {
    return res.status(400).json({ error: 'El saldo contado debe ser un número de cero para arriba.' });
  }
  if (!motivo) {
    return res.status(400).json({ error: 'Escriba el motivo del ajuste: es lo que permitirá entender el descuadre más adelante.' });
  }

  const actual = await db.prepare(`
    SELECT COALESCE(SUM(monto), 0) AS saldo FROM dinero_movimientos
     WHERE forma = ? AND moneda = ?
  `).get(forma, moneda);

  const diferencia = Number((saldoReal - Number(actual.saldo)).toFixed(2));
  if (diferencia === 0) {
    return res.json({ ok: true, sin_cambios: true, saldo: saldoReal });
  }

  const r = await db.prepare(`
    INSERT INTO dinero_movimientos (forma, moneda, monto, concepto, origen_tipo, usuario_id, nota)
    VALUES (?, ?, ?, ?, 'ajuste', ?, ?)
  `).run(
    forma, moneda, diferencia,
    `Ajuste por conteo: ${motivo}`,
    req.usuario?.id ?? null,
    `El sistema tenía ${Number(actual.saldo).toFixed(2)} y se contaron ${saldoReal.toFixed(2)}.`,
  );

  await auditar({
    modulo: 'contabilidad', accion: 'modificar', req,
    entidad: 'dinero_movimientos', entidad_id: r.lastInsertRowid,
    descripcion: `Ajuste de ${forma} en ${moneda}: de ${Number(actual.saldo).toFixed(2)} a ${saldoReal.toFixed(2)}`,
    motivo,
  });

  res.json({ ok: true, saldo: saldoReal, diferencia });
});

export default router;
