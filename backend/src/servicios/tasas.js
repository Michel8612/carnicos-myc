// ============================================================
//  Proveedor de Tasas de Cambio (USD/CUP)
//
//  Pieza CENTRAL y única que sabe hablar con elTOQUE (o con quien
//  sea en el futuro). Ninguna otra parte del sistema debe llamar
//  directamente a una API externa de tasas: todos pasan por aquí.
//
//  Filosofía: el sistema tiene que funcionar HOY, sin token y con
//  la conexión mala de Cuba. Por eso:
//   - Se cachea 1 hora en tasas_cambio (no gastar peticiones).
//   - Si el proveedor falla por lo que sea, se devuelve la última
//     tasa válida guardada, marcada como "pendiente" (nunca se
//     lanza una excepción hacia arriba: el llamador siempre recibe
//     un objeto usable).
//   - Si nunca hubo ninguna tasa, se devuelve disponible:false.
//   - Hay un respaldo manual (parametros.tasa_manual) para trabajar
//     desde el primer día, mientras elTOQUE aprueba el token.
// ============================================================

import db from '../db/index.js';
import { obtenerCredencial } from '../routes/credenciales.js';

const UNA_HORA_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 7000; // conexión mala en Cuba: que nunca cuelgue la app
const MONEDA = 'USD';

// ------------------------------------------------------------
//  Adaptadores de proveedores — mapa intercambiable.
//  Añadir un proveedor nuevo en el futuro = escribir un objeto
//  más aquí con { nombre, disponible(), consultar() } y nada más.
// ------------------------------------------------------------
const PROVEEDORES = {
  eltoque: {
    nombre: 'elTOQUE',
    // Sin token no tiene sentido ni intentar la llamada. El token sale
    // de obtenerCredencial(): 1º lo que el dueño puso en el panel
    // (Empresa → Credenciales), 2º la variable de entorno ELTOQUE_TOKEN
    // del despliegue. Por eso pasó de ser síncrono a async: consultar
    // la base cuesta una petición más, pero es la única forma de que
    // "el dueño puso el token en el panel" tenga efecto AL MOMENTO, sin
    // esperar a un reinicio del contenedor serverless.
    disponible: async () => Boolean(await obtenerCredencial('ELTOQUE_TOKEN')),
    async consultar() {
      const token = await obtenerCredencial('ELTOQUE_TOKEN');
      const controlador = new AbortController();
      const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
      try {
        const resp = await fetch('https://tasas.eltoque.com/v1/trmi', {
          headers: { Authorization: `Bearer ${token}` },
          signal: controlador.signal,
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const datos = await resp.json();
        // El formato conocido (de la comunidad) es { tasas: { USD, ECU, MLC, ... }, date }.
        // Programamos a la defensiva: puede variar.
        const valor = Number(datos?.tasas?.USD);
        if (!Number.isFinite(valor) || valor <= 0) {
          throw new Error('La respuesta de elTOQUE no trajo una tasa USD válida.');
        }
        return { valor, fecha_tasa: datos?.date || null };
      } finally {
        clearTimeout(temporizador);
      }
    },
  },
};

// Proveedor que se usa hoy. El día que se quiera cambiar u ofrecer
// varios, esto puede pasar a ser un parámetro más de la tabla `parametros`.
const PROVEEDOR_ACTIVO = 'eltoque';

// ------------------------------------------------------------
//  Acceso a la base
// ------------------------------------------------------------

async function ultimaFilaGuardada() {
  return db
    .prepare(
      `SELECT valor, fuente, fecha_tasa, obtenida_en
         FROM tasas_cambio
        WHERE moneda = ?
        ORDER BY obtenida_en DESC
        LIMIT 1`
    )
    .get(MONEDA);
}

async function guardarTasa({ valor, fuente, fecha_tasa }) {
  await db
    .prepare(
      `INSERT INTO tasas_cambio (moneda, valor, fuente, fecha_tasa) VALUES (?, ?, ?, ?)`
    )
    .run(MONEDA, valor, fuente, fecha_tasa || null);
}

async function tasaManualDeParametros() {
  const fila = await db.prepare(`SELECT valor FROM parametros WHERE clave = 'tasa_manual'`).get();
  const n = fila ? Number(fila.valor) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function obtenerMargen() {
  const fila = await db.prepare(`SELECT valor FROM parametros WHERE clave = 'margen_usd'`).get();
  const n = fila ? Number(fila.valor) : NaN;
  return Number.isFinite(n) ? n : 0.02; // 2% por defecto
}

// ------------------------------------------------------------
//  Utilidades
// ------------------------------------------------------------

function esReciente(fechaISO) {
  if (!fechaISO) return false;
  const ms = new Date(fechaISO).getTime();
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms < UNA_HORA_MS;
}

// Traduce errores técnicos (red, HTTP, timeout, JSON raro) a un
// motivo legible en español para mostrar en la interfaz.
function motivoLegible(err) {
  if (err?.name === 'AbortError') {
    return 'La consulta a elTOQUE tardó demasiado y se canceló (conexión lenta).';
  }
  if (err instanceof TypeError) {
    return 'No hay conexión con elTOQUE en este momento.';
  }
  const msg = err?.message || '';
  if (msg.startsWith('HTTP')) {
    return `elTOQUE respondió con un error (${msg}).`;
  }
  return msg || 'No se pudo consultar la tasa de elTOQUE.';
}

function respuesta({ disponible, valor, fuente, actualizada, pendiente, motivo, margen }) {
  return {
    disponible,
    valor: valor ?? null,
    fuente: fuente ?? null,
    actualizada: actualizada ?? null,
    pendiente: Boolean(pendiente),
    motivo: motivo ?? null,
    margen,
  };
}

// Cuando el proveedor no está disponible o falla: usar la última
// tasa guardada (marcando pendiente), o si no hay ninguna, la tasa
// manual de `parametros`, o si tampoco existe, disponible:false.
async function respaldo({ margen, motivo, ultima }) {
  if (ultima) {
    return respuesta({
      disponible: true,
      valor: ultima.valor,
      fuente: ultima.fuente,
      actualizada: ultima.obtenida_en,
      pendiente: true,
      motivo,
      margen,
    });
  }
  const manual = await tasaManualDeParametros();
  if (manual != null) {
    return respuesta({
      disponible: true,
      valor: manual,
      fuente: 'manual',
      actualizada: null,
      pendiente: true,
      motivo,
      margen,
    });
  }
  return respuesta({
    disponible: false,
    valor: null,
    fuente: null,
    actualizada: null,
    pendiente: true,
    motivo: motivo || 'Todavía no hay ninguna tasa registrada. Fije una tasa manual mientras llega el token de elTOQUE.',
    margen,
  });
}

// ------------------------------------------------------------
//  API del servicio
// ------------------------------------------------------------

// Devuelve la tasa actual. NUNCA lanza: ante cualquier fallo,
// devuelve la mejor información disponible (o disponible:false).
export async function obtenerTasa({ forzar = false } = {}) {
  const margen = await obtenerMargen();

  let ultima;
  try {
    ultima = await ultimaFilaGuardada();
  } catch {
    ultima = undefined; // si falla la lectura de caché, seguimos igual
  }

  // 1. Caché: si hay una tasa de hace menos de una hora y no se
  //    fuerza la actualización, se devuelve tal cual (no gastar peticiones).
  //    OJO: "pendiente" no es solo "¿está vieja?", es "¿es de verdad la
  //    tasa real de elTOQUE, o es el respaldo manual?". Si la última fila
  //    guardada vino de 'manual' (no del proveedor activo), sigue siendo
  //    un valor "pendiente de actualización real" aunque esté recién
  //    puesta — si no, el frontend mostraría una tasa manual como si
  //    fuera la tasa oficial confirmada.
  if (!forzar && ultima && esReciente(ultima.obtenida_en)) {
    const esDelProveedorReal = ultima.fuente === PROVEEDORES[PROVEEDOR_ACTIVO].nombre;
    return respuesta({
      disponible: true,
      valor: ultima.valor,
      fuente: ultima.fuente,
      actualizada: ultima.obtenida_en,
      pendiente: !esDelProveedorReal,
      motivo: null,
      margen,
    });
  }

  // 2. Intentar el proveedor activo.
  const proveedor = PROVEEDORES[PROVEEDOR_ACTIVO];
  if (await proveedor.disponible()) {
    try {
      const resultado = await proveedor.consultar();
      try {
        await guardarTasa({ valor: resultado.valor, fuente: proveedor.nombre, fecha_tasa: resultado.fecha_tasa });
      } catch {
        // si falla el guardado no pasa nada grave: igual devolvemos la tasa fresca
      }
      return respuesta({
        disponible: true,
        valor: resultado.valor,
        fuente: proveedor.nombre,
        actualizada: new Date().toISOString(),
        pendiente: false,
        motivo: null,
        margen,
      });
    } catch (err) {
      // 3. Falló (sin red, HTTP, JSON raro, timeout): respaldo.
      return respaldo({ margen, motivo: motivoLegible(err), ultima });
    }
  }

  // Sin token: directo al respaldo, sin intentar la llamada.
  return respaldo({
    margen,
    motivo: 'Todavía no se ha puesto el token de elTOQUE. Se pone desde el panel, en Empresa → Credenciales.',
    ultima,
  });
}

// Guarda la tasa manual (respaldo para trabajar sin token) y además
// una fila en tasas_cambio con fuente:'manual', para que quede en
// el historial y disponible de inmediato como "última tasa válida".
export async function fijarTasaManual(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('La tasa debe ser un número positivo.');
  }
  // OJO: la tabla `parametros` no tiene columna `id` (su clave primaria es
  // `clave`). El adaptador de la base añade "RETURNING id" a cualquier
  // INSERT que no traiga ya un RETURNING, así que se lo damos explícito
  // para que no intente devolver una columna que no existe.
  await db
    .prepare(
      `INSERT INTO parametros (clave, valor, actualizado_en) VALUES ('tasa_manual', ?, NOW())
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = NOW()
       RETURNING clave`
    )
    .run(String(n));
  await guardarTasa({ valor: n, fuente: 'manual', fecha_tasa: null });
  return obtenerTasa({ forzar: false });
}
