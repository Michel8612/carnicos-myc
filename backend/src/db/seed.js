// ============================================================
//  Datos iniciales (semilla)
//
//  Crea lo mínimo para arrancar:
//   - Las unidades de medida típicas
//   - Los almacenes reales del negocio
//   - Un usuario dueño para el primer acceso
//
//  Se ejecuta una sola vez. Si ya hay datos, no los duplica.
// ============================================================

import db, { inicializarBaseDeDatos } from './index.js';
import bcrypt from 'bcryptjs';

await inicializarBaseDeDatos();

const hayUsuarios = (await db.prepare('SELECT COUNT(*) AS n FROM usuarios').get()).n;

if (hayUsuarios > 0) {
  console.log('La base de datos ya tiene datos. No se vuelve a sembrar.');
  process.exit(0);
}

// --- Unidades de medida ---
// Incluye las unidades "base" originales y las líquidas/volumen
// (Litro, Mililitro, Gramo, Galón), que antes insertaba una
// migración de SQLite que ya no existe en Postgres. Se insertan
// solo si aún no existen, comprobando por abreviatura.
const insUnidad = db.prepare('INSERT INTO unidades (nombre, abreviatura) VALUES (?, ?)');
const existeUnidad = db.prepare('SELECT 1 FROM unidades WHERE abreviatura = ? LIMIT 1');
const unidades = [
  ['Kilogramo', 'kg'],
  ['Libra', 'lb'],
  ['Unidad', 'u'],
  ['Caja', 'caja'],
  ['Contenedor', 'cont'],
  ['Litro', 'L'],
  ['Mililitro', 'ml'],
  ['Gramo', 'g'],
  ['Galón', 'gal'],
];
for (const [n, a] of unidades) {
  if (!(await existeUnidad.get(a))) await insUnidad.run(n, a);
}

// --- Almacenes reales del negocio ---
// --- Almacenes de ejemplo (el dueño los renombra o agrega los suyos) ---
const insAlmacen = db.prepare('INSERT INTO almacenes (nombre, zona, descripcion) VALUES (?, ?, ?)');
await insAlmacen.run('Almacén principal', 'seco', 'Almacén general');
await insAlmacen.run('Mostrador / Venta', 'seco', 'Punto de venta');

// --- Usuario dueño (primer acceso) ---
// Contraseña inicial: cambiar después del primer ingreso. El nombre real
// del dueño y del negocio se ponen en el primer ingreso / Ajustes.
const claveInicial = 'admin123';
const hash = bcrypt.hashSync(claveInicial, 10);
await db.prepare(
  'INSERT INTO usuarios (nombre, usuario, clave_hash, rol, debe_cambiar) VALUES (?, ?, ?, ?, 1)'
).run('Dueño', 'dueno', hash, 'dueno');

console.log('Datos iniciales creados.');
console.log('Usuario: dueno');
console.log('Clave:   admin123  (cámbiela después del primer ingreso)');
process.exit(0);
