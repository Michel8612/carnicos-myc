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

// ---------- Cierre diario ----------
// En pantalla el botón se llama "Cierre diario" (antes "Reiniciar
// jornada": mismo botón, nombre más claro). El endpoint SIGUE
// llamándose /reiniciar a propósito: cambiarlo rompería a quien ya lo
// esté llamando y no aporta nada.
//
// Descuenta lo vendido de la existencia, anota cada venta en el libro
// de contabilidad (queda con fecha y hora) y pone el vendido en cero.
// Al final deja además UNA línea-resumen del cierre (tipo
// 'cierre_ventas', ver más abajo): es lo que lee GET /cierres para
// pintar "Cierres anteriores" en pantalla, sin tener que adivinar qué
// líneas del libro pertenecen a cuál cierre.
router.post('/reiniciar', async (req, res) => {
  const usuarioId = duenoDeLaHoja(req, req.body);

  // Con qué se cobró la jornada.
  //
  // Se admite un DESGLOSE: un día real se cobra en varias formas y monedas a
  // la vez ("100 000 en efectivo, 50 000 por transferencia y 100 USD"). Antes
  // solo se podía declarar UNA forma para todo el día, lo que obligaba a
  // mentir en el balance.
  //
  // Si no viene desglose, se sigue admitiendo la forma única de siempre: el
  // cierre viejo funciona igual sin tocar nada.
  const FORMAS_PAGO = ['efectivo', 'transferencia'];
  const normalizaForma = (f) => (FORMAS_PAGO.includes(f) ? f : 'efectivo');
  const normalizaMoneda = (m) => (/^[A-Z]{2,6}$/.test(String(m || '').toUpperCase())
    ? String(m).toUpperCase() : 'CUP');

  const formaPago = normalizaForma(req.body?.forma_pago);
  const monedaCobro = normalizaMoneda(req.body?.moneda);

  const cobrosDeclarados = Array.isArray(req.body?.cobros)
    ? req.body.cobros
        .map((c) => ({
          forma: normalizaForma(c?.forma),
          moneda: normalizaMoneda(c?.moneda),
          monto: Number(c?.monto),
        }))
        .filter((c) => Number.isFinite(c.monto) && c.monto > 0)
    : [];

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

  const totalGanancia = Number((totalDinero - totalCosto).toFixed(2));

  // Ventas hechas HOY por el CARRITO. Se cobran en el acto (crean su fila en
  // `ventas` y ya movieron caja, libro y dinero disponible), asi que NO se
  // vuelven a registrar aqui: solo se informan.
  //
  // Sin esto, quien vendia por catalogo veia su venta "desaparecer" al cerrar
  // el dia, porque el cierre solo miraba el campo `vendido` de la hoja y el
  // carrito nunca lo toca. Era justo lo que reportaba el cliente.
  const carrito = await db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS ventas
      FROM ventas
     WHERE usuario_id = ?
       AND (fecha AT TIME ZONE 'America/Havana')::date = (now() AT TIME ZONE 'America/Havana')::date
  `).get(usuarioId);
  const totalCarrito = Number(Number(carrito.total).toFixed(2));
  const ventasCarrito = Number(carrito.ventas);

  // Lo que de verdad entró hoy en este punto de venta.
  const totalDia = Number((totalDinero + totalCarrito).toFixed(2));

  // Línea-resumen del cierre, para "Cierres anteriores". OJO: ingreso y
  // costo van en CERO a propósito — el ingreso y el costo reales YA
  // quedaron anotados arriba, línea por línea (una por producto
  // vendido). Repetirlos aquí los sumaría DOS VECES en los totales de
  // Contabilidad y en Tributación (que suman ingreso/costo de TODO
  // contabilidad_registros). El total vendido de este cierre se guarda
  // en "valor" en cambio, que por convención de esta tabla es solo de
  // referencia y nunca se suma en esos cálculos — el mismo truco que ya
  // usan los movimientos de almacén (ver POST /inventario/movimientos).
  await anotar({
    tipo: 'cierre_ventas',
    concepto: 'Cierre diario de ventas',
    producto: null,
    cantidad: filas.length,
    unidad: null,
    costo: 0,
    ingreso: 0,
    valor: totalDia,
    area: 'ventas',
    usuario: req.usuario,
    nota: `Hoja: ${totalDinero.toFixed(2)}`
        + (totalCarrito > 0 ? ` · Carrito: ${totalCarrito.toFixed(2)} (${ventasCarrito} venta/s)` : '')
        + ` · Ganancia: ${totalGanancia.toFixed(2)} · Costo: ${totalCosto.toFixed(2)}`
        + ` · ${filas.length} producto(s) con venta.`,
  });

  // El dinero cobrado entra al balance del negocio (Parte 2), en la
  // moneda y la forma con que se cobró de verdad. Hasta ahora el cierre
  // dejaba el rastro contable pero el dueño tenía que sumar a mano lo que
  // le había entrado: eso era justo lo que pedía el cliente.
  //
  // Va FUERA de un try/catch que corte: si esto fallara, el cierre ya se
  // hizo y la mercancía ya se descontó. Se registra el fallo y se sigue,
  // igual que hace el libro contable.
  // Solo entra lo de la HOJA: lo del carrito ya se registró al venderse.
  // Sumarlo aquí lo contaría dos veces en el dinero disponible.
  if (totalDinero > 0 || cobrosDeclarados.length) {
    try {
      const nombreVendedor = (await db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(usuarioId))?.nombre
        || req.usuario.usuario;

      // Si declaró el desglose, se anota línea por línea: cada forma y cada
      // moneda va a su propia casilla del balance. Si no, todo junto como antes.
      const lineas = cobrosDeclarados.length
        ? cobrosDeclarados
        : [{ forma: formaPago, moneda: monedaCobro, monto: Number(totalDinero.toFixed(2)) }];

      for (const l of lineas) {
        await db.prepare(`
          INSERT INTO dinero_movimientos (forma, moneda, monto, concepto, origen_tipo, origen_id, usuario_id, nota)
          VALUES (?, ?, ?, ?, 'venta', ?, ?, ?)
        `).run(
          l.forma, l.moneda, Number(l.monto.toFixed(2)),
          `Ventas del día — ${nombreVendedor}`,
          usuarioId, req.usuario.id,
          `${filas.length} producto(s). Ganancia: ${totalGanancia.toFixed(2)}.`,
        );
      }
    } catch (e) {
      console.error('No se pudo llevar el cobro al balance de dinero:', e.message);
    }
  }

  // Se devuelven las tres cifras por separado para que la pantalla pueda
  // enseñarlas sin sumarlas mal: lo de la hoja, lo del carrito y el total.
  const soloCup = cobrosDeclarados.filter((c) => c.moneda === 'CUP')
    .reduce((s, c) => s + c.monto, 0);
  const descuadre = cobrosDeclarados.length
    ? Number((soloCup - totalDinero).toFixed(2))
    : 0;

  res.json({
    ok: true,
    total_dinero: Number(totalDinero.toFixed(2)),
    total_carrito: totalCarrito,
    ventas_carrito: ventasCarrito,
    total_dia: totalDia,
    total_costo: Number(totalCosto.toFixed(2)),
    total_ganancia: totalGanancia,
    productos: filas.length,
    forma_pago: formaPago,
    moneda: monedaCobro,
    cobros: cobrosDeclarados,
    // Si lo declarado en pesos no cuadra con lo que dice la hoja, se avisa
    // pero NO se bloquea: puede haber cobrado parte en divisa. Quien cierra
    // tiene que poder verlo, no que se lo escondan.
    aviso: descuadre !== 0
      ? `Lo declarado en CUP (${soloCup.toFixed(2)}) no coincide con lo vendido en la hoja `
        + `(${totalDinero.toFixed(2)}). Diferencia: ${descuadre.toFixed(2)}.`
      : null,
  });
});

// ---------- GET /ingresos-por-punto : cuánto entró en cada punto de venta ----------
// "En el punto de venta XYZ ingresó ___". Se agrupa por el vendedor dueño
// de la hoja, que ES el punto de venta: por eso un punto nuevo aparece
// solo, con su nombre, sin tocar código — que es lo que se pidió.
router.get('/ingresos-por-punto', async (req, res) => {
  if (!ES_JEFE(req.usuario.rol) && req.usuario.rol !== 'contabilidad') {
    return res.status(403).json({ error: 'No tiene permiso para ver los ingresos por punto de venta.' });
  }
  const { desde, hasta } = req.query;
  const cond = ["d.origen_tipo = 'venta'"];
  const params = [];
  if (desde) { cond.push('d.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('d.fecha <= ?'); params.push(`${hasta} 23:59:59`); }

  const filas = await db.prepare(`
    SELECT COALESCE(u.nombre, 'Sin asignar') AS punto,
           d.moneda, d.forma,
           COALESCE(SUM(d.monto), 0) AS total,
           COUNT(*) AS cierres,
           MAX(d.fecha) AS ultimo
      FROM dinero_movimientos d
      LEFT JOIN usuarios u ON u.id = d.origen_id
     WHERE ${cond.join(' AND ')}
     GROUP BY 1, 2, 3
     ORDER BY 1, 2
  `).all(...params);

  res.json(filas.map((f) => ({
    punto: f.punto,
    moneda: f.moneda,
    forma: f.forma,
    total: Number(Number(f.total).toFixed(2)),
    cierres: Number(f.cierres),
    ultimo: f.ultimo,
  })));
});

// ---------- Cierres anteriores (historial de "Cierre diario") ----------
// Lee las líneas-resumen que deja POST /reiniciar (tipo='cierre_ventas',
// ver el comentario de arriba). Mismo criterio de visibilidad que
// /historial: cada vendedor ve los suyos; dueño/admin/proveedor los ven
// todos. Nota: queda registrado con el usuario que EJECUTÓ el cierre
// (req.usuario), no necesariamente el dueño de la hoja — igual que ya
// pasa con las líneas de detalle de arriba, para no inventar un criterio
// distinto dentro del mismo endpoint.
router.get('/cierres', async (req, res) => {
  const esJefe = ES_JEFE(req.usuario.rol);
  const cond = ['tipo = ?'];
  const params = ['cierre_ventas'];
  if (!esJefe) {
    cond.push('usuario_id = ?');
    params.push(req.usuario.id);
  }
  const filas = await db.prepare(`
    SELECT id, fecha, valor AS total_vendido, usuario_nombre, nota
    FROM contabilidad_registros
    WHERE ${cond.join(' AND ')}
    ORDER BY fecha DESC
    LIMIT 200
  `).all(...params);
  res.json(filas);
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

      // 4.b) Y al dinero disponible del negocio, para que el dueño vea el
      // cobro sin esperar al cierre del día. La venta por carrito se cobra
      // en el acto: si solo entrara en el cierre, el balance mentiría
      // durante toda la jornada.
      const formaCarrito = ['efectivo', 'transferencia'].includes(req.body?.forma_pago)
        ? req.body.forma_pago
        : 'efectivo';
      const monedaCarrito = /^[A-Z]{2,6}$/.test(String(req.body?.moneda || '').toUpperCase())
        ? String(req.body.moneda).toUpperCase()
        : 'CUP';
      await db.prepare(`
        INSERT INTO dinero_movimientos (forma, moneda, monto, concepto, origen_tipo, origen_id, usuario_id)
        VALUES (?, ?, ?, ?, 'venta', ?, ?)
      `).run(formaCarrito, monedaCarrito, total, `Venta a ${cliente || 'Cliente'}`, req.usuario.id, req.usuario.id);
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

