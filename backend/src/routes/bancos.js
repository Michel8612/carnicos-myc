// ============================================================
//  Cuentas bancarias, movimientos y pasarelas de pago (§5)
//
//  El montaje en server.js ya trae requiereSesion (lectura libre
//  para cualquier sesión) y escrituraSoloRoles('contabilidad')
//  (escriben dueño/admin/proveedor + contabilidad) — aquí no hace
//  falta repetirlo.
//
//  QR: por instrucción expresa, el QR de cobro solo puede llevar
//  datos PÚBLICOS (banco, número/alias de cobro, moneda, titular).
//  Nunca claves, tokens ni credenciales. Ver construirPayloadQr().
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';
import { estadoPasarelas } from '../servicios/pagos.js';

const router = Router();

const ESTADOS_CUENTA = ['activa', 'inactiva'];
const USAR_EN_VALIDOS = ['ventas', 'compras', 'pagos', 'cobros'];

function formatearCuenta(fila) {
  if (!fila) return null;
  let usarEn = [];
  try { usarEn = fila.usar_en ? JSON.parse(fila.usar_en) : []; } catch { usarEn = []; }
  return { ...fila, usar_en: usarEn };
}

// El QR de cobro solo lleva lo que hace falta para que alguien le
// pague a esta cuenta: nunca nada sensible. Se guarda como texto: es
// la app oficial del banco (o el usuario, pegando la imagen) quien
// realmente lo convierte en una imagen QR — aquí no se genera ninguna
// codificación QR propia (ver informe: no se inventó un algoritmo QR).
function construirPayloadQr({ banco, alias, numero, moneda, titular }) {
  const partes = [
    `Banco: ${banco}`,
    alias ? `Alias de cobro: ${alias}` : `Cuenta: ${numero}`,
    `Moneda: ${moneda}`,
    titular ? `Titular: ${titular}` : null,
  ].filter(Boolean);
  return partes.join('\n');
}

function limpiar(v) {
  const s = (v ?? '').toString().trim();
  return s || null;
}

function usarEnValido(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => USAR_EN_VALIDOS.includes(v));
}

// ------------------------------------------------------------
//  Cuentas bancarias
// ------------------------------------------------------------

router.get('/cuentas', async (req, res) => {
  const filas = await db.prepare(`
    SELECT * FROM cuentas_bancarias ORDER BY estado ASC, banco ASC, alias ASC
  `).all();
  res.json(filas.map(formatearCuenta));
});

router.post('/cuentas', async (req, res) => {
  const b = req.body || {};
  const banco = limpiar(b.banco);
  const numero = limpiar(b.numero);
  if (!banco) return res.status(400).json({ error: 'El banco es obligatorio.' });
  if (!numero) return res.status(400).json({ error: 'El número de cuenta es obligatorio.' });

  const moneda = limpiar(b.moneda) || 'CUP';
  const alias = limpiar(b.alias);
  const titular = limpiar(b.titular);
  const usarEn = usarEnValido(b.usar_en);
  const qrDatos = limpiar(b.qr_datos) || construirPayloadQr({ banco, alias, numero, moneda, titular });
  const qrImagen = limpiar(b.qr_imagen);

  const r = await db.prepare(`
    INSERT INTO cuentas_bancarias (banco, numero, alias, titular, moneda, usar_en, qr_datos, qr_imagen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(banco, numero, alias, titular, moneda, JSON.stringify(usarEn), qrDatos, qrImagen);

  const fila = await db.prepare('SELECT * FROM cuentas_bancarias WHERE id = ?').get(r.lastInsertRowid);

  await auditar({
    modulo: 'bancos', accion: 'crear', req, entidad: 'cuentas_bancarias', entidad_id: r.lastInsertRowid,
    descripcion: `Alta de cuenta bancaria: ${banco} ${numero}`,
    despues: formatearCuenta(fila),
  });

  res.json(formatearCuenta(fila));
});

router.put('/cuentas/:id', async (req, res) => {
  const id = Number(req.params.id);
  const antes = await db.prepare('SELECT * FROM cuentas_bancarias WHERE id = ?').get(id);
  if (!antes) return res.status(404).json({ error: 'Cuenta no encontrada.' });

  const b = req.body || {};
  const banco = limpiar(b.banco) || antes.banco;
  const numero = limpiar(b.numero) || antes.numero;
  const moneda = limpiar(b.moneda) || antes.moneda;
  const alias = 'alias' in b ? limpiar(b.alias) : antes.alias;
  const titular = 'titular' in b ? limpiar(b.titular) : antes.titular;
  const usarEn = 'usar_en' in b ? usarEnValido(b.usar_en) : (() => { try { return JSON.parse(antes.usar_en || '[]'); } catch { return []; } })();
  const estado = 'estado' in b && ESTADOS_CUENTA.includes(b.estado) ? b.estado : antes.estado;
  const qrDatos = 'qr_datos' in b ? (limpiar(b.qr_datos) || construirPayloadQr({ banco, alias, numero, moneda, titular })) : antes.qr_datos;
  const qrImagen = 'qr_imagen' in b ? limpiar(b.qr_imagen) : antes.qr_imagen;

  await db.prepare(`
    UPDATE cuentas_bancarias
       SET banco = ?, numero = ?, alias = ?, titular = ?, moneda = ?,
           usar_en = ?, estado = ?, qr_datos = ?, qr_imagen = ?
     WHERE id = ?
  `).run(banco, numero, alias, titular, moneda, JSON.stringify(usarEn), estado, qrDatos, qrImagen, id);

  const despues = await db.prepare('SELECT * FROM cuentas_bancarias WHERE id = ?').get(id);

  await auditar({
    modulo: 'bancos', accion: 'modificar', req, entidad: 'cuentas_bancarias', entidad_id: id,
    descripcion: `Cambio en cuenta bancaria: ${banco} ${numero}`,
    antes: formatearCuenta(antes), despues: formatearCuenta(despues),
  });

  res.json(formatearCuenta(despues));
});

// Borrar una cuenta con movimientos rompería el historial contable:
// en vez de borrarla, se desactiva. Sin movimientos, sí se borra.
router.delete('/cuentas/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cuenta = await db.prepare('SELECT * FROM cuentas_bancarias WHERE id = ?').get(id);
  if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada.' });

  const { total } = await db.prepare('SELECT COUNT(*) AS total FROM movimientos_bancarios WHERE cuenta_id = ?').get(id);

  if (Number(total) > 0) {
    await db.prepare(`UPDATE cuentas_bancarias SET estado = 'inactiva' WHERE id = ?`).run(id);
    await auditar({
      modulo: 'bancos', accion: 'modificar', req, entidad: 'cuentas_bancarias', entidad_id: id,
      descripcion: `Cuenta ${cuenta.banco} ${cuenta.numero} desactivada (tiene ${total} movimiento(s): no se puede borrar sin perder historial)`,
      antes: formatearCuenta(cuenta), despues: { ...formatearCuenta(cuenta), estado: 'inactiva' },
    });
    return res.json({
      borrada: false,
      desactivada: true,
      mensaje: 'Esta cuenta tiene movimientos registrados, así que no se borró: se marcó como inactiva para conservar el historial contable.',
    });
  }

  await db.prepare('DELETE FROM cuentas_bancarias WHERE id = ?').run(id);
  await auditar({
    modulo: 'bancos', accion: 'eliminar', req, entidad: 'cuentas_bancarias', entidad_id: id,
    descripcion: `Baja de cuenta bancaria: ${cuenta.banco} ${cuenta.numero}`,
    antes: formatearCuenta(cuenta),
  });
  res.json({ borrada: true, desactivada: false });
});

// ------------------------------------------------------------
//  Movimientos bancarios
// ------------------------------------------------------------

router.get('/movimientos', async (req, res) => {
  const { cuenta_id, desde, hasta, estado } = req.query;
  const condiciones = [];
  const params = [];

  if (cuenta_id) { condiciones.push('m.cuenta_id = ?'); params.push(Number(cuenta_id)); }
  if (estado) { condiciones.push('m.estado = ?'); params.push(estado); }
  if (desde) { condiciones.push('m.fecha >= ?'); params.push(desde); }
  if (hasta) { condiciones.push('m.fecha <= ?'); params.push(`${hasta} 23:59:59`); }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const filas = await db.prepare(`
    SELECT m.*, c.banco AS cuenta_banco, c.alias AS cuenta_alias, c.numero AS cuenta_numero
      FROM movimientos_bancarios m
      JOIN cuentas_bancarias c ON c.id = m.cuenta_id
      ${where}
     ORDER BY m.fecha DESC, m.id DESC
  `).all(...params);

  res.json(filas);
});

router.post('/movimientos', async (req, res) => {
  const b = req.body || {};
  const cuentaId = Number(b.cuenta_id);
  if (!cuentaId) return res.status(400).json({ error: 'Debe indicar la cuenta bancaria.' });

  const cuenta = await db.prepare('SELECT id, moneda FROM cuentas_bancarias WHERE id = ?').get(cuentaId);
  if (!cuenta) return res.status(400).json({ error: 'La cuenta indicada no existe.' });

  if (!['ingreso', 'egreso'].includes(b.tipo)) {
    return res.status(400).json({ error: 'El tipo de movimiento debe ser "ingreso" o "egreso".' });
  }
  const monto = Number(b.monto);
  if (!Number.isFinite(monto) || monto <= 0) {
    return res.status(400).json({ error: 'El monto debe ser un número mayor que cero.' });
  }

  const moneda = limpiar(b.moneda) || cuenta.moneda || 'CUP';
  const fecha = limpiar(b.fecha) || new Date().toISOString();

  const r = await db.prepare(`
    INSERT INTO movimientos_bancarios
      (cuenta_id, fecha, tipo, monto, moneda, concepto, referencia, origen, usuario_id, nota)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
  `).run(cuentaId, fecha, b.tipo, monto, moneda, limpiar(b.concepto), limpiar(b.referencia), req.usuario?.id ?? null, limpiar(b.nota));

  const fila = await db.prepare('SELECT * FROM movimientos_bancarios WHERE id = ?').get(r.lastInsertRowid);

  await auditar({
    modulo: 'bancos', accion: 'crear', req, entidad: 'movimientos_bancarios', entidad_id: r.lastInsertRowid,
    descripcion: `Movimiento manual de ${b.tipo} por ${monto} ${moneda}`,
    despues: fila,
  });

  res.json(fila);
});

// Conciliar (asociar el movimiento a una venta/compra/gasto real) y
// desconciliar (deshacer esa asociación), en el mismo endpoint: el
// body decide cuál de las dos operaciones se hace.
router.post('/movimientos/:id/conciliar', async (req, res) => {
  const id = Number(req.params.id);
  const mov = await db.prepare('SELECT * FROM movimientos_bancarios WHERE id = ?').get(id);
  if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado.' });

  const b = req.body || {};

  if (b.desconciliar) {
    if (mov.estado !== 'conciliado') {
      return res.status(400).json({ error: 'Este movimiento no está conciliado.' });
    }
    await db.prepare(`
      UPDATE movimientos_bancarios
         SET estado = 'registrado', conciliado_tipo = NULL, conciliado_id = NULL, conciliado_en = NULL
       WHERE id = ?
    `).run(id);
    await auditar({
      modulo: 'bancos', accion: 'modificar', req, entidad: 'movimientos_bancarios', entidad_id: id,
      descripcion: 'Movimiento desconciliado', antes: mov,
    });
  } else {
    const conciliadoTipo = limpiar(b.conciliado_tipo);
    if (!conciliadoTipo) return res.status(400).json({ error: 'Debe indicar a qué se concilia el movimiento (conciliado_tipo).' });
    await db.prepare(`
      UPDATE movimientos_bancarios
         SET estado = 'conciliado', conciliado_tipo = ?, conciliado_id = ?, conciliado_en = NOW()
       WHERE id = ?
    `).run(conciliadoTipo, b.conciliado_id ?? null, id);
    await auditar({
      modulo: 'bancos', accion: 'modificar', req, entidad: 'movimientos_bancarios', entidad_id: id,
      descripcion: `Movimiento conciliado con ${conciliadoTipo}${b.conciliado_id ? ` #${b.conciliado_id}` : ''}`,
      antes: mov,
    });
  }

  const fila = await db.prepare('SELECT * FROM movimientos_bancarios WHERE id = ?').get(id);
  res.json(fila);
});

// ------------------------------------------------------------
//  Pasarelas de pago — estado de las integraciones (§6)
// ------------------------------------------------------------

router.get('/pasarelas', async (req, res) => {
  res.json(await estadoPasarelas());
});

export default router;
