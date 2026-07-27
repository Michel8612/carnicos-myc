// ============================================================
//  RESPALDO DE LA BASE DE DATOS
//
//  Antes esto copiaba el archivo SQLite local a una carpeta de
//  respaldos. Ahora la base de datos vive en la nube (Postgres/
//  Neon), que ya gestiona sus propias copias de seguridad. Esta
//  función se conserva (mismo nombre de export) para que
//  server.js no tenga que cambiar, pero ya no hace nada por su
//  cuenta.
// ============================================================

export async function respaldarBaseDeDatos() {
  console.log('Respaldo gestionado por Neon (Postgres en la nube).');
}
