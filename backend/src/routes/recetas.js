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
import { anotar } from '../libro.js';

const router = Router();
router.use(requiereSesion);

// Quién puede crear/editar/borrar recetas y registrar producción (cocina).
// El router se monta con permiso de escritura ampliado a 'almacen' (para
// poder llamar /disponibles/:id/al-almacen más abajo), así que aquí se
// filtra fino: esas rutas de cocina siguen siendo solo para cocinero/dueño.
const ES_COCINA = (rol) => ['cocinero', 'dueno', 'admin', 'proveedor'].includes(rol);
// Quién puede dar entrada al almacén de lo producido.
const ES_ALMACEN_O_DUENO = (rol) =>
  ['almacen', 'almacenero', 'dueno', 'admin', 'proveedor'].includes(rol);

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

// ---------- CREAR UN COMPONENTE desde el área de recetas ----------
// El cocinero necesita poder anotar lo que lleva una receta (azúcar, sal,
// sal de nitro…) AUNQUE el almacenero todavía no lo haya registrado: las
// recetas son del área de cocina y no dependen del almacén. Aquí se crea
// el componente como materia prima, con existencia cero; cuando el
// almacenero lo reciba, le dará entrada desde su área.
router.post('/componente', async (req, res) => {
  if (!ES_COCINA(req.usuario.rol)) {
    return res.status(403).json({ error: 'Esta acción es solo para cocina.' });
  }
  const { nombre, unidad, precio_costo } = req.body;
  if (!nombre || !String(nombre).trim()) {
    return res.status(400).json({ error: 'Escriba el nombre del componente.' });
  }
  const limpio = String(nombre).trim();

  // Si ya existe uno con ese nombre, se reutiliza (no se duplica).
  const existente = await db.prepare(
    'SELECT id, nombre FROM productos WHERE lower(nombre) = lower(?) AND activo = 1'
  ).get(limpio);
  if (existente) return res.json({ id: existente.id, nombre: existente.nombre, ya_existia: true });

  const uni = await db.prepare('SELECT id FROM unidades WHERE abreviatura = ?').get(unidad || 'lb');
  const r = await db.prepare(
    'INSERT INTO productos (nombre, tipo, unidad_id, precio_costo) VALUES (?, ?, ?, ?)'
  ).run(limpio, 'materia_prima', uni ? uni.id : null, Number(precio_costo) || 0);
  res.json({ id: r.lastInsertRowid, nombre: limpio, ya_existia: false });
});

// ---------- CREAR receta ----------
router.post('/', async (req, res) => {
  if (!ES_COCINA(req.usuario.rol)) {
    return res.status(403).json({ error: 'Esta acción es solo para cocina.' });
  }
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
  if (!ES_COCINA(req.usuario.rol)) {
    return res.status(403).json({ error: 'Esta acción es solo para cocina.' });
  }
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
  if (!ES_COCINA(req.usuario.rol)) {
    return res.status(403).json({ error: 'Esta acción es solo para cocina.' });
  }
  await db.prepare('UPDATE recetas SET activa = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- VISTA PREVIA de producción ----------
// Traduce lo que pide el usuario a un "factor" (veces la receta base).
// Acepta cantidad_final (libras/kg de producto terminado que quiere) o
// factor directo. Si no viene nada, es una vez la receta.
function factorDesde(fuente, receta) {
  const cantidadFinal = Number(fuente.cantidad_final);
  if (cantidadFinal > 0 && receta.rinde_cantidad > 0) {
    return cantidadFinal / receta.rinde_cantidad;
  }
  return Number(fuente.factor) || 1;
}

// Dado una receta y cuánto se quiere producir, muestra qué se va a
// consumir y si alcanza el inventario, SIN producir todavía.
router.get('/:id/previa', async (req, res) => {
  const id = Number(req.params.id);
  const almacenId = req.query.almacen_id ? Number(req.query.almacen_id) : null;

  const receta = await db.prepare('SELECT * FROM recetas WHERE id = ?').get(id);
  if (!receta) return res.status(404).json({ error: 'Receta no encontrada.' });

  // Se puede pedir por CANTIDAD FINAL (ej. "quiero 50 lb de jamón") o por
  // factor (veces la receta base). La cantidad final es lo natural para el
  // usuario; aquí se traduce a factor sobre el rinde de la receta.
  const factor = factorDesde(req.query, receta);

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

// ---------- REGISTRAR PRODUCCIÓN (cocina) ----------
// La cocina y el almacén llevan contabilidades SEPARADAS: aquí se
// registra qué se produjo, qué consumió y cuánto costó (queda en el
// historial de cocina y en los reportes), pero NO se tocan las
// existencias del almacén. El almacenero descarga su inventario aparte.
router.post('/:id/producir', async (req, res) => {
  if (!ES_COCINA(req.usuario.rol)) {
    return res.status(403).json({ error: 'Esta acción es solo para cocina.' });
  }
  const id = Number(req.params.id);
  const almacenId = req.body.almacen_id ? Number(req.body.almacen_id) : null;
  const nota = req.body.nota || null;

  const receta = await db.prepare('SELECT * FROM recetas WHERE id = ?').get(id);
  if (!receta) return res.status(404).json({ error: 'Receta no encontrada.' });
  if (!almacenId) return res.status(400).json({ error: 'Indique el almacén de producción.' });

  // Cuánto se va a producir: por cantidad final (lb/kg) o por factor.
  const factor = factorDesde(req.body, receta);

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

    // 1) Calcular el consumo y su costo. Se AVISA si el almacén no tiene
    //    suficiente, pero NO se descuenta nada: el almacén es otra
    //    contabilidad y se descarga por su propia sección.
    for (const ing of ingredientes) {
      const necesita = Number((ing.cantidad * factor).toFixed(3));
      const costoUnit = ing.precio_costo || 0;
      costoTotal += Number((necesita * costoUnit).toFixed(2));

      const ex = await db.prepare('SELECT cantidad FROM existencias WHERE producto_id=? AND almacen_id=?')
        .get(ing.producto_id, almacenId);
      const hay = ex ? ex.cantidad : 0;
      if (hay < necesita) {
        avisos.push(`${ing.producto_nombre}: en almacén hay ${hay} y hacen falta ${necesita}`);
      }
    }

    // 2) Registrar la producción (historial de cocina)
    const prod = await db.prepare(`
      INSERT INTO producciones
        (receta_id, producto_final_id, cantidad_producida, factor_escala, costo_total, almacen_id, usuario_id, nota)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, receta.producto_final_id, cantidadProducida, factor, Number(costoTotal.toFixed(2)), almacenId, req.usuario.id, nota);
    const prodId = prod.lastInsertRowid;

    // 3) Detalle de consumo (qué llevó y cuánto costó cada componente)
    for (const ing of ingredientes) {
      const necesita = Number((ing.cantidad * factor).toFixed(3));
      const costoUnit = ing.precio_costo || 0;
      await db.prepare(`
        INSERT INTO produccion_consumo (produccion_id, producto_id, cantidad, costo_unitario, costo)
        VALUES (?, ?, ?, ?, ?)
      `).run(prodId, ing.producto_id, necesita, costoUnit, Number((necesita * costoUnit).toFixed(2)));
    }

    // 4) Actualizar el costo por unidad del producto terminado (ficha de costo)
    let costoUnitFinal = 0;
    if (cantidadProducida > 0) {
      costoUnitFinal = Number((costoTotal / cantidadProducida).toFixed(4));
      await db.prepare('UPDATE productos SET precio_costo = ? WHERE id = ?')
        .run(costoUnitFinal, receta.producto_final_id);
    }

    // 5) Dejarlo disponible para que el ALMACENERO le dé entrada cuando
    //    corresponda. Producir NO mete esto al almacén todavía: es la
    //    cocina, no el almacén (ver /disponibles/:id/al-almacen).
    await db.prepare(`
      INSERT INTO produccion_disponible
        (produccion_id, producto_nombre, cantidad, unidad, costo_unitario, entregado)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(prodId, receta.nombre, cantidadProducida, receta.rinde_unidad, costoUnitFinal);

    return { prodId, costoTotal: Number(costoTotal.toFixed(2)) };
  });

  const resultado = await tx();

  // Que el contador lo vea: la cocina consumió materia prima por este valor.
  // Producir NO es una pérdida: es convertir materia prima en producto
  // terminado. El costo se reconoce cuando el producto se VENDE (eso lo
  // hace el área de ventas). Aquí se guarda el valor como referencia.
  await anotar({
    tipo: 'produccion',
    concepto: `Producción — ${receta.nombre}`,
    producto: receta.nombre,
    cantidad: cantidadProducida,
    unidad: receta.rinde_unidad || '',
    costo: 0,
    ingreso: 0,
    valor: resultado.costoTotal,
    area: 'cocina',
    usuario: req.usuario,
    nota: nota || null,
  });

  res.json({
    ok: true,
    produccion_id: resultado.prodId,
    cantidad_producida: cantidadProducida,
    costo_total: resultado.costoTotal,
    costo_unitario: cantidadProducida > 0 ? Number((resultado.costoTotal / cantidadProducida).toFixed(4)) : 0,
    avisos,
    // Deja claro para quien consuma la API que el almacén no se movió.
    afecta_almacen: false,
  });
});

// ============================================================
//  LO PRODUCIDO QUE AÚN NO ESTÁ EN EL ALMACÉN
//
//  El cocinero produce, pero eso NO entra solo al almacén: el
//  almacenero (o el dueño) revisa esta lista y decide cuándo darle
//  entrada. Así el almacén nunca se mueve sin que alguien de esa
//  área lo confirme.
// ============================================================

// ---------- LISTAR lo pendiente de entrar al almacén ----------
// Lo puede ver cualquiera con sesión (cocinero, almacenero, dueño...);
// solo dar la entrada está restringido más abajo.
router.get('/disponibles', async (req, res) => {
  const filas = await db.prepare(`
    SELECT pd.*, pr.almacen_id AS almacen_sugerido_id, a.nombre AS almacen_sugerido
    FROM produccion_disponible pd
    LEFT JOIN producciones pr ON pr.id = pd.produccion_id
    LEFT JOIN almacenes a ON a.id = pr.almacen_id
    WHERE pd.entregado = 0
    ORDER BY pd.fecha DESC
  `).all();
  res.json(filas);
});

// ---------- DAR ENTRADA al almacén de lo producido ----------
// Solo el almacenero (de su propio almacén) o el dueño. Busca o crea el
// producto terminado por nombre, suma la cantidad a existencias del
// almacén elegido, deja el movimiento de entrada y marca entregado=1.
router.post('/disponibles/:id/al-almacen', async (req, res) => {
  if (!ES_ALMACEN_O_DUENO(req.usuario.rol)) {
    return res.status(403).json({ error: 'Solo el almacenero o el dueño pueden dar entrada al almacén.' });
  }
  const id = Number(req.params.id);
  const almacenId = Number(req.body?.almacen_id);
  if (!almacenId) return res.status(400).json({ error: 'Indique el almacén que recibe la producción.' });

  // Un almacenero solo puede recibir en SU propio almacén.
  if ((req.usuario.rol === 'almacen' || req.usuario.rol === 'almacenero') &&
      almacenId !== Number(req.usuario.almacen_id)) {
    return res.status(403).json({ error: 'Solo puede dar entrada en su propio almacén.' });
  }

  const disponible = await db.prepare('SELECT * FROM produccion_disponible WHERE id = ?').get(id);
  if (!disponible) return res.status(404).json({ error: 'Ese producto ya no está disponible.' });
  if (disponible.entregado) return res.status(400).json({ error: 'Esa producción ya se llevó al almacén.' });

  const tx = db.transaction(async () => {
    // Buscar (o crear) el producto terminado por su nombre.
    const existente = await db.prepare(
      "SELECT id FROM productos WHERE lower(nombre) = lower(?) AND tipo = 'terminado' AND activo = 1"
    ).get(disponible.producto_nombre);

    let productoId;
    if (existente) {
      productoId = existente.id;
    } else {
      const uni = await db.prepare('SELECT id FROM unidades WHERE abreviatura = ?').get(disponible.unidad || 'lb');
      const nuevo = await db.prepare(
        'INSERT INTO productos (nombre, tipo, unidad_id, precio_costo) VALUES (?, ?, ?, ?)'
      ).run(disponible.producto_nombre, 'terminado', uni ? uni.id : null, disponible.costo_unitario || 0);
      productoId = nuevo.lastInsertRowid;
    }

    // Sumar a existencias del almacén elegido.
    const fila = await db.prepare(
      'SELECT id, cantidad FROM existencias WHERE producto_id = ? AND almacen_id = ?'
    ).get(productoId, almacenId);
    if (fila) {
      await db.prepare('UPDATE existencias SET cantidad = ? WHERE id = ?')
        .run(Number((fila.cantidad + disponible.cantidad).toFixed(3)), fila.id);
    } else {
      await db.prepare('INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)')
        .run(productoId, almacenId, disponible.cantidad);
    }

    // Movimiento de entrada (el rastro del almacén).
    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, origen_id, usuario_id, nota)
      VALUES (?, ?, 'entrada', ?, 'produccion', ?, ?, 'Entrada de producción de cocina')
    `).run(productoId, almacenId, disponible.cantidad, disponible.produccion_id, req.usuario.id);

    // Marcar como entregado.
    await db.prepare('UPDATE produccion_disponible SET entregado = 1 WHERE id = ?').run(id);

    return productoId;
  });

  await tx();

  const almacen = await db.prepare('SELECT nombre FROM almacenes WHERE id = ?').get(almacenId);
  await anotar({
    tipo: 'almacen',
    concepto: `Entrada de producción — ${disponible.producto_nombre}`,
    producto: disponible.producto_nombre,
    cantidad: disponible.cantidad,
    unidad: disponible.unidad,
    costo: 0,
    ingreso: 0,
    valor: Number((disponible.cantidad * (disponible.costo_unitario || 0)).toFixed(2)),
    area: 'almacen',
    usuario: req.usuario,
    nota: almacen ? `Recibido en ${almacen.nombre}` : null,
  });

  res.json({ ok: true });
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

