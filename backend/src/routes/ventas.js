// ============================================================
//  Ventas y deudas (Fase 2)
//
//  Al registrar una venta, el sistema:
//   1) descuenta los productos del inventario
//   2) registra el ingreso en caja (lo que se pagó)
//   3) si quedó algo sin pagar, lo deja como deuda
//
//  Todo en una acción, sin doble trabajo.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';
import { anotar } from '../libro.js';

const router = Router();
router.use(requiereSesion);

// ---------- Registrar una venta ----------

router.post('/', async (req, res) => {
  const { cliente, almacen_id, items, pagado, moneda } = req.body;
  // items = [{ producto_id, cantidad, precio_unitario }]

  if (!almacen_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Indique el almacén y al menos un producto.' });
  }

  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';
  const total = items.reduce((s, it) => s + Number(it.cantidad) * Number(it.precio_unitario), 0);
  const pagadoNum = Number(pagado) || 0;

  if (pagadoNum > total) {
    return res.status(400).json({ error: 'Lo pagado no puede ser mayor que el total.' });
  }

  let estado = 'pendiente';
  if (pagadoNum >= total) estado = 'pagada';
  else if (pagadoNum > 0) estado = 'parcial';

  const tx = db.transaction(async () => {
    // 1) Verificar y descontar inventario de cada producto.
    for (const it of items) {
      const ex = await db.prepare(
        'SELECT id, cantidad FROM existencias WHERE producto_id = ? AND almacen_id = ?'
      ).get(it.producto_id, almacen_id);
      if (!ex || ex.cantidad < Number(it.cantidad)) {
        const prod = await db.prepare('SELECT nombre FROM productos WHERE id = ?').get(it.producto_id);
        const nombreProd = prod?.nombre || 'producto';
        const hayAqui = ex ? ex.cantidad : 0;

        // Buscar en QUÉ OTROS almacenes sí hay este producto, para
        // que el usuario sepa de dónde puede venderlo en vez de solo
        // recibir "no hay". Esto evita el bug de "no hay" cuando en
        // realidad el producto existe en otro almacén.
        const enOtros = await db.prepare(`
          SELECT a.nombre AS almacen, e.cantidad
          FROM existencias e
          JOIN almacenes a ON a.id = e.almacen_id
          WHERE e.producto_id = ? AND e.almacen_id != ? AND e.cantidad > 0
          ORDER BY e.cantidad DESC
        `).all(it.producto_id, almacen_id);

        let msg = `No hay suficiente "${nombreProd}" en ese almacén (hay ${hayAqui}, necesita ${it.cantidad}).`;
        if (enOtros.length > 0) {
          const lista = enOtros.map((o) => `${o.almacen}: ${o.cantidad}`).join(', ');
          msg += ` Sí hay en otro almacén → ${lista}. Cambie el almacén de la venta o traslade el producto.`;
        }
        throw new Error(msg);
      }
      await db.prepare('UPDATE existencias SET cantidad = cantidad - ? WHERE id = ?')
        .run(Number(it.cantidad), ex.id);
      await db.prepare(`
        INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
        VALUES (?, ?, 'salida', ?, 'venta', ?, 'Venta')
      `).run(it.producto_id, almacen_id, Number(it.cantidad), req.usuario.id);
    }

    // 2) Crear la venta.
    const r = await db.prepare(`
      INSERT INTO ventas (cliente, total, pagado, estado, usuario_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(cliente || 'Cliente', total, pagadoNum, estado, req.usuario.id);
    const ventaId = r.lastInsertRowid;

    // 3) Guardar el detalle.
    for (const it of items) {
      await db.prepare(`
        INSERT INTO ventas_detalle (venta_id, producto_id, cantidad, precio_unitario)
        VALUES (?, ?, ?, ?)
      `).run(ventaId, it.producto_id, Number(it.cantidad), Number(it.precio_unitario));
    }

    // 4) Registrar en caja lo que se pagó (si algo se pagó).
    if (pagadoNum > 0) {
      await db.prepare(`
        INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
        VALUES ('ingreso', ?, ?, ?, 'venta', ?, ?)
      `).run(`Venta a ${cliente || 'Cliente'}`, pagadoNum, mon, ventaId, req.usuario.id);
    }

    return { ventaId, total, estado };
  });

  try {
    res.json({ ok: true, ...(await tx()) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Lista de ventas ----------

router.get('/', async (req, res) => {
  const ventas = await db.prepare(`
    SELECT v.*, u.nombre AS usuario_nombre
    FROM ventas v LEFT JOIN usuarios u ON u.id = v.usuario_id
    ORDER BY v.fecha DESC LIMIT 100
  `).all();
  res.json(ventas);
});

// ---------- Deudas (ventas no pagadas del todo) ----------

router.get('/deudas', async (req, res) => {
  const deudas = await db.prepare(`
    SELECT cliente,
           SUM(total - pagado) AS debe,
           COUNT(*) AS ventas_pendientes
    FROM ventas
    WHERE estado IN ('pendiente', 'parcial')
    GROUP BY cliente
    ORDER BY debe DESC
  `).all();
  const totalDeuda = deudas.reduce((s, d) => s + d.debe, 0);
  res.json({ deudas, totalDeuda });
});

// ---------- Ventas pendientes de un cliente (para cobrar) ----------

router.get('/pendientes/:cliente', async (req, res) => {
  const ventas = await db.prepare(`
    SELECT id, fecha, total, pagado, (total - pagado) AS pendiente, estado
    FROM ventas
    WHERE cliente = ? AND estado IN ('pendiente', 'parcial')
    ORDER BY fecha
  `).all(req.params.cliente);
  res.json(ventas);
});

// ---------- Registrar un cobro (abonar a una deuda) ----------

router.post('/:id/cobrar', async (req, res) => {
  const id = Number(req.params.id);
  const { monto, moneda } = req.body;
  const m = Number(monto);
  if (!m || m <= 0) return res.status(400).json({ error: 'Indique el monto a cobrar.' });

  const venta = await db.prepare('SELECT * FROM ventas WHERE id = ?').get(id);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const pendiente = venta.total - venta.pagado;
  if (m > pendiente) return res.status(400).json({ error: `Solo quedan ${pendiente} por cobrar.` });

  const mon = ['CUP', 'USD', 'MLC'].includes(moneda) ? moneda : 'CUP';
  const nuevoPagado = venta.pagado + m;
  const nuevoEstado = nuevoPagado >= venta.total ? 'pagada' : 'parcial';

  const tx = db.transaction(async () => {
    await db.prepare('UPDATE ventas SET pagado = ?, estado = ? WHERE id = ?')
      .run(nuevoPagado, nuevoEstado, id);
    await db.prepare(`
      INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
      VALUES ('ingreso', ?, ?, ?, 'venta', ?, ?)
    `).run(`Cobro a ${venta.cliente}`, m, mon, id, req.usuario.id);
  });
  await tx();

  res.json({ ok: true, estado: nuevoEstado });
});



// ============================================================
//  ÁREA DE VENTAS — inventario PROPIO del vendedor
//
//  El área de ventas NO depende del almacén: son cosas distintas.
//  Cada vendedor arma su propia lista de productos (los agrega él,
//  con su costo y su precio de venta) y esa lista se le guarda.
//
//  Durante el día anota lo VENDIDO de cada producto. Al pulsar
//  "Reiniciar jornada" se descuenta lo vendido de la existencia,
//  se anota todo en el libro de contabilidad (con fecha y hora) y
//  el contador de vendido vuelve a cero. Los productos que quedan
//  en cero se pueden eliminar cuando el vendedor quiera.
// ============================================================

const ES_JEFE = (rol) => rol === 'dueno' || rol === 'admin' || rol === 'proveedor';

// De quién es la hoja que se está viendo. Cada vendedor ve la suya;
// el dueño puede mirar la de cualquiera pasando ?usuario_id=.
function duenoDeLaHoja(req, fuente) {
  if (ES_JEFE(req.usuario.rol) && fuente && fuente.usuario_id) {
    return Number(fuente.usuario_id);
  }
  return req.usuario.id;
}

// ---------- Hoja del día ----------
router.get('/hoja', async (req, res) => {
  const esJefe = ES_JEFE(req.usuario.rol);
  const usuarioId = duenoDeLaHoja(req, req.query);

  const productos = await db.prepare(`
    SELECT id, nombre, unidad, cantidad, costo_unitario, precio_venta, vendido, imagen
    FROM venta_inventario
    WHERE usuario_id = ?
    ORDER BY nombre
  `).all(usuarioId);

  // Si el producto de la hoja no trae su propia imagen, se busca la del
  // producto terminado con el MISMO NOMBRE (la que dejó la receta), para
  // que el vendedor la vea sin tener que volver a cargarla.
  for (const p of productos) {
    if (!p.imagen) {
      const match = await db.prepare(`
        SELECT imagen FROM productos
        WHERE lower(nombre) = lower(?) AND imagen IS NOT NULL
        ORDER BY (tipo = 'terminado') DESC
        LIMIT 1
      `).get(p.nombre);
      if (match) p.imagen = match.imagen;
    }
  }

  let totalIngreso = 0, totalCosto = 0, valorExistencia = 0;
  const filas = productos.map((p) => {
    const total = Number((p.vendido * p.precio_venta).toFixed(2));       // dinero de lo vendido
    const costoVendido = Number((p.vendido * p.costo_unitario).toFixed(2));
    const ganancia = Number((total - costoVendido).toFixed(2));
    totalIngreso += total;
    totalCosto += costoVendido;
    valorExistencia += Number((p.cantidad * p.costo_unitario).toFixed(2));
    return { ...p, total, costo_vendido: costoVendido, ganancia };
  });

  // Vendedores, para que el dueño pueda elegir de quién ver la hoja.
  let vendedores = [];
  if (esJefe) {
    vendedores = await db.prepare(
      "SELECT id, nombre, usuario FROM usuarios WHERE activo = 1 AND rol IN ('ventas','dueno','admin') ORDER BY nombre"
    ).all();
  }

  res.json({
    es_jefe: esJefe,
    usuario_id: usuarioId,
    vendedores,
    productos: filas,
    total_dinero: Number(totalIngreso.toFixed(2)),
    total_costo: Number(totalCosto.toFixed(2)),
    total_ganancia: Number((totalIngreso - totalCosto).toFixed(2)),
    valor_existencia: Number(valorExistencia.toFixed(2)),
  });
});

// ---------- Agregar un producto a la hoja ----------
router.post('/producto', async (req, res) => {
  const usuarioId = duenoDeLaHoja(req, req.body);
  const { nombre, unidad, cantidad, costo_unitario, precio_venta, imagen } = req.body;
  if (!nombre || !String(nombre).trim()) {
    return res.status(400).json({ error: 'Escriba el nombre del producto.' });
  }
  const r = await db.prepare(`
    INSERT INTO venta_inventario (usuario_id, nombre, unidad, cantidad, costo_unitario, precio_venta, imagen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    usuarioId, String(nombre).trim(), unidad || 'u',
    Number(cantidad) || 0, Number(costo_unitario) || 0, Number(precio_venta) || 0, imagen || null
  );
  res.json({ ok: true, id: r.lastInsertRowid });
});

// ---------- Editar un producto (nombre, cantidad, costo, precio, vendido) ----------
router.put('/producto/:id', async (req, res) => {
  const id = Number(req.params.id);
  const fila = await db.prepare('SELECT * FROM venta_inventario WHERE id = ?').get(id);
  if (!fila) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (fila.usuario_id !== req.usuario.id && !ES_JEFE(req.usuario.rol)) {
    return res.status(403).json({ error: 'Ese producto no es de su hoja.' });
  }
  const b = req.body;
  await db.prepare(`
    UPDATE venta_inventario
    SET nombre = ?, unidad = ?, cantidad = ?, costo_unitario = ?, precio_venta = ?, vendido = ?, imagen = ?
    WHERE id = ?
  `).run(
    b.nombre !== undefined ? String(b.nombre).trim() : fila.nombre,
    b.unidad !== undefined ? b.unidad : fila.unidad,
    b.cantidad !== undefined ? Number(b.cantidad) : fila.cantidad,
    b.costo_unitario !== undefined ? Number(b.costo_unitario) : fila.costo_unitario,
    b.precio_venta !== undefined ? Number(b.precio_venta) : fila.precio_venta,
    b.vendido !== undefined ? Number(b.vendido) : fila.vendido,
    b.imagen !== undefined ? (b.imagen || null) : fila.imagen,
    id
  );
  res.json({ ok: true });
});

// ---------- Anotar lo vendido de un producto (no toca la existencia) ----------
router.post('/vendido/:id', async (req, res) => {
  const id = Number(req.params.id);
  const vendido = Number(req.body.vendido);
  if (Number.isNaN(vendido) || vendido < 0) {
    return res.status(400).json({ error: 'Cantidad vendida no válida.' });
  }
  const fila = await db.prepare('SELECT * FROM venta_inventario WHERE id = ?').get(id);
  if (!fila) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (fila.usuario_id !== req.usuario.id && !ES_JEFE(req.usuario.rol)) {
    return res.status(403).json({ error: 'Ese producto no es de su hoja.' });
  }
  await db.prepare('UPDATE venta_inventario SET vendido = ? WHERE id = ?').run(vendido, id);
  res.json({ ok: true });
});

// ---------- Eliminar un producto de la hoja ----------
router.delete('/producto/:id', async (req, res) => {
  const id = Number(req.params.id);
  const fila = await db.prepare('SELECT * FROM venta_inventario WHERE id = ?').get(id);
  if (!fila) return res.json({ ok: true });
  if (fila.usuario_id !== req.usuario.id && !ES_JEFE(req.usuario.rol)) {
    return res.status(403).json({ error: 'Ese producto no es de su hoja.' });
  }
  await db.prepare('DELETE FROM venta_inventario WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Reiniciar jornada ----------
// Descuenta lo vendido de la existencia, anota cada venta en el libro
// de contabilidad (queda con fecha y hora) y pone el vendido en cero.
router.post('/reiniciar', async (req, res) => {
  const usuarioId = duenoDeLaHoja(req, req.body);

  const filas = await db.prepare(
    'SELECT * FROM venta_inventario WHERE usuario_id = ? AND vendido > 0'
  ).all(usuarioId);

  let totalDinero = 0, totalCosto = 0;
  for (const f of filas) {
    const ingreso = Number((f.vendido * f.precio_venta).toFixed(2));
    const costo = Number((f.vendido * f.costo_unitario).toFixed(2));
    totalDinero += ingreso;
    totalCosto += costo;

    // Descontar de la existencia (sin bajar de cero).
    const nueva = Math.max(0, Number((f.cantidad - f.vendido).toFixed(3)));
    await db.prepare('UPDATE venta_inventario SET cantidad = ?, vendido = 0 WHERE id = ?').run(nueva, f.id);

    // Dejar constancia en el libro del contador.
    await anotar({
      tipo: 'venta',
      concepto: `Venta del día — ${f.nombre}`,
      producto: f.nombre,
      cantidad: f.vendido,
      unidad: f.unidad,
      costo,
      ingreso,
      area: 'ventas',
      usuario: req.usuario,
    });

    // Y en la caja del negocio.
    if (ingreso > 0) {
      await db.prepare(`
        INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, usuario_id)
        VALUES ('ingreso', ?, ?, 'CUP', 'venta', ?)
      `).run('Venta ' + f.nombre, ingreso, req.usuario.id);
    }
  }

  res.json({
    ok: true,
    total_dinero: Number(totalDinero.toFixed(2)),
    total_costo: Number(totalCosto.toFixed(2)),
    total_ganancia: Number((totalDinero - totalCosto).toFixed(2)),
    productos: filas.length,
  });
});

// ============================================================
//  CARRITO DE VENTA (vende directo desde la hoja propia)
//
//  A diferencia de "vendido" (que solo anota y se descuenta al
//  reiniciar la jornada), el carrito registra la venta al instante:
//  descuenta la existencia de cada producto de la hoja, crea la
//  venta con su detalle, la caja y el apunte en el libro, todo en
//  una sola transacción (o nada, si algo no alcanza).
// ============================================================

router.post('/carrito', async (req, res) => {
  const { items, cliente, metodo_pago } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Indique al menos un producto.' });
  }

  const tx = db.transaction(async () => {
    let total = 0;
    let costoTotal = 0;
    const lineas = [];

    // 1) Validar cada producto: que exista, que sea del vendedor (o el
    //    usuario sea dueño/admin) y que tenga existencia suficiente.
    for (const it of items) {
      const productoId = Number(it.producto_id);
      const cantidad = Number(it.cantidad);
      if (!productoId || !cantidad || cantidad <= 0) {
        throw new Error('Cada producto necesita un id y una cantidad válida.');
      }
      const fila = await db.prepare('SELECT * FROM venta_inventario WHERE id = ?').get(productoId);
      if (!fila) throw new Error('Uno de los productos ya no está en la hoja.');
      if (fila.usuario_id !== req.usuario.id && !ES_JEFE(req.usuario.rol)) {
        throw new Error(`"${fila.nombre}" no es de su hoja.`);
      }
      if (fila.cantidad < cantidad) {
        throw new Error(`No hay suficiente "${fila.nombre}" (hay ${fila.cantidad}, pidió ${cantidad}).`);
      }
      const precioUnit = fila.precio_venta;
      const subtotal = Number((cantidad * precioUnit).toFixed(2));
      total += subtotal;
      costoTotal += Number((cantidad * fila.costo_unitario).toFixed(2));
      lineas.push({ fila, cantidad, precioUnit, subtotal });
    }
    total = Number(total.toFixed(2));
    costoTotal = Number(costoTotal.toFixed(2));

    // 2) Alcanza todo: descontar existencia de cada producto de la hoja.
    for (const l of lineas) {
      await db.prepare('UPDATE venta_inventario SET cantidad = cantidad - ? WHERE id = ?')
        .run(l.cantidad, l.fila.id);
    }

    // 3) Registrar la venta (pagada de una vez: es venta de mostrador) y su detalle.
    const r = await db.prepare(`
      INSERT INTO ventas (cliente, total, pagado, estado, metodo_pago, usuario_id)
      VALUES (?, ?, ?, 'pagada', ?, ?)
    `).run(cliente || 'Cliente', total, total, metodo_pago || null, req.usuario.id);
    const ventaId = r.lastInsertRowid;

    for (const l of lineas) {
      // Se guarda también el nombre: así el historial sigue diciendo qué se
      // vendió aunque después ese producto se borre o se renombre.
      await db.prepare(`
        INSERT INTO ventas_detalle (venta_id, producto_id, producto_nombre, cantidad, precio_unitario)
        VALUES (?, ?, ?, ?, ?)
      `).run(ventaId, l.fila.id, l.fila.nombre, l.cantidad, l.precioUnit);
    }

    // 4) Ingreso en caja.
    if (total > 0) {
      await db.prepare(`
        INSERT INTO caja (tipo, concepto, monto, moneda, origen_tipo, origen_id, usuario_id)
        VALUES ('ingreso', ?, ?, 'CUP', 'venta', ?, ?)
      `).run(`Venta a ${cliente || 'Cliente'}`, total, ventaId, req.usuario.id);
    }

    // 5) Apunte en el libro de contabilidad.
    await anotar({
      tipo: 'venta',
      concepto: `Venta — ${cliente || 'Cliente'}`,
      producto: lineas.map((l) => l.fila.nombre).join(', '),
      cantidad: lineas.reduce((s, l) => s + l.cantidad, 0),
      unidad: '',
      costo: costoTotal,
      ingreso: total,
      area: 'ventas',
      usuario: req.usuario,
      nota: metodo_pago || null,
    });

    return {
      ventaId, total,
      items: lineas.map((l) => ({
        producto_id: l.fila.id, nombre: l.fila.nombre,
        cantidad: l.cantidad, precio_unitario: l.precioUnit, subtotal: l.subtotal,
      })),
    };
  });

  try {
    const resultado = await tx();
    res.json({ ok: true, venta_id: resultado.ventaId, total: resultado.total, items: resultado.items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
//  HISTORIAL DE VENTAS
//
//  Cada vendedor ve las suyas; el dueño/admin ve todas. "Eliminar"
//  del historial solo OCULTA el registro (oculto=1): no borra la
//  venta ni toca inventario, caja o contabilidad, para no perder
//  el rastro económico real.
// ============================================================

router.get('/historial', async (req, res) => {
  const esJefe = ES_JEFE(req.usuario.rol);
  const filtroUsuario = esJefe ? '' : 'AND v.usuario_id = ?';
  const params = esJefe ? [] : [req.usuario.id];

  const ventas = await db.prepare(`
    SELECT v.id, v.fecha, v.cliente, v.total, v.metodo_pago, u.nombre AS usuario_nombre
    FROM ventas v
    LEFT JOIN usuarios u ON u.id = v.usuario_id
    WHERE v.oculto = 0 ${filtroUsuario}
    ORDER BY v.fecha DESC
    LIMIT 200
  `).all(...params);

  for (const v of ventas) {
    const detalle = await db.prepare(
      'SELECT producto_id, producto_nombre, cantidad, precio_unitario FROM ventas_detalle WHERE venta_id = ?'
    ).all(v.id);
    v.productos = [];
    for (const d of detalle) {
      // Lo normal es que el nombre venga guardado con la línea. Las ventas
      // viejas no lo tienen, así que se busca: primero en la hoja propia del
      // vendedor y luego en el catálogo general. Si el producto ya no existe,
      // se deja un nombre genérico para no romper el historial.
      let nombre = d.producto_nombre;
      if (!nombre) {
        const enHoja = await db.prepare('SELECT nombre FROM venta_inventario WHERE id = ?').get(d.producto_id);
        if (enHoja) {
          nombre = enHoja.nombre;
        } else {
          const enCatalogo = await db.prepare('SELECT nombre FROM productos WHERE id = ?').get(d.producto_id);
          nombre = enCatalogo ? enCatalogo.nombre : 'Producto';
        }
      }
      v.productos.push({
        nombre,
        cantidad: d.cantidad,
        precio_unitario: d.precio_unitario,
        subtotal: Number((d.cantidad * d.precio_unitario).toFixed(2)),
      });
    }
  }

  res.json(ventas);
});

router.delete('/historial/:id', async (req, res) => {
  const id = Number(req.params.id);
  const venta = await db.prepare('SELECT * FROM ventas WHERE id = ?').get(id);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });
  if (venta.usuario_id !== req.usuario.id && !ES_JEFE(req.usuario.rol)) {
    return res.status(403).json({ error: 'Esa venta no es suya.' });
  }
  await db.prepare('UPDATE ventas SET oculto = 1 WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;

