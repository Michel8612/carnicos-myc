// ============================================================
//  Sincronización offline
//
//  Cada dispositivo trabaja con su copia local y apila los
//  cambios en una "cola". Cuando hay internet, envía la cola
//  aquí (subir) y pide las novedades de los demás (bajar).
//
//  Modelo seguro: los movimientos son hechos que se acumulan,
//  no números que se sobreescriben. Así dos personas sin
//  conexión nunca se pisan. Solo se avisa de choque cuando
//  se edita exactamente el mismo registro.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';
import { guardarIpvDiarioNucleo } from './ipv.js';

const router = Router();
router.use(requiereSesion);

// Cada cambio del dispositivo trae un id único propio (uuid)
// para no duplicarse si se reenvía. Guardamos los ya aplicados.
// No se usa 'await' a nivel de módulo (bloquearía la carga de
// server.js hasta tener conexión a la base): se lanza al cargar
// el archivo, igual que antes, y solo se avisa si falla.
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_aplicados (
    cambio_uuid TEXT PRIMARY KEY,
    aplicado_en TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`).catch((err) => console.error('Aviso: no se pudo crear sync_aplicados.', err.message));

// ---------- SUBIR: el dispositivo envía su cola ----------

router.post('/subir', async (req, res) => {
  const { cambios } = req.body;       // lista de cambios pendientes
  if (!Array.isArray(cambios)) {
    return res.status(400).json({ error: 'Formato de sincronización inválido.' });
  }

  const aceptados = [];
  const conflictos = [];

  for (const c of cambios) {
    // Si ya lo aplicamos antes (reenvío), lo damos por bueno sin repetir.
    const yaAplicado = await db.prepare('SELECT 1 FROM sync_aplicados WHERE cambio_uuid = ?').get(c.uuid);
    if (yaAplicado) { aceptados.push(c.uuid); continue; }

    try {
      const tx = db.transaction(async () => {
        if (c.tabla === 'movimientos') {
          // Hecho que se acumula: nunca choca.
          await db.prepare(`
            INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, fecha, nota)
            VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
          `).run(c.producto_id, c.almacen_id, c.tipo, c.cantidad, req.usuario.id, c.fecha, c.nota || null);
          await aplicarMovimientoAExistencias(c);
        } else if (c.tabla === 'caja') {
          await db.prepare(`
            INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, usuario_id, fecha)
            VALUES (?, ?, ?, ?, 'manual', ?, ?)
          `).run(c.tipo, c.concepto, c.monto, c.moneda, req.usuario.id, c.fecha);
        } else if (c.tabla === 'ipv_guardar') {
          // Cuadre diario hecho sin conexión en el teléfono. Se aplica
          // con las mismas reglas que el guardado normal: si el día ya
          // fue cerrado en la PC mientras tanto, se reporta como choque
          // (guardarIpvDiario lanza error) y el dueño decide.
          await guardarIpvDiarioNucleo(c);
        } else if (c.tabla === 'edicion') {
          // Edición de un registro existente: aquí SÍ puede haber choque.
          const actual = await db.prepare(`SELECT version FROM ${tablaSegura(c.objetivo)} WHERE id = ?`).get(c.registro_id);
          if (actual && c.version_base != null && actual.version !== c.version_base) {
            // El registro cambió desde que el dispositivo lo leyó: choque.
            throw { _conflicto: true };
          }
          // (la edición concreta se aplicaría aquí según el campo)
        }
        await db.prepare('INSERT INTO sync_aplicados (cambio_uuid) VALUES (?)').run(c.uuid);
      });
      await tx();
      aceptados.push(c.uuid);
    } catch (e) {
      if (e && e._conflicto) {
        conflictos.push({ uuid: c.uuid, motivo: 'El registro fue modificado por otra persona.' });
      } else {
        conflictos.push({ uuid: c.uuid, motivo: e?.message || 'No se pudo aplicar el cambio.' });
      }
    }
  }

  res.json({ aceptados, conflictos });
});

// ---------- BAJAR: el dispositivo pide novedades ----------

// Devuelve los movimientos y caja creados después de cierta marca de tiempo.
router.get('/bajar', async (req, res) => {
  const desde = req.query.desde || '1970-01-01';
  const movimientos = await db.prepare(
    'SELECT * FROM movimientos WHERE fecha > ? ORDER BY fecha'
  ).all(desde);
  const caja = await db.prepare(
    'SELECT * FROM caja WHERE fecha > ? ORDER BY fecha'
  ).all(desde);
  res.json({ servidor_hora: new Date().toISOString(), movimientos, caja });
});

// --- Auxiliares ---

async function aplicarMovimientoAExistencias(c) {
  const fila = await db.prepare(
    'SELECT id, cantidad FROM existencias WHERE producto_id = ? AND almacen_id = ?'
  ).get(c.producto_id, c.almacen_id);
  const delta = c.tipo === 'salida' ? -Number(c.cantidad) : Number(c.cantidad);
  if (fila) {
    await db.prepare('UPDATE existencias SET cantidad = cantidad + ? WHERE id = ?').run(delta, fila.id);
  } else {
    await db.prepare('INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)')
      .run(c.producto_id, c.almacen_id, delta);
  }
}

// Evita inyección: solo permite nombres de tabla conocidos.
function tablaSegura(nombre) {
  const permitidas = ['productos', 'caja', 'existencias'];
  if (!permitidas.includes(nombre)) throw new Error('Tabla no permitida.');
  return nombre;
}

export default router;
