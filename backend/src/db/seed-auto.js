// ============================================================
//  Auto-siembra (semilla de arranque)
//
//  En la nube (serverless) no es cómodo correr un script de seed
//  a mano. Esta función se llama en cada arranque pero SOLO hace
//  algo la primera vez: si no hay ningún usuario, crea las
//  unidades de medida, un par de almacenes de ejemplo y el
//  usuario dueño inicial (dueno / admin123, obliga a cambiarla).
//
//  Es idempotente: si ya hay datos, no toca nada.
// ============================================================

import db from './index.js';
import bcrypt from 'bcryptjs';

const UNIDADES = [
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

export async function sembrarSiVacio() {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM usuarios').get();
  if (row.n > 0) return false; // ya hay datos: no sembrar

  for (const [nombre, abrev] of UNIDADES) {
    const ex = await db.prepare('SELECT 1 FROM unidades WHERE abreviatura = ? LIMIT 1').get(abrev);
    if (!ex) await db.prepare('INSERT INTO unidades (nombre, abreviatura) VALUES (?, ?)').run(nombre, abrev);
  }

  await db.prepare('INSERT INTO almacenes (nombre, zona, descripcion) VALUES (?, ?, ?)')
    .run('Almacén principal', 'seco', 'Materias primas');
  await db.prepare('INSERT INTO almacenes (nombre, zona, descripcion) VALUES (?, ?, ?)')
    .run('Centro de elaboración', 'embutido', 'Producción');
  await db.prepare('INSERT INTO almacenes (nombre, zona, descripcion) VALUES (?, ?, ?)')
    .run('Mostrador / Venta', 'seco', 'Punto de venta');

  const hash = bcrypt.hashSync('admin123', 10);
  await db.prepare(
    'INSERT INTO usuarios (nombre, usuario, clave_hash, rol, debe_cambiar) VALUES (?, ?, ?, ?, 0)'
  ).run('Administrador', 'admin', hash, 'dueno');

  // Nombre del negocio para la cabecera / login.
  await db.prepare("UPDATE config_negocio SET nombre = ? WHERE id = 1").run('Cárnicos M&C');

  console.log('Semilla Cárnicos M&C creada. Usuario: admin  Clave: admin123');
  return true;
}
