// ============================================================
//  Conexión a la base de datos  —  PostgreSQL (Neon)
//
//  Antes el sistema usaba SQLite (archivo local). Para la nube
//  (Netlify + Neon) pasamos a PostgreSQL de verdad.
//
//  Para NO tener que reescribir toda la lógica de las rutas,
//  este archivo expone el MISMO adaptador de siempre:
//      db.prepare(sql).get(...args)   -> una fila (o undefined)
//      db.prepare(sql).all(...args)   -> todas las filas
//      db.prepare(sql).run(...args)   -> { lastInsertRowid, changes }
//      db.exec(sql)                   -> ejecuta SQL suelto
//      db.transaction(fn)             -> corre fn en una transacción
//
//  Diferencia importante: ahora TODO es asíncrono. Las rutas
//  llaman con  await db.prepare(...).get(...).
//
//  Trucos del adaptador para no cambiar el SQL de las rutas:
//   - Convierte los '?' de SQLite a '$1, $2 ...' de Postgres.
//   - En los INSERT sin RETURNING, añade "RETURNING id" para
//     emular el lastInsertRowid que devolvía SQLite.
//   - Usa AsyncLocalStorage para que, dentro de una transacción,
//     todas las consultas viajen por la MISMA conexión (cliente),
//     sin tener que pasar el cliente a mano por cada llamada.
//
//  Requiere la variable de entorno DATABASE_URL (cadena de Neon).
// ============================================================

import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// --- Números: que los DOUBLE/NUMERIC lleguen como number, no string ---
// pg devuelve NUMERIC (OID 1700) y BIGINT (20) como texto por defecto,
// lo que rompería los cálculos (sumar "10" + "5" = "105"). Los forzamos
// a número. Los importes usan DOUBLE PRECISION, que ya llega como number.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // NUMERIC
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // BIGINT (COUNT)

const connectionString = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  console.warn(
    'AVISO: falta DATABASE_URL. Defina la cadena de conexión de Postgres (Neon) en las variables de entorno.'
  );
}

// SSL: Neon exige TLS. En local (Postgres de Docker) se puede desactivar
// poniendo PGSSL=off.
const ssl = process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString,
  ssl,
  max: Number(process.env.PG_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

// Contexto de transacción: guarda el cliente activo para la petición
// en curso, sin ensuciar variables globales (a prueba de concurrencia).
const als = new AsyncLocalStorage();

// Devuelve el ejecutor correcto: el cliente de la transacción si
// estamos dentro de una, o el pool normal si no.
function ejecutor() {
  const store = als.getStore();
  return store?.client || pool;
}

// '?'  ->  '$1', '$2', ...   (placeholders de Postgres)
function aPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Si es un INSERT sin RETURNING, añadimos RETURNING id para poder
// devolver el id nuevo (como hacía lastInsertRowid en SQLite).
function conRetornoId(sql) {
  const s = sql.trim();
  if (/^insert/i.test(s) && !/returning/i.test(s)) {
    return s.replace(/;?\s*$/, ' RETURNING id');
  }
  return sql;
}

async function consultar(sql, params) {
  return ejecutor().query(aPostgres(sql), params);
}

const db = {
  prepare(sql) {
    return {
      get: async (...args) => {
        const r = await consultar(sql, args);
        return r.rows[0]; // undefined si no hay filas
      },
      all: async (...args) => {
        const r = await consultar(sql, args);
        return r.rows;
      },
      run: async (...args) => {
        const r = await consultar(conRetornoId(sql), args);
        return {
          lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined,
          changes: r.rowCount,
        };
      },
    };
  },

  // Ejecuta SQL suelto (puede traer varias sentencias). Sin parámetros.
  async exec(sql) {
    await ejecutor().query(sql);
  },

  // Corre fn dentro de una transacción. Todas las consultas que fn
  // haga con db.prepare(...) usarán automáticamente el mismo cliente.
  // OJO: fn debe ser async (o devolver una promesa) y quien llame a
  // la función devuelta debe usar await.
  transaction(fn) {
    return async (...args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const resultado = await als.run({ client }, () => fn(...args));
        await client.query('COMMIT');
        return resultado;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* si el rollback falla, dejamos que suba el error original */
        }
        throw err;
      } finally {
        client.release();
      }
    };
  },
};

// Crea todas las tablas si no existen. Idempotente: se puede llamar
// en cada arranque sin peligro.
export async function inicializarBaseDeDatos() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(schema);
  console.log('Base de datos lista (PostgreSQL).');
}

export default db;
