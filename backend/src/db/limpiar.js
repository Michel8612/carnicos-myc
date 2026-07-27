// ============================================================
//  Dejar TODO EN CEROS para la entrega
//
//  Borra todos los datos de prueba (movimientos, existencias,
//  caja, ventas, producción) pero CONSERVA lo básico para
//  empezar limpio: el usuario dueño, los almacenes y las
//  unidades de medida.
//
//  Úselo una sola vez, justo antes de entregar el sistema a
//  el dueño, para que arranque sin datos de prueba.
//
//  Ejecutar con:  npm run limpiar
// ============================================================

import db, { inicializarBaseDeDatos } from './index.js';

await inicializarBaseDeDatos();

console.log('Dejando el sistema en ceros para la entrega...');

// Tablas cuyo id (SERIAL) hay que reiniciar a 1 para que todo
// empiece limpio (equivalente al DELETE FROM sqlite_sequence de antes).
const TABLAS_CON_SECUENCIA = [
  'movimientos', 'existencias', 'caja', 'ventas', 'ventas_detalle',
  'compras', 'compras_detalle', 'ordenes_produccion', 'formulas',
  'formula_valores', 'transporte', 'productos',
];

const limpiar = db.transaction(async () => {
  // Borrar todos los movimientos y datos operativos.
  await db.prepare('DELETE FROM movimientos').run();
  await db.prepare('DELETE FROM existencias').run();
  await db.prepare('DELETE FROM caja').run();
  await db.prepare('DELETE FROM ventas_detalle').run();
  await db.prepare('DELETE FROM ventas').run();
  await db.prepare('DELETE FROM compras_detalle').run();
  await db.prepare('DELETE FROM compras').run();
  await db.prepare('DELETE FROM ordenes_produccion').run();
  await db.prepare('DELETE FROM formula_valores').run();
  await db.prepare('DELETE FROM formulas').run();
  await db.prepare('DELETE FROM transporte').run();

  // Borrar productos de prueba (el catálogo lo llena el dueño).
  await db.prepare('DELETE FROM productos').run();

  // Borrar usuarios de prueba, pero CONSERVAR al dueño.
  await db.prepare("DELETE FROM usuarios WHERE usuario != 'dueno'").run();

  // Borrar el registro de sincronización.
  await db.prepare('DELETE FROM sync_aplicados').run();

  // Reiniciar los contadores de id (SERIAL) para que todo empiece desde 1.
  for (const t of TABLAS_CON_SECUENCIA) {
    await db.exec(`ALTER SEQUENCE ${t}_id_seq RESTART WITH 1`);
  }
});

await limpiar();

// Comprobar que quedó limpio.
const cuenta = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;

console.log('');
console.log('Sistema en ceros. Estado final:');
console.log(`  Productos:    ${await cuenta('productos')}  (el dueño los agrega)`);
console.log(`  Movimientos:  ${await cuenta('movimientos')}`);
console.log(`  Caja:         ${await cuenta('caja')}`);
console.log(`  Existencias:  ${await cuenta('existencias')}`);
console.log(`  Usuarios:     ${await cuenta('usuarios')}  (solo el dueño)`);
console.log(`  Almacenes:    ${await cuenta('almacenes')}  (conservados)`);
console.log(`  Unidades:     ${await cuenta('unidades')}  (conservadas)`);
console.log('');
console.log('Listo para entregar. El dueño entra con su usuario y empieza limpio.');
