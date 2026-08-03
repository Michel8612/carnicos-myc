// ============================================================
//  Conciliación de inventario — el conteo físico del almacén (§10)
//
//  Qué resuelve: lo que dice el sistema casi nunca coincide al 100%
//  con lo que hay en el estante (mermas, pesadas imprecisas, algo que
//  se movió sin anotar...). Este módulo deja CONTAR de verdad, comparar
//  contra el sistema, y decidir si se ajusta el inventario o si el
//  conteo queda solo como constancia.
//
//  El montaje en server.js ya trae requiereSesion (lectura libre para
//  cualquier sesión) y escrituraSoloRoles('almacen','almacenero',
//  'almacen_central') (escriben dueño/admin/proveedor + los tres roles
//  de almacén) — aquí no hace falta repetir ese control.
//
//  REGLA DURA: una conciliación 'cerrada' no se modifica ni se reabre.
//  Es el acta del conteo físico — el papel que alguien firmó dando fe
//  de lo que había en ese momento. Si se pudiera editar después, dejaría
//  de servir como prueba de nada (ni para el dueño, ni para el propio
//  almacenero si algún día hay que aclarar una diferencia). Por eso
//  PUT /lineas, /cerrar y /anular rechazan con 400 cualquier intento
//  sobre una conciliación que no esté 'abierta'.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';
import { crearNotificacion } from './notificaciones.js';
import { servirDescarga } from '../servicios/exportar.js';

const router = Router();

// Los pesos en kilos llegan con decimales largos (0.1 + 0.2 no da
// exacto en binario). Sin redondear, dos cantidades "iguales a simple
// vista" saldrían con una diferencia fantasma de 0.0000000001, y el
// conteo mostraría un descuadre que no existe. Redondeamos a 3
// decimales SIEMPRE antes de comparar o guardar (mismo criterio que ya
// usa moverExistencia() en inventario.js).
function redondear(n) {
  return Number(Number(n).toFixed(3));
}

// Recalcula la diferencia de una línea a partir de sus dos cantidades.
// Si no hay física todavía, no hay diferencia que mostrar (NULL, no 0:
// 0 significaría "se contó y coincide", que es una afirmación distinta
// de "todavía no se ha contado").
function calcularDiferencia(existenciaSistema, existenciaFisica) {
  if (existenciaFisica === null || existenciaFisica === undefined) return null;
  return redondear(existenciaFisica - existenciaSistema);
}

// ------------------------------------------------------------
//  GET / — historial de conteos
// ------------------------------------------------------------
router.get('/', async (req, res) => {
  const { estado, almacen_id } = req.query;
  const cond = [];
  const params = [];

  if (estado) { cond.push('c.estado = ?'); params.push(estado); }
  if (almacen_id) { cond.push('c.almacen_id = ?'); params.push(Number(almacen_id)); }

  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const filas = await db.prepare(`
    SELECT c.*, a.nombre AS almacen_nombre, u.nombre AS usuario_nombre,
           COUNT(l.id) AS lineas,
           COUNT(l.id) FILTER (WHERE l.diferencia IS NOT NULL AND l.diferencia <> 0) AS lineas_con_diferencia
    FROM conciliaciones c
    LEFT JOIN almacenes a ON a.id = c.almacen_id
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    LEFT JOIN conciliacion_lineas l ON l.conciliacion_id = c.id
    ${where}
    GROUP BY c.id, a.nombre, u.nombre
    ORDER BY c.creado_en DESC
  `).all(...params);

  res.json(filas);
});

// ------------------------------------------------------------
//  POST / — abrir un conteo nuevo
// ------------------------------------------------------------
router.post('/', async (req, res) => {
  const almacenId = Number(req.body?.almacen_id);
  const nota = (req.body?.nota ?? '').toString().trim() || null;
  if (!almacenId) return res.status(400).json({ error: 'Indique el almacén a contar.' });

  const almacen = await db.prepare('SELECT id, nombre FROM almacenes WHERE id = ?').get(almacenId);
  if (!almacen) return res.status(400).json({ error: 'El almacén indicado no existe.' });

  // Dos conteos abiertos a la vez sobre el MISMO almacén se pisarían:
  // cada uno ajustaría existencias contra una "foto" distinta, y al
  // cerrar el segundo se perdería o se duplicaría el ajuste del primero.
  // Por eso solo se permite uno abierto por almacén.
  const yaAbierto = await db.prepare(
    "SELECT id FROM conciliaciones WHERE almacen_id = ? AND estado = 'abierta'"
  ).get(almacenId);
  if (yaAbierto) {
    return res.status(400).json({
      error: 'Ya hay un conteo abierto en este almacén. Ciérrelo o anúlelo antes de abrir otro.',
    });
  }

  let conciliacionId = null;
  const tx = db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO conciliaciones (almacen_id, estado, nota, usuario_id)
      VALUES (?, 'abierta', ?, ?)
    `).run(almacenId, nota, req.usuario.id);
    conciliacionId = r.lastInsertRowid;

    // Una línea por cada producto activo con existencia en este almacén,
    // guardando en existencia_sistema la cantidad de ESTE instante: es la
    // foto contra la que se va a comparar. Si en vez de esto se leyera la
    // existencia al CERRAR el conteo, cualquier venta o movimiento hecho
    // mientras se cuenta (el conteo de un almacén grande puede tardar
    // horas) falsearía la diferencia — parecería que sobra o falta algo
    // que en realidad solo se vendió de forma normal mientras tanto.
    // OJO: no se filtra por cantidad > 0. Justo el error más caro de
    // detectar es el contrario — el sistema dice CERO pero en el
    // estante sí hay algo (una entrada que nunca se registró) —, así
    // que un producto con existencia en 0 en este almacén entra igual
    // al conteo. Lo que sí excluye es un producto que este almacén
    // nunca tuvo (sin fila en existencias): no hay nada que contar ahí.
    const existencias = await db.prepare(`
      SELECT e.producto_id, e.cantidad
      FROM existencias e
      JOIN productos p ON p.id = e.producto_id
      WHERE e.almacen_id = ? AND p.activo = 1
    `).all(almacenId);

    for (const ex of existencias) {
      await db.prepare(`
        INSERT INTO conciliacion_lineas (conciliacion_id, producto_id, existencia_sistema, existencia_fisica)
        VALUES (?, ?, ?, NULL)
      `).run(conciliacionId, ex.producto_id, redondear(ex.cantidad));
    }
  });

  try {
    await tx();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  await auditar({
    modulo: 'almacen', accion: 'crear', req, entidad: 'conciliaciones', entidad_id: conciliacionId,
    descripcion: `Conteo físico abierto en ${almacen.nombre}`,
  });

  const conteo = await obtenerConConLineas(conciliacionId);
  res.json(conteo);
});

// Cabecera + líneas de un conteo, con lo que hace falta para pintarlas
// (nombre de producto, unidad) ordenadas por nombre de producto.
async function obtenerConConLineas(id) {
  const cabecera = await db.prepare(`
    SELECT c.*, a.nombre AS almacen_nombre, u.nombre AS usuario_nombre
    FROM conciliaciones c
    LEFT JOIN almacenes a ON a.id = c.almacen_id
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE c.id = ?
  `).get(id);
  if (!cabecera) return null;

  const lineas = await db.prepare(`
    SELECT l.*, p.nombre AS producto_nombre, COALESCE(un.abreviatura,'') AS unidad
    FROM conciliacion_lineas l
    JOIN productos p ON p.id = l.producto_id
    LEFT JOIN unidades un ON un.id = p.unidad_id
    WHERE l.conciliacion_id = ?
    ORDER BY p.nombre
  `).all(id);

  return { ...cabecera, lineas };
}

// ------------------------------------------------------------
//  GET /:id — detalle (y exportación)
// ------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const conteo = await obtenerConConLineas(id);
  if (!conteo) return res.status(404).json({ error: 'Conteo no encontrado.' });

  const columnas = [
    { clave: 'producto_nombre', titulo: 'Producto' },
    { clave: 'unidad', titulo: 'Unidad' },
    { clave: 'existencia_sistema', titulo: 'Según el sistema' },
    { clave: 'existencia_fisica', titulo: 'Contado' },
    { clave: 'diferencia', titulo: 'Diferencia' },
    { clave: 'motivo', titulo: 'Motivo' },
  ];

  const exportado = await servirDescarga(req, res, {
    base: `conteo-fisico-${conteo.almacen_nombre || id}`,
    columnas,
    filas: conteo.lineas,
  });
  if (exportado) {
    // Deja constancia de quién se llevó el papel firmado y cuándo: es el
    // documento que respalda cualquier ajuste de inventario.
    await auditar({
      modulo: 'almacen', accion: 'exportar', req, entidad: 'conciliaciones', entidad_id: id,
      descripcion: `Exportación del conteo físico de ${conteo.almacen_nombre || 'almacén'}`,
    });
    return;
  }

  res.json(conteo);
});

// ------------------------------------------------------------
//  PUT /lineas/:id — anotar lo contado en una línea
// ------------------------------------------------------------
router.put('/lineas/:id', async (req, res) => {
  const id = Number(req.params.id);
  const linea = await db.prepare(`
    SELECT l.*, c.estado AS conciliacion_estado
    FROM conciliacion_lineas l
    JOIN conciliaciones c ON c.id = l.conciliacion_id
    WHERE l.id = ?
  `).get(id);
  if (!linea) return res.status(404).json({ error: 'Línea no encontrada.' });
  if (linea.conciliacion_estado !== 'abierta') {
    return res.status(400).json({ error: 'Este conteo ya está cerrado o anulado: no se puede modificar.' });
  }

  // Permite volver a poner la física en NULL (mandando null o cadena
  // vacía) para corregir un dedazo sin dejar un número inventado.
  const crudo = req.body?.existencia_fisica;
  let existenciaFisica = null;
  if (crudo !== null && crudo !== undefined && String(crudo).trim() !== '') {
    const n = Number(crudo);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'Lo contado debe ser un número mayor o igual que cero.' });
    }
    existenciaFisica = redondear(n);
  }

  const motivo = (req.body?.motivo ?? '').toString().trim() || null;
  const diferencia = calcularDiferencia(linea.existencia_sistema, existenciaFisica);

  await db.prepare(`
    UPDATE conciliacion_lineas SET existencia_fisica = ?, diferencia = ?, motivo = ? WHERE id = ?
  `).run(existenciaFisica, diferencia, motivo, id);

  const actualizada = await db.prepare(`
    SELECT l.*, p.nombre AS producto_nombre, COALESCE(un.abreviatura,'') AS unidad
    FROM conciliacion_lineas l
    JOIN productos p ON p.id = l.producto_id
    LEFT JOIN unidades un ON un.id = p.unidad_id
    WHERE l.id = ?
  `).get(id);

  res.json(actualizada);
});

// ------------------------------------------------------------
//  POST /:id/cerrar — cierra el conteo, con o sin ajustar existencias
// ------------------------------------------------------------
router.post('/:id/cerrar', async (req, res) => {
  const id = Number(req.params.id);
  const ajustar = !!req.body?.ajustar;

  let resultado;
  const tx = db.transaction(async () => {
    const conteo = await db.prepare('SELECT * FROM conciliaciones WHERE id = ?').get(id);
    if (!conteo) throw Object.assign(new Error('Conteo no encontrado.'), { status: 404 });
    if (conteo.estado !== 'abierta') {
      throw Object.assign(new Error('Este conteo ya está cerrado o anulado.'), { status: 400 });
    }

    const lineas = await db.prepare(`
      SELECT l.*, p.nombre AS producto_nombre
      FROM conciliacion_lineas l
      JOIN productos p ON p.id = l.producto_id
      WHERE l.conciliacion_id = ?
    `).all(id);

    let ajustadas = 0;
    const detalleDiferencias = [];

    for (const l of lineas) {
      if (l.existencia_fisica === null || l.existencia_fisica === undefined) continue;
      if (!l.diferencia || Number(l.diferencia) === 0) continue;

      detalleDiferencias.push(
        `${l.producto_nombre}: ${Number(l.diferencia) > 0 ? '+' : ''}${l.diferencia}`
      );

      if (ajustar) {
        // Las existencias pasan a ser las que se contaron de verdad.
        const fila = await db.prepare(
          'SELECT id FROM existencias WHERE producto_id = ? AND almacen_id = ?'
        ).get(l.producto_id, conteo.almacen_id);
        if (fila) {
          await db.prepare('UPDATE existencias SET cantidad = ? WHERE id = ?')
            .run(l.existencia_fisica, fila.id);
        } else {
          await db.prepare(
            'INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)'
          ).run(l.producto_id, conteo.almacen_id, l.existencia_fisica);
        }

        // El movimiento lleva la diferencia CON SU SIGNO (positiva si
        // sobró, negativa si faltó): así el historial cuenta en qué
        // sentido se corrigió, no solo que "algo cambió".
        await db.prepare(`
          INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, origen_id, usuario_id, nota)
          VALUES (?, ?, 'ajuste', ?, 'conciliacion', ?, ?, ?)
        `).run(
          l.producto_id, conteo.almacen_id, l.diferencia, id, req.usuario.id,
          `Ajuste por conteo físico #${id}${l.motivo ? ` — ${l.motivo}` : ''}`
        );
        ajustadas += 1;
      }
    }

    await db.prepare(`
      UPDATE conciliaciones SET estado = 'cerrada', cerrada_en = now() WHERE id = ?
    `).run(id);

    return { conteo, ajustadas, detalleDiferencias };
  });

  try {
    resultado = await tx();
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const { conteo, ajustadas, detalleDiferencias } = resultado;

  await auditar({
    modulo: 'almacen', accion: 'modificar', req, entidad: 'conciliaciones', entidad_id: id,
    descripcion: ajustar
      ? `Conteo cerrado ajustando existencias (${ajustadas} producto(s) corregido(s))`
      : `Conteo cerrado como constancia, sin tocar existencias (${detalleDiferencias.length} diferencia(s) detectada(s))`,
    despues: { ajustar, ajustadas, diferencias: detalleDiferencias },
  });

  if (detalleDiferencias.length > 0) {
    const resumen = `${detalleDiferencias.length} producto(s) no cuadraron en ${conteo.almacen_nombre || 'el almacén'}${ajustar ? ' (existencias ajustadas)' : ' (sin ajustar, solo constancia)'}.`;
    // Aviso operativo para el equipo de almacén: a ellos les toca revisar
    // por qué hubo diferencia.
    await crearNotificacion({
      tipo: 'conteo_con_diferencias',
      titulo: 'Conteo físico con diferencias',
      mensaje: resumen,
      severidad: 'aviso',
      destino_rol: 'almacen',
      referencia_tipo: 'conciliaciones',
      referencia_id: id,
    });
    // Y otro SIN destino_rol (nulo = lo ve todo el mundo, incluido el
    // dueño): el resultado de un conteo con descuadres le interesa a
    // quien dirige el negocio, no solo a quien lo hizo.
    await crearNotificacion({
      tipo: 'conteo_con_diferencias',
      titulo: 'Conteo físico con diferencias',
      mensaje: resumen,
      severidad: 'aviso',
      referencia_tipo: 'conciliaciones',
      referencia_id: id,
    });
  }

  res.json({ ok: true, ajustadas, diferencias: detalleDiferencias.length });
});

// ------------------------------------------------------------
//  POST /:id/anular — anula el conteo, sin tocar existencias
// ------------------------------------------------------------
router.post('/:id/anular', async (req, res) => {
  const id = Number(req.params.id);
  const motivo = (req.body?.motivo ?? '').toString().trim();
  if (!motivo) return res.status(400).json({ error: 'Indique el motivo de la anulación.' });

  const conteo = await db.prepare('SELECT * FROM conciliaciones WHERE id = ?').get(id);
  if (!conteo) return res.status(404).json({ error: 'Conteo no encontrado.' });
  if (conteo.estado !== 'abierta') {
    return res.status(400).json({ error: 'Este conteo ya está cerrado o anulado.' });
  }

  await db.prepare(`UPDATE conciliaciones SET estado = 'anulada' WHERE id = ?`).run(id);

  await auditar({
    modulo: 'almacen', accion: 'cancelar', req, entidad: 'conciliaciones', entidad_id: id,
    descripcion: 'Conteo físico anulado', motivo,
  });

  res.json({ ok: true });
});

export default router;
