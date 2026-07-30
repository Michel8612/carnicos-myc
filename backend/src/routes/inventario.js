// ============================================================
//  Rutas de inventario
//
//  Maneja productos, existencias y movimientos (entradas/salidas).
//  Incluye el cálculo de "en cuántos días se agota" basado en
//  el ritmo real de salidas de cada producto.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';
import { anotar } from '../libro.js';
import { auditar } from '../auditoria.js';

const router = Router();
router.use(requiereSesion);

// Un usuario de rol 'almacen' solo ve y mueve SU PROPIO almacén (el
// que tiene asignado en usuarios.almacen_id). El dueño (y roles admin/
// proveedor) ven y mueven todos. 'almacen_central' es un almacenero SIN
// almacén propio: ve y mueve TODOS los almacenes, igual que el dueño.
// Esta es la única función que decide el límite, para que la excepción
// de almacen_central quede en un solo lugar (GET /existencias,
// GET /almacenes y POST /movimientos ya la usan a través de ella).
const ES_ALMACENERO_LIMITADO = (rol) => rol === 'almacen' || rol === 'almacenero';

// Quién puede borrar una línea del HISTORIAL de movimientos: solo el
// administrador real del negocio (dueño/admin/proveedor —soporte, mismo
// trato que en el resto del sistema—). A propósito NO incluye
// 'almacen_central': mover mercancía de cualquier almacén es una cosa,
// borrar un registro de auditoría del historial es otra muy distinta.
const ES_ADMIN_TOTAL = (rol) => rol === 'dueno' || rol === 'admin' || rol === 'proveedor';

// Devuelve el almacen_id al que hay que limitar las consultas, o null
// si no hay límite (dueño / admin / proveedor / almacen_central / etc.).
function almacenDeLaSesion(req) {
  const rol = req.usuario.rol;
  if (ES_ALMACENERO_LIMITADO(rol)) {
    return req.usuario.almacen_id || null;
  }
  return null;
}

// Quién puede resolver (aceptar/cancelar) una transferencia PENDIENTE:
// el destinatario real (el almacenero dueño de ese almacén, o el vendedor
// al que iba dirigida), más los roles que ya ven/mueven todo en el
// sistema (dueño, admin, proveedor —soporte, mismo trato que en el resto
// del código— y almacen_central).
function puedeResolverTransferencia(req, t) {
  const rol = req.usuario.rol;
  if (rol === 'dueno' || rol === 'admin' || rol === 'proveedor' || rol === 'almacen_central') return true;
  if (t.destino_tipo === 'almacen') {
    return ES_ALMACENERO_LIMITADO(rol) && Number(req.usuario.almacen_id) === Number(t.destino_almacen_id);
  }
  if (t.destino_tipo === 'ventas') {
    return Number(req.usuario.id) === Number(t.destino_usuario_id);
  }
  return false;
}

// Nombre real del usuario (para dejar rastro legible en transferencias y
// en el libro). req.usuario solo trae el nombre de USUARIO (login), no el
// nombre para mostrar, así que se busca en la tabla.
async function nombreDeUsuario(id) {
  const u = await db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(id);
  return u ? u.nombre : null;
}

// ---------- Productos ----------

// Lista de productos con su unidad.
router.get('/productos', async (req, res) => {
  const filas = await db.prepare(`
    SELECT p.*, u.abreviatura AS unidad
    FROM productos p
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1
    ORDER BY p.nombre
  `).all();
  res.json(filas);
});

// Crear producto nuevo (el dueño amplía su catálogo sin tocar código).
router.post('/productos', async (req, res) => {
  const { nombre, tipo, categoria, unidad_id, precio_costo, precio_venta, stock_minimo } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'Indique nombre y tipo del producto.' });
  const r = await db.prepare(`
    INSERT INTO productos (nombre, tipo, categoria, unidad_id, precio_costo, precio_venta, stock_minimo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nombre, tipo, categoria || null, unidad_id || null, precio_costo || 0, precio_venta || 0, stock_minimo || 0);
  res.json({ id: r.lastInsertRowid });
});

// Editar un producto existente.
router.put('/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, tipo, categoria, unidad_id, precio_costo, precio_venta, stock_minimo } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'Indique nombre y tipo.' });
  await db.prepare(`
    UPDATE productos
    SET nombre = ?, tipo = ?, categoria = ?, unidad_id = ?, precio_costo = ?, precio_venta = ?, stock_minimo = ?
    WHERE id = ?
  `).run(nombre, tipo, categoria || null, unidad_id || null, precio_costo || 0, precio_venta || 0, stock_minimo || 0, id);
  res.json({ ok: true });
});

// Eliminar un producto. Si ya tiene movimientos, no se borra de
// verdad (se desactiva) para no romper el historial. Si nunca se
// usó, se borra del todo.
router.delete('/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const usado = (await db.prepare(
    'SELECT COUNT(*) AS n FROM movimientos WHERE producto_id = ?'
  ).get(id)).n;
  const enExistencias = (await db.prepare(
    'SELECT COALESCE(SUM(cantidad),0) AS c FROM existencias WHERE producto_id = ?'
  ).get(id)).c;

  if (usado > 0 || enExistencias > 0) {
    // Tiene historial o existencias: solo desactivar.
    await db.prepare('UPDATE productos SET activo = 0 WHERE id = ?').run(id);
    return res.json({ ok: true, desactivado: true });
  }
  // Nunca se usó: borrar del todo.
  await db.prepare('DELETE FROM existencias WHERE producto_id = ?').run(id);
  await db.prepare('DELETE FROM productos WHERE id = ?').run(id);
  res.json({ ok: true, eliminado: true });
});

// ---------- Existencias con predicción ----------

// Devuelve cada producto con su stock total, su estado y los días
// estimados que quedan antes de agotarse.
router.get('/existencias', async (req, res) => {
  // Si es un almacenero, solo se cuenta SU almacén; el dueño ve el total
  // sumando todos los almacenes (como antes).
  const almacenId = almacenDeLaSesion(req);

  const stock = await db.prepare(`
    SELECT p.id, p.nombre, p.stock_minimo, p.tipo, p.unidad_id, p.imagen,
           p.precio_costo, p.precio_venta, u.abreviatura AS unidad,
           COALESCE(SUM(e.cantidad), 0) AS cantidad
    FROM productos p
    LEFT JOIN existencias e ON e.producto_id = p.id ${almacenId ? 'AND e.almacen_id = ?' : ''}
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1
    GROUP BY p.id, u.abreviatura
    ORDER BY p.nombre
  `).all(...(almacenId ? [almacenId] : []));

  // Ritmo de salida: promedio diario de los últimos 30 días.
  const salidas = await db.prepare(`
    SELECT producto_id, SUM(cantidad) AS total
    FROM movimientos
    WHERE tipo = 'salida' AND fecha >= now() - interval '30 days'
    ${almacenId ? 'AND almacen_id = ?' : ''}
    GROUP BY producto_id
  `).all(...(almacenId ? [almacenId] : []));
  const ritmo = {};
  for (const s of salidas) ritmo[s.producto_id] = s.total / 30;  // por día

  const resultado = stock.map((p) => {
    const porDia = ritmo[p.id] || 0;
    let diasRestantes = null;
    let fechaAgotamiento = null;
    if (porDia > 0) {
      diasRestantes = Math.floor(p.cantidad / porDia);
      const f = new Date();
      f.setDate(f.getDate() + diasRestantes);
      fechaAgotamiento = f.toISOString().slice(0, 10);
    }

    // Estado de la tarjeta.
    let estado = 'normal';
    if (p.cantidad <= 0) estado = 'agotado';
    else if (p.stock_minimo > 0 && p.cantidad <= p.stock_minimo) estado = 'critico';
    else if (diasRestantes !== null && diasRestantes <= 7) estado = 'bajo';

    return { ...p, consumo_diario: Number(porDia.toFixed(2)), dias_restantes: diasRestantes, fecha_agotamiento: fechaAgotamiento, estado };
  });

  res.json(resultado);
});

// ---------- Registrar un movimiento ----------

// Suma (o resta) una cantidad a la existencia de un producto en un
// almacén. Se usa tanto para el movimiento principal como para la
// entrada en el almacén de destino cuando hay traslado.
async function moverExistencia(productoId, almacenId, delta) {
  const fila = await db.prepare(
    'SELECT id, cantidad FROM existencias WHERE producto_id = ? AND almacen_id = ?'
  ).get(productoId, almacenId);
  if (fila) {
    const nueva = Number((fila.cantidad + delta).toFixed(3));
    if (nueva < 0) throw new Error('No hay suficiente existencia para esa salida.');
    await db.prepare('UPDATE existencias SET cantidad = ? WHERE id = ?').run(nueva, fila.id);
  } else {
    if (delta < 0) throw new Error('No hay existencia de ese producto en ese almacén.');
    await db.prepare(
      'INSERT INTO existencias (producto_id, almacen_id, cantidad) VALUES (?, ?, ?)'
    ).run(productoId, almacenId, delta);
  }
}

// Entrada, salida o ajuste. Actualiza existencias y deja el rastro.
//
// La SALIDA admite, opcionalmente, un DESTINO:
//  - destino_tipo ('almacen'|'ventas') + destino_id: la mercancía sale
//    del origen YA, pero NO entra sola al destino. Queda "en tránsito"
//    (una fila en transferencias con estado='pendiente') hasta que el
//    destinatario la acepte o la cancele. Se admite también el campo
//    viejo destino_almacen_id (compatibilidad hacia atrás): equivale a
//    destino_tipo:'almacen'.
//  - destino_texto: no crea ninguna transferencia, solo queda anotado a
//    dónde fue (ej. "Punto de venta del centro"). Puede combinarse con
//    lo anterior o usarse solo.
// Si no viene nada de destino, es una salida simple.
router.post('/movimientos', async (req, res) => {
  const { producto_id, almacen_id, tipo, cantidad, nota, destino_texto, proveedor, costo_unitario } = req.body;
  let { destino_tipo, destino_id } = req.body;
  if (!destino_id && req.body.destino_almacen_id) {
    destino_tipo = 'almacen';
    destino_id = req.body.destino_almacen_id;
  }

  if (!producto_id || !almacen_id || !tipo || !cantidad) {
    return res.status(400).json({ error: 'Faltan datos del movimiento.' });
  }
  if (!['entrada', 'salida', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de movimiento no válido.' });
  }
  const cant = Number(cantidad);
  if (cant <= 0) return res.status(400).json({ error: 'La cantidad debe ser mayor que cero.' });

  // Un almacenero solo puede registrar movimientos en SU propio almacén.
  const limiteAlmacen = almacenDeLaSesion(req);
  if (limiteAlmacen && Number(almacen_id) !== Number(limiteAlmacen)) {
    return res.status(403).json({ error: 'Solo puede registrar movimientos en su propio almacén.' });
  }

  // El envío a otro destino solo tiene sentido para una SALIDA.
  const destinoTipo = (tipo === 'salida' && destino_id && ['almacen', 'ventas'].includes(destino_tipo))
    ? destino_tipo
    : null;
  const destinoId = destinoTipo ? Number(destino_id) : null;
  if (destinoTipo === 'almacen' && destinoId === Number(almacen_id)) {
    return res.status(400).json({ error: 'El almacén de destino debe ser distinto del de origen.' });
  }

  let transferenciaId = null;
  let destinoNombreParaNota = null;

  const tx = db.transaction(async () => {
    // 1) Movimiento principal (entrada/salida/ajuste) en el almacén de origen.
    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
      VALUES (?, ?, ?, ?, 'manual', ?, ?)
    `).run(producto_id, almacen_id, tipo, cant, req.usuario.id, nota || null);

    const delta = tipo === 'salida' ? -cant : cant;
    await moverExistencia(producto_id, almacen_id, delta);

    // 1.b) Si la entrada viene de una COMPRA (se indicó el proveedor), se
    //      deja además su rastro en la tabla "compras". No hace falta una
    //      pantalla aparte: comprar mercancía ya se registra aquí, y así
    //      Tributación puede informar cuánto se compró en el período.
    //      Ojo: comprar NO resta ganancia (es cambiar dinero por
    //      inventario), por eso no genera gasto ni asiento de costo.
    if (tipo === 'entrada' && proveedor && String(proveedor).trim()) {
      const prod = await db.prepare('SELECT precio_costo FROM productos WHERE id = ?').get(producto_id);
      const costoUnit = Number(costo_unitario) > 0
        ? Number(costo_unitario)
        : Number(prod?.precio_costo) || 0;
      const compra = await db.prepare(`
        INSERT INTO compras (tipo, proveedor, almacen_id, costo_total, moneda, referencia, usuario_id)
        VALUES ('nacional', ?, ?, ?, 'CUP', ?, ?)
      `).run(String(proveedor).trim(), almacen_id, cant * costoUnit, nota || null, req.usuario.id);
      await db.prepare(`
        INSERT INTO compras_detalle (compra_id, producto_id, cantidad, costo_unitario)
        VALUES (?, ?, ?, ?)
      `).run(compra.lastInsertRowid, producto_id, cant, costoUnit);
    }

    // 2) Si hay destino, la mercancía queda EN TRÁNSITO: ya no se suma
    //    sola allá. Se crea la transferencia pendiente de aceptación.
    if (destinoTipo) {
      const producto = await db.prepare('SELECT nombre, precio_costo FROM productos WHERE id = ?').get(producto_id);
      const origenAlm = await db.prepare('SELECT nombre FROM almacenes WHERE id = ?').get(almacen_id);

      let destinoNombre = null;
      let destinoAlmacenId = null;
      let destinoUsuarioId = null;
      if (destinoTipo === 'almacen') {
        const d = await db.prepare('SELECT nombre FROM almacenes WHERE id = ?').get(destinoId);
        if (!d) throw new Error('El almacén de destino no existe.');
        destinoNombre = d.nombre;
        destinoAlmacenId = destinoId;
      } else {
        const d = await db.prepare(
          "SELECT nombre FROM usuarios WHERE id = ? AND rol = 'ventas' AND activo = 1"
        ).get(destinoId);
        if (!d) throw new Error('El vendedor de destino no existe o no está activo.');
        destinoNombre = d.nombre;
        destinoUsuarioId = destinoId;
      }
      destinoNombreParaNota = destinoNombre;

      const enviadoNombre = (await nombreDeUsuario(req.usuario.id)) || req.usuario.usuario;

      const r = await db.prepare(`
        INSERT INTO transferencias (
          producto_id, producto_nombre, cantidad, costo_unitario,
          origen_almacen_id, origen_almacen_nombre,
          destino_tipo, destino_almacen_id, destino_usuario_id, destino_nombre,
          estado, enviado_por, enviado_nombre, nota
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)
      `).run(
        producto_id, producto?.nombre || null, cant, producto?.precio_costo || 0,
        almacen_id, origenAlm?.nombre || null,
        destinoTipo, destinoAlmacenId, destinoUsuarioId, destinoNombre,
        req.usuario.id, enviadoNombre, destino_texto || null
      );
      transferenciaId = r.lastInsertRowid;
    }
  });

  try {
    await tx();

    // Dejar constancia en el libro de contabilidad: el contador debe ver
    // CUALQUIER movimiento económico, venga del área que venga.
    const info = await db.prepare(`
      SELECT p.nombre, COALESCE(p.precio_costo,0) AS costo, COALESCE(u.abreviatura,'') AS unidad,
             a.nombre AS almacen
      FROM productos p
      LEFT JOIN unidades u ON u.id = p.unidad_id
      LEFT JOIN almacenes a ON a.id = ?
      WHERE p.id = ?
    `).get(almacen_id, producto_id);

    if (info) {
      const valor = Number((cant * info.costo).toFixed(2));
      // A dónde fue: enviado a otro almacén/vendedor (pendiente de que lo
      // acepten), un destino libre en texto, o nada.
      const partesDestino = [];
      if (destinoTipo) {
        partesDestino.push(
          `enviado a ${destinoTipo === 'almacen' ? 'almacén' : 'vendedor'} ${destinoNombreParaNota || ''} — pendiente de aceptación`
        );
      }
      if (destino_texto) partesDestino.push(`destino: ${destino_texto}`);

      await anotar({
        tipo: 'almacen',
        concepto: `${tipo === 'entrada' ? 'Entrada' : tipo === 'salida' ? 'Salida' : 'Ajuste'} de almacén — ${info.nombre}`,
        producto: info.nombre,
        cantidad: cant,
        unidad: info.unidad,
        // Mover mercancía NO es ganancia ni pérdida: una entrada es cambiar
        // dinero por inventario (una inversión) y una salida es sacarlo del
        // estante. Por eso se guarda su VALOR como referencia, pero no suma
        // ni resta en el resultado del negocio: eso lo hacen las ventas
        // (ingreso) y los gastos.
        costo: 0,
        ingreso: 0,
        valor,
        area: 'almacen',
        usuario: req.usuario,
        nota: [info.almacen, ...partesDestino, nota].filter(Boolean).join(' · ') || null,
      });
    }

    res.json({ ok: true, transferencia_id: transferenciaId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
//  Historial de movimientos del almacén
// ============================================================

// Lista de movimientos (entradas/salidas/traslados/ajustes/producción)
// con filtros opcionales por almacén y por fecha, para la pantalla de
// Almacén. Un almacenero limitado solo ve los de SU almacén (igual que
// en /existencias); el resto puede filtrar por ?almacen_id= o ver todos.
router.get('/movimientos', async (req, res) => {
  const limiteAlmacen = almacenDeLaSesion(req);
  const cond = [];
  const params = [];

  if (limiteAlmacen) {
    cond.push('m.almacen_id = ?');
    params.push(limiteAlmacen);
  } else if (req.query.almacen_id) {
    cond.push('m.almacen_id = ?');
    params.push(Number(req.query.almacen_id));
  }
  if (req.query.desde) {
    cond.push('m.fecha >= ?');
    params.push(req.query.desde);
  }
  if (req.query.hasta) {
    cond.push('m.fecha <= ?');
    params.push(req.query.hasta + ' 23:59:59');
  }

  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const filas = await db.prepare(`
    SELECT m.id, m.fecha, m.tipo, m.cantidad, m.nota, m.origen_tipo,
           p.nombre AS producto, COALESCE(u.abreviatura,'') AS unidad,
           a.nombre AS almacen, us.nombre AS usuario_nombre
    FROM movimientos m
    JOIN productos p ON p.id = m.producto_id
    LEFT JOIN unidades u ON u.id = p.unidad_id
    LEFT JOIN almacenes a ON a.id = m.almacen_id
    LEFT JOIN usuarios us ON us.id = m.usuario_id
    ${where}
    ORDER BY m.fecha DESC
    LIMIT 300
  `).all(...params);

  res.json(filas);
});

// Borrar una línea del historial de movimientos.
//
// DECISIÓN IMPORTANTE (a propósito, no un olvido): borrar aquí NO
// deshace el movimiento ni toca `existencias`. Es el MISMO criterio que
// ya sigue este sistema con el historial de ventas y con el libro
// contable: borrar del historial no deshace nada, solo quita la línea
// del registro. Si además se devolviera/quitara cantidad de
// existencias, el inventario dejaría de cuadrar con la realidad física
// del almacén (desde que se hizo el movimiento puede haberse contado,
// vendido o movido más mercancía, y "deshacer" ya no reflejaría nada
// real). Por eso este DELETE es puramente un borrado de auditoría.
//
// Solo dueño/admin/proveedor (ver ES_ADMIN_TOTAL). Motivo obligatorio.
// Queda registrado en auditoría con el movimiento completo en "antes",
// para poder reconstruirlo a mano si hiciera falta.
router.delete('/movimientos/:id', async (req, res) => {
  if (!ES_ADMIN_TOTAL(req.usuario.rol)) {
    return res.status(403).json({
      error: 'Solo un administrador puede borrar líneas del historial de almacén.',
    });
  }

  const id = Number(req.params.id);
  const motivo = req.body?.motivo;
  if (!motivo || !String(motivo).trim()) {
    return res.status(400).json({ error: 'Indique el motivo del borrado.' });
  }

  const mov = await db.prepare('SELECT * FROM movimientos WHERE id = ?').get(id);
  if (!mov) return res.status(404).json({ error: 'Ese movimiento no existe.' });

  try {
    await db.prepare('DELETE FROM movimientos WHERE id = ?').run(id);
  } catch (err) {
    // Defensivo: si algún día otra tabla llega a depender de
    // movimientos.id por clave foránea, se explica en español en vez
    // de reventar con el error crudo de Postgres.
    if (err.code === '23503') {
      return res.status(400).json({
        error: 'Este movimiento tiene otros registros que dependen de él y no se puede borrar.',
      });
    }
    throw err;
  }

  // OJO: NO se toca `existencias` — ver la nota de más arriba.
  await auditar({
    modulo: 'almacen',
    accion: 'eliminar',
    req,
    entidad: 'movimientos',
    entidad_id: id,
    descripcion: `Borrado de línea del historial de almacén (${mov.tipo}, ${mov.cantidad} unidades). No afecta existencias.`,
    antes: mov,
    motivo: String(motivo).trim(),
  });

  res.json({ ok: true });
});

// ============================================================
//  Transferencias entre áreas (almacén → almacén, almacén → vendedor)
// ============================================================

// Todos los destinos posibles a los que se puede enviar una salida:
// todos los almacenes + todos los vendedores activos. Se consulta en
// vivo (nada cacheado) para que aparezca de inmediato cualquier almacén
// o vendedor creado después. Cualquiera con sesión puede verlo (GET).
router.get('/destinos', async (req, res) => {
  // Si quien consulta es un almacenero con almacén propio, no tiene
  // sentido que se ofrezca a sí mismo como destino de su propia salida.
  const origenId = almacenDeLaSesion(req);

  const almacenes = await db.prepare('SELECT id, nombre FROM almacenes ORDER BY nombre').all();
  const vendedores = await db.prepare(
    "SELECT id, nombre FROM usuarios WHERE activo = 1 AND rol = 'ventas' ORDER BY nombre"
  ).all();

  const destinos = [
    ...almacenes
      .filter((a) => !origenId || Number(a.id) !== Number(origenId))
      .map((a) => ({ tipo: 'almacen', id: a.id, nombre: a.nombre })),
    ...vendedores.map((v) => ({ tipo: 'ventas', id: v.id, nombre: `${v.nombre} (Ventas)` })),
  ];

  res.json({ destinos });
});

// Transferencias pendientes que le tocan a QUIEN consulta: su propio
// almacén (si es almacenero) o él mismo como vendedor destinatario.
// Dueño/admin/proveedor/almacen_central ven TODAS las pendientes.
router.get('/transferencias/pendientes', async (req, res) => {
  const rol = req.usuario.rol;
  let filas;
  if (rol === 'dueno' || rol === 'admin' || rol === 'proveedor' || rol === 'almacen_central') {
    filas = await db.prepare(
      "SELECT * FROM transferencias WHERE estado = 'pendiente' ORDER BY fecha_envio DESC"
    ).all();
  } else if (ES_ALMACENERO_LIMITADO(rol)) {
    filas = await db.prepare(`
      SELECT * FROM transferencias
      WHERE estado = 'pendiente' AND destino_tipo = 'almacen' AND destino_almacen_id = ?
      ORDER BY fecha_envio DESC
    `).all(req.usuario.almacen_id);
  } else {
    // Cualquier otro rol (típicamente 'ventas') ve las suyas como
    // destinatario directo.
    filas = await db.prepare(`
      SELECT * FROM transferencias
      WHERE estado = 'pendiente' AND destino_tipo = 'ventas' AND destino_usuario_id = ?
      ORDER BY fecha_envio DESC
    `).all(req.usuario.id);
  }
  res.json(filas);
});

// Historial completo de transferencias (últimas 200, más recientes
// primero), con su estado, para la vista de historial.
router.get('/transferencias', async (req, res) => {
  const filas = await db.prepare(
    'SELECT * FROM transferencias ORDER BY fecha_envio DESC LIMIT 200'
  ).all();
  res.json(filas);
});

// Aceptar una transferencia pendiente: entra de verdad al destino.
router.post('/transferencias/:id/aceptar', async (req, res) => {
  const id = Number(req.params.id);

  const tx = db.transaction(async () => {
    const t = await db.prepare('SELECT * FROM transferencias WHERE id = ?').get(id);
    if (!t) throw Object.assign(new Error('Transferencia no encontrada.'), { status: 404 });
    if (t.estado !== 'pendiente') {
      throw Object.assign(new Error('Esa transferencia ya fue resuelta.'), { status: 400 });
    }
    if (!puedeResolverTransferencia(req, t)) {
      throw Object.assign(new Error('No tiene permiso para aceptar esta transferencia.'), { status: 403 });
    }

    if (t.destino_tipo === 'almacen') {
      // Igual que hacía antes el traslado directo: entra al almacén destino.
      await db.prepare(`
        INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
        VALUES (?, ?, 'entrada', ?, 'traslado', ?, ?)
      `).run(
        t.producto_id, t.destino_almacen_id, t.cantidad, req.usuario.id,
        `Transferencia aceptada desde ${t.origen_almacen_nombre || 'otro almacén'}`
      );
      await moverExistencia(t.producto_id, t.destino_almacen_id, t.cantidad);
    } else {
      // destino_tipo === 'ventas': entra en la hoja PROPIA del vendedor
      // (tabla venta_inventario), igual que POST /ventas/producto. Si ya
      // tiene ese producto (mismo nombre), suma cantidad en vez de duplicar.
      const existente = await db.prepare(
        'SELECT id FROM venta_inventario WHERE usuario_id = ? AND lower(nombre) = lower(?)'
      ).get(t.destino_usuario_id, t.producto_nombre);

      // La unidad del producto de almacén (abreviatura), para que la hoja
      // del vendedor la muestre igual que el resto de sus productos.
      const unidadProd = await db.prepare(`
        SELECT COALESCE(u.abreviatura, 'u') AS abreviatura
        FROM productos p LEFT JOIN unidades u ON u.id = p.unidad_id
        WHERE p.id = ?
      `).get(t.producto_id);

      if (existente) {
        await db.prepare('UPDATE venta_inventario SET cantidad = cantidad + ? WHERE id = ?')
          .run(t.cantidad, existente.id);
      } else {
        await db.prepare(`
          INSERT INTO venta_inventario (usuario_id, nombre, unidad, cantidad, costo_unitario, precio_venta)
          VALUES (?, ?, ?, ?, ?, 0)
        `).run(
          t.destino_usuario_id, t.producto_nombre, unidadProd?.abreviatura || 'u',
          t.cantidad, t.costo_unitario || 0
        );
      }
    }

    const resueltoNombre = (await nombreDeUsuario(req.usuario.id)) || req.usuario.usuario;
    await db.prepare(`
      UPDATE transferencias
      SET estado = 'aceptada', resuelto_por = ?, resuelto_nombre = ?, fecha_resolucion = now()
      WHERE id = ?
    `).run(req.usuario.id, resueltoNombre, id);

    return t;
  });

  try {
    const t = await tx();
    await anotar({
      tipo: 'almacen',
      concepto: `Transferencia aceptada — ${t.producto_nombre}`,
      producto: t.producto_nombre,
      cantidad: t.cantidad,
      unidad: '',
      costo: 0,
      ingreso: 0,
      valor: Number((t.cantidad * (t.costo_unitario || 0)).toFixed(2)),
      area: 'almacen',
      usuario: req.usuario,
      nota: `De ${t.origen_almacen_nombre || 'almacén'} a ${t.destino_nombre || (t.destino_tipo === 'almacen' ? 'almacén' : 'vendedor')} (transferencia aceptada)`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Cancelar una transferencia pendiente: la mercancía NO puede
// desaparecer —ya salió del origen cuando se envió—, así que vuelve.
router.post('/transferencias/:id/cancelar', async (req, res) => {
  const id = Number(req.params.id);

  const tx = db.transaction(async () => {
    const t = await db.prepare('SELECT * FROM transferencias WHERE id = ?').get(id);
    if (!t) throw Object.assign(new Error('Transferencia no encontrada.'), { status: 404 });
    if (t.estado !== 'pendiente') {
      throw Object.assign(new Error('Esa transferencia ya fue resuelta.'), { status: 400 });
    }
    if (!puedeResolverTransferencia(req, t)) {
      throw Object.assign(new Error('No tiene permiso para cancelar esta transferencia.'), { status: 403 });
    }

    await db.prepare(`
      INSERT INTO movimientos (producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota)
      VALUES (?, ?, 'entrada', ?, 'traslado', ?, 'Devolución por transferencia cancelada')
    `).run(t.producto_id, t.origen_almacen_id, t.cantidad, req.usuario.id);
    await moverExistencia(t.producto_id, t.origen_almacen_id, t.cantidad);

    const resueltoNombre = (await nombreDeUsuario(req.usuario.id)) || req.usuario.usuario;
    await db.prepare(`
      UPDATE transferencias
      SET estado = 'cancelada', resuelto_por = ?, resuelto_nombre = ?, fecha_resolucion = now()
      WHERE id = ?
    `).run(req.usuario.id, resueltoNombre, id);

    return t;
  });

  try {
    const t = await tx();
    await anotar({
      tipo: 'almacen',
      concepto: `Transferencia cancelada — ${t.producto_nombre}`,
      producto: t.producto_nombre,
      cantidad: t.cantidad,
      unidad: '',
      costo: 0,
      ingreso: 0,
      valor: Number((t.cantidad * (t.costo_unitario || 0)).toFixed(2)),
      area: 'almacen',
      usuario: req.usuario,
      nota: `Devuelto a ${t.origen_almacen_nombre || 'almacén de origen'} (transferencia cancelada)`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Lista de almacenes (para los formularios).
// Un almacenero solo ve el suyo por defecto. Pasando ?todos=1 se
// devuelven todos (por ejemplo, para elegir un almacén de DESTINO al
// dar salida con traslado). El dueño siempre ve todos.
router.get('/almacenes', async (req, res) => {
  const limiteAlmacen = almacenDeLaSesion(req);
  if (limiteAlmacen && !req.query.todos) {
    const propio = await db.prepare('SELECT * FROM almacenes WHERE id = ?').get(limiteAlmacen);
    return res.json(propio ? [propio] : []);
  }
  res.json(await db.prepare('SELECT * FROM almacenes ORDER BY nombre').all());
});

// Lista de unidades de medida (para crear productos).
router.get('/unidades', async (req, res) => {
  res.json(await db.prepare('SELECT * FROM unidades ORDER BY id').all());
});

export default router;

