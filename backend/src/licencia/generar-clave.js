// ============================================================
//  HERRAMIENTA DEL PROVEEDOR — Generar clave de activación
//
//  SOLO para uso del desarrollador. NO entregar al cliente.
//
//  Lee el identificador de esta instalación y muestra la clave
//  de activación que la desbloquea. Cuando el cliente pague,
//  ejecute esto, copie la clave y désela (o introdúzcala usted).
//
//  Ejecutar con:  npm run clave
// ============================================================

import db from '../db/index.js';
import { generarClaveProveedor } from './licencia.js';

const fila = await db.prepare('SELECT * FROM licencia WHERE id = 1').get();

if (!fila) {
  console.log('No hay licencia registrada todavía. Arranque el sistema una vez primero.');
  process.exit(0);
}

const clave = generarClaveProveedor(fila.id_instalacion);

console.log('');
console.log('  ============================================================');
console.log('     CLAVE DE ACTIVACIÓN DE ESTE SISTEMA');
console.log('  ============================================================');
console.log('');
console.log('     Instalación:', fila.id_instalacion);
console.log('     Estado:     ', fila.activada ? 'YA ACTIVADO' : 'sin activar');
console.log('');
console.log('     CLAVE:  ' + clave);
console.log('');
console.log('  ------------------------------------------------------------');
console.log('  Introduzca esta clave en la pantalla de activación del');
console.log('  sistema para desbloquearlo de forma permanente.');
console.log('  ============================================================');
console.log('');
