// ============================================================
//  Cuentas por cobrar y por pagar (§10.3)
//
//  Una sola tabla (cuentas_terceros) con `tipo` en vez de dos tablas
//  separadas: "lo que me deben" y "lo que debo" son la misma forma
//  (un tercero, un documento, un vencimiento y un saldo), así que se
//  reparten por un filtro, no por un esquema distinto.
//
//  El montaje en server.js ya trae requiereSesion (lectura libre para
//  cualquier sesión) y escrituraSoloRoles('contabilidad') (escriben
//  dueño/admin/proveedor + contabilidad) — aquí no hace falta repetirlo.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';
import { crearNotificacion } from './notificaciones.js';
import { servirDescarga } from '../servicios/exportar.js';

const router = Router();

const TIPOS = ['cobrar', 'pagar'];

function limpiar(v) {
  const s = (v ?? '').toString().trim();
  return s || null;
}

// Redondeo a 2 decimales ANTES de comparar importes. Sin esto, un saldo
// que en teoría es 0 pero en la práctica quedó en 0.0000000001 (cosas
// del punto flotante) deja el documento "parcial" para siempre y nunca
// pasa a "pagada".
function money(n) {
  return Number(Number(n ?? 0).toFixed(2));
}

// Estado que le corresponde a una cuenta según su saldo y si ya tiene
// pagos. No se toca a mano en ningún sitio: siempre sale de aquí, para
// que crear, editar, pagar y borrar-pago den siempre el mismo resultado.
function estadoSegunSaldo(saldo, tienePagos) {
  if (money(saldo) <= 0) return 'pagada';
  return tienePagos ? 'parcial' : 'pendiente';
}

// ------------------------------------------------------------
//  GET / — listado con filtros, "pagado"/"dias_vencida" calculados
//  y totales. Con ?formato=, se exporta en vez de devolver JSON.
// ------------------------------------------------------------
router.get('/', async (req, res) => {
  const { tipo, estado, tercero, vencidas } = req.query;
  const condiciones = [];
  const params = [];

  if (tipo) { condiciones.push('c.tipo = ?'); params.push(tipo); }
  if (estado) { condiciones.push('c.estado = ?'); params.push(estado); }
  if (tercero) { condiciones.push('LOWER(c.tercero) LIKE LOWER(?)'); params.push(`%${tercero}%`); }
  if (vencidas === '1') {
    condiciones.push('c.saldo > 0');
    condiciones.push('c.fecha_vencimiento IS NOT NULL');
    condiciones.push('c.fecha_vencimiento < CURRENT_DATE');
  }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const filas = await db.prepare(`
    SELECT c.*,
           COALESCE(p.pagado, 0) AS pagado,
           CASE
             WHEN c.saldo > 0 AND c.fecha_vencimiento IS NOT NULL AND c.fecha_vencimiento < CURRENT_DATE
               THEN (CURRENT_DATE - c.fecha_vencimiento)
             ELSE 0
           END AS dias_vencida
      FROM cuentas_terceros c
      LEFT JOIN (
        SELECT cuenta_id, SUM(monto) AS pagado FROM cuentas_pagos GROUP BY cuenta_id
      ) p ON p.cuenta_id = c.id
      ${where}
     ORDER BY
       -- Se repite la condición de "vencida" (en vez de usar el alias
       -- dias_vencida) porque dentro de una expresión de ORDER BY,
       -- Postgres solo reconoce el alias si es el ítem completo, no
       -- si va mezclado con más operadores.
       (CASE WHEN c.saldo > 0 AND c.fecha_vencimiento IS NOT NULL AND c.fecha_vencimiento < CURRENT_DATE THEN 0 ELSE 1 END) ASC,
       c.fecha_vencimiento ASC NULLS LAST,
       c.id DESC
  `).all(...params);

  const totales = filas.reduce((t, f) => {
    t.documentos += 1;
    t.monto = money(t.monto + Number(f.monto));
    t.pagado = money(t.pagado + Number(f.pagado));
    t.saldo = money(t.saldo + Number(f.saldo));
    if (Number(f.dias_vencida) > 0) t.vencido = money(t.vencido + Number(f.saldo));
    return t;
  }, { documentos: 0, monto: 0, pagado: 0, saldo: 0, vencido: 0 });

  const columnas = [
    { clave: 'tercero', titulo: tipo === 'pagar' ? 'Proveedor' : 'Cliente / Proveedor', ancho: 26 },
    { clave: 'documento', titulo: 'Documento', ancho: 18 },
    { clave: 'concepto', titulo: 'Concepto', ancho: 28 },
    { clave: 'monto', titulo: 'Monto', ancho: 14 },
    { clave: 'pagado', titulo: 'Pagado', ancho: 14 },
    { clave: 'saldo', titulo: 'Saldo', ancho: 14 },
    { clave: 'moneda', titulo: 'Moneda', ancho: 10 },
    { clave: 'fecha_emision', titulo: 'Emisión', ancho: 14 },
    { clave: 'fecha_vencimiento', titulo: 'Vencimiento', ancho: 14 },
    { clave: 'dias_vencida', titulo: 'Días vencida', ancho: 12 },
    { clave: 'estado', titulo: 'Estado', ancho: 12 },
  ];

  if (await servirDescarga(req, res, {
    base: `cuentas-por-${tipo === 'pagar' ? 'pagar' : 'cobrar'}`,
    columnas,
    filas,
  })) {
    await auditar({
      modulo: 'contabilidad', accion: 'exportar', req, entidad: 'cuentas_terceros',
      descripcion: `Exportación de cuentas por ${tipo === 'pagar' ? 'pagar' : 'cobrar'} (${filas.length} documento(s))`,
    });
    return;
  }

  res.json({ filas, totales });
});

// ------------------------------------------------------------
//  GET /antiguedad — antigüedad de saldos por tramos (0-30/31-60/
//  61-90/más de 90 días), es lo que se le lleva al banco.
// ------------------------------------------------------------
router.get('/antiguedad', async (req, res) => {
  const tipo = TIPOS.includes(req.query.tipo) ? req.query.tipo : 'cobrar';

  const filas = await db.prepare(`
    SELECT tercero, saldo, fecha_emision, fecha_vencimiento
      FROM cuentas_terceros
     WHERE tipo = ? AND saldo > 0 AND estado <> 'anulada'
  `).all(tipo);

  const tramos = { tramo_0_30: 0, tramo_31_60: 0, tramo_61_90: 0, tramo_mas_90: 0, total: 0 };
  const porTercero = new Map();

  for (const f of filas) {
    // Sin vencimiento, se cuenta desde que se emitió el documento: es
    // la única fecha que siempre existe.
    const referencia = f.fecha_vencimiento || f.fecha_emision;
    const dias = Math.max(0, Math.floor((Date.now() - new Date(referencia).getTime()) / 86400000));
    const clave = dias <= 30 ? 'tramo_0_30' : dias <= 60 ? 'tramo_31_60' : dias <= 90 ? 'tramo_61_90' : 'tramo_mas_90';
    const saldo = money(f.saldo);

    tramos[clave] = money(tramos[clave] + saldo);
    tramos.total = money(tramos.total + saldo);

    if (!porTercero.has(f.tercero)) {
      porTercero.set(f.tercero, { tercero: f.tercero, tramo_0_30: 0, tramo_31_60: 0, tramo_61_90: 0, tramo_mas_90: 0, total: 0 });
    }
    const fila = porTercero.get(f.tercero);
    fila[clave] = money(fila[clave] + saldo);
    fila.total = money(fila.total + saldo);
  }

  const detalle = [...porTercero.values()].sort((a, b) => b.total - a.total);

  const columnas = [
    { clave: 'tercero', titulo: tipo === 'pagar' ? 'Proveedor' : 'Cliente', ancho: 26 },
    { clave: 'tramo_0_30', titulo: '0 a 30 días', ancho: 14 },
    { clave: 'tramo_31_60', titulo: '31 a 60 días', ancho: 14 },
    { clave: 'tramo_61_90', titulo: '61 a 90 días', ancho: 14 },
    { clave: 'tramo_mas_90', titulo: 'Más de 90 días', ancho: 16 },
    { clave: 'total', titulo: 'Total adeudado', ancho: 16 },
  ];
  // Fila de cierre con el total general, para que el informe se lea
  // solo (sin tener que sumar a mano columna por columna).
  const filasExportar = [...detalle, { tercero: 'TOTAL', ...tramos }];

  if (await servirDescarga(req, res, {
    base: `antiguedad-cuentas-por-${tipo === 'pagar' ? 'pagar' : 'cobrar'}`,
    columnas,
    filas: filasExportar,
  })) {
    await auditar({
      modulo: 'contabilidad', accion: 'exportar', req, entidad: 'cuentas_terceros',
      descripcion: `Exportación de antigüedad de saldos (${tipo === 'pagar' ? 'por pagar' : 'por cobrar'})`,
    });
    return;
  }

  res.json({ tramos, detalle });
});

// ------------------------------------------------------------
//  POST / — alta de documento (factura, vale, contrato...)
// ------------------------------------------------------------
router.post('/', async (req, res) => {
  const b = req.body || {};
  const tipo = b.tipo;
  if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'El tipo debe ser "cobrar" o "pagar".' });

  const tercero = limpiar(b.tercero);
  if (!tercero) return res.status(400).json({ error: 'El cliente o proveedor es obligatorio.' });

  const monto = Number(b.monto);
  if (!Number.isFinite(monto) || monto <= 0) {
    return res.status(400).json({ error: 'El monto debe ser un número mayor que cero.' });
  }

  const moneda = limpiar(b.moneda) || 'CUP';
  const fechaEmision = limpiar(b.fecha_emision) || new Date().toISOString().slice(0, 10);

  const r = await db.prepare(`
    INSERT INTO cuentas_terceros
      (tipo, tercero, documento, concepto, monto, saldo, moneda, fecha_emision,
       fecha_vencimiento, estado, referencia_tipo, referencia_id, nota, usuario_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?)
  `).run(
    tipo, tercero, limpiar(b.documento), limpiar(b.concepto), monto, monto, moneda, fechaEmision,
    limpiar(b.fecha_vencimiento), limpiar(b.referencia_tipo), b.referencia_id ?? null,
    limpiar(b.nota), req.usuario?.id ?? null,
  );

  const fila = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(r.lastInsertRowid);

  await auditar({
    modulo: 'contabilidad', accion: 'crear', req, entidad: 'cuentas_terceros', entidad_id: r.lastInsertRowid,
    descripcion: `Alta de cuenta por ${tipo}: ${tercero} — ${monto} ${moneda}`,
    despues: fila,
  });

  res.json(fila);
});

// ------------------------------------------------------------
//  PUT /:id — edita datos del documento. El monto solo si no
//  tiene pagos (si ya cobró/pagó algo, cambiarlo desordena el
//  historial: hay que anular y volver a crear).
// ------------------------------------------------------------
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const antes = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(id);
  if (!antes) return res.status(404).json({ error: 'Documento no encontrado.' });

  if (antes.estado === 'anulada') {
    return res.status(400).json({ error: 'Este documento está anulado: no se puede editar.' });
  }
  if (antes.estado === 'pagada') {
    return res.status(400).json({ error: 'Este documento ya está pagado: no se puede editar.' });
  }

  const b = req.body || {};
  const tercero = 'tercero' in b ? limpiar(b.tercero) : antes.tercero;
  if (!tercero) return res.status(400).json({ error: 'El cliente o proveedor es obligatorio.' });

  const documento = 'documento' in b ? limpiar(b.documento) : antes.documento;
  const concepto = 'concepto' in b ? limpiar(b.concepto) : antes.concepto;
  const fechaVencimiento = 'fecha_vencimiento' in b ? limpiar(b.fecha_vencimiento) : antes.fecha_vencimiento;
  const nota = 'nota' in b ? limpiar(b.nota) : antes.nota;

  let monto = antes.monto;
  let saldo = antes.saldo;
  let estado = antes.estado;

  if ('monto' in b && b.monto != null && money(b.monto) !== money(antes.monto)) {
    const { total } = await db.prepare('SELECT COUNT(*) AS total FROM cuentas_pagos WHERE cuenta_id = ?').get(id);
    if (Number(total) > 0) {
      return res.status(400).json({
        error: 'Este documento ya tiene pagos registrados: no se puede cambiar el importe. Anule los pagos primero o anule el documento.',
      });
    }
    const nuevoMonto = Number(b.monto);
    if (!Number.isFinite(nuevoMonto) || nuevoMonto <= 0) {
      return res.status(400).json({ error: 'El monto debe ser un número mayor que cero.' });
    }
    monto = nuevoMonto;
    saldo = nuevoMonto; // sin pagos, el saldo es igual al monto entero
    estado = estadoSegunSaldo(saldo, false);
  }

  await db.prepare(`
    UPDATE cuentas_terceros
       SET tercero = ?, documento = ?, concepto = ?, fecha_vencimiento = ?, nota = ?,
           monto = ?, saldo = ?, estado = ?
     WHERE id = ?
  `).run(tercero, documento, concepto, fechaVencimiento, nota, monto, saldo, estado, id);

  const despues = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(id);

  await auditar({
    modulo: 'contabilidad', accion: 'modificar', req, entidad: 'cuentas_terceros', entidad_id: id,
    descripcion: `Cambio en documento de ${antes.tipo}: ${tercero}`,
    antes, despues,
  });

  res.json(despues);
});

// ------------------------------------------------------------
//  POST /:id/anular — nunca se borra un documento contable: lo que
//  desaparece de la base no se puede auditar. Anular deja el rastro
//  (con motivo) y el saldo en cero, pero el documento sigue existiendo.
// ------------------------------------------------------------
router.post('/:id/anular', async (req, res) => {
  const id = Number(req.params.id);
  const motivo = limpiar(req.body?.motivo);
  if (!motivo) return res.status(400).json({ error: 'Debe indicar el motivo de la anulación.' });

  const antes = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(id);
  if (!antes) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (antes.estado === 'anulada') return res.status(400).json({ error: 'Este documento ya está anulado.' });

  await db.prepare(`UPDATE cuentas_terceros SET estado = 'anulada', saldo = 0 WHERE id = ?`).run(id);
  const despues = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(id);

  await auditar({
    modulo: 'contabilidad', accion: 'cancelar', req, entidad: 'cuentas_terceros', entidad_id: id,
    descripcion: `Anulación de documento de ${antes.tipo}: ${antes.tercero}`,
    antes, despues, motivo,
  });

  res.json(despues);
});

// ------------------------------------------------------------
//  GET /:id/pagos — historial de pagos de UN documento
// ------------------------------------------------------------
router.get('/:id/pagos', async (req, res) => {
  const id = Number(req.params.id);
  const cuenta = await db.prepare('SELECT id FROM cuentas_terceros WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'Documento no encontrado.' });

  const filas = await db.prepare(`
    SELECT p.*, u.nombre AS usuario_nombre
      FROM cuentas_pagos p
      LEFT JOIN usuarios u ON u.id = p.usuario_id
     WHERE p.cuenta_id = ?
     ORDER BY p.fecha DESC, p.id DESC
  `).all(id);
  res.json(filas);
});

// ------------------------------------------------------------
//  POST /:id/pagos — registrar un cobro/pago. Todo dentro de una
//  transacción: si falla el recálculo de saldo, el pago tampoco
//  queda a medias insertado.
// ------------------------------------------------------------
router.post('/:id/pagos', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};

  const monto = Number(b.monto);
  if (!Number.isFinite(monto) || monto <= 0) {
    return res.status(400).json({ error: 'El monto del pago debe ser un número mayor que cero.' });
  }

  const cuenta = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'Documento no encontrado.' });
  if (cuenta.estado === 'anulada') return res.status(400).json({ error: 'Este documento está anulado: no admite pagos.' });
  if (cuenta.estado === 'pagada') return res.status(400).json({ error: 'Este documento ya está pagado por completo.' });

  if (money(monto) > money(cuenta.saldo)) {
    return res.status(400).json({
      error: `El pago (${money(monto)}) es mayor que lo que queda por pagar (${money(cuenta.saldo)}).`,
    });
  }

  const resultado = await db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO cuentas_pagos (cuenta_id, monto, fecha, metodo, referencia, nota, usuario_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, monto, limpiar(b.fecha) || new Date().toISOString().slice(0, 10),
      limpiar(b.metodo), limpiar(b.referencia), limpiar(b.nota), req.usuario?.id ?? null);

    const { pagado } = await db.prepare('SELECT COALESCE(SUM(monto),0) AS pagado FROM cuentas_pagos WHERE cuenta_id = ?').get(id);
    const nuevoSaldo = money(cuenta.monto - Number(pagado));
    const nuevoEstado = estadoSegunSaldo(nuevoSaldo, true);

    await db.prepare('UPDATE cuentas_terceros SET saldo = ?, estado = ? WHERE id = ?').run(nuevoSaldo, nuevoEstado, id);

    return { pagoId: r.lastInsertRowid, saldo: nuevoSaldo, estado: nuevoEstado };
  })();

  const cuentaDespues = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(id);
  const pago = await db.prepare('SELECT * FROM cuentas_pagos WHERE id = ?').get(resultado.pagoId);

  await auditar({
    modulo: 'contabilidad', accion: 'crear', req, entidad: 'cuentas_pagos', entidad_id: resultado.pagoId,
    descripcion: `Pago de ${monto} sobre documento #${id} (${cuenta.tercero})`,
    antes: { saldo: cuenta.saldo, estado: cuenta.estado },
    despues: { saldo: cuentaDespues.saldo, estado: cuentaDespues.estado },
  });

  if (resultado.estado === 'pagada') {
    await crearNotificacion({
      tipo: 'cuenta_saldada',
      titulo: `Documento saldado: ${cuenta.tercero}`,
      mensaje: `El documento ${cuenta.documento || '#' + id} quedó completamente pagado.`,
      severidad: 'info',
      destino_rol: 'contabilidad',
      referencia_tipo: 'cuentas_terceros',
      referencia_id: id,
    });
  }

  res.json({ pago, cuenta: cuentaDespues });
});

// ------------------------------------------------------------
//  DELETE /pagos/:id — deshacer un pago mal registrado. Recalcula
//  saldo y estado en la misma transacción del borrado.
// ------------------------------------------------------------
router.delete('/pagos/:id', async (req, res) => {
  const pagoId = Number(req.params.id);
  const motivo = limpiar(req.body?.motivo);
  if (!motivo) return res.status(400).json({ error: 'Debe indicar el motivo del borrado.' });

  const pago = await db.prepare('SELECT * FROM cuentas_pagos WHERE id = ?').get(pagoId);
  if (!pago) return res.status(404).json({ error: 'Pago no encontrado.' });

  const cuenta = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(pago.cuenta_id);
  if (!cuenta) return res.status(404).json({ error: 'El documento de este pago ya no existe.' });

  const resultado = await db.transaction(async () => {
    await db.prepare('DELETE FROM cuentas_pagos WHERE id = ?').run(pagoId);

    const { pagado } = await db.prepare('SELECT COALESCE(SUM(monto),0) AS pagado FROM cuentas_pagos WHERE cuenta_id = ?').get(cuenta.id);
    const tienePagos = Number(pagado) > 0;
    // Un documento anulado no vuelve a activarse solo porque se borre
    // un pago: sigue anulado, con saldo en cero.
    const nuevoSaldo = cuenta.estado === 'anulada' ? 0 : money(cuenta.monto - Number(pagado));
    const nuevoEstado = cuenta.estado === 'anulada' ? 'anulada' : estadoSegunSaldo(nuevoSaldo, tienePagos);

    await db.prepare('UPDATE cuentas_terceros SET saldo = ?, estado = ? WHERE id = ?').run(nuevoSaldo, nuevoEstado, cuenta.id);

    return { saldo: nuevoSaldo, estado: nuevoEstado };
  })();

  await auditar({
    modulo: 'contabilidad', accion: 'eliminar', req, entidad: 'cuentas_pagos', entidad_id: pagoId,
    descripcion: `Borrado de pago sobre documento #${cuenta.id} (${cuenta.tercero})`,
    antes: pago, motivo,
  });

  const cuentaDespues = await db.prepare('SELECT * FROM cuentas_terceros WHERE id = ?').get(cuenta.id);
  res.json({ borrado: true, cuenta: cuentaDespues });
});

export default router;
