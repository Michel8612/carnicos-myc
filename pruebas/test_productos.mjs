// ============================================================
//  PRODUCTOS: precio en dólares, borrado y edición
//
//  Cubre los tres fallos que reportó el cliente en agosto:
//   1. No poder eliminar un producto (le llegaba el error crudo de la base).
//   2. El valor del inventario no reflejaba lo que daba de alta.
//   3. No poder meter el precio en dólares ni corregirlo después.
//
//  Corre DESPUÉS de sembrar. Fija la tasa a mano para no depender de
//  lo que diga elTOQUE hoy.
// ============================================================

import { login, api, assert } from './helpers.mjs';

let fallas = 0;
function A(cond, msg) { if (!assert(cond, msg)) fallas++; }

const TASA = 675;
const tok = await login('admin', 'admin123');
await api('PUT', '/api/tasas/manual', tok, { valor: TASA });

const almacenes = (await api('GET', '/api/inventario/almacenes', tok)).body;
const almacenId = (almacenes.almacenes || almacenes)[0].id;

const listar = async () => {
  const r = (await api('GET', '/api/inventario/productos', tok)).body;
  return r.productos || r;
};
const buscar = async (nombre) => (await listar()).find((p) => p.nombre === nombre);

console.log('\n=== 1. PRECIO EN DÓLARES AL CREAR ===');

let r = await api('POST', '/api/inventario/productos', tok, {
  nombre: 'Pollo del Norte', tipo: 'materia_prima',
  precio_costo_usd: 2, moneda_origen: 'USD',
  cantidad: 20, almacen_id: almacenId,
});
A(r.status === 200, 'se crea un producto declarando el costo SOLO en dólares');

const pollo = await buscar('Pollo del Norte');
A(pollo && Number(pollo.precio_costo) === 2 * TASA,
  `el peso se calcula solo: 2 USD x ${TASA} = ${2 * TASA} (real ${pollo && pollo.precio_costo})`);

console.log('\n=== 2. EL ALTA CON CANTIDAD ARCHIVA EL COSTO ===');
// Este era el fallo: dar de alta un producto con cantidad inicial dejaba
// una entrada "sin costo", así que el valor del inventario y las entradas
// por fecha salían en cero aunque el producto tuviera su precio.

const valor = (await api('GET', '/api/inventario/valor', tok)).body;
const hoy = valor.por_fecha[0];
A(Number(hoy.valor_cup) >= 20 * 2 * TASA,
  `las entradas de hoy valen al menos lo del alta (${hoy.valor_cup})`);
A(Number(hoy.valor_usd) >= 40,
  `y traen su importe en dólares: 20 x 2 = 40 (real ${hoy.valor_usd})`);

console.log('\n=== 3. CORREGIR EL PRECIO DESPUÉS, EN DÓLARES ===');
// El costo de compra cambia de un día para otro: sin esto había que dar
// de baja el producto y volverlo a crear.

r = await api('PUT', `/api/inventario/productos/${pollo.id}`, tok, {
  nombre: 'Pollo del Norte', tipo: 'materia_prima',
  precio_costo_usd: 3, moneda_origen: 'USD',
});
A(r.status === 200, 'se edita el precio de un producto ya creado');
A(Number(r.body.precio_costo) === 3 * TASA,
  `el nuevo peso sale del dólar: 3 x ${TASA} = ${3 * TASA} (real ${r.body.precio_costo})`);

// Editar solo el nombre NO puede dejar el precio en cero.
r = await api('PUT', `/api/inventario/productos/${pollo.id}`, tok, {
  nombre: 'Pollo del Norte II', tipo: 'materia_prima',
});
const tras = await buscar('Pollo del Norte II');
A(tras && Number(tras.precio_costo) === 3 * TASA,
  'editar el nombre sin tocar el precio conserva el precio');

console.log('\n=== 4. BORRAR UN PRODUCTO CON HISTORIAL ===');
// Antes reventaba con el error de Postgres. Ahora se explica y se ofrece
// ocultarlo, porque borrar su historial sería borrar contabilidad.

r = await api('DELETE', `/api/inventario/productos/${pollo.id}`, tok);
A(r.status === 409, `no lo borra a la brava (status ${r.status})`);
A(r.body.se_puede_ocultar === true, 'ofrece ocultarlo');
A(/no se puede borrar porque está usado en/.test(r.body.error || ''),
  'y explica en castellano dónde está usado');
A(!/relation|constraint|violates|ERROR:/i.test(r.body.error || ''),
  'el mensaje NO es el error crudo de la base de datos');

console.log('\n=== 5. OCULTAR Y RECUPERAR ===');

r = await api('DELETE', `/api/inventario/productos/${pollo.id}?ocultar=1`, tok);
A(r.status === 200 && r.body.ocultado, 'se puede ocultar');
A(!(await listar()).some((p) => p.id === pollo.id), 'deja de aparecer en la lista');

const ocultos = (await api('GET', '/api/inventario/productos/ocultos', tok)).body;
A(ocultos.some((p) => p.id === pollo.id), 'aparece entre los ocultos');

r = await api('POST', `/api/inventario/productos/${pollo.id}/mostrar`, tok);
A(r.status === 200, 'se puede volver a mostrar');
A((await listar()).some((p) => p.id === pollo.id),
  'vuelve a la lista: ocultar NO es un viaje de ida');

console.log('\n=== 6. BORRAR UNO SIN HISTORIAL SÍ LO BORRA ===');

await api('POST', '/api/inventario/productos', tok, {
  nombre: 'Producto pasajero', tipo: 'reventa', precio_costo: 10,
});
const pasajero = await buscar('Producto pasajero');
r = await api('DELETE', `/api/inventario/productos/${pasajero.id}`, tok);
A(r.status === 200 && r.body.eliminado,
  'un producto que nunca se usó se borra de verdad, no se oculta');
A(!(await listar()).some((p) => p.id === pasajero.id), 'y desaparece');

console.log(`\n========== TOTAL FALLAS: ${fallas} ==========`);
process.exit(fallas ? 1 : 0);
