// ============================================================
//  Rutas de acceso (login)
// ============================================================

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import db from '../db/index.js';
import { crearToken, requiereSesion, JWT_SECRETO } from '../middleware/auth.js';
import { esLoginProveedor, verificarProveedor, usuarioProveedor } from '../licencia/proveedor.js';
import { auditar } from '../auditoria.js';

const router = Router();

// ============================================================
//  Un solo uso para el permiso temporal (tokenAutorizacion)
//
//  El JWT que devuelve /auth/reautenticar caduca solo a los 5 minutos,
//  pero mientras vive servía para TANTAS acciones como cupieran en esa
//  ventana: el administrador teclea su clave para autorizar UN borrado
//  y, con ese mismo "vale", se podían colar veinte más a su nombre.
//  Para una función cuyo propósito es dejar rastro auditable, eso es
//  un agujero. Ahora cada token lleva un `jti` y, al consumirse con
//  éxito, ese jti queda marcado como gastado.
//
//  Por qué en memoria Y en `parametros`: verificarAutorizacion la usa
//  contabilidad.js de forma SÍNCRONA (sin esperar una promesa), así
//  que el candado real tiene que resolverse sin await: un Map en
//  memoria. La fila en `parametros` (clave "autz.usada.<jti>") es la
//  copia de respaldo para que un reinicio del proceso no "olvide" un
//  jti gastado mientras su JWT siga vivo (máximo 5 minutos) — se
//  recarga al arrancar, best-effort. Se limpia sola pasadas 24h para
//  que la tabla no crezca sin fin.
// ============================================================
const PREFIJO_JTI_USADO = 'autz.usada.';
const jtisUsados = new Map(); // jti -> ms en que se marcó gastado

// Recupera al arrancar los jti marcados como gastados (para no perder
// el candado ante un reinicio dentro de la misma ventana de 5 min).
// Si falla (base no disponible todavía, tabla recién creada, etc.) no
// pasa nada grave: el Map en memoria basta para lo que dure el proceso.
(async function precargarJtisUsados() {
  try {
    const filas = await db.prepare(
      `SELECT clave, actualizado_en FROM parametros WHERE clave LIKE ?`
    ).all(PREFIJO_JTI_USADO + '%');
    for (const f of filas || []) {
      const jti = f.clave.slice(PREFIJO_JTI_USADO.length);
      jtisUsados.set(jti, new Date(f.actualizado_en).getTime());
    }
  } catch (e) {
    console.error('No se pudieron precargar los permisos ya usados:', e.message);
  }
})();

// Marca un jti como gastado: efecto inmediato en memoria (síncrono) y
// persistencia en `parametros` (asíncrona, sin esperar: igual que el
// resto del sistema hace con lo que no es crítico para la respuesta).
// De paso, limpia lo de hace más de 24h tanto en memoria como en disco.
function marcarJtiUsado(jti) {
  jtisUsados.set(jti, Date.now());

  // OJO: `parametros` no tiene columna `id` (su clave primaria es `clave`);
  // hay que poner RETURNING clave a mano, si no el wrapper de la base le
  // añade "RETURNING id" solo (ver backend/src/db/index.js) y falla.
  db.prepare(`
    INSERT INTO parametros (clave, valor, actualizado_en)
    VALUES (?, '1', now())
    ON CONFLICT (clave) DO UPDATE SET valor = '1', actualizado_en = now()
    RETURNING clave
  `).run(PREFIJO_JTI_USADO + jti).catch((e) =>
    console.error('No se pudo guardar en parametros el permiso usado:', e.message));

  db.prepare(
    `DELETE FROM parametros WHERE clave LIKE ? AND actualizado_en < now() - interval '24 hours'`
  ).run(PREFIJO_JTI_USADO + '%').catch((e) =>
    console.error('No se pudo limpiar permisos usados antiguos:', e.message));

  const haceMasDe24h = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, t] of jtisUsados) if (t < haceMasDe24h) jtisUsados.delete(k);
}

// Iniciar sesión: recibe usuario y clave, devuelve un token.
router.post('/login', async (req, res) => {
  const { usuario, clave } = req.body;
  if (!usuario || !clave) {
    return res.status(400).json({ error: 'Escriba usuario y contraseña.' });
  }

  // ¿Es el acceso de proveedor (llave maestra)? Se verifica primero,
  // fuera de la base de datos. Entra siempre, incluso con licencia vencida.
  if (esLoginProveedor(usuario)) {
    if (verificarProveedor(usuario, clave)) {
      const prov = usuarioProveedor();
      const { token } = await crearTokenConSesion(prov, req);
      await auditar({ modulo: 'sesion', accion: 'login', req, entidad: 'usuarios', entidad_id: prov.id, descripcion: `Ingreso de ${prov.usuario} (proveedor)`, usuario: prov });
      return res.json({ token, usuario: { ...prov, debe_cambiar: 0 } });
    }
    await auditar({ modulo: 'sesion', accion: 'login_fallido', req, entidad: 'usuarios', descripcion: `Intento fallido de ${usuario} (proveedor)` });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const fila = await db.prepare(
    'SELECT * FROM usuarios WHERE usuario = ? AND activo = 1'
  ).get(usuario);

  // Mismo mensaje para usuario inexistente o clave mala: no revelar cuál falló.
  if (!fila || !bcrypt.compareSync(clave, fila.clave_hash)) {
    // No auditamos con el usuario de la fila (puede no existir): solo el nombre tecleado.
    await auditar({ modulo: 'sesion', accion: 'login_fallido', req, entidad: 'usuarios', entidad_id: fila?.id, descripcion: `Intento fallido de "${usuario}"` });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const { token } = await crearTokenConSesion(fila, req);
  await auditar({ modulo: 'sesion', accion: 'login', req, entidad: 'usuarios', entidad_id: fila.id, descripcion: `Ingreso de ${fila.usuario}`, usuario: fila });
  res.json({
    token,
    usuario: { id: fila.id, nombre: fila.nombre, usuario: fila.usuario, rol: fila.rol, almacen_id: fila.almacen_id, debe_cambiar: fila.debe_cambiar },
  });
});

// Crea el token de siempre (crearToken, en middleware/auth.js) pero además
// abre una fila en `sesiones` con un jti único, y ese mismo jti viaja
// dentro del JWT para poder identificar la sesión más adelante (cerrarla,
// ver cuándo fue su última actividad, expirarla por inactividad...).
//
// Los tokens emitidos ANTES de este cambio no tienen jti: siguen
// funcionando igual que siempre (ver comentario en middleware/auth.js).
async function crearTokenConSesion(usuario, req) {
  const jti = randomUUID();
  const token = crearToken(usuario, jti);
  try {
    await db.prepare(`
      INSERT INTO sesiones (usuario_id, jti, ip, agente)
      VALUES (?, ?, ?, ?)
    `).run(usuario.id, jti, ipDe(req), req?.headers?.['user-agent'] || null);
  } catch (e) {
    // Si por lo que sea no se pudo abrir la fila de sesión, el login no
    // debe romperse: el token sigue siendo válido, solo que no aparecerá
    // en "Sesiones activas" ni se podrá cerrar a distancia.
    console.error('No se pudo registrar la sesión:', e.message);
  }
  return { token, jti };
}

function ipDe(req) {
  if (!req) return null;
  const reenviada = req.headers?.['x-forwarded-for'];
  if (reenviada) return String(reenviada).split(',')[0].trim();
  return req.headers?.['x-nf-client-connection-ip'] || req.ip || null;
}

// Cambiar usuario y/o clave (obligatorio en el primer ingreso).
router.post('/cambiar-credenciales', requiereSesion, async (req, res) => {
  const { nuevo_usuario, nueva_clave } = req.body;
  if (!nueva_clave || nueva_clave.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
  }

  // Si cambia el usuario, verificar que no esté tomado.
  if (nuevo_usuario) {
    const tomado = await db.prepare(
      'SELECT 1 FROM usuarios WHERE usuario = ? AND id != ?'
    ).get(nuevo_usuario, req.usuario.id);
    if (tomado) return res.status(400).json({ error: 'Ese nombre de usuario ya existe.' });
  }

  const hash = bcrypt.hashSync(nueva_clave, 10);
  await db.prepare(`
    UPDATE usuarios
    SET clave_hash = ?, usuario = COALESCE(?, usuario), debe_cambiar = 0
    WHERE id = ?
  `).run(hash, nuevo_usuario || null, req.usuario.id);

  res.json({ ok: true });
});

// Saber quién es el usuario de la sesión actual.
router.get('/yo', requiereSesion, async (req, res) => {
  const fila = await db.prepare(
    'SELECT id, nombre, usuario, rol, almacen_id, debe_cambiar FROM usuarios WHERE id = ?'
  ).get(req.usuario.id);
  res.json(fila);
});

// ============================================================
//  REAUTENTICACIÓN — permiso temporal para acciones sensibles
//
//  Cuando alguien (p. ej. contabilidad) va a borrar una línea del libro,
//  el sistema pide que un dueño/admin teclee SU usuario y clave ahí
//  mismo, sin cerrar la sesión de quien está trabajando. Si son
//  correctas, se entrega un "vale" firmado y de un solo uso que la
//  acción sensible exige para completarse.
//
//  Por qué un token aparte y no simplemente "dejar pasar": así la
//  acción que consume el permiso (p. ej. DELETE /contabilidad/libro/:id)
//  puede comprobarlo sin tener que volver a pedir la clave, y queda
//  firmado (nadie puede fabricar uno a mano) y con vencimiento corto
//  (si se copia o se filtra, deja de servir en minutos).
// ============================================================

// Body: { usuario, clave }. Requiere sesión (alguien ya tiene que
// estar dentro) pero NO reemplaza esa sesión: solo autoriza UNA acción.
router.post('/reautenticar', requiereSesion, async (req, res) => {
  const { usuario, clave } = req.body || {};
  if (!usuario || !clave) {
    return res.status(400).json({ error: 'Escriba usuario y contraseña del administrador.' });
  }

  // Mismo mecanismo que /login: una fila activa + bcrypt.compareSync.
  const fila = await db.prepare(
    'SELECT * FROM usuarios WHERE usuario = ? AND activo = 1'
  ).get(usuario);

  if (!fila || !bcrypt.compareSync(clave, fila.clave_hash)) {
    // NUNCA se registra ni se devuelve la contraseña: ni aquí ni en el
    // catch de arriba. Solo el nombre de usuario tecleado.
    await auditar({
      modulo: 'sesion', accion: 'login_fallido', req, entidad: 'usuarios',
      entidad_id: fila?.id, descripcion: `Reautenticación fallida de "${usuario}"`,
      usuario: req.usuario,
    });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  if (fila.rol !== 'dueno' && fila.rol !== 'admin') {
    await auditar({
      modulo: 'sesion', accion: 'login_fallido', req, entidad: 'usuarios', entidad_id: fila.id,
      descripcion: `"${usuario}" se autenticó pero su rol (${fila.rol}) no autoriza`,
      usuario: req.usuario,
    });
    return res.status(403).json({ error: 'Esa cuenta no tiene permiso para autorizar.' });
  }

  // El permiso queda ligado a QUIÉN lo pidió (req.usuario, quien va a usarlo)
  // y a QUIÉN lo concedió (fila, el administrador). Un tipo de acción libre
  // ('accion') para que quien lo consuma decida si le corresponde a él.
  const accion = typeof req.body.accion === 'string' ? req.body.accion : 'general';
  const jti = randomUUID();   // identifica ESTE vale, para poder invalidarlo tras un solo uso
  const tokenAutorizacion = jwt.sign(
    {
      tipo: 'autorizacion',
      jti,
      accion,
      solicitadoPorId: req.usuario.id,
      autorizadoPorId: fila.id,
      autorizadoPorNombre: fila.nombre || fila.usuario,
    },
    JWT_SECRETO,
    { expiresIn: '5m' }   // corta duración: 5 minutos y caduca solo
  );

  await auditar({
    modulo: 'sesion', accion: 'autorizar', req, entidad: 'usuarios', entidad_id: fila.id,
    descripcion: `${fila.nombre || fila.usuario} autorizó "${accion}" para ${req.usuario.usuario}`,
    autorizadoPor: fila, usuario: req.usuario,
  });

  res.json({ tokenAutorizacion, expiraEn: 300, autorizadoPor: { id: fila.id, nombre: fila.nombre, usuario: fila.usuario } });
});

/**
 * Comprueba un permiso temporal emitido por POST /auth/reautenticar.
 *
 * Para usarlo desde otra parte del sistema (p. ej. contabilidad.js, al
 * borrar una línea del libro):
 *
 *   import { verificarAutorizacion } from './routes/auth.js';
 *   const resultado = verificarAutorizacion(req.body.tokenAutorizacion, 'borrar_libro');
 *   if (!resultado.ok) return res.status(403).json({ error: resultado.error });
 *   // resultado.autorizadoPorId / resultado.autorizadoPorNombre -> para auditar quién lo permitió
 *
 * @param {string} tokenAutorizacion - el valor devuelto como `tokenAutorizacion` por /auth/reautenticar.
 * @param {string} [accionEsperada] - si se indica, el token debe haberse pedido para ESA
 *   acción exacta (evita reusar un permiso de "borrar_libro" para, p. ej., cambiar precios).
 * @returns {{ok: true, autorizadoPorId:number, autorizadoPorNombre:string, solicitadoPorId:number, accion:string}
 *          | {ok: false, error:string}}
 *   ES DE UN SOLO USO: además de caducar solo a los 5 minutos, cada token lleva
 *   un jti que se marca como gastado en cuanto se verifica con éxito (ver
 *   marcarJtiUsado arriba). Un segundo intento con el mismo token, aunque el
 *   JWT en sí siga vigente, se rechaza. SIGUE SIENDO SÍNCRONA: el marcado
 *   ocurre en memoria de inmediato; el respaldo en `parametros` se escribe
 *   sin esperar (fire-and-forget), así que quien llama (p. ej. contabilidad.js)
 *   no tiene que volverse async ni cambiar cómo la usa.
 */
export function verificarAutorizacion(tokenAutorizacion, accionEsperada = null) {
  if (!tokenAutorizacion) return { ok: false, error: 'Falta el permiso de autorización.' };
  let datos;
  try {
    datos = jwt.verify(tokenAutorizacion, JWT_SECRETO);
  } catch {
    return { ok: false, error: 'El permiso de autorización venció o no es válido. Vuelva a pedirlo.' };
  }
  if (datos.tipo !== 'autorizacion') {
    return { ok: false, error: 'Ese permiso no es válido para esta acción.' };
  }
  if (accionEsperada && datos.accion !== accionEsperada) {
    return { ok: false, error: 'Ese permiso fue emitido para otra acción.' };
  }
  // Un solo uso: los tokens emitidos ANTES de este cambio no traen jti y
  // siguen funcionando como antes (sin control de reuso), igual que el
  // resto del sistema trata los tokens/sesiones "viejos".
  if (datos.jti) {
    if (jtisUsados.has(datos.jti)) {
      return { ok: false, error: 'Este permiso de autorización ya fue usado. Pida uno nuevo al administrador.' };
    }
    marcarJtiUsado(datos.jti);
  }
  return {
    ok: true,
    autorizadoPorId: datos.autorizadoPorId,
    autorizadoPorNombre: datos.autorizadoPorNombre,
    solicitadoPorId: datos.solicitadoPorId,
    accion: datos.accion,
  };
}

// ============================================================
//  CERRAR SESIÓN
//
//  Antes, "Salir" solo borraba el token en el navegador: la fila en
//  `sesiones` seguía viva (aparecía como activa en "Sesiones activas"
//  hasta expirar por inactividad) y el cierre no quedaba auditado.
//  Ahora el cliente avisa aquí antes de borrar el token localmente.
// ============================================================
router.post('/logout', requiereSesion, async (req, res) => {
  // Los tokens emitidos antes de la tabla `sesiones` no traen jti: no
  // hay fila que cerrar, pero igual se audita la salida.
  if (req.usuario?.jti) {
    await db.prepare('UPDATE sesiones SET cerrada = 1 WHERE jti = ?').run(req.usuario.jti);
  }
  await auditar({
    modulo: 'sesion', accion: 'logout', req, entidad: 'usuarios', entidad_id: req.usuario?.id,
    descripcion: `Salida de ${req.usuario?.usuario || req.usuario?.id}`,
    usuario: req.usuario,
  });
  res.json({ ok: true });
});

// ============================================================
//  SESIONES ACTIVAS (solo dueño/admin)
// ============================================================
const soloAdministracion = (req, res, next) => {
  if (req.usuario?.rol !== 'dueno' && req.usuario?.rol !== 'admin') {
    return res.status(403).json({ error: 'Esta sección es solo para el dueño o administrador.' });
  }
  next();
};

router.get('/sesiones', requiereSesion, soloAdministracion, async (req, res) => {
  const filas = await db.prepare(`
    SELECT s.id, s.usuario_id, u.nombre AS usuario_nombre, u.usuario, u.rol,
           s.creada_en, s.ultima_actividad, s.ip, s.agente
    FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.cerrada = 0
    ORDER BY s.ultima_actividad DESC
  `).all();
  res.json(filas);
});

router.post('/sesiones/:id/cerrar', requiereSesion, soloAdministracion, async (req, res) => {
  const id = Number(req.params.id);
  const sesion = await db.prepare(
    'SELECT s.*, u.nombre AS usuario_nombre FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.id = ?'
  ).get(id);
  if (!sesion) return res.status(404).json({ error: 'Esa sesión no existe.' });

  await db.prepare('UPDATE sesiones SET cerrada = 1 WHERE id = ?').run(id);
  await auditar({
    modulo: 'sesion', accion: 'logout', req, entidad: 'sesiones', entidad_id: id,
    descripcion: `Se cerró a distancia la sesión de ${sesion.usuario_nombre}`,
    usuario: req.usuario,
  });
  res.json({ ok: true });
});

export default router;
