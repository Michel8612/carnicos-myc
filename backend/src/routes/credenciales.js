// ============================================================
//  Credenciales de servicios externos — panel de configuración
//
//  Objetivo: que el dueño ponga tokens y claves de servicios externos
//  (elTOQUE, Transfermóvil, EnZona...) DESDE EL PANEL, sin tocar
//  variables de entorno en Netlify ni volver a desplegar. Antes esto
//  vivía solo en `process.env`, lo que obligaba a pedirle a alguien
//  que tocara el despliegue cada vez que cambiaba un token.
//
//  Montada en server.js como:
//    app.use('/api/credenciales', requiereSesion, escrituraSoloRoles(), credencialesRoutes)
//  GET libre para cualquier sesión; PUT/DELETE solo dueño/admin/proveedor
//  (ya lo garantiza ese middleware antes de llegar aquí — no se repite).
//
//  Prioridad de lectura (ver obtenerCredencial más abajo):
//    1º lo que el dueño puso en la tabla `credenciales` (base de datos)
//    2º la variable de entorno del despliegue
//  Así lo que decide el dueño desde el panel manda sobre lo que haya
//  en Netlify, y si no ha puesto nada, todo sigue funcionando como el
//  primer día (con la variable de entorno, si existe).
//
//  OJO SERVERLESS — nada de caché en memoria de proceso aquí. En
//  Netlify Functions cada invocación puede caer en un contenedor
//  reciclado o en uno nuevo, y no hay forma fiable de invalidar desde
//  fuera una caché guardada en una variable de módulo. Cachear el
//  valor es EXACTAMENTE el error que hay que evitar: el dueño pondría
//  el token desde el panel y el sistema seguiría usando el viejo (o
//  ninguno) hasta que tocara reiniciar el contenedor, que puede
//  tardar horas. Por eso `obtenerCredencial` consulta la base EN CADA
//  LLAMADA, sin memorizar nada entre invocaciones. El coste es una
//  consulta más por operación — insignificante para el volumen de
//  este negocio — a cambio de que "lo guardé" sea de verdad "ya
//  funciona", sin esperar a nada.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';

const router = Router();

// Claves que el sistema ya conoce y explica en el panel, aunque el
// dueño todavía no haya puesto ningún valor. Una clave nueva (de un
// servicio que se añada el día de mañana) NO necesita aparecer aquí:
// PUT /api/credenciales/:clave admite cualquier clave, y una vez
// guardada aparecerá igual en el listado (ver GET más abajo).
const CLAVES_CONOCIDAS = [
  { clave: 'ELTOQUE_TOKEN', descripcion: 'Token de acceso a la API de elTOQUE, para traer la tasa del dólar (USD/CUP) automáticamente.' },
  { clave: 'TRANSFERMOVIL_USUARIO', descripcion: 'Usuario de la cuenta de comercio en Transfermóvil.' },
  { clave: 'TRANSFERMOVIL_CLAVE', descripcion: 'Clave de la cuenta de comercio en Transfermóvil.' },
  { clave: 'TRANSFERMOVIL_TELEFONO', descripcion: 'Número de teléfono asociado a la cuenta de comercio en Transfermóvil.' },
  { clave: 'ENZONA_CLIENT_ID', descripcion: 'Identificador de cliente (Client ID) de la cuenta de comercio en EnZona.' },
  { clave: 'ENZONA_CLIENT_SECRET', descripcion: 'Clave secreta (Client Secret) de la cuenta de comercio en EnZona.' },
];

// Solo mayúsculas, números y guion bajo (mismo estilo que las claves
// conocidas, tipo ELTOQUE_TOKEN). Evita claves raras a medio pegar.
const CLAVE_VALIDA = /^[A-Z0-9_]+$/;

function ultimos4(valor) {
  const s = String(valor ?? '');
  return s.length > 4 ? s.slice(-4) : s; // si el valor ya es cortísimo, no hay mucho que ocultar
}

// ------------------------------------------------------------
//  Lectura con prioridad — la usa el resto del sistema (tasas.js,
//  pagos.js, y cualquier servicio nuevo que necesite un secreto).
//  1º base de datos (lo que puso el dueño), 2º variable de entorno.
//  Nunca lanza: si falla la lectura de la base, sigue con la
//  variable de entorno (mismo espíritu que servicios/tasas.js).
// ------------------------------------------------------------
export async function obtenerCredencial(clave) {
  let fila;
  try {
    fila = await db.prepare('SELECT valor FROM credenciales WHERE clave = ?').get(clave);
  } catch {
    fila = undefined;
  }
  if (fila && fila.valor) return fila.valor;
  return process.env[clave] || null;
}

// GET — el listado NUNCA devuelve el valor completo de una credencial:
// quien ya la puso no necesita volver a leerla (la escribió él mismo
// hace un momento), y quien no debería verla tampoco debe poder,
// aunque tenga acceso a esta pantalla. Basta con saber que está
// puesta, de dónde viene y sus últimos 4 caracteres (para reconocer
// "es la de siempre" o "me equivoqué al pegar") sin exponer el secreto.
router.get('/', async (req, res) => {
  const filasDb = await db.prepare(
    'SELECT clave, valor, descripcion, actualizado_en FROM credenciales'
  ).all();
  const porClave = new Map(filasDb.map((f) => [f.clave, f]));

  // Conocidas primero (orden estable para el panel), y después
  // cualquier clave que ya esté en la base pero no en la lista
  // conocida (una clave nueva que se guardó sin tocar código).
  const claves = [...CLAVES_CONOCIDAS];
  for (const f of filasDb) {
    if (!claves.some((c) => c.clave === f.clave)) {
      claves.push({ clave: f.clave, descripcion: f.descripcion || 'Credencial personalizada.' });
    }
  }

  const lista = claves.map(({ clave, descripcion }) => {
    const fila = porClave.get(clave);
    const enBase = Boolean(fila && fila.valor);
    const valorEnv = process.env[clave] || null;
    const puesta = enBase || Boolean(valorEnv);
    const origen = enBase ? 'base_datos' : (valorEnv ? 'variable_entorno' : null);
    const valorActivo = enBase ? fila.valor : valorEnv;
    return {
      clave,
      descripcion: (fila && fila.descripcion) || descripcion,
      puesta,
      origen, // 'base_datos' | 'variable_entorno' | null
      ultimos4: puesta ? ultimos4(valorActivo) : null,
      actualizado_en: fila ? fila.actualizado_en : null,
    };
  });

  res.json(lista);
});

// PUT /:clave — guarda o actualiza. Admite cualquier clave (no solo
// las conocidas), para que un servicio nuevo no obligue a tocar
// código: basta con que el panel (o quien sea) mande la clave que
// haga falta.
router.put('/:clave', async (req, res) => {
  const clave = String(req.params.clave || '').trim().toUpperCase();
  if (!clave || !CLAVE_VALIDA.test(clave)) {
    return res.status(400).json({ error: 'La clave debe usar solo mayúsculas, números y guion bajo (ej. MI_SERVICIO_TOKEN).' });
  }

  const valor = (req.body?.valor ?? '').toString().trim();
  if (!valor) {
    return res.status(400).json({ error: 'El valor no puede estar vacío. Para quitar la credencial, use el botón de borrar.' });
  }

  const conocida = CLAVES_CONOCIDAS.find((c) => c.clave === clave);
  const descripcion = limpiarTexto(req.body?.descripcion) || conocida?.descripcion || null;

  await db.prepare(`
    INSERT INTO credenciales (clave, valor, descripcion, actualizado_en, actualizado_por)
    VALUES (?, ?, ?, NOW(), ?)
    ON CONFLICT (clave) DO UPDATE SET
      valor = EXCLUDED.valor,
      descripcion = COALESCE(EXCLUDED.descripcion, credenciales.descripcion),
      actualizado_en = NOW(),
      actualizado_por = EXCLUDED.actualizado_por
    RETURNING clave
  `).run(clave, valor, descripcion, req.usuario?.id ?? null);

  // Se audita QUE se guardó, con los últimos 4 caracteres para poder
  // reconocer el cambio en el historial — nunca el valor completo:
  // la auditoría es de lectura más amplia que "quién puede ver
  // credenciales", así que escribir el secreto ahí sería guardarlo
  // dos veces, una de ellas sin el mismo control de acceso.
  await auditar({
    modulo: 'config',
    accion: 'modificar',
    req,
    entidad: 'credenciales',
    entidad_id: clave,
    descripcion: `Credencial "${clave}" actualizada desde el panel (terminada en ${ultimos4(valor)}).`,
  });

  res.json({ ok: true, clave });
});

// DELETE /:clave — borra la de la base. El sistema vuelve a usar la
// variable de entorno automáticamente si la hay, gracias a la
// prioridad de obtenerCredencial(): no hace falta ningún paso más.
router.delete('/:clave', async (req, res) => {
  const clave = String(req.params.clave || '').trim().toUpperCase();
  const antes = await db.prepare('SELECT clave FROM credenciales WHERE clave = ?').get(clave);
  if (!antes) {
    return res.status(404).json({ error: 'Esa credencial no está guardada en la base de datos.' });
  }

  await db.prepare('DELETE FROM credenciales WHERE clave = ?').run(clave);

  await auditar({
    modulo: 'config',
    accion: 'eliminar',
    req,
    entidad: 'credenciales',
    entidad_id: clave,
    descripcion: `Credencial "${clave}" borrada de la base de datos (vuelve a mandar la variable de entorno, si existe).`,
  });

  res.json({ ok: true, clave });
});

function limpiarTexto(v) {
  const s = (v ?? '').toString().trim();
  return s || null;
}

export default router;
