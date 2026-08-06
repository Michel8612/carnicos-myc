// ============================================================
//  COSTOS EN DOS MONEDAS AL DAR ENTRADA (Parte 5)
//
//  Lo que se protege aquí es una regla contable, no una pantalla:
//  de cada entrada tienen que quedar archivados los DOS importes y
//  LA TASA de ese día. Si alguien "simplifica" en el futuro guardando
//  solo el USD, el costo de las compras viejas empezaría a moverse
//  solo con el dólar y esta batería lo cazaría.
//
//  Corre DESPUÉS de sembrar. Fija la tasa a mano (400) para que el
//  resultado no dependa de lo que diga elTOQUE hoy.
// ============================================================

import { login, api, assert } from './helpers.mjs';
import { execSync } from 'node:child_process';

let fallas = 0;
function A(cond, msg) { if (!assert(cond, msg)) fallas++; }

function sql(q) {
  return execSync(
    `docker exec gestion-db-test psql -U gestion -d gestion -t -A -c "${q.replace(/"/g, '\\"')}"`,
  ).toString().trim();
}

const TASA = 400;

const tok = await login('admin', 'admin123');

// Tasa fija: si dependiéramos de la de elTOQUE, la prueba daría un
// resultado distinto cada día y dejaría de servir para nada.
await api('PUT', '/api/tasas/manual', tok, { valor: TASA });

const almacenes = (await api('GET', '/api/inventario/almacenes', tok)).body;
const almacenId = (almacenes.almacenes || almacenes)[0].id;
const productos = (await api('GET', '/api/inventario/productos', tok)).body;
const productoId = (productos.productos || productos)[0].id;

const entrada = (extra) => api('POST', '/api/inventario/movimientos', tok, {
  producto_id: productoId, almacen_id: almacenId, tipo: 'entrada', cantidad: 1, ...extra,
});

console.log('\n=== 1. CONVERSIÓN EN LOS DOS SENTIDOS ===');

let r = await entrada({ costo_cup: 800 });
A(r.status === 200, 'entrada con importe solo en CUP');
A(r.body.costo.usd === 2, `de 800 CUP saca 2 USD a la tasa ${TASA} (real ${r.body.costo.usd})`);
A(r.body.costo.tasa === TASA, 'archiva la tasa que usó');
A(r.body.costo.moneda_origen === 'CUP', 'marca que se pagó en CUP');

r = await entrada({ costo_usd: 2, moneda_origen: 'USD' });
A(r.body.costo.cup === 800, `de 2 USD saca 800 CUP (real ${r.body.costo.cup})`);
A(r.body.costo.moneda_origen === 'USD', 'marca que se pagó en USD');

console.log('\n=== 2. LA TASA REAL DE LA COMPRA MANDA ===');

// Si quien registra escribe los dos importes, es porque esa compra se
// hizo a otro cambio. El sistema no debe "corregirlo" con la tasa del día.
r = await entrada({ costo_cup: 900, costo_usd: 2, moneda_origen: 'USD' });
A(r.body.costo.cup === 900 && r.body.costo.usd === 2,
  'respeta los dos importes escritos a mano');
A(r.body.costo.tasa === 450,
  `guarda la tasa implícita de esa compra, 450, y no la del día (real ${r.body.costo.tasa})`);

console.log('\n=== 3. LO ARCHIVADO NO SE RECALCULA ===');

const idMov = Number(sql('SELECT MAX(id) FROM movimientos'));
const fila = sql(`SELECT costo_unitario_cup||'|'||costo_unitario_usd||'|'||tasa_usada FROM movimientos WHERE id = ${idMov}`);
A(fila === '900|2|450', `la base guarda los tres datos juntos (real ${fila})`);

// Se cambia la tasa del sistema: lo ya archivado NO puede moverse.
await api('PUT', '/api/tasas/manual', tok, { valor: 1000 });
const filaDespues = sql(`SELECT costo_unitario_cup||'|'||costo_unitario_usd||'|'||tasa_usada FROM movimientos WHERE id = ${idMov}`);
A(filaDespues === fila,
  'al cambiar la tasa del dólar, el costo de una entrada vieja sigue igual');
await api('PUT', '/api/tasas/manual', tok, { valor: TASA });

console.log('\n=== 4. COMPATIBILIDAD Y CASOS LÍMITE ===');

r = await entrada({ costo_unitario: 100 });
A(r.body.costo.cup === 100, 'sigue admitiendo el campo antiguo costo_unitario como CUP');

r = await api('POST', '/api/inventario/movimientos', tok, {
  producto_id: productoId, almacen_id: almacenId, tipo: 'salida', cantidad: 1,
});
A(r.body.costo.cup === null && r.body.costo.usd === null,
  'una salida no archiva costo (no compra nada)');

r = await entrada({});
A(r.status === 200 && r.body.costo.cup === null,
  'dar entrada sin declarar costo sigue permitido');

console.log('\n=== 5. LA COMPRA GUARDA SU MONEDA ===');

r = await entrada({ costo_usd: 3, moneda_origen: 'USD', proveedor: 'Proveedor en dólares' });
A(r.status === 200, 'entrada con proveedor pagada en USD');
const compra = sql("SELECT moneda||'|'||tasa_cambio FROM compras ORDER BY id DESC LIMIT 1");
A(compra === `USD|${TASA}`, `la compra deja constancia de la moneda y la tasa (real ${compra})`);

console.log('\n=== 6. VALOR DEL INVENTARIO (Parte 7) ===');

const v = (await api('GET', '/api/inventario/valor', tok)).body;
A(v && v.inventario && v.compras && Array.isArray(v.por_fecha),
  'GET /inventario/valor trae inventario, compras y entradas por fecha');
A(Number(v.inventario.cup) > 0, `valora el inventario en CUP (${v.inventario.cup})`);
A(Number(v.inventario.usd) > 0, `valora el mismo inventario en USD (${v.inventario.usd})`);
A(typeof v.inventario.criterio === 'string' && v.inventario.criterio.length > 20,
  'explica con qué criterio se valoró (se le muestra al usuario)');
A(typeof v.inventario.productos_sin_costo === 'number',
  'dice cuántos productos se valoraron sin compras registradas');

const conCosto = v.por_fecha.find((f) => Number(f.valor_cup) > 0);
A(conCosto && Number(conCosto.valor_usd) > 0,
  'las entradas por fecha traen su valor en las dos monedas');

// Lo comprado pagando en dólares tiene que quedar separado de lo pagado
// en pesos: es justo lo que se pidió para saber en qué moneda se adquirió.
const enUsd = (v.compras.por_moneda || []).find((m) => m.moneda === 'USD');
A(enUsd && Number(enUsd.cup) > 0, 'separa lo comprado pagando en USD');

console.log('\n=== 7. EL ALMACENERO NO VE DINERO (Parte 6, adelanto) ===');

const tokAlm = await login('alm1', 'prueba123');
const rAlm = await api('GET', '/api/inventario/valor', tokAlm);
A(rAlm.status === 403, `el almacenero recibe 403, no los importes (status ${rAlm.status})`);
A(!JSON.stringify(rAlm.body).match(/\d{4,}/),
  'la respuesta al almacenero no contiene ninguna cifra de dinero');

console.log(`\n========== TOTAL FALLAS: ${fallas} ==========`);
process.exit(fallas ? 1 : 0);
