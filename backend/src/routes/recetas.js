// ============================================================
//  RECETAS DE PRODUCCIÓN
//
//  Una receta = producto terminado + lista de ingredientes.
//  Producir con una receta:
//    - escala los ingredientes por el factor pedido
//    - descuenta cada ingrediente del inventario (avisa si falta,
//      pero permite y deja el stock en negativo)
//    - suma el producto terminado al inventario
//    - calcula el costo real (suma del costo de los ingredientes)
//    - registra fecha, cantidades y consumo detallado
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';

const router = Router();
router.use(requiereSesion);

// ---------- LISTAR recetas (todas, o de un producto) ----------
router.get('/', async (req, res) => {
  const productoId = req.query.producto_id ? Number(req.query.producto_id) : null;
  const filtro = productoId ? 'WHERE r.producto_final_id = ? AND r.activa = 1' : 'WHERE r.activa = 1';
  const params = productoId ? [productoId] : [];
  const recetas = await db.prepare(`
    SELECT r.*, p.nombre AS producto_nombre, u.abreviatura AS unidad
    FROM recetas r
    JOIN productos p ON p.id = r.producto_final_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    ${filtro}
    ORDER BY p.nombre, r.nombre
  `).all(...params);

  // adjuntar ingredientes a cada receta
  for (const r of recetas) {
    r.ingredientes = await db.prepare(`
      SELECT ri.*, p.nombre AS producto_nombre, p.precio_costo,
             u.abreviatura AS unidad
      FROM receta_ingredientes ri
      JOIN productos p ON p.id = ri.producto_id
      LEFT JOIN unidades u ON u.id = p.unidad_id
      WHERE ri.receta_id = ?
    `).all(r.id);
  }
  res.json(recetas);
});

// El producto terminado de una receta es la PROPIA receta: se llama igual.
// Esta función busca un producto "terminado" con ese nombre y, si no existe,
// lo crea (con la unidad del rinde: lb/g/kg). Así el usuario NO tiene que
// elegir el producto final: escribe el nombre de la receta y ya.
async function resolverProductoFinal(nombre, rindeUnidad) {
  const existente = await db.prepare(
    "SELECT id FROM productos WHERE lower(nombre) = lower(?) AND tipo = 'terminado' AND activo = 1"
  ).get(nombre);
  if (existente) return existente.id;
  const uni = await db.prepare('SELECT id FROM unidades WHERE abreviatura = ?').get(rindeUnidad || 'lb');
  const nuevo = await db.prepare(
    'INSERT INTO productos (nombre, tipo, unidad_id) VALUES (?, ?, ?)'
  ).run(nombre, 'terminado', uni ? uni.id : null);
  return nuevo.lastInsertRowid;
}

// ---------- CREAR receta ----------
router.post('/', async (req, res) => {
  let { producto_final_id, nombre, rinde_cantidad, rinde_unidad, ingredientes } = req.body;
  if (!nombre) {
    return res.status(400).json({ error: 'Escriba el nombre de la receta.' });
  }
  if (!ingredientes || ingredientes.length === 0) {
    return res.status(400).json({ error: 'La receta necesita al menos un componente.' });
  }
  const tx = db.transaction(async () => {
    // Si no vino un producto final, se resuelve/crea con el nombre de la receta.
    const finalId = producto_final_id || (await resolverProductoFinal(nombre, rinde_unidad));
    const r = await db.prepare(`
      INSERT INTO recetas (producto_final_id, nombre, rinde_cantidad, rinde_unidad, usuario_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(finalId, nombre, rinde_cantidad || 1, rinde_unidad || 'lb', req.usuario.id);
    const recetaId = r.lastInsertRowid;
    for (const ing of ingredientes) {
      if (!ing.producto_id || !ing.cantidad) continue;
      await db.prepare('INSERT INTO receta_ingredientes (receta_id, producto_id, cantidad) VALUES (?, ?, ?)')
        .run(recetaId, ing.producto_id, Number(ing.cantidad));
    }
    return recetaId;
  });
  res.json({ id: await tx() });
});

// ---------- EDITAR receta ----------
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, rinde_cantidad, rinde_unidad, ingredientes } = req.body;
  const tx = db.transaction(async () => {
    // Traer la receta para conocer su producto final actual.
    const actual = await db.prepare('SELECT producto_final_id FROM recetas WHERE id = ?').get(id);
    await db.prepare('UPDATE recetas SET nombre = ?, rinde_cantidad = ?, rinde_unidad = ? WHERE id = ?')
      .run(nombre, rinde_cantidad || 1, rinde_unidad || 'lb', id);
    // Mantener sincronizado el nombre del producto terminado con la receta.
    if (actual && actual.producto_final_id && nombre) {
      await db.prepare("UPDATE productos SET nombre = ? WHERE id = ? AND tipo = 'terminado'")
        .run(nombre, actual.producto_final_id);
    }
    await db.prepare('DELETE FROM receta_ingredientes WHERE receta_id = ?').run(id);
    for (const ing of (ingredientes || [])) {
      if (!ing.producto_id || !ing.cantidad) continue;
      await db.prepare('INSERT INTO receta_ingredientes (receta_id, producto_id, cantidad) VALUES (?, ?, ?)')
        .run(id, ing.producto_id, Number(ing.cantidad));
    }
  });
  await tx();
  res.json({ ok: true });
});

// ---------- ELIMINAR (desactivar) receta ----------
router.delete('/:id', async (req, res) => {
  await db.prepare('UPDATE recetas SET activa = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- VISTA PREVIA de producción ----------
// Dado una receta y un factor, muestra qué se va a consumir y si
// alcanza el inventario, SIN producir todavía.
router.get('/:id/previa', async (req, res) => {
  const id = Number(req.params.id);
  const factor = Number(req.query.factor) || 1;
  const almacenId = req.query.almacen_id ? Number(req.query.almacen_id) : null;

  const receta = await db.prepare('SELECT * FROM recetas WHERE id = ?').get(id);
  if (!receta) return res.status(404).json({ error: 'Receta no encontrada.' });

  const ingredientes = await db.prepare(`
    SELECT ri.*, p.nombre AS producto_nombre, p.precio_costo, u.abreviatura AS unidad
    FROM receta_ingredientes ri
    JOIN productos p ON p.id = ri.producto_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE ri.receta_id = ?
  `).all(id);

  let costoTotal = 0;
  const filas = [];
  for (const ing of ingredientes) {
    const necesita = Number((ing.cantidad * factor).toFixed(3));
    // stock disponible en el almacén (o total)
    const stockRow = almacenId
      ? await db.prepare('SELECT COALESCE(SUM(cantidad),0) t FROM existencias WHERE producto_id=? AND almacen_id=?').get(ing.producto_id, almacenId)
      : await db.prepare('SELECT COALESCE(SUM(cantidad),0) t FROM existencias WHERE producto_id=?').get(ing.producto_id);
    const disponible = stockRow.t;
    const precioCosto = ing.precio_costo || 0;
    const costo = Number((necesita * precioCosto).toFixed(2));
    costoTotal += costo;
    filas.push({
      producto_id: ing.producto_id,
      producto: ing.producto_nombre,
      unidad: ing.unidad || '',
      necesita, disponible,
      alcanza: disponible >= necesita,
      falta: disponible >= necesita ? 0 : Number((necesita - disponible).toFixed(3)),
      costo,
      // Si el ingrediente no tiene precio de costo, su aporte al costo
      // es 0 y el costo total queda INFLADO a la baja (parece más barato
      // de lo que es). Lo marcamos para avisarle al usuario.
      sin_costo: precioCosto <= 0,
    });
  }

  res.json({
    receta_id: id,
    rinde: Number((receta.rinde_cantidad * factor).toFixed(3)),
    factor,
    costo_total: Number(costoTotal.toFixed(2)),
    ingredientes: filas,
    hay_faltantes: filas.some((f) => !f.alcanza),
    hay_sin_costo: filas.some((f) => f.sin_costo),
  });
});

// ---------- PRODUCIR ----------
// Ejecuta la producción: descuenta ingredientes, suma terminado,
// calcula costo, registra. Avisa faltantes pero PERMITE (negativo).
router.post('/:id/producir', async (req, res) => {
  const id = Number(req.params.id);
  const factor = Number(req.body.factor) || 1;
  const almacenId = req.body.almacen_id ? Number(req.body.almacen_id) : null;
  const nota = req.body.nota || null;

  const receta = await db.prepare('SELECT * FROM recetas WHERE id = ?').get(id);
  if (!receta) return res.status(404).json({ error: 'Receta no encontrada.' });
  if (!almacenId) return res.status(400).json({ error: 'Indique el almacén de producción.' });

  const ingredientes = await db.prepare(`
    SELECT ri.*, p.nombre AS producto_nombre, p.precio_costo
    FROM receta_ingredientes ri
    JOIN productos p ON p.id = ri.producto_id
    WHERE ri.receta_id = ?
  `).all(id);
  if (ingredientes.length === 0) {
    return res.status(400).json({ error: 'La receta no tiene ingredientes.' });
  }

  const cantidadProducida = Number((receta.rinde_cantidad * factor).toFixed(3));
  const avisos = [];

  const tx = db.transaction(async () => {
    let costoTotal = 0;

    // 1) Descontar cada ingrediente
    for (const ing of ingredientes) {
      const necesita = Number((ing.cantidad * factor).toFixed(3));
      const costoUnit = ing.precio_costo || 0;
      const costo = Number((necesita * costoUnit).toFixed(2));
      costoTotal += costo;

      // existencia en ese almacén (crea la fila si no existe)
      let ex = await db.prepare('SELECT id, cantidad FROM existencias WHERE producto_id=? AND almacen_id=?')
        .get(ing.producto_id, almacenId);
      if (!ex) {
        const r = await db.prepare('INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, 0)')
          .run(ing.producto_id, almacenId);
        ex = { id: r.lastInsertRowid, cantidad: 0 };
      }
      if (ex.cantidad < necesita) {
        avisos.push(`${ing.producto_nombre}: faltan ${Number((necesita - ex.cantidad).toFixed(3))} (quedó en negativo)`);
      }
      // descontar (permite negativo, como pediste)
      await db.prepare('UPDATE existencias SET cantidad = cantidad - ? WHERE id = ?').run(necesita, ex.id);
      await db.prepare(`
        INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
        VALUES (?, ?, 'salida', ?, 'produccion', ?, 'Consumo en producción')
      `).run(ing.producto_id, almacenId, necesita, req.usuario.id);
    }

    // 2) Sumar el producto terminado
    let exFinal = await db.prepare('SELECT id FROM existencias WHERE producto_id=? AND almacen_id=?')
      .get(receta.producto_final_id, almacenId);
    if (!exFinal) {
      await db.prepare('INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)')
        .run(receta.producto_final_id, almacenId, cantidadProducida);
    } else {
      await db.prepare('UPDATE existencias SET cantidad = cantidad + ? WHERE id = ?')
        .run(cantidadProducida, exFinal.id);
    }
    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
      VALUES (?, ?, 'produccion', ?, 'produccion', ?, 'Producto terminado')
    `).run(receta.producto_final_id, almacenId, cantidadProducida, req.usuario.id);

    // 3) Registrar la producción
    const prod = await db.prepare(`
      INSERT INTO producciones
        (receta_id, producto_final_id, cantidad_producida, factor_escala, costo_total, almacen_id, usuario_id, nota)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, receta.producto_final_id, cantidadProducida, factor, Number(costoTotal.toFixed(2)), almacenId, req.usuario.id, nota);
    const prodId = prod.lastInsertRowid;

    // 4) Detalle de consumo
    for (const ing of ingredientes) {
      const necesita = Number((ing.cantidad * factor).toFixed(3));
      const costoUnit = ing.precio_costo || 0;
      await db.prepare(`
        INSERT INTO produccion_consumo (produccion_id, producto_id, cantidad, costo_unitario, costo)
        VALUES (?, ?, ?, ?, ?)
      `).run(prodId, ing.producto_id, necesita, costoUnit, Number((necesita * costoUnit).toFixed(2)));
    }

    // 5) Actualizar el costo del producto terminado (costo por unidad)
    if (cantidadProducida > 0) {
      const costoUnitFinal = Number((costoTotal / cantidadProducida).toFixed(4));
      await db.prepare('UPDATE productos SET precio_costo = ? WHERE id = ?')
        .run(costoUnitFinal, receta.producto_final_id);
    }

    return { prodId, costoTotal: Number(costoTotal.toFixed(2)) };
  });

  const resultado = await tx();
  res.json({
    ok: true,
    produccion_id: resultado.prodId,
    cantidad_producida: cantidadProducida,
    costo_total: resultado.costoTotal,
    costo_unitario: cantidadProducida > 0 ? Number((resultado.costoTotal / cantidadProducida).toFixed(4)) : 0,
    avisos,
  });
});

// ---------- HISTORIAL de producciones ----------
router.get('/historial/lista', async (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0, 7);
  const producciones = await db.prepare(`
    SELECT pr.*, p.nombre AS producto_nombre, r.nombre AS receta_nombre,
           u.abreviatura AS unidad, a.nombre AS almacen_nombre
    FROM producciones pr
    JOIN productos p ON p.id = pr.producto_final_id
    LEFT JOIN recetas r ON r.id = pr.receta_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    LEFT JOIN almacenes a ON a.id = pr.almacen_id
    WHERE to_char(pr.fecha, 'YYYY-MM') = ?
    ORDER BY pr.fecha DESC
  `).all(mes);

  for (const pr of producciones) {
    pr.consumo = await db.prepare(`
      SELECT pc.*, p.nombre AS producto_nombre, u.abreviatura AS unidad
      FROM produccion_consumo pc
      JOIN productos p ON p.id = pc.producto_id
      LEFT JOIN unidades u ON u.id = p.unidad_id
      WHERE pc.produccion_id = ?
    `).all(pr.id);
  }
  res.json(producciones);
});

export default router;
