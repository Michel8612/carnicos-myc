// ============================================================
//  LIBRO DE CONTABILIDAD
//
//  Un solo lugar donde anotar todo hecho económico del negocio:
//  ventas del día, entradas y salidas del almacén, producciones
//  y gastos. Cada anotación lleva su fecha y hora y se conserva
//  por tiempo indefinido, hasta que el contador decida borrarla.
//
//  Lo usan las demás secciones (almacén, ventas, cocina) para que
//  el contador vea TODO sin tener que ir a buscarlo a cada área.
// ============================================================

import db from './db/index.js';

/**
 * Anota un hecho económico en el libro.
 * Nunca interrumpe la operación principal: si el apunte falla, se
 * avisa por consola pero la venta o el movimiento siguen su curso.
 */
export async function anotar({
  tipo,            // venta | almacen | produccion | gasto
  concepto,
  producto = null,
  cantidad = 0,
  unidad = null,
  costo = 0,
  ingreso = 0,
  valor = 0,       // valor de referencia (mercancía movida), no afecta el resultado
  area = null,
  usuario = null,  // objeto de sesión (req.usuario)
  nota = null,
}) {
  try {
    const ganancia = Number((Number(ingreso || 0) - Number(costo || 0)).toFixed(2));
    await db.prepare(`
      INSERT INTO contabilidad_registros
        (tipo, concepto, producto, cantidad, unidad, costo, ingreso, ganancia,
         valor, area, usuario_id, usuario_nombre, nota)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tipo, concepto, producto, Number(cantidad || 0), unidad,
      Number(costo || 0), Number(ingreso || 0), ganancia, Number(valor || 0),
      area, usuario ? usuario.id : null, usuario ? (usuario.nombre || usuario.usuario) : null, nota
    );
  } catch (e) {
    console.error('No se pudo anotar en el libro de contabilidad:', e.message);
  }
}

export default { anotar };
