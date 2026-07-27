// ============================================================
//  HERRAMIENTA DEL PROVEEDOR — Generar hash de su clave
//
//  SOLO para el desarrollador. Genera el valor SALT:HASH de la
//  clave que usted elija, para pegarlo en proveedor.js.
//
//  Uso:   npm run clave-proveedor "MiClaveSecreta"
// ============================================================

import crypto from 'node:crypto';

const clave = process.argv[2];

if (!clave) {
  console.log('');
  console.log('  Uso:  npm run clave-proveedor "su-clave-secreta"');
  console.log('  Ejemplo:  npm run clave-proveedor "SoporteSiliconBay2026"');
  console.log('');
  process.exit(0);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(clave, salt, 64).toString('hex');

console.log('');
console.log('  ============================================================');
console.log('     HASH DE SU CLAVE DE PROVEEDOR');
console.log('  ============================================================');
console.log('');
console.log('  Copie esta línea completa y péguela en el archivo');
console.log('  backend/src/licencia/proveedor.js, en PROVEEDOR_CLAVE:');
console.log('');
console.log('  ' + salt + ':' + hash);
console.log('');
console.log('  Su clave para entrar será la que acaba de escribir.');
console.log('  No la olvide ni la comparta con el cliente.');
console.log('  ============================================================');
console.log('');
