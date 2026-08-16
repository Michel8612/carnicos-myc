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
import { resolverCosto } from '../servicios/monedas.js';

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

// ------------------------------------------------------------
//  QUITAR EL DINERO DE LAS RESPUESTAS (Parte 6)
//
//  El almacenero trabaja con productos, cantidades y unidades: los
//  precios y costos no son asunto suyo. Se quitan AQUÍ, en el servidor,
//  y no escondiéndolos con CSS en la pantalla: si el servidor los
//  enviara igual, bastarían dos clics en el navegador para leerlos, y
//  eso no sería ocultarlos sino disimularlos.
//
//  El dueño, el proveedor y contabilidad los siguen viendo enteros. El
//  almacén central también es almacén: tampoco ve dinero.
// ------------------------------------------------------------
const CAMPOS_DE_DINERO = [
  'precio_costo', 'precio_venta', 'costo_unitario', 'costo',
  'costo_unitario_cup', 'costo_unitario_usd', 'tasa_usada',
  'valor_costo', 'valor_venta', 'ganancia_potencial',
];

function puedeVerDinero(rol) {
  return ES_ADMIN_TOTAL(rol) || rol === 'contabilidad';
}

function sinDinero(datos, rol) {
  if (puedeVerDinero(rol)) return datos;
  const limpiar = (o) => {
    if (!o || typeof o !== 'object') return o;
    const copia = { ...o };
    for (const c of CAMPOS_DE_DINERO) delete copia[c];
    return copia;
  };
  return Array.isArray(datos) ? datos.map(limpiar) : limpiar(datos);
}

router.get('/productos', async (req, res) => {
  const filas = await db.prepare(`
    SELECT p.*, u.abreviatura AS unidad
    FROM productos p
    LEFT JOIN unidades u ON u.id = p.unidad_id
    WHERE p.activo = 1
    ORDER BY p.nombre
  `).all();
  res.json(sinDinero(filas, req.usuario?.rol));
});

// Crear producto nuevo (el dueño amplía su catálogo sin tocar código).
//
// Además, de forma OPCIONAL, acepta ya una cantidad inicial: si vienen
// `cantidad` y `almacen_id`, en la MISMA transacción se crea el producto
// y se registra una ENTRADA por esa cantidad — el mismo camino que sigue
// una entrada normal (POST /movimientos, tipo 'entrada'), para que quede
// en el historial de movimientos como lo que es y no como un atajo que
// mete existencia sin dejar rastro. Si no vienen, el producto se crea
// exactamente igual que siempre, sin existencia (el flujo de antes no
// cambia en nada).
router.post('/productos', async (req, res) => {
  const { nombre, tipo, categoria, unidad_id, precio_venta, stock_minimo } = req.body;
  const { almacen_id } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'Indique nombre y tipo del producto.' });

  // El costo se puede declarar en pesos, en dólares o en ambos. Muchas
  // compras se hacen EN DÓLARES y obligar a teclear el equivalente en pesos
  // hacía que el dueño tuviera que sacar la cuenta a mano cada vez, con la
  // tasa cambiando a diario. Ahora escribe la moneda en que compró de verdad
  // y el sistema calcula la otra.
  const costoAlta = await resolverCosto({
    costo_cup: req.body.precio_costo,
    costo_usd: req.body.precio_costo_usd,
    moneda_origen: req.body.moneda_origen,
    tasa: req.body.tasa,
  });
  // En la ficha del producto el precio de costo vive en pesos: es la moneda
  // en la que suman el inventario y la contabilidad.
  const precio_costo = costoAlta.cup ?? 0;

  const cantidadInicial = Number(req.body.cantidad) || 0;
  if (cantidadInicial > 0) {
    if (!almacen_id) {
      return res.status(400).json({ error: 'Indique el almacén de la cantidad inicial.' });
    }
    // Mismo límite que ya aplica en POST /movimientos: un almacenero
    // solo puede meter existencia en SU propio almacén.
    const limiteAlmacen = almacenDeLaSesion(req);
    if (limiteAlmacen && Number(almacen_id) !== Number(limiteAlmacen)) {
      return res.status(403).json({ error: 'Solo puede dar entrada en su propio almacén.' });
    }
  }

  let productoId = null;
  const tx = db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO productos (nombre, tipo, categoria, unidad_id, precio_costo, precio_venta, stock_minimo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(nombre, tipo, categoria || null, unidad_id || null, precio_costo || 0, precio_venta || 0, stock_minimo || 0);
    productoId = r.lastInsertRowid;

    if (cantidadInicial > 0) {
      // Se archiva el costo IGUAL que en una entrada normal. Antes no se
      // hacía, y el resultado era que dar de alta un producto con cantidad
      // inicial dejaba una entrada "sin costo": el valor del inventario y
      // las entradas por fecha salían en cero aunque el producto tuviera su
      // precio en la ficha. Fue justo lo que reportó el cliente.
      await db.prepare(`
        INSERT INTO movimientos (
          producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota,
          costo_unitario_cup, costo_unitario_usd, moneda_origen, tasa_usada
        ) VALUES (?, ?, 'entrada', ?, 'manual', ?, ?, ?, ?, ?, ?)
      `).run(
        productoId, almacen_id, cantidadInicial, req.usuario.id,
        'Alta de producto con cantidad inicial',
        costoAlta.cup, costoAlta.usd, costoAlta.moneda_origen, costoAlta.tasa,
      );
      await moverExistencia(productoId, almacen_id, cantidadInicial);
    }
  });

  try {
    await tx();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Fuera de la transacción (mismo patrón que POST /movimientos): dejar
  // el mismo rastro en el libro de Contabilidad que deja cualquier
  // entrada normal, para que el contador la vea igual que a cualquier
  // otra.
  if (cantidadInicial > 0) {
    const [alm, unidadInfo] = await Promise.all([
      db.prepare('SELECT nombre FROM almacenes WHERE id = ?').get(almacen_id),
      unidad_id ? db.prepare('SELECT abreviatura FROM unidades WHERE id = ?').get(unidad_id) : null,
    ]);
    const valor = Number((cantidadInicial * (Number(precio_costo) || 0)).toFixed(2));
    await anotar({
      tipo: 'almacen',
      concepto: `Entrada de almacén — ${nombre}`,
      producto: nombre,
      cantidad: cantidadInicial,
      unidad: unidadInfo?.abreviatura || null,
      // Igual que en POST /movimientos: mover mercancía no es ganancia
      // ni pérdida, así que costo/ingreso van en cero y el valor queda
      // solo de referencia.
      costo: 0,
      ingreso: 0,
      valor,
      area: 'almacen',
      usuario: req.usuario,
      nota: [alm?.nombre, 'Alta de producto con cantidad inicial'].filter(Boolean).join(' · '),
    });
  }

  res.json({ id: productoId });
});

// Editar un producto existente.
router.put('/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, tipo, categoria, unidad_id, precio_venta, stock_minimo } = req.body;
  if (!nombre || !tipo) return res.status(400).json({ error: 'Indique nombre y tipo.' });

  const antes = await db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  if (!antes) return res.status(404).json({ error: 'Ese producto no existe.' });

  // Igual que en el alta: se puede escribir el costo en dólares y el peso
  // sale solo. El costo de compra cambia de un día para otro, así que poder
  // corregirlo sin dar de baja el producto es imprescindible.
  const costo = await resolverCosto({
    costo_cup: req.body.precio_costo,
    costo_usd: req.body.precio_costo_usd,
    moneda_origen: req.body.moneda_origen,
    tasa: req.body.tasa,
  });
  // Si no se declara ningún costo, se conserva el que tenía: editar el
  // nombre no puede dejar el producto a cero sin querer.
  const precioCosto = costo.cup ?? (Number(antes.precio_costo) || 0);

  await db.prepare(`
    UPDATE productos
    SET nombre = ?, tipo = ?, categoria = ?, unidad_id = ?, precio_costo = ?, precio_venta = ?, stock_minimo = ?
    WHERE id = ?
  `).run(nombre, tipo, categoria || null, unidad_id || null, precioCosto,
         precio_venta ?? antes.precio_venta ?? 0, stock_minimo ?? antes.stock_minimo ?? 0, id);

  // Cambiar un precio es un hecho económico: mueve el valor del inventario y
  // el margen. Tiene que quedar quién lo hizo y desde qué cifra.
  if (Number(antes.precio_costo) !== Number(precioCosto)) {
    await auditar({
      modulo: 'almacen', accion: 'modificar', req, entidad: 'productos', entidad_id: id,
      descripcion: `Precio de costo de ${nombre}: ${antes.precio_costo} → ${precioCosto} CUP`
                 + (costo.usd ? ` (${costo.usd} USD a ${costo.tasa})` : ''),
      antes: { precio_costo: antes.precio_costo }, despues: { precio_costo: precioCosto },
    });
  }

  res.json({ ok: true, precio_costo: precioCosto, precio_costo_usd: costo.usd, tasa: costo.tasa, aviso: costo.aviso });
});

// Eliminar un producto. Si ya tiene movimientos, no se borra de
// verdad (se desactiva) para no romper el historial. Si nunca se
// usó, se borra del todo.
// Dónde puede estar enganchado un producto. Antes solo se miraban los
// movimientos, y al borrar uno que estaba en una RECETA la base lo
// rechazaba: al usuario le llegaba el error crudo de Postgres, ilegible.
// Doce tablas apuntan a `productos`; estas son las que el dueño entiende.
const USOS_DE_PRODUCTO = [
  { tabla: 'receta_ingredientes', campo: 'producto_id',       etiqueta: 'receta(s)' },
  { tabla: 'producciones',        campo: 'producto_final_id', etiqueta: 'producción(es)' },
  { tabla: 'produccion_consumo',  campo: 'producto_id',       etiqueta: 'producción(es) que lo consumieron' },
  { tabla: 'produccion_disponible', campo: 'producto_id',     etiqueta: 'producción(es) esperando entrada' },
  { tabla: 'compras_detalle',     campo: 'producto_id',       etiqueta: 'compra(s)' },
  { tabla: 'transferencias',      campo: 'producto_id',       etiqueta: 'transferencia(s)' },
  { tabla: 'jornada_ventas',      campo: 'producto_id',       etiqueta: 'jornada(s) de venta' },
  { tabla: 'conciliacion_lineas', campo: 'producto_id',       etiqueta: 'conteo(s) físico(s)' },
  { tabla: 'ipv_diario_lineas',   campo: 'producto_id',       etiqueta: 'parte(s) de IPV' },
  { tabla: 'movimientos',         campo: 'producto_id',       etiqueta: 'movimiento(s) de almacén' },
];

async function dondeSeUsaElProducto(id) {
  const usos = [];
  for (const u of USOS_DE_PRODUCTO) {
    try {
      const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${u.tabla} WHERE ${u.campo} = ?`).get(id);
      if (Number(r.n) > 0) usos.push(`${r.n} ${u.etiqueta}`);
    } catch {
      // Una tabla que no exista en esta instalación no puede impedir el
      // borrado: se ignora y se sigue mirando las demás.
    }
  }
  return usos;
}

// Borrar un producto, u ocultarlo si su historial no lo permite.
//
// El dueño puede pedir el borrado de dos maneras:
//   · normal            -> si está enganchado en algún sitio, NO se toca y
//                          se le explica dónde, para que decida.
//   · ?ocultar=1        -> se acepta esconderlo conservando el historial.
router.delete('/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const producto = await db.prepare('SELECT id, nombre, activo FROM productos WHERE id = ?').get(id);
  if (!producto) return res.status(404).json({ error: 'Ese producto ya no existe.' });

  const usos = await dondeSeUsaElProducto(id);
  const enExistencias = Number((await db.prepare(
    'SELECT COALESCE(SUM(cantidad),0) AS c FROM existencias WHERE producto_id = ?'
  ).get(id)).c) || 0;

  const aceptaOcultar = req.query.ocultar === '1' || req.body?.ocultar === true;

  if (usos.length || enExistencias > 0) {
    const motivos = [...usos];
    if (enExistencias > 0) motivos.push(`${enExistencias} en existencia`);

    if (!aceptaOcultar) {
      // Se DEVUELVE el porqué en vez de decidir por él. Borrar el historial
      // de un producto sería borrar contabilidad; ocultarlo es otra cosa y
      // tiene que elegirla una persona.
      return res.status(409).json({
        error: `"${producto.nombre}" no se puede borrar porque está usado en: ${motivos.join(', ')}. `
             + 'Se puede OCULTAR: deja de aparecer en las listas y su historial se conserva.',
        se_puede_ocultar: true,
        usos: motivos,
      });
    }

    await db.prepare('UPDATE productos SET activo = 0 WHERE id = ?').run(id);
    await auditar({
      modulo: 'almacen', accion: 'modificar', req, entidad: 'productos', entidad_id: id,
      descripcion: `Producto "${producto.nombre}" ocultado (usado en: ${motivos.join(', ')})`,
    });
    return res.json({ ok: true, ocultado: true, usos: motivos });
  }

  // No está enganchado en ningún sitio: se borra de verdad.
  await db.prepare('DELETE FROM existencias WHERE producto_id = ?').run(id);
  await db.prepare('DELETE FROM productos WHERE id = ?').run(id);
  await auditar({
    modulo: 'almacen', accion: 'eliminar', req, entidad: 'productos', entidad_id: id,
    descripcion: `Producto "${producto.nombre}" eliminado (no tenía historial)`,
    antes: producto,
  });
  res.json({ ok: true, eliminado: true });
});

// ---------- Productos ocultos: verlos y recuperarlos ----------
// Sin esto, ocultar sería un viaje de ida: el producto desaparece y no hay
// forma de traerlo de vuelta sin tocar la base a mano.
router.get('/productos/ocultos', async (req, res) => {
  const filas = await db.prepare(`
    SELECT p.id, p.nombre, p.tipo, u.abreviatura AS unidad
      FROM productos p LEFT JOIN unidades u ON u.id = p.unidad_id
     WHERE p.activo = 0 ORDER BY p.nombre
  `).all();
  res.json(filas);
});

router.post('/productos/:id/mostrar', async (req, res) => {
  const id = Number(req.params.id);
  const p = await db.prepare('SELECT id, nombre FROM productos WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Ese producto no existe.' });
  await db.prepare('UPDATE productos SET activo = 1 WHERE id = ?').run(id);
  await auditar({
    modulo: 'almacen', accion: 'modificar', req, entidad: 'productos', entidad_id: id,
    descripcion: `Producto "${p.nombre}" vuelto a mostrar`,
  });
  res.json({ ok: true });
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

  res.json(sinDinero(resultado, req.usuario?.rol));
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
  // Costo en las dos monedas. `costo_unitario` se sigue admitiendo como
  // antes (se entiende en CUP) para no romper lo que ya llamaba a esta ruta.
  const { costo_cup, costo_usd, moneda_origen, tasa } = req.body;
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

  // El costo se resuelve ANTES de abrir la transacción: consultar la tasa
  // puede tardar (sale a internet) y no conviene tener la conexión de la
  // base retenida mientras tanto.
  //
  // Solo se archiva costo en las ENTRADAS. Una salida o un ajuste no
  // compran nada: ponerles precio de compra ensuciaría el valor del
  // inventario, que se calcula sumando lo que entró.
  const costo = tipo === 'entrada'
    ? await resolverCosto({
        costo_cup: costo_cup ?? costo_unitario,
        costo_usd,
        moneda_origen,
        tasa,
      })
    : { cup: null, usd: null, moneda_origen: null, tasa: null, aviso: null };

  const tx = db.transaction(async () => {
    // 1) Movimiento principal (entrada/salida/ajuste) en el almacén de origen.
    await db.prepare(`
      INSERT INTO movimientos (
        producto_id, almacen_id, tipo, cantidad, origen_tipo, usuario_id, nota,
        costo_unitario_cup, costo_unitario_usd, moneda_origen, tasa_usada
      ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)
    `).run(
      producto_id, almacen_id, tipo, cant, req.usuario.id, nota || null,
      costo.cup, costo.usd, costo.moneda_origen, costo.tasa,
    );

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
      // El costo en CUP es el de referencia para el total de la compra; si no
      // se declaró ninguno, se cae al precio de costo que ya tenga el producto.
      const costoUnit = costo.cup ?? (Number(prod?.precio_costo) || 0);
      // `moneda` y `tasa_cambio` existían en la tabla pero iban fijas en
      // 'CUP' y 1: ahora guardan lo que realmente se pagó. Así una compra
      // hecha en dólares deja constancia de que lo fue.
      //
      // OJO CON LA LECTURA: `costo_total` va SIEMPRE en CUP, también cuando
      // `moneda` dice 'USD'. `moneda` no describe a `costo_total`, sino la
      // moneda en que se pagó de verdad. Se mantiene así porque todo lo que
      // ya lee esta tabla (tributación, informes) suma en moneda nacional, y
      // cambiar la unidad a mitad del historial mezclaría pesos con dólares
      // en la misma columna. El importe original se recupera dividiendo:
      // costo_total / tasa_cambio.
      const compra = await db.prepare(`
        INSERT INTO compras (tipo, proveedor, almacen_id, costo_total, moneda, tasa_cambio, referencia, usuario_id)
        VALUES ('nacional', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(proveedor).trim(), almacen_id, cant * costoUnit,
        costo.moneda_origen || 'CUP', costo.tasa ?? 1,
        nota || null, req.usuario.id,
      );
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

    // Se devuelve el costo tal como quedó archivado (los dos importes y la
    // tasa) para que la pantalla pueda confirmarle al usuario a qué cambio
    // se guardó, y el aviso si no se pudo convertir por falta de tasa.
    res.json({
      ok: true,
      transferencia_id: transferenciaId,
      costo: {
        cup: costo.cup, usd: costo.usd,
        moneda_origen: costo.moneda_origen, tasa: costo.tasa,
      },
      aviso: costo.aviso,
    });
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

  res.json(sinDinero(filas, req.usuario?.rol));
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
// ------------------------------------------------------------
//  VALOR DEL INVENTARIO Y ENTRADAS POR FECHA (Parte 7)
//
//  Responde dos preguntas distintas que conviene no mezclar:
//
//   1. "¿Cuánto compré y cuándo?"  -> `por_fecha` y `compras`. Es un dato
//      EXACTO: sale de lo que quedó archivado en cada entrada, con su
//      importe en las dos monedas y la tasa de aquel día.
//
//   2. "¿Cuánto vale lo que tengo hoy?" -> `inventario`. Es una
//      ESTIMACIÓN, y hay que decirlo. Lo que hay en existencia no se
//      puede casar con las entradas concretas de las que salió: no se
//      lleva lotes, y la mercancía entra y sale mezclada. Se valora al
//      costo medio de compra de cada producto, que es el criterio
//      habitual y el único que los datos permiten sostener.
//
//  Solo lo ve quien puede ver dinero: el almacenero trabaja con
//  cantidades, no con costos (ver Parte 6).
// ------------------------------------------------------------
router.get('/valor', async (req, res) => {
  const rol = req.usuario?.rol;
  if (!ES_ADMIN_TOTAL(rol) && rol !== 'contabilidad') {
    return res.status(403).json({ error: 'No tiene permiso para ver los valores del inventario.' });
  }

  const { desde, hasta, almacen_id } = req.query;
  const cond = ["m.tipo = 'entrada'"];
  const params = [];
  if (desde) { cond.push('m.fecha >= ?'); params.push(desde); }
  if (hasta) { cond.push('m.fecha <= ?'); params.push(`${hasta} 23:59:59`); }
  if (almacen_id) { cond.push('m.almacen_id = ?'); params.push(Number(almacen_id)); }
  const where = `WHERE ${cond.join(' AND ')}`;

  // ---- Entradas agrupadas por día ----
  // Se agrupa en hora de Cuba: si se usara UTC, lo que entró a las 8 de
  // la noche aparecería con la fecha del día siguiente.
  const porFecha = await db.prepare(`
    SELECT (m.fecha AT TIME ZONE 'America/Havana')::date AS fecha,
           COUNT(*)                                            AS entradas,
           COALESCE(SUM(m.cantidad), 0)                        AS cantidad,
           COALESCE(SUM(m.cantidad * COALESCE(m.costo_unitario_cup, 0)), 0) AS valor_cup,
           COALESCE(SUM(m.cantidad * COALESCE(m.costo_unitario_usd, 0)), 0) AS valor_usd,
           COUNT(*) FILTER (WHERE m.costo_unitario_cup IS NULL) AS sin_costo
      FROM movimientos m
      ${where}
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT 180
  `).all(...params);

  // ---- Lo comprado, separado por la moneda en que se PAGÓ ----
  const porMoneda = await db.prepare(`
    SELECT COALESCE(m.moneda_origen, 'CUP') AS moneda,
           COALESCE(SUM(m.cantidad * COALESCE(m.costo_unitario_cup, 0)), 0) AS cup,
           COALESCE(SUM(m.cantidad * COALESCE(m.costo_unitario_usd, 0)), 0) AS usd
      FROM movimientos m
      ${where}
       AND m.costo_unitario_cup IS NOT NULL
     GROUP BY 1
  `).all(...params);

  // ---- Valor de lo que hay HOY en existencia ----
  // El costo medio sale de las entradas que SÍ declararon costo. Para el
  // USD no se usa la tasa de hoy: se usa la tasa media a la que se compró
  // ese producto, que es lo que de verdad costó en dólares.
  const filas = await db.prepare(`
    WITH costos AS (
      SELECT producto_id,
             SUM(cantidad * costo_unitario_cup) / NULLIF(SUM(cantidad), 0) AS medio_cup,
             SUM(cantidad * costo_unitario_usd) / NULLIF(SUM(cantidad), 0) AS medio_usd
        FROM movimientos
       WHERE tipo = 'entrada' AND costo_unitario_cup IS NOT NULL
       GROUP BY producto_id
    )
    SELECT p.id, p.nombre, COALESCE(SUM(e.cantidad), 0) AS cantidad,
           c.medio_cup, c.medio_usd, p.precio_costo
      FROM productos p
      JOIN existencias e ON e.producto_id = p.id
      LEFT JOIN costos c ON c.producto_id = p.id
     WHERE p.activo = 1 ${almacen_id ? 'AND e.almacen_id = ?' : ''}
     GROUP BY p.id, p.nombre, c.medio_cup, c.medio_usd, p.precio_costo
    HAVING COALESCE(SUM(e.cantidad), 0) > 0
  `).all(...(almacen_id ? [Number(almacen_id)] : []));

  let invCup = 0, invUsd = 0, sinCosto = 0;
  for (const f of filas) {
    const cantidad = Number(f.cantidad) || 0;
    // Si el producto nunca tuvo una entrada con costo, se cae a su
    // precio de costo de ficha. Se cuenta aparte para poder avisarlo.
    const medioCup = f.medio_cup != null ? Number(f.medio_cup) : Number(f.precio_costo) || 0;
    if (f.medio_cup == null) sinCosto += 1;
    invCup += cantidad * medioCup;
    // El USD solo se suma si ese producto se compró alguna vez con
    // importe en dólares. No se convierte a la tasa de hoy: eso haría
    // que el valor del inventario cambiara solo cada mañana.
    if (f.medio_usd != null) invUsd += cantidad * Number(f.medio_usd);
  }

  const redondear = (n) => Number((Number(n) || 0).toFixed(2));

  res.json({
    inventario: {
      cup: redondear(invCup),
      usd: redondear(invUsd),
      productos: filas.length,
      productos_sin_costo: sinCosto,
      criterio: 'Es el mismo inventario visto en dos monedas, no dos cifras que se sumen. '
              + 'Cada producto se valora al costo medio de sus compras, y el importe en '
              + 'dólares usa la tasa a la que se compró de verdad, no la de hoy: por eso '
              + 'no cambia solo cuando se mueve el dólar.',
    },
    compras: {
      cup: redondear(porMoneda.reduce((s, f) => s + Number(f.cup), 0)),
      usd: redondear(porMoneda.reduce((s, f) => s + Number(f.usd), 0)),
      por_moneda: porMoneda.map((f) => ({
        moneda: f.moneda, cup: redondear(f.cup), usd: redondear(f.usd),
      })),
    },
    por_fecha: porFecha.map((f) => ({
      fecha: f.fecha,
      entradas: Number(f.entradas),
      cantidad: redondear(f.cantidad),
      valor_cup: redondear(f.valor_cup),
      valor_usd: redondear(f.valor_usd),
      sin_costo: Number(f.sin_costo),
    })),
  });
});


// ---------- PUT /destinos/:tipo/:id : dirección y teléfono ----------
// Hacen falta para el aviso al transportista. Se editan aquí y no en una
// pantalla aparte porque es donde se usan: quien manda la mercancía es
// quien se da cuenta de que falta la dirección.
router.put('/destinos/:tipo/:id', async (req, res) => {
  const { tipo, id } = req.params;
  if (!['almacen', 'ventas'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de destino no válido.' });
  }
  const direccion = (req.body?.direccion ?? '').toString().trim() || null;
  const telefono = (req.body?.telefono ?? '').toString().trim() || null;

  const tabla = tipo === 'almacen' ? 'almacenes' : 'usuarios';
  const antes = await db.prepare(`SELECT id, nombre, direccion, telefono FROM ${tabla} WHERE id = ?`).get(Number(id));
  if (!antes) return res.status(404).json({ error: 'Ese destino no existe.' });

  await db.prepare(`UPDATE ${tabla} SET direccion = ?, telefono = ? WHERE id = ?`)
    .run(direccion, telefono, Number(id));

  await auditar({
    modulo: 'almacen', accion: 'modificar', req, entidad: tabla, entidad_id: Number(id),
    descripcion: `Dirección/teléfono de ${antes.nombre}`,
    antes, despues: { ...antes, direccion, telefono },
  });

  res.json({ ok: true, direccion, telefono });
});

// ---------- GET /puntos-venta : que hay en cada punto de venta ----------
//
// El almacenero surte los puntos de venta, asi que necesita saber que les
// queda ANTES de mandar mercancia. Hasta ahora el inventario de cada
// vendedor era suyo y nadie mas lo veia: el almacenero mandaba a ciegas.
//
// Es SOLO DE CONSULTA. Mover la mercancia sigue siendo cosa del vendedor
// en su hoja, o del almacenero por una transferencia normal, que deja su
// rastro y necesita que el destinatario la acepte. Dejar que el almacenero
// tocara el inventario ajeno sin rastro seria abrir un agujero.
//
// El dinero se filtra como en todas partes: el almacenero ve cantidades,
// no precios (ver sinDinero).
router.get('/puntos-venta', async (req, res) => {
  const rol = req.usuario?.rol;
  const puedeVer = ES_ADMIN_TOTAL(rol) || rol === 'contabilidad'
    || ES_ALMACENERO_LIMITADO(rol) || rol === 'almacen_central';
  if (!puedeVer) {
    return res.status(403).json({ error: 'No tiene permiso para ver los puntos de venta.' });
  }

  const filas = await db.prepare(`
    SELECT u.id AS punto_id, u.nombre AS punto,
           v.id, v.nombre AS producto, v.unidad,
           v.cantidad, v.vendido, v.costo_unitario, v.precio_venta
      FROM venta_inventario v
      JOIN usuarios u ON u.id = v.usuario_id
     WHERE u.activo = 1
     ORDER BY u.nombre, v.nombre
  `).all();

  // Se agrupa por punto para que la pantalla no tenga que hacerlo.
  const puntos = new Map();
  for (const f of filas) {
    if (!puntos.has(f.punto_id)) {
      puntos.set(f.punto_id, { id: f.punto_id, nombre: f.punto, productos: [], total_productos: 0 });
    }
    const p = puntos.get(f.punto_id);
    p.productos.push(sinDinero({
      id: f.id, producto: f.producto, unidad: f.unidad,
      cantidad: Number(f.cantidad), vendido: Number(f.vendido),
      costo_unitario: f.costo_unitario, precio_venta: f.precio_venta,
    }, rol));
    p.total_productos += 1;
  }

  res.json([...puntos.values()]);
});

router.get('/destinos', async (req, res) => {
  // Si quien consulta es un almacenero con almacén propio, no tiene
  // sentido que se ofrezca a sí mismo como destino de su propia salida.
  const origenId = almacenDeLaSesion(req);

  // Se traen también dirección y teléfono: con ellos la pantalla arma el
  // aviso de WhatsApp para el transportista sin tener que pedir el dato a
  // mano en cada envío. No son datos sensibles (el almacenero tiene que
  // saber a dónde manda la mercancía), así que no se filtran por rol.
  const almacenes = await db.prepare(
    'SELECT id, nombre, direccion, telefono FROM almacenes ORDER BY nombre'
  ).all();
  const vendedores = await db.prepare(
    "SELECT id, nombre, direccion, telefono FROM usuarios WHERE activo = 1 AND rol = 'ventas' ORDER BY nombre"
  ).all();

  const destinos = [
    ...almacenes
      .filter((a) => !origenId || Number(a.id) !== Number(origenId))
      .map((a) => ({ tipo: 'almacen', id: a.id, nombre: a.nombre, direccion: a.direccion, telefono: a.telefono })),
    ...vendedores.map((v) => ({
      tipo: 'ventas', id: v.id, nombre: `${v.nombre} (Ventas)`,
      direccion: v.direccion, telefono: v.telefono,
    })),
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
  res.json(sinDinero(filas, req.usuario?.rol));
});

// Historial completo de transferencias (últimas 200, más recientes
// primero), con su estado, para la vista de historial.
router.get('/transferencias', async (req, res) => {
  const filas = await db.prepare(
    'SELECT * FROM transferencias ORDER BY fecha_envio DESC LIMIT 200'
  ).all();
  res.json(sinDinero(filas, req.usuario?.rol));
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

