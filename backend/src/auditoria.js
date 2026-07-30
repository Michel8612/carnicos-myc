// ============================================================
//  AUDITORÍA CENTRALIZADA
//
//  Un solo sitio donde queda constancia de QUIÉN hizo QUÉ y CUÁNDO:
//  entradas y salidas de sesión, altas, cambios, borrados, movimientos
//  de almacén, ventas, producción y cambios de configuración.
//
//  Por qué existe aparte del libro de contabilidad: el libro cuenta
//  hechos ECONÓMICOS (dinero y mercancía); la auditoría cuenta hechos
//  de USO del sistema (quién tocó qué). Son preguntas distintas y
//  mezclarlas haría ilegibles las dos.
//
//  Regla dura: esta tabla NO se borra desde la aplicación. Un registro
//  de auditoría que se puede borrar no sirve para auditar nada.
// ============================================================

import db from './db/index.js';

// Los módulos y acciones son texto libre a propósito (así una sección
// nueva no obliga a migrar la base), pero conviene usar SIEMPRE estos
// para que los filtros de la pantalla de auditoría sigan sirviendo.
export const MODULOS = [
  'sesion', 'usuarios', 'ventas', 'almacen', 'contabilidad', 'tributacion',
  'gastos', 'nomina', 'produccion', 'recetas', 'compras', 'bancos',
  'empresa', 'config', 'legal', 'tasas',
];

export const ACCIONES = [
  'login', 'login_fallido', 'logout', 'crear', 'modificar', 'eliminar',
  'autorizar', 'aceptar', 'cancelar', 'exportar',
];

/**
 * Deja constancia de una acción.
 *
 * Nunca interrumpe la operación principal: si el apunte de auditoría
 * falla (base caída, columna nueva sin migrar...), se avisa por consola
 * y la venta, el borrado o lo que fuese sigue su curso. Perder una
 * línea de auditoría es malo; tumbar la operación del cliente es peor.
 *
 * @param {object} datos
 * @param {string} datos.modulo    - de MODULOS
 * @param {string} datos.accion    - de ACCIONES
 * @param {object} datos.req       - la petición, para sacar usuario e IP
 * @param {string} [datos.entidad] - qué objeto se tocó (tabla o concepto)
 * @param {string|number} [datos.entidad_id]
 * @param {string} [datos.descripcion]
 * @param {*} [datos.antes]        - valor anterior (se serializa solo)
 * @param {*} [datos.despues]      - valor nuevo (se serializa solo)
 * @param {string} [datos.motivo]
 * @param {object} [datos.autorizadoPor] - usuario que prestó el permiso
 */
export async function auditar({
  modulo,
  accion,
  req = null,
  entidad = null,
  entidad_id = null,
  descripcion = null,
  antes = undefined,
  despues = undefined,
  motivo = null,
  autorizadoPor = null,
  usuario = null,
}) {
  try {
    const u = usuario || req?.usuario || null;
    await db.prepare(`
      INSERT INTO auditoria
        (usuario_id, usuario_nombre, rol, modulo, accion, entidad, entidad_id,
         descripcion, valor_anterior, valor_nuevo, motivo,
         autorizado_por, autorizado_nombre, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      u?.id ?? null,
      u?.nombre ?? u?.usuario ?? null,
      u?.rol ?? null,
      modulo,
      accion,
      entidad,
      entidad_id == null ? null : String(entidad_id),
      descripcion,
      serializar(antes),
      serializar(despues),
      motivo,
      autorizadoPor?.id ?? null,
      autorizadoPor?.nombre ?? autorizadoPor?.usuario ?? null,
      ipDe(req),
    );
  } catch (e) {
    console.error('No se pudo escribir en auditoría:', e.message);
  }
}

// Guardamos los valores como texto: un objeto va en JSON legible y un
// número o cadena va tal cual, para que la pantalla no tenga que
// adivinar el formato al mostrarlo.
function serializar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// La IP real cuando hay un proxy delante (Netlify siempre lo tiene).
function ipDe(req) {
  if (!req) return null;
  const reenviada = req.headers?.['x-forwarded-for'];
  if (reenviada) return String(reenviada).split(',')[0].trim();
  return req.headers?.['x-nf-client-connection-ip'] || req.ip || null;
}

export default { auditar, MODULOS, ACCIONES };
