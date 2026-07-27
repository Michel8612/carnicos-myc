// ============================================================
//  Licencia y periodo de prueba
//
//  El sistema arranca con 14 días de prueba. Al vencer, se
//  bloquea (sin borrar datos) hasta que se introduzca la clave
//  de activación, que solo el proveedor puede generar.
//
//  La clave está atada a esta instalación concreta, así una
//  misma clave no sirve en otra copia del sistema.
// ============================================================

import crypto from 'node:crypto';
import db from '../db/index.js';

const DIAS_PRUEBA = 14;

// Secreto del proveedor. SOLO el desarrollador lo conoce.
// Con él se generan y verifican las claves de activación.
// IMPORTANTE: cambiar esto por un valor propio y secreto antes
// de entregar, y NO compartirlo con el cliente.
const SECRETO_LICENCIA = process.env.SECRETO_LICENCIA || '65b326c0c0af1ce73df9b3b1973e121c04c91368515be2ec';

// Registra la fecha de inicio la primera vez que arranca el sistema.
// La tabla 'licencia' ya la crea el schema.sql; aquí solo se
// comprueba si hace falta sembrar la fila inicial (id = 1).
export async function inicializarLicencia() {
  const fila = await db.prepare('SELECT * FROM licencia WHERE id = 1').get();
  if (!fila) {
    // Primera vez: registrar fecha y un identificador único de esta instalación.
    const idInstalacion = crypto.randomBytes(8).toString('hex');
    await db.prepare(
      'INSERT INTO licencia (id, instalada_en, id_instalacion, activada) VALUES (1, ?, ?, 0)'
    ).run(new Date().toISOString(), idInstalacion);
  }
}

// Calcula la clave de activación correcta para esta instalación.
// Es una huella del id de instalación + el secreto del proveedor.
function claveEsperada(idInstalacion) {
  return crypto
    .createHmac('sha256', SECRETO_LICENCIA)
    .update(idInstalacion)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase()
    .match(/.{1,4}/g)
    .join('-');   // formato bonito: XXXX-XXXX-XXXX-XXXX
}

// Devuelve el estado actual de la licencia.
export async function estadoLicencia() {
  const fila = await db.prepare('SELECT * FROM licencia WHERE id = 1').get();
  if (!fila) return { estado: 'error' };

  if (fila.activada) {
    return { estado: 'activada', id_instalacion: fila.id_instalacion };
  }

  const inicio = new Date(fila.instalada_en);
  const ahora = new Date();
  const diasPasados = Math.floor((ahora - inicio) / (1000 * 60 * 60 * 24));
  const diasRestantes = DIAS_PRUEBA - diasPasados;

  if (diasRestantes <= 0) {
    return { estado: 'vencida', id_instalacion: fila.id_instalacion };
  }
  return { estado: 'prueba', dias_restantes: diasRestantes, id_instalacion: fila.id_instalacion };
}

// Intenta activar con una clave. Devuelve true si la clave es correcta.
export async function activarLicencia(clave) {
  const fila = await db.prepare('SELECT * FROM licencia WHERE id = 1').get();
  if (!fila) return false;

  const esperada = claveEsperada(fila.id_instalacion);
  const recibida = (clave || '').trim().toUpperCase();

  if (recibida === esperada) {
    await db.prepare('UPDATE licencia SET activada = 1 WHERE id = 1').run();
    return true;
  }
  return false;
}

// Solo para uso del PROVEEDOR: genera la clave de una instalación.
// Se usa desde la herramienta de línea de comandos, nunca expuesta al cliente.
export function generarClaveProveedor(idInstalacion) {
  return claveEsperada(idInstalacion);
}
