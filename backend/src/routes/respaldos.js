// ============================================================
//  Copias de seguridad — exportar y restaurar la base completa
//
//  El montaje en server.js ya trae requiereSesion (lectura libre
//  para cualquier sesión) y escrituraSoloRoles() (escriben dueño/
//  admin/proveedor) — aquí no hace falta repetirlo para las rutas
//  normales. Para /restaurar SÍ se repite la comprobación de rol
//  dentro del router: es una operación irreversible (borra y
//  reemplaza TODA la base) y no queremos que dependa solo de cómo
//  esté montada la ruta hoy en server.js.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';

const router = Router();

const ROLES_RESTAURAR = ['dueno', 'admin', 'proveedor'];

// Nunca se restaura: es el registro de lo que pasó en el sistema
// (quién hizo qué, incluida esta misma restauración), no un dato de
// negocio. Si se sobrescribiera con un respaldo viejo se perdería el
// rastro de todo lo ocurrido desde entonces.
const TABLA_AUDITORIA = 'auditoria';

// ------------------------------------------------------------
//  Helpers de esquema (todo se lee de information_schema, nunca de
//  una lista a mano, para que una tabla nueva no quede desactualizada)
// ------------------------------------------------------------

async function listarTablas() {
  const filas = await db.prepare(`
    SELECT table_name AS nombre
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `).all();
  return filas.map((f) => f.nombre);
}

// Columnas reales de cada tabla: al restaurar, una fila del JSON solo
// se inserta con las columnas que la tabla ACTUAL de verdad tiene. Si
// el respaldo es de una versión anterior con una columna que ya no
// existe, esa columna se ignora en vez de romper toda la restauración.
async function columnasPorTabla() {
  const filas = await db.prepare(`
    SELECT table_name AS tabla, column_name AS columna
      FROM information_schema.columns
     WHERE table_schema = 'public'
  `).all();
  const mapa = {};
  for (const f of filas) {
    if (!mapa[f.tabla]) mapa[f.tabla] = new Set();
    mapa[f.tabla].add(f.columna);
  }
  return mapa;
}

// Relaciones padre → hija (llaves foráneas) entre tablas de public.
// Las auto-referencias (p.ej. una categoría con padre_id que apunta a
// la misma tabla) no cuentan como dependencia ENTRE tablas, así que
// se descartan aquí.
async function relacionesFk() {
  const filas = await db.prepare(`
    SELECT DISTINCT tc.table_name AS hija, ccu.table_name AS padre
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'
  `).all();
  return filas.filter((f) => f.hija !== f.padre);
}

// ------------------------------------------------------------
//  Estrategia elegida para el orden de restauración: en vez de
//  desactivar las restricciones de llave foránea (session_replication_role
//  exige superusuario, y el rol de la app en Neon no lo es), se
//  calcula el orden real de dependencias con un ordenamiento
//  topológico (Kahn): primero los "padres" (p.ej. usuarios,
//  almacenes), después los "hijos" que los referencian (p.ej.
//  ventas.usuario_id). Si hubiera un ciclo entre tablas distintas
//  (este esquema no lo tiene hoy), las que sobran se insertan al
//  final en orden alfabético: es un caso raro y preferimos intentar
//  la restauración igual a bloquearla del todo.
// ------------------------------------------------------------
function ordenTopologico(tablas, relaciones) {
  const hijasDe = new Map(tablas.map((t) => [t, new Set()])); // padre -> Set(hijas)
  const padresPendientes = new Map(tablas.map((t) => [t, 0])); // hija -> cuántos padres le faltan

  for (const { hija, padre } of relaciones) {
    if (!hijasDe.has(padre) || !padresPendientes.has(hija)) continue; // fuera del conjunto a restaurar
    if (!hijasDe.get(padre).has(hija)) {
      hijasDe.get(padre).add(hija);
      padresPendientes.set(hija, padresPendientes.get(hija) + 1);
    }
  }

  const listos = tablas.filter((t) => padresPendientes.get(t) === 0).sort();
  const orden = [];
  const pendientes = new Set(tablas);

  while (listos.length) {
    const t = listos.shift();
    if (!pendientes.has(t)) continue;
    orden.push(t);
    pendientes.delete(t);
    for (const hija of hijasDe.get(t)) {
      padresPendientes.set(hija, padresPendientes.get(hija) - 1);
      if (padresPendientes.get(hija) === 0) listos.push(hija);
    }
    listos.sort();
  }

  return [...orden, ...[...pendientes].sort()]; // lo que quedó por un ciclo, al final
}

function nombreArchivo() {
  const hoy = new Date().toISOString().slice(0, 10); // AAAA-MM-DD
  return `respaldo-carnicos-${hoy}.json`;
}

function nombreUsuario(req) {
  return req.usuario?.nombre ?? req.usuario?.usuario ?? null;
}

// ------------------------------------------------------------
//  GET /exportar — descarga un respaldo COMPLETO en JSON
// ------------------------------------------------------------
router.get('/exportar', async (req, res) => {
  const tablas = await listarTablas();
  const contenido = {};
  let totalFilas = 0;

  for (const tabla of tablas) {
    // El nombre de tabla sale de information_schema, no del usuario:
    // es seguro interpolarlo en el SQL, no hay forma de inyección.
    const filas = await db.prepare(`SELECT * FROM "${tabla}"`).all();
    contenido[tabla] = filas;
    totalFilas += filas.length;
  }

  const respaldo = {
    version: 1,
    generado_en: new Date().toISOString(),
    tablas: contenido,
  };

  const json = JSON.stringify(respaldo);
  const tamanoBytes = Buffer.byteLength(json, 'utf8');

  await db.prepare(`
    INSERT INTO respaldos (tipo, tablas, filas, tamano_bytes, usuario_id, usuario_nombre, resultado, detalle)
    VALUES ('exportar', ?, ?, ?, ?, ?, 'ok', ?)
  `).run(
    tablas.length, totalFilas, tamanoBytes, req.usuario?.id ?? null, nombreUsuario(req),
    `Descarga completa: ${tablas.length} tablas, ${totalFilas} filas.`,
  );

  await auditar({
    modulo: 'respaldos', accion: 'exportar', req, entidad: 'respaldos',
    descripcion: `Descarga de respaldo completo: ${tablas.length} tablas, ${totalFilas} filas (${tamanoBytes} bytes).`,
    despues: { tablas: tablas.length, filas: totalFilas, tamano_bytes: tamanoBytes },
  });

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo()}"`);
  res.send(json);
});

// ------------------------------------------------------------
//  POST /restaurar — vuelve a meter un respaldo JSON (irreversible)
// ------------------------------------------------------------
router.post('/restaurar', async (req, res) => {
  const rol = req.usuario?.rol;
  if (!ROLES_RESTAURAR.includes(rol)) {
    return res.status(403).json({ error: 'Solo el dueño puede restaurar un respaldo.' });
  }

  const b = req.body || {};
  if (b.confirmar !== 'RESTAURAR') {
    return res.status(400).json({ error: 'Para restaurar hay que enviar confirmar: "RESTAURAR" (así, en mayúsculas).' });
  }

  const datos = b.datos;
  if (!datos || typeof datos !== 'object' || !datos.tablas || typeof datos.tablas !== 'object') {
    return res.status(400).json({ error: 'El archivo no tiene el formato esperado de un respaldo (falta "tablas").' });
  }

  const tablasReales = new Set(await listarTablas());
  const columnas = await columnasPorTabla();

  // Solo se restauran tablas que EXISTEN hoy y que no son auditoría.
  // Una tabla del respaldo que ya no existe en el sistema actual
  // (versión vieja) simplemente se ignora, en vez de fallar todo.
  const tablasARestaurar = Object.keys(datos.tablas)
    .filter((t) => tablasReales.has(t) && t !== TABLA_AUDITORIA);

  const relaciones = await relacionesFk();
  const orden = ordenTopologico(tablasARestaurar, relaciones);

  let totalFilas = 0;

  // Todo dentro de una transacción: si algo falla a mitad de camino
  // (una fila que no cumple una restricción, un tipo de dato raro en
  // el JSON...) no debe quedar la base a medias entre lo viejo y lo
  // nuevo. db.transaction hace BEGIN/COMMIT/ROLLBACK solo.
  const tx = db.transaction(async () => {
    if (!orden.length) return;

    // 1) Vaciar TODAS las tablas a restaurar en un solo TRUNCATE. Un
    // TRUNCATE con la lista completa no falla por llaves foráneas
    // aunque las tablas se referencien entre sí (Postgres solo exige
    // que la tabla referenciada esté también en la lista, y aquí
    // están todas). CASCADE cubre, además, alguna tabla que no venga
    // en el respaldo pero dependa de una que sí se restaura (caso
    // raro: tabla nueva creada después de que se tomó ese respaldo).
    // RESTART IDENTITY reinicia los contadores de id para que, tras
    // reinsertar los ids explícitos del respaldo, sigan consecutivos.
    const listaTruncate = orden.map((t) => `"${t}"`).join(', ');
    await db.exec(`TRUNCATE TABLE ${listaTruncate} RESTART IDENTITY CASCADE`);

    // 2) Insertar tabla por tabla en orden padres-antes-que-hijos,
    // fila por fila, usando solo las columnas que la tabla actual
    // realmente tiene.
    for (const tabla of orden) {
      const filas = datos.tablas[tabla];
      if (!Array.isArray(filas) || !filas.length) continue;
      const colsValidas = columnas[tabla] || new Set();

      for (const fila of filas) {
        const cols = Object.keys(fila || {}).filter((c) => colsValidas.has(c));
        if (!cols.length) continue;
        const marcadores = cols.map(() => '?').join(', ');
        const nombresCols = cols.map((c) => `"${c}"`).join(', ');
        // El envoltorio de la base añade "RETURNING id" a todo INSERT que no
        // traiga ya un RETURNING (emula el lastInsertRowid de SQLite). Cuatro
        // tablas no tienen columna `id` — parametros, categorias_gasto,
        // credenciales y autorizaciones_usadas — y ese añadido las hacía
        // fallar con «column "id" does not exist». Como la restauración va en
        // una sola transacción, una de esas filas tumbaba la restauración
        // ENTERA: el botón de restaurar no servía para ningún respaldo real.
        // Con un RETURNING explícito el envoltorio ya no pone el suyo; aquí no
        // hace falta el id nuevo, porque las filas se insertan con los valores
        // que traía el respaldo.
        const retorno = colsValidas.has('id') ? '' : ' RETURNING 1';
        await db.prepare(`
          INSERT INTO "${tabla}" (${nombresCols}) VALUES (${marcadores})${retorno}
        `).run(...cols.map((c) => fila[c]));
        totalFilas += 1;
      }

      // Como los ids se insertaron a mano, la secuencia (reiniciada
      // por RESTART IDENTITY) se quedó en 1: sin este ajuste, la
      // siguiente alta normal chocaría con un id que ya existe.
      if (colsValidas.has('id')) {
        await db.exec(`
          SELECT setval(
            pg_get_serial_sequence('"${tabla}"', 'id'),
            COALESCE((SELECT MAX(id) FROM "${tabla}"), 1),
            (SELECT MAX(id) IS NOT NULL FROM "${tabla}")
          )
        `);
      }
    }
  });

  try {
    await tx();
  } catch (err) {
    await db.prepare(`
      INSERT INTO respaldos (tipo, tablas, filas, usuario_id, usuario_nombre, resultado, detalle)
      VALUES ('restaurar', ?, ?, ?, ?, 'error', ?)
    `).run(tablasARestaurar.length, totalFilas, req.usuario?.id ?? null, nombreUsuario(req), `Restauración fallida: ${err.message}`);

    await auditar({
      modulo: 'respaldos', accion: 'restaurar', req, entidad: 'respaldos',
      descripcion: `Restauración fallida: ${err.message}`, motivo: 'error',
    });

    return res.status(500).json({ error: 'La restauración falló y no se aplicó ningún cambio (se revirtió todo): ' + err.message });
  }

  await db.prepare(`
    INSERT INTO respaldos (tipo, tablas, filas, usuario_id, usuario_nombre, resultado, detalle)
    VALUES ('restaurar', ?, ?, ?, ?, 'ok', ?)
  `).run(
    tablasARestaurar.length, totalFilas, req.usuario?.id ?? null, nombreUsuario(req),
    `Restauración completa: ${tablasARestaurar.length} tablas, ${totalFilas} filas. La tabla de auditoría no se tocó.`,
  );

  await auditar({
    modulo: 'respaldos', accion: 'restaurar', req, entidad: 'respaldos',
    descripcion: `Restauración de respaldo: ${tablasARestaurar.length} tablas, ${totalFilas} filas.`,
    despues: { tablas: tablasARestaurar.length, filas: totalFilas },
  });

  res.json({ ok: true, tablas: tablasARestaurar.length, filas: totalFilas });
});

// ------------------------------------------------------------
//  GET / — historial de copias y restauraciones (quién y cuándo)
// ------------------------------------------------------------
router.get('/', async (req, res) => {
  const filas = await db.prepare(`
    SELECT * FROM respaldos ORDER BY creado_en DESC LIMIT 200
  `).all();
  res.json(filas);
});

export default router;
