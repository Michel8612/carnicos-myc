// ============================================================
//  EL VENDEDOR RECIBE LA MERCANCÍA QUE LE MANDAN
//
//  El fallo que arregla esta batería: el almacenero enviaba producto a
//  un vendedor, el aviso no le llegaba, y como la mercancía enviada NO
//  entra sola —queda pendiente hasta que la aceptan— el vendedor se
//  quedaba sin ella para siempre.
//
//  Lo que se protege:
//   · que al enviar se cree el aviso, y llegue AL VENDEDOR de destino,
//   · que NO le llegue al vendedor de la otra tienda,
//   · que el dueño lo siga viendo todo,
//   · que el vendedor pueda aceptar y la mercancía entre en su hoja,
//   · que no pueda aceptar lo que va dirigido a otro,
//   · que en ningún momento se le escapen los costos,
//   · y que los avisos viejos, dirigidos a un rol, se sigan viendo.
//
//  Corre DESPUÉS de sembrar.
// ============================================================

import { login, api, assert } from './helpers.mjs';

let fallas = 0;
function A(cond, msg) { if (!assert(cond, msg)) fallas++; }

const tok = await login('admin', 'admin123');

// Hace falta un SEGUNDO vendedor: el aislamiento entre tiendas no se
// puede probar con uno solo, y es justo lo que se rompería si el aviso
// se dirigiera al rol 'ventas' en vez de a la persona.
const nuevo = await api('POST', '/api/usuarios', tok, {
  nombre: 'Vendedora Dos', usuario: 'vend2', rol: 'ventas', clave_temporal: 'prueba123',
});
A(nuevo.status === 200 || nuevo.status === 201, `se crea el segundo vendedor (${nuevo.status})`);

const usuarios = (await api('GET', '/api/usuarios', tok)).body;
const listaU = usuarios.usuarios || usuarios;
const vendA = listaU.find((u) => u.usuario === 'vend');
const vendB = listaU.find((u) => u.usuario === 'vend2');
A(!!vendA && !!vendB, `están los dos vendedores (A=${vendA?.id} B=${vendB?.id})`);

const tokA = await login('vend', 'prueba123');
const tokB = await login('vend2', 'prueba123');
const tokAlm = await login('alm1', 'prueba123');

const almacenes = (await api('GET', '/api/inventario/almacenes?todos=1', tok)).body;
const listaAlm = almacenes.almacenes || almacenes;
// El almacén de alm1: es el que puede usar como origen sin ser admin.
const almDeAlm1 = listaAlm.find((a) => /Almacenero Uno/.test(a.nombre)) || listaAlm[0];

const contarSinLeer = async (t) => Number((await api('GET', '/api/notificaciones/contador', t)).body.sin_leer);
const antesA = await contarSinLeer(tokA);
const antesB = await contarSinLeer(tokB);

console.log('\n=== 1. EL ALMACENERO ENVÍA AL VENDEDOR A ===');

let r = await api('POST', '/api/inventario/movimientos', tokAlm, {
  producto_id: 1, almacen_id: almDeAlm1.id, tipo: 'salida', cantidad: 7,
  destino_tipo: 'ventas', destino_id: vendA.id, nota: 'envío de prueba',
});
A(r.status === 200 && r.body.ok, `el almacenero puede enviar (${r.status})`);
A(r.body.transferencia_id > 0, 'queda una transferencia pendiente, no una entrada directa');
const transferenciaId = r.body.transferencia_id;

console.log('\n=== 2. EL AVISO LE LLEGA A ÉL, Y SOLO A ÉL ===');

const avisosA = (await api('GET', '/api/notificaciones', tokA)).body;
const mio = avisosA.find((n) => n.tipo === 'transferencia_pendiente'
  && Number(n.referencia_id) === transferenciaId);
A(!!mio, 'al vendedor destinatario le llega el aviso');
A(mio && /por recibir/i.test(mio.titulo), `y dice lo que pasa: "${mio && mio.titulo}"`);
A(mio && !mio.leida, 'y le llega sin leer, que es lo que enciende la campanita');

const avisosB = (await api('GET', '/api/notificaciones', tokB)).body;
A(!avisosB.some((n) => Number(n.referencia_id) === transferenciaId
  && n.tipo === 'transferencia_pendiente'),
  'al vendedor de la OTRA tienda no le llega: no ve qué ni cuánto se le manda al primero');

const avisosAdmin = (await api('GET', '/api/notificaciones', tok)).body;
A(avisosAdmin.some((n) => Number(n.referencia_id) === transferenciaId),
  'el dueño lo sigue viendo todo');

A((await contarSinLeer(tokA)) > antesA, 'a A le sube la campanita');
A((await contarSinLeer(tokB)) === antesB, 'a B no le sube');

console.log('\n=== 3. LA BANDEJA: CADA UNO VE LO SUYO ===');

const pendA = (await api('GET', '/api/inventario/transferencias/pendientes', tokA)).body;
A(pendA.some((t) => t.id === transferenciaId), 'A ve el envío en su bandeja');
const pendB = (await api('GET', '/api/inventario/transferencias/pendientes', tokB)).body;
A(!pendB.some((t) => t.id === transferenciaId), 'B no lo ve en la suya');

console.log('\n=== 4. NI DE PASO SE LE ESCAPAN LOS COSTOS ===');

const fila = pendA.find((t) => t.id === transferenciaId);
A(fila && fila.costo_unitario === undefined,
  'la respuesta cruda que recibe el vendedor NO trae costo_unitario');
A(fila && !Object.keys(fila).some((k) => /costo|precio/i.test(k)),
  `ni ningún otro campo de dinero (campos: ${fila && Object.keys(fila).join(',')})`);

console.log('\n=== 5. ACEPTAR: SOLO EL DESTINATARIO ===');

r = await api('POST', `/api/inventario/transferencias/${transferenciaId}/aceptar`, tokB);
A(r.status === 403, `el vendedor de la otra tienda no puede aceptarlo (${r.status})`);

r = await api('POST', `/api/inventario/transferencias/${transferenciaId}/aceptar`, tokA);
A(r.status === 200, `el destinatario sí (${r.status})`);

const hoja = (await api('GET', '/api/ventas/hoja', tokA)).body;
const enHoja = (hoja.productos || []).find((p) => /Carne/i.test(p.nombre));
A(!!enHoja, 'y el producto aparece en SU hoja del día');
A(enHoja && Number(enHoja.cantidad) >= 7, `con la cantidad enviada (${enHoja && enHoja.cantidad})`);

console.log('\n=== 6. ACEPTAR APAGA EL AVISO ===');

const avisosA2 = (await api('GET', '/api/notificaciones', tokA)).body;
const ya = avisosA2.find((n) => Number(n.referencia_id) === transferenciaId
  && n.tipo === 'transferencia_pendiente');
A(ya && ya.leida, 'el aviso queda leído solo: ya no hay nada que avisar');

r = await api('POST', `/api/notificaciones/${mio.id}/leida`, tokA);
A(r.status === 200, `y el vendedor puede marcarlo leído sin que le rebote (${r.status})`);

console.log('\n=== 7. UN ENVÍO A UN ALMACÉN SIGUE SIENDO DEL ALMACÉN ===');

r = await api('POST', '/api/inventario/movimientos', tok, {
  producto_id: 2, almacen_id: 1, tipo: 'salida', cantidad: 3,
  destino_tipo: 'almacen', destino_id: almDeAlm1.id, nota: 'envío a almacén',
});
A(r.status === 200, `se envía a un almacén (${r.status})`);
const transferenciaAlm = r.body.transferencia_id;

const avisosAlm = (await api('GET', '/api/notificaciones', tokAlm)).body;
A(avisosAlm.some((n) => Number(n.referencia_id) === transferenciaAlm),
  'al almacenero le llega por su rol');
const avisosA3 = (await api('GET', '/api/notificaciones', tokA)).body;
A(!avisosA3.some((n) => Number(n.referencia_id) === transferenciaAlm),
  'y al vendedor no, que no es asunto suyo');

console.log('\n=== 8. LO DE ANTES NO SE ROMPE ===');

// Un aviso dirigido a un ROL (como los que ya existían antes de este
// cambio) tiene que seguir llegándole a todo ese rol.
const avisosAlm2 = (await api('GET', '/api/notificaciones', tokAlm)).body;
A(avisosAlm2.some((n) => n.destino_rol === 'almacen'),
  'los avisos por rol siguen llegando');
const tokAlm2 = await login('alm2', 'prueba123');
const avisosOtroAlm = (await api('GET', '/api/notificaciones', tokAlm2)).body;
A(avisosOtroAlm.some((n) => n.destino_rol === 'almacen'),
  'y al otro almacenero también: un aviso de rol es para todo el rol');

// El vendedor sigue sin poder escribir en el almacén: aceptar un envío
// es lo ÚNICO que se le abrió.
r = await api('POST', '/api/inventario/movimientos', tokA, {
  producto_id: 1, almacen_id: 1, tipo: 'entrada', cantidad: 5,
});
A(r.status === 403, `el vendedor sigue sin poder tocar el almacén (${r.status})`);

console.log(`\n========== TOTAL FALLAS: ${fallas} ==========`);
process.exit(fallas ? 1 : 0);
