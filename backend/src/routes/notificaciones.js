// ============================================================
//  CENTRO DE NOTIFICACIONES
//
//  Avisos que le tocan a un usuario según su rol (o a TODOS, si
//  destino_rol es nulo). No viven solo en pantalla: se guardan en la
//  tabla `notificaciones` (ver schema.sql), así que un aviso de la
//  mañana sigue ahí aunque nadie haya tenido la pestaña abierta.
//
//  "Leída" es POR USUARIO, no por notificación: `leida_por` guarda una
//  lista de ids separados por coma, y solo se le AÑADE el propio id al
//  marcar leída (nunca se reemplaza la lista). Así, si un aviso es para
//  todo el rol "almacén", que un almacenero la lea no se la borra a
//  los demás.
//
//  El montaje en server.js ya trae requiereSesion — aquí no hace
//  falta repetirlo.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

// Quién ve TODO sin que le filtren por destino_rol: el dueño y quien
// hace de dueño (admin/proveedor). Mismo criterio que el resto del
// sistema (ver p. ej. inventario.js/ES_ADMIN_TOTAL): las cifras y
// avisos del negocio no se le esconden a quien lo dirige.
const ES_JEFE = (rol) => rol === 'dueno' || rol === 'admin' || rol === 'proveedor';

// `destino_rol` guarda un solo valor, pero el rol de "almacén" tiene
// varios nombres históricos en este sistema (ver inventario.js:
// ES_ALMACENERO_LIMITADO usa 'almacen' Y 'almacenero'; recetas.js suma
// además 'almacen_central' para dar-entrada). Para no duplicar una
// notificación tres veces, destino_rol='almacen' se guarda UNA vez y
// aquí se expande al grupo completo de roles que deben verla.
const GRUPOS_ROL = {
  almacen: ['almacen', 'almacenero', 'almacen_central'],
};

// ¿Esta notificación le toca a ESTE usuario?
function leTocaAlUsuario(fila, usuario) {
  // Dirigida a una persona concreta: manda eso y nada más. Se comprueba
  // antes que el rol porque un aviso con destinatario NO es "para
  // todos" aunque no lleve destino_rol.
  if (fila.destino_usuario_id != null) {
    return Number(fila.destino_usuario_id) === Number(usuario.id);
  }
  if (!fila.destino_rol) return true; // nulo = para todos
  if (fila.destino_rol === usuario.rol) return true;
  const grupo = GRUPOS_ROL[fila.destino_rol];
  return Array.isArray(grupo) && grupo.includes(usuario.rol);
}

// ¿Ya la leyó ESTE usuario? Comparación como texto exacto (no con
// "incluye", para que el id 2 no haga match con el id 12).
function yaLeida(leidaPor, usuarioId) {
  return (leidaPor || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(usuarioId));
}

// Filtro SQL + en memoria: primero se trae de la base lo que aplicaría
// por destino_rol simple (NULL o el propio rol) y, si el usuario es de
// un grupo (almacén), se completa con lo que aplique a ese grupo. Se
// hace así en dos pasos para no tener que escribir SQL dinámico por
// cada grupo nuevo que aparezca en el futuro.
async function notificacionesPara(usuario, limite = 200) {
  const rol = usuario.rol;
  const esJefe = ES_JEFE(rol);

  if (esJefe) {
    return db.prepare(`
      SELECT * FROM notificaciones ORDER BY creada_en DESC LIMIT ?
    `).all(limite);
  }

  // Roles que, además del propio, hay que aceptar como destino_rol
  // (el grupo al que pertenece este usuario, si pertenece a alguno).
  const gruposDelUsuario = Object.entries(GRUPOS_ROL)
    .filter(([, roles]) => roles.includes(rol))
    .map(([clave]) => clave);

  const destinosValidos = [rol, ...gruposDelUsuario];
  const placeholders = destinosValidos.map(() => '?').join(',');

  // Tres formas de que un aviso sea suyo: va a su nombre, no va a nadie
  // en particular (para todos), o va a su rol. Los avisos con
  // destinatario ajeno quedan fuera aquí mismo, en la consulta: así el
  // vendedor de una tienda no ve lo que se le manda a otra.
  return db.prepare(`
    SELECT * FROM notificaciones
    WHERE destino_usuario_id = ?
       OR (destino_usuario_id IS NULL
           AND (destino_rol IS NULL OR destino_rol IN (${placeholders})))
    ORDER BY creada_en DESC
    LIMIT ?
  `).all(usuario.id, ...destinosValidos, limite);
}

// ---------- GET / : las que le tocan al usuario, con si ya la leyó ----------
router.get('/', async (req, res) => {
  const filas = await notificacionesPara(req.usuario);
  res.json(filas.map((f) => ({
    ...f,
    leida: yaLeida(f.leida_por, req.usuario.id),
  })));
});

// ---------- GET /contador : cuántas sin leer (pinta la campanita) ----------
router.get('/contador', async (req, res) => {
  const filas = await notificacionesPara(req.usuario, 1000);
  const sinLeer = filas.filter((f) => !yaLeida(f.leida_por, req.usuario.id)).length;
  res.json({ sin_leer: sinLeer });
});

// ---------- POST /:id/leida : marcar leída SOLO para este usuario ----------
router.post('/:id/leida', async (req, res) => {
  const id = Number(req.params.id);
  const fila = await db.prepare('SELECT * FROM notificaciones WHERE id = ?').get(id);
  if (!fila) return res.status(404).json({ error: 'Notificación no encontrada.' });
  if (!ES_JEFE(req.usuario.rol) && !leTocaAlUsuario(fila, req.usuario)) {
    return res.status(403).json({ error: 'Esta notificación no es para su rol.' });
  }

  if (!yaLeida(fila.leida_por, req.usuario.id)) {
    // Se AÑADE el id a la lista existente, nunca se reemplaza: así no
    // se le quita la marca de "sin leer" a los demás destinatarios de
    // este mismo aviso (p. ej. otro almacenero del mismo rol).
    const actuales = (fila.leida_por || '').split(',').map((s) => s.trim()).filter(Boolean);
    actuales.push(String(req.usuario.id));
    await db.prepare('UPDATE notificaciones SET leida_por = ? WHERE id = ?')
      .run(actuales.join(','), id);
  }

  res.json({ ok: true });
});

// ---------- POST /leer-todas : vaciar la campanita de un tirón ----------
// El centro de avisos acumula: quien vuelve de un día libre puede tener
// veinte sin leer y marcarlas de una en una es absurdo. Igual que arriba,
// solo se AÑADE el propio id: a los demás destinatarios no se les toca.
router.post('/leer-todas', async (req, res) => {
  const filas = await notificacionesPara(req.usuario, 1000);
  let marcadas = 0;
  for (const f of filas) {
    if (yaLeida(f.leida_por, req.usuario.id)) continue;
    const actuales = (f.leida_por || '').split(',').map((s) => s.trim()).filter(Boolean);
    actuales.push(String(req.usuario.id));
    await db.prepare('UPDATE notificaciones SET leida_por = ? WHERE id = ?')
      .run(actuales.join(','), f.id);
    marcadas += 1;
  }
  res.json({ ok: true, marcadas });
});

// ============================================================
//  Para que OTROS módulos avisen sin duplicar SQL
// ============================================================

// Nunca interrumpe la operación que la motivó (igual que auditar(), en
// auditoria.js): perder una notificación es malo, pero tumbar una
// producción o una venta por un fallo al avisar sería mucho peor. Por
// eso atrapa su propio error y devuelve null en vez de propagarlo.
// `destino_usuario_id` dirige el aviso a UNA persona; `destino_rol`, a
// un rol entero; ninguno de los dos, a todo el mundo. Si se pasan los
// dos manda la persona (ver leTocaAlUsuario).
export async function crearNotificacion({
  tipo, titulo, mensaje = null, severidad = 'info',
  destino_rol = null, destino_usuario_id = null,
  referencia_tipo = null, referencia_id = null,
}) {
  try {
    if (!tipo || !titulo) throw new Error('Hacen falta al menos tipo y título.');
    const severidadValida = ['info', 'aviso', 'urgente'].includes(severidad) ? severidad : 'info';
    const r = await db.prepare(`
      INSERT INTO notificaciones (tipo, titulo, mensaje, severidad, destino_rol, destino_usuario_id, referencia_tipo, referencia_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tipo, titulo, mensaje, severidadValida, destino_rol,
      destino_usuario_id ?? null, referencia_tipo, referencia_id ?? null,
    );
    return r.lastInsertRowid;
  } catch (e) {
    console.error('No se pudo crear la notificación:', e.message);
    return null;
  }
}

// Cierra (marca leída) todas las notificaciones que apunten a una
// referencia concreta, para UN usuario. Pensada para cuando otro
// módulo resuelve lo que motivó el aviso — p. ej. el almacenero da
// entrada a una producción — y quiere cerrar ese aviso sin tener que
// guardar el id de la notificación en su propia tabla: le basta con
// saber a qué se refería (referencia_tipo + referencia_id), que es un
// dato que ya tiene a mano.
export async function marcarLeidaPorReferencia({ referencia_tipo, referencia_id, usuario_id }) {
  try {
    if (!referencia_tipo || referencia_id == null || !usuario_id) return;
    const filas = await db.prepare(`
      SELECT id, leida_por FROM notificaciones
      WHERE referencia_tipo = ? AND referencia_id = ?
    `).all(referencia_tipo, referencia_id);
    for (const f of filas) {
      if (yaLeida(f.leida_por, usuario_id)) continue;
      const actuales = (f.leida_por || '').split(',').map((s) => s.trim()).filter(Boolean);
      actuales.push(String(usuario_id));
      await db.prepare('UPDATE notificaciones SET leida_por = ? WHERE id = ?')
        .run(actuales.join(','), f.id);
    }
  } catch (e) {
    console.error('No se pudo marcar leída por referencia:', e.message);
  }
}

export default router;
