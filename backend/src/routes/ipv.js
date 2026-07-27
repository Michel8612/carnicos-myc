// ============================================================
//  Reporte IPV — Informe de Producción y Ventas
//  (Inventario a Precio de Venta / cuadre diario)
//
//  Reconstruye, para una fecha y un almacén, el modelo cubano
//  clásico: por cada producto muestra
//     Existencia inicial + Entradas − Salidas = Existencia final
//  y el importe a precio de venta.
//
//  NO usa tablas nuevas: se calcula a partir de 'movimientos'
//  (el histórico de entradas/salidas) cruzado con 'productos'.
//  Así el cuadre siempre coincide con lo que el sistema ya
//  tiene registrado; no hay doble captura.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion);

// Normaliza una fecha 'YYYY-MM-DD'. Si no viene, usa hoy.
function diaValido(fecha) {
  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  return new Date().toISOString().slice(0, 10);
}

// ---------- IPV de un día ----------
//
// GET /api/ipv?fecha=YYYY-MM-DD&almacen_id=ID
//   almacen_id es opcional; si no viene, agrega todos.
//
router.get('/', async (req, res) => {
  const fecha = diaValido(req.query.fecha);
  const almacenId = req.query.almacen_id ? Number(req.query.almacen_id) : null;

  // El "inicio del día" y el "fin del día" en texto ISO, para
  // comparar contra movimientos.fecha (que es datetime('now')).
  const inicioDia = `${fecha} 00:00:00`;
  const finDia = `${fecha} 23:59:59`;

  // Filtro opcional por almacén (se inserta en cada consulta).
  const filtroAlm = almacenId ? 'AND m.almacen_id = ?' : '';

  // Sumas ANTES del día (existencia inicial) y DURANTE el día
  // (entradas y salidas), por producto. Todo se saca de
  // 'movimientos', que ya registra cada entrada/salida con su tipo.
  //
  // Convención de signos (según el schema):
  //   tipo 'entrada'  , 'produccion' (producto final)  -> suma
  //   tipo 'salida'   , 'ajuste' negativo              -> resta
  // Para el IPV separamos explícitamente entradas y salidas.

  async function sumaEntradas(desde, hasta) {
    const params = [desde, hasta];
    if (almacenId) params.push(almacenId);
    return db.prepare(`
      SELECT m.producto_id AS pid, COALESCE(SUM(m.cantidad),0) AS total
      FROM movimientos m
      WHERE m.tipo IN ('entrada','produccion')
        AND m.fecha >= ? AND m.fecha <= ?
        ${filtroAlm}
      GROUP BY m.producto_id
    `).all(...params);
  }

  async function sumaSalidas(desde, hasta) {
    const params = [desde, hasta];
    if (almacenId) params.push(almacenId);
    return db.prepare(`
      SELECT m.producto_id AS pid, COALESCE(SUM(m.cantidad),0) AS total
      FROM movimientos m
      WHERE m.tipo IN ('salida')
        AND m.fecha >= ? AND m.fecha <= ?
        ${filtroAlm}
      GROUP BY m.producto_id
    `).all(...params);
  }

  // Un mapa rápido producto_id -> cantidad.
  const aMapa = (filas) => {
    const m = {};
    for (const f of filas) m[f.pid] = f.total;
    return m;
  };

  // Movimientos históricos hasta el final del día ANTERIOR = existencia inicial.
  // (todo lo que entró menos todo lo que salió antes de este día)
  const entradasAntes = aMapa(await sumaEntradas('0000-01-01 00:00:00', inicioDia));
  const salidasAntes = aMapa(await sumaSalidas('0000-01-01 00:00:00', inicioDia));

  // Movimientos del propio día.
  const entradasHoy = aMapa(await sumaEntradas(inicioDia, finDia));
  const salidasHoy = aMapa(await sumaSalidas(inicioDia, finDia));

  // Catálogo de productos activos con su unidad y precio de venta.
  const productos = await db.prepare(`
    SELECT p.id, p.nombre, p.tipo, p.precio_venta,
           u.abreviatura AS unidad
    FROM productos p
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1
    ORDER BY p.nombre
  `).all();

  const filas = [];
  let totalImporte = 0;

  for (const p of productos) {
    const inicial = (entradasAntes[p.id] || 0) - (salidasAntes[p.id] || 0);
    const entradas = entradasHoy[p.id] || 0;
    const salidas = salidasHoy[p.id] || 0;
    const final = inicial + entradas - salidas;

    // El IPV no lista productos que nunca se movieron y están en cero.
    if (inicial === 0 && entradas === 0 && salidas === 0) continue;

    const importe = final * (p.precio_venta || 0);
    totalImporte += importe;

    filas.push({
      producto_id: p.id,
      producto: p.nombre,
      tipo: p.tipo,
      unidad: p.unidad || '',
      inicial: Number(inicial.toFixed(3)),
      entradas: Number(entradas.toFixed(3)),
      salidas: Number(salidas.toFixed(3)),
      final: Number(final.toFixed(3)),
      precio_venta: p.precio_venta || 0,
      importe: Number(importe.toFixed(2)),
    });
  }

  res.json({
    fecha,
    almacen_id: almacenId,
    generado: new Date().toISOString(),
    total_importe: Number(totalImporte.toFixed(2)),
    filas,
  });
});

// ============================================================
//  IPV DIARIO EDITABLE
//
//  Flujo:
//   GET  /ipv/diario?fecha=&almacen_id=  -> trae (o prepara) el IPV
//        del día, con lo anotado a mano + lo que el sistema calculó,
//        y la diferencia entre ambos.
//   POST /ipv/diario/guardar   -> guarda las líneas escritas a mano.
//   POST /ipv/diario/cerrar    -> cierra el día (candado).
//   POST /ipv/diario/correccion-> registra un cambio en un día cerrado.
// ============================================================

// Calcula, desde los movimientos del sistema, las cifras "reales"
// de un producto para una fecha/almacén (lo que el sistema sabe).
async function calcSistema(productoId, almacenId, fecha) {
  const inicioDia = `${fecha} 00:00:00`;
  const finDia = `${fecha} 23:59:59`;
  const filtroAlm = almacenId ? 'AND almacen_id = ?' : '';

  // Consultas directas: entradas/salidas antes del día (para la
  // existencia inicial) y durante el día.
  const entAntes = (await db.prepare(`SELECT COALESCE(SUM(cantidad),0) t FROM movimientos WHERE tipo IN ('entrada','produccion') AND producto_id=? AND fecha < ? ${filtroAlm}`).get(productoId, inicioDia, ...(almacenId?[almacenId]:[]))).t;
  const salAntes = (await db.prepare(`SELECT COALESCE(SUM(cantidad),0) t FROM movimientos WHERE tipo='salida' AND producto_id=? AND fecha < ? ${filtroAlm}`).get(productoId, inicioDia, ...(almacenId?[almacenId]:[]))).t;
  const entHoy = (await db.prepare(`SELECT COALESCE(SUM(cantidad),0) t FROM movimientos WHERE tipo IN ('entrada','produccion') AND producto_id=? AND fecha>=? AND fecha<=? ${filtroAlm}`).get(productoId, inicioDia, finDia, ...(almacenId?[almacenId]:[]))).t;
  const salHoy = (await db.prepare(`SELECT COALESCE(SUM(cantidad),0) t FROM movimientos WHERE tipo='salida' AND producto_id=? AND fecha>=? AND fecha<=? ${filtroAlm}`).get(productoId, inicioDia, finDia, ...(almacenId?[almacenId]:[]))).t;

  const inicial = entAntes - salAntes;
  return {
    inicial: Number(inicial.toFixed(3)),
    entradas: Number(entHoy.toFixed(3)),
    salidas: Number(salHoy.toFixed(3)),
    final: Number((inicial + entHoy - salHoy).toFixed(3)),
  };
}

// GET del IPV diario del día (lo crea en memoria si no existe aún).
router.get('/diario', async (req, res) => {
  const fecha = diaValido(req.query.fecha);
  const almacenId = req.query.almacen_id ? Number(req.query.almacen_id) : null;

  // ¿Ya existe un IPV guardado para este día/almacén?
  let cab = await db.prepare('SELECT * FROM ipv_diario WHERE fecha = ? AND almacen_id IS NOT DISTINCT FROM ?')
    .get(fecha, almacenId);

  // Líneas manuales ya guardadas (si las hay), indexadas por producto.
  const lineasGuardadas = {};
  if (cab) {
    for (const l of await db.prepare('SELECT * FROM ipv_diario_lineas WHERE ipv_id = ?').all(cab.id)) {
      lineasGuardadas[l.producto_id] = l;
    }
  }

  // Todos los productos activos.
  const productos = await db.prepare(`
    SELECT p.id, p.nombre, p.precio_venta, u.abreviatura AS unidad
    FROM productos p LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1 ORDER BY p.nombre
  `).all();

  const filas = [];
  for (const p of productos) {
    const g = lineasGuardadas[p.id];
    // manual: lo guardado, o vacío si nunca se llenó
    const inicial_manual = g ? g.inicial_manual : '';
    const entradas_manual = g ? g.entradas_manual : '';
    const salidas_manual = g ? g.salidas_manual : '';
    const precio = g ? g.precio : (p.precio_venta || 0);
    // sistema: lo que el sistema calculó por su cuenta
    const sis = await calcSistema(p.id, almacenId, fecha);
    // final manual (si hay datos escritos)
    const finalManual = (inicial_manual === '' && entradas_manual === '' && salidas_manual === '')
      ? null
      : Number(((+inicial_manual||0) + (+entradas_manual||0) - (+salidas_manual||0)).toFixed(3));
    filas.push({
      producto_id: p.id, producto: p.nombre, unidad: p.unidad || '',
      inicial_manual, entradas_manual, salidas_manual, precio,
      final_manual: finalManual,
      sistema: sis,
      // diferencia entre el conteo a mano y lo que dice el sistema
      diferencia: finalManual === null ? null : Number((finalManual - sis.final).toFixed(3)),
    });
  }

  res.json({
    fecha,
    almacen_id: almacenId,
    estado: cab ? cab.estado : 'nuevo',
    nota: cab ? cab.nota : '',
    filas,
  });
});

// Guardar (crear o actualizar) las líneas escritas a mano.
// Núcleo del guardado del IPV, SIN transacción propia: así puede
// llamarse tanto desde el endpoint normal (que le pone transacción)
// como desde la sincronización offline (que ya viene dentro de una,
// y SQLite no permite transacciones anidadas).
export async function guardarIpvDiarioNucleo({ fecha, almacen_id, nota, lineas }) {
  if (!fecha) throw new Error('Falta la fecha.');
  const almacenId = almacen_id ? Number(almacen_id) : null;

  let cab = await db.prepare('SELECT * FROM ipv_diario WHERE fecha = ? AND almacen_id IS NOT DISTINCT FROM ?')
    .get(fecha, almacenId);
  if (cab && cab.estado === 'cerrado') {
    throw new Error('Este IPV ya está cerrado. Use "corrección" para cambiarlo.');
  }
  if (!cab) {
    const r = await db.prepare('INSERT INTO ipv_diario (fecha, almacen_id, nota) VALUES (?, ?, ?)')
      .run(fecha, almacenId, nota || null);
    cab = { id: r.lastInsertRowid };
  } else {
    await db.prepare('UPDATE ipv_diario SET nota = ? WHERE id = ?').run(nota || null, cab.id);
    await db.prepare('DELETE FROM ipv_diario_lineas WHERE ipv_id = ?').run(cab.id);
  }
  for (const l of (lineas || [])) {
    // Solo guardar líneas con algún dato escrito.
    if (l.inicial_manual === '' && l.entradas_manual === '' && l.salidas_manual === '') continue;
    await db.prepare(`
      INSERT INTO ipv_diario_lineas
        (ipv_id, producto_id, inicial_manual, entradas_manual, salidas_manual, precio)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(cab.id, l.producto_id, +l.inicial_manual||0, +l.entradas_manual||0, +l.salidas_manual||0, +l.precio||0);
  }
  return cab.id;
}

// Versión con transacción propia (la usa el endpoint normal).
export async function guardarIpvDiario(datos) {
  const tx = db.transaction(async () => guardarIpvDiarioNucleo(datos));
  return tx();
}

router.post('/diario/guardar', async (req, res) => {
  try {
    const id = await guardarIpvDiario(req.body);
    res.json({ ok: true, ipv_id: id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cerrar el día (candado).
router.post('/diario/cerrar', async (req, res) => {
  const { fecha, almacen_id } = req.body;
  const almacenId = almacen_id ? Number(almacen_id) : null;
  const cab = await db.prepare('SELECT * FROM ipv_diario WHERE fecha = ? AND almacen_id IS NOT DISTINCT FROM ?')
    .get(fecha, almacenId);
  if (!cab) return res.status(400).json({ error: 'No hay IPV guardado para cerrar. Guarde primero.' });
  if (cab.estado === 'cerrado') return res.status(400).json({ error: 'Ya estaba cerrado.' });
  await db.prepare(`UPDATE ipv_diario SET estado='cerrado', cerrado_en=now(), cerrado_por=? WHERE id=?`)
    .run(req.usuario.id, cab.id);
  res.json({ ok: true });
});

// Registrar una corrección sobre un IPV ya cerrado (auditoría).
router.post('/diario/correccion', async (req, res) => {
  const { fecha, almacen_id, descripcion } = req.body;
  if (!descripcion) return res.status(400).json({ error: 'Describa la corrección.' });
  const almacenId = almacen_id ? Number(almacen_id) : null;
  const cab = await db.prepare('SELECT * FROM ipv_diario WHERE fecha = ? AND almacen_id IS NOT DISTINCT FROM ?')
    .get(fecha, almacenId);
  if (!cab) return res.status(400).json({ error: 'No existe ese IPV.' });
  await db.prepare('INSERT INTO ipv_correcciones (ipv_id, usuario_id, descripcion) VALUES (?, ?, ?)')
    .run(cab.id, req.usuario.id, descripcion);
  // Reabrir para editar, dejando rastro de la corrección.
  await db.prepare(`UPDATE ipv_diario SET estado='abierto' WHERE id=?`).run(cab.id);
  res.json({ ok: true });
});

export default router;
