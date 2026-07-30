// ============================================================
//  Documentos legales (Términos, Privacidad, Tratamiento de Datos)
//
//  Por qué esta ruta NO lleva `requiereSesion` en server.js: hay que
//  poder leer los documentos y aceptarlos ANTES de tener acceso al
//  resto del sistema (justo al terminar de entrar). El control de
//  sesión se hace aquí dentro, ruta por ruta:
//    - GET  /documentos  -> público (hace falta leerlos sin sesión)
//    - GET  /estado      -> requiere sesión (qué le falta a ESE usuario)
//    - POST /aceptar     -> requiere sesión
//    - POST /documentos  -> requiere sesión, solo dueño/admin
//    - GET  /historial   -> requiere sesión, solo dueño/admin
//
//  Regla dura del encargo: si este módulo fallara (base caída, tabla
//  vacía, lo que sea), el usuario debe poder seguir entrando al
//  sistema. Bloquear el acceso al negocio por un aviso legal caído
//  sería peor que el problema. Por eso las lecturas (GET /documentos
//  y GET /estado) SIEMPRE responden 200 con algo razonable (aunque
//  sea "no hay nada pendiente"), nunca tumban al que llama.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion } from '../middleware/auth.js';
import { auditar } from '../auditoria.js';

const router = Router();

const TIPOS = ['terminos', 'privacidad', 'datos'];

// --- Contenido inicial (versión 1.0) ---
//
// Redactado en español claro, pensado para un software de gestión
// INTERNO de una MIPYME cubana de embutidos (Cárnicos M&C): qué datos
// guarda (personal, ventas, inventario, producción, nómina y datos
// fiscales), dónde se alojan (un servidor en la nube contratado por
// el negocio, no un centro de datos certificado) y quién accede.
//
// A propósito NO son plantillas de multinacionales ni prometen
// certificaciones o garantías que este negocio no tiene. Son una base
// honesta. Por eso cada texto termina con el mismo aviso: el titular
// del negocio debe revisarlos con un asesor legal cubano antes de
// darlos por definitivos.
const AVISO_BASE =
  '\n\nAviso: este documento es una base redactada para el uso interno de ' +
  'Cárnicos M&C y no sustituye el asesoramiento de un abogado. El titular ' +
  'del negocio debe revisarlo con un asesor legal antes de considerarlo ' +
  'definitivo.';

const TERMINOS = `Cárnicos M&C usa este sistema como herramienta interna de gestión: ventas, almacén e inventario, producción y recetas, contabilidad, nómina y datos fiscales del negocio. Este documento explica las condiciones bajo las que el personal autorizado puede usarlo.

1. Quién puede usar el sistema
Solo puede acceder quien tenga una cuenta creada por el titular del negocio (dueño) o por quien él autorice. Cada persona usa su propio usuario y contraseña; las cuentas no se comparten entre compañeros de trabajo, aunque hagan la misma tarea.

2. Para qué se usa
El sistema es una herramienta de trabajo para registrar y consultar la actividad del negocio: ventas, existencias, producción, gastos, cobros, pagos y nómina. No debe usarse para fines ajenos al negocio ni para guardar información que no corresponda a Cárnicos M&C.

3. Responsabilidad de cada usuario
Cada usuario responde por lo que registra bajo su cuenta. Si detecta un error, un dato equivocado o un acceso indebido, debe avisar de inmediato al dueño del negocio.

4. Disponibilidad
El sistema puede tener interrupciones por mantenimiento, fallas del servidor o de la conexión a internet. No se garantiza que esté disponible en todo momento. El negocio conserva, en la medida de lo posible, sus propios controles en papel u otros medios para no depender por completo del sistema.

5. El sistema es una herramienta, no un asesor
Los cálculos, reportes y cifras que muestra el sistema sirven de apoyo a la gestión, pero no sustituyen el criterio del dueño ni el de un contador o asesor legal. Las decisiones del negocio y el cumplimiento de las obligaciones fiscales y laborales siguen siendo responsabilidad de Cárnicos M&C.

6. Cambios en estas condiciones
Estas condiciones pueden actualizarse conforme el sistema evolucione. Cuando eso ocurra, se pedirá aceptar la nueva versión antes de seguir usando el sistema.${AVISO_BASE}`;

const PRIVACIDAD = `Esta política explica qué datos personales maneja el sistema de gestión de Cárnicos M&C, para qué se usan y cómo se protegen.

1. Qué datos se guardan
Del personal que usa el sistema: nombre, nombre de usuario, rol de trabajo y, si corresponde, el almacén o área asignada. De clientes y proveedores del negocio: los datos que se registren al hacer una venta, una compra o llevar cuentas por cobrar o pagar (por ejemplo, nombre y, si se anota, un contacto). No se piden ni se guardan datos que no hagan falta para operar el negocio.

2. Para qué se usan
Únicamente para el funcionamiento del negocio: llevar las ventas, el inventario, la producción, la contabilidad y la nómina de Cárnicos M&C. No se venden ni se ceden a terceros ajenos al negocio.

3. Dónde se guardan
La información se guarda en un servidor en la nube contratado por el titular del negocio. No se trata de un centro de datos propio ni certificado especialmente para esto: es el alojamiento que el negocio puede costear en este momento. Si eso cambia, se avisará.

4. Quién puede ver qué
Cada usuario ve, según su rol, solo la parte del sistema que necesita para su trabajo (por ejemplo, quien vende no ve la nómina). El dueño del negocio tiene acceso a todo. Quien brinda soporte técnico al sistema puede acceder para resolver fallas, bajo el compromiso de no usar la información para otro fin.

5. Seguridad
Las contraseñas se guardan cifradas (no se pueden leer directamente) y el acceso se controla con sesiones que caducan. Aun así, ningún sistema es perfectamente seguro: no se puede prometer que nunca vaya a ocurrir un incidente, pero se toman medidas razonables para evitarlo.

6. Sus derechos
Quien tenga datos guardados en el sistema (personal, cliente o proveedor) puede pedirle al dueño del negocio consultar, corregir o solicitar la eliminación de sus datos, salvo que la ley obligue a conservarlos (por ejemplo, registros contables o fiscales).

7. Cuánto tiempo se conservan
Mientras dure la relación laboral o comercial, y después por el tiempo que las normas contables y fiscales cubanas exijan conservar esos registros.${AVISO_BASE}`;

const DATOS = `Este documento complementa la Política de Privacidad y explica, de forma más operativa, cómo se tratan los datos dentro del sistema de Cárnicos M&C.

1. Tipos de datos que maneja el sistema
- Datos de ventas e inventario: productos, precios, existencias, movimientos de almacén.
- Datos de producción: recetas, cantidades producidas, insumos usados.
- Datos contables y fiscales: ingresos, gastos, tributos, información de la empresa ante las autoridades cubanas.
- Datos de nómina: personal y pagos, cuando aplica.
- Datos de acceso: usuario, rol, y un registro de auditoría de quién hizo qué y cuándo dentro del sistema.

2. Quién registra los datos
Los datos los introduce el propio personal autorizado, cada uno en el área que le corresponde. El sistema guarda, para cada acción importante, quién la hizo y cuándo (auditoría interna), precisamente para poder aclarar dudas o corregir errores con base cierta.

3. Copias de seguridad
Se hacen respaldos de la información para reducir el riesgo de perderla por una falla técnica. Esto no elimina el riesgo por completo: ante un incidente grave, podría perderse información reciente que aún no se haya respaldado.

4. A quién se transfieren los datos
Los datos no se entregan a terceros ajenos al negocio, salvo que una autoridad competente lo exija por ley, o que sea estrictamente necesario para que el sistema funcione (por ejemplo, la empresa que aloja el servidor en la nube, que solo almacena la información, no la usa con otro fin).

5. Datos más sensibles (nómina y datos fiscales)
La información de nómina y los datos fiscales de la empresa se muestran solo a los roles que realmente los necesitan (dueño y contabilidad). El resto del personal no tiene acceso a esa parte del sistema.

6. Conservación y borrado
Los datos se conservan mientras el negocio los necesite para operar y por el plazo que exijan las normas contables y fiscales cubanas. Borrar un dato del sistema no siempre borra de inmediato las copias de seguridad ya hechas; esas copias antiguas se van reemplazando con el tiempo.${AVISO_BASE}`;

const DOCUMENTOS_INICIALES = [
  { tipo: 'terminos', version: '1.0', titulo: 'Términos y Condiciones de Uso', contenido: TERMINOS },
  { tipo: 'privacidad', version: '1.0', titulo: 'Política de Privacidad', contenido: PRIVACIDAD },
  { tipo: 'datos', version: '1.0', titulo: 'Política de Tratamiento de Datos', contenido: DATOS },
];

// Siembra idempotente: solo inserta si la tabla está vacía. Se cachea en
// memoria de proceso (`sembrado`) para no hacer un COUNT en cada petición
// una vez comprobado que ya hay datos.
let sembrado = false;
async function sembrarSiFalta() {
  if (sembrado) return;
  const fila = await db.prepare('SELECT COUNT(*) AS n FROM documentos_legales').get();
  if (Number(fila?.n) > 0) { sembrado = true; return; }
  for (const doc of DOCUMENTOS_INICIALES) {
    await db.prepare(`
      INSERT INTO documentos_legales (tipo, version, titulo, contenido, vigente)
      VALUES (?, ?, ?, ?, 1)
    `).run(doc.tipo, doc.version, doc.titulo, doc.contenido);
  }
  sembrado = true;
}

// La IP real cuando hay un proxy delante (mismo criterio que auditoria.js).
function ipDe(req) {
  if (!req) return null;
  const reenviada = req.headers?.['x-forwarded-for'];
  if (reenviada) return String(reenviada).split(',')[0].trim();
  return req.headers?.['x-nf-client-connection-ip'] || req.ip || null;
}

// ------------------------------------------------------------
//  GET /legal/documentos  — público: los documentos vigentes
// ------------------------------------------------------------
router.get('/documentos', async (req, res) => {
  try {
    await sembrarSiFalta();
    const filas = await db.prepare(`
      SELECT id, tipo, version, titulo, contenido, creado_en
      FROM documentos_legales WHERE vigente = 1 ORDER BY tipo
    `).all();
    res.json(filas);
  } catch (e) {
    console.error('legal: no se pudieron leer los documentos vigentes:', e.message);
    // Falla hacia abierto: no hay nada que mostrar, pero no se tumba al que llama.
    res.json([]);
  }
});

// ------------------------------------------------------------
//  GET /legal/estado  — con sesión: qué le falta aceptar a ESTE usuario
// ------------------------------------------------------------
router.get('/estado', requiereSesion, async (req, res) => {
  try {
    await sembrarSiFalta();
    const vigentes = await db.prepare(`
      SELECT id, tipo, version, titulo FROM documentos_legales WHERE vigente = 1
    `).all();

    const pendientes = [];
    for (const doc of vigentes) {
      const acept = await db.prepare(`
        SELECT id FROM aceptaciones_legales WHERE usuario_id = ? AND documento_id = ?
      `).get(req.usuario.id, doc.id);
      if (!acept) {
        pendientes.push({ documento_id: doc.id, tipo: doc.tipo, version: doc.version, titulo: doc.titulo });
      }
    }
    res.json({ al_dia: pendientes.length === 0, pendientes });
  } catch (e) {
    console.error('legal: no se pudo calcular el estado de aceptación:', e.message);
    // Falla hacia abierto: si no se puede saber qué falta, no se bloquea el acceso.
    res.json({ al_dia: true, pendientes: [], aviso: 'No se pudo comprobar el estado legal.' });
  }
});

// ------------------------------------------------------------
//  POST /legal/aceptar  — con sesión: registra la(s) aceptación(es)
//  Cuerpo esperado: { versiones: [documento_id, documento_id, ...] }
// ------------------------------------------------------------
router.post('/aceptar', requiereSesion, async (req, res) => {
  const versiones = Array.isArray(req.body?.versiones) ? req.body.versiones : [];
  const ids = versiones.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) {
    return res.status(400).json({ error: 'No se indicó qué documento se acepta.' });
  }
  try {
    const aceptados = [];
    for (const id of ids) {
      const doc = await db.prepare(
        'SELECT id, tipo, version FROM documentos_legales WHERE id = ? AND vigente = 1'
      ).get(id);
      if (!doc) continue; // versión que ya no es vigente o no existe: se ignora sin romper el resto

      const yaAceptado = await db.prepare(
        'SELECT id FROM aceptaciones_legales WHERE usuario_id = ? AND documento_id = ?'
      ).get(req.usuario.id, doc.id);
      if (yaAceptado) continue; // idempotente: aceptar dos veces no duplica

      await db.prepare(`
        INSERT INTO aceptaciones_legales (usuario_id, usuario_nombre, documento_id, tipo, version, ip)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.usuario.id, req.usuario.usuario || req.usuario.nombre || null, doc.id, doc.tipo, doc.version, ipDe(req));

      await auditar({
        modulo: 'legal',
        accion: 'aceptar',
        req,
        entidad: 'documentos_legales',
        entidad_id: doc.id,
        descripcion: `Aceptó "${doc.tipo}" versión ${doc.version}`,
      });
      aceptados.push(doc.id);
    }
    res.json({ ok: true, aceptados });
  } catch (e) {
    console.error('legal: no se pudo registrar la aceptación:', e.message);
    res.status(500).json({ error: 'No se pudo registrar la aceptación. Intente de nuevo.' });
  }
});

// ------------------------------------------------------------
//  POST /legal/documentos  — con sesión, solo dueño/admin: publica
//  una versión nueva. La anterior de ese tipo deja de ser vigente,
//  así que todos vuelven a tener que aceptar (GET /estado ya lo
//  detecta solo, comparando por documento_id).
// ------------------------------------------------------------
router.post('/documentos', requiereSesion, async (req, res) => {
  const rol = req.usuario?.rol;
  if (rol !== 'dueno' && rol !== 'admin') {
    return res.status(403).json({ error: 'Solo el dueño puede publicar documentos legales.' });
  }

  const { tipo, version, titulo, contenido } = req.body || {};
  if (!TIPOS.includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de documento no válido.' });
  }
  if (!version || !String(version).trim()) {
    return res.status(400).json({ error: 'Indique la versión.' });
  }
  if (!contenido || !String(contenido).trim()) {
    return res.status(400).json({ error: 'El contenido no puede estar vacío.' });
  }

  try {
    const tx = db.transaction(async () => {
      // Nunca se borra: se marca la anterior como no vigente y se crea la nueva.
      await db.prepare('UPDATE documentos_legales SET vigente = 0 WHERE tipo = ? AND vigente = 1').run(tipo);
      const r = await db.prepare(`
        INSERT INTO documentos_legales (tipo, version, titulo, contenido, vigente)
        VALUES (?, ?, ?, ?, 1)
      `).run(tipo, String(version).trim(), titulo || null, contenido);
      return r.lastInsertRowid;
    });
    const nuevoId = await tx();

    await auditar({
      modulo: 'legal',
      accion: 'crear',
      req,
      entidad: 'documentos_legales',
      entidad_id: nuevoId,
      descripcion: `Publicó nueva versión de "${tipo}": ${version}`,
    });

    res.json({ ok: true, id: nuevoId });
  } catch (e) {
    console.error('legal: no se pudo publicar el documento:', e.message);
    res.status(500).json({ error: 'No se pudo publicar el documento. Intente de nuevo.' });
  }
});

// ------------------------------------------------------------
//  GET /legal/historial  — con sesión, solo dueño/admin: todas las
//  versiones (vigentes o no) y quién ha aceptado cada una. No hay
//  método específico en api.js para esta ruta (no se tocó api.js);
//  public/js/legal.js la llama con un fetch propio.
// ------------------------------------------------------------
router.get('/historial', requiereSesion, async (req, res) => {
  const rol = req.usuario?.rol;
  if (rol !== 'dueno' && rol !== 'admin') {
    return res.status(403).json({ error: 'No tiene permiso para ver el historial legal.' });
  }
  try {
    const documentos = await db.prepare(`
      SELECT id, tipo, version, titulo, vigente, creado_en
      FROM documentos_legales ORDER BY tipo, creado_en DESC
    `).all();
    const aceptaciones = await db.prepare(`
      SELECT documento_id, usuario_nombre, tipo, version, fecha, ip
      FROM aceptaciones_legales ORDER BY fecha DESC
    `).all();
    res.json({ documentos, aceptaciones });
  } catch (e) {
    console.error('legal: no se pudo leer el historial:', e.message);
    res.status(500).json({ error: 'No se pudo leer el historial.' });
  }
});

export default router;
