// Regenera backend/src/db/schema.js a partir de schema.sql.
// En Netlify los .sql no viajan con la funcion serverless: el esquema
// tiene que existir tambien como modulo JS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Se resuelve a partir de la ubicación de este archivo, para que siga
// funcionando aunque se mueva la carpeta del proyecto.
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..', 'backend', 'src', 'db');
const sql = fs.readFileSync(`${RAIZ}/schema.sql`, 'utf8');

// Escapar lo que rompe un template literal: la barra invertida primero,
// despues la comilla invertida y la apertura de interpolacion.
const esc = sql
  .split('\\').join('\\\\')
  .split('`').join('\\`')
  .split('${').join('\\${');

const cabecera = [
  '// Esquema de la base de datos como modulo JS.',
  '// Se genera desde schema.sql: en Netlify los .sql no viajan con la',
  '// funcion serverless, por eso el esquema vive tambien aqui.',
  '',
  'export const SCHEMA_SQL = `',
].join('\n');

fs.writeFileSync(`${RAIZ}/schema.js`, `${cabecera}${esc}\`;\n\nexport default SCHEMA_SQL;\n`);
console.log('schema.js regenerado desde schema.sql —', sql.length, 'caracteres');
