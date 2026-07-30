import { login, api, assert } from './helpers.mjs';
import { execSync } from 'node:child_process';

let fails = 0;
function A(cond, msg) { if (!assert(cond, msg)) fails++; }

function sql(q) {
  const out = execSync(`docker exec gestion-db-test psql -U gestion -d gestion -t -A -F"," -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
  return out;
}
function sqlNum(q) {
  const s = sql(q);
  return s === '' ? null : Number(s);
}

const tokAdmin = await login('admin', 'admin123');
async function resetYLogin(id, usuario) {
  const r = await api('POST', `/api/usuarios/${id}/reiniciar-clave`, tokAdmin, { clave_temporal: 'prueba123' });
  if (r.status !== 200) throw new Error(`no se pudo reiniciar clave de ${usuario}: ${JSON.stringify(r.body)}`);
  return login(usuario, 'prueba123');
}
const tokAlm1 = await resetYLogin(2, 'alm1');       // almacen 4
const tokAlm2 = await resetYLogin(3, 'alm2');       // almacen 5
const tokVend = await resetYLogin(6, 'vend');       // vendedor original (id 6)
const tokVendNuevo = await resetYLogin(7, 'vend_nuevo_test'); // vendedor creado en test 1 (id 7)

const PROD_SAL = 2, PROD_CARNE = 1;
const ALM1 = 4, ALM2 = 5;

// ============================================================
// TEST 2: salida almacen->almacen. Debe bajar origen, NO subir destino, y
// dejar una fila 'pendiente' en transferencias.
// ============================================================
console.log('\n=== TEST 2: salida almacen -> almacen (queda pendiente) ===');
let salAntesOrigen, salAntesDestino;
{
  salAntesOrigen = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  salAntesDestino = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM2}`) ?? 0;
  console.log('  Sal en almacen4 antes:', salAntesOrigen, ' en almacen5 antes:', salAntesDestino);

  const r = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'salida', cantidad: 5,
    destino_tipo: 'almacen', destino_id: ALM2, nota: 'test transferencia 1',
  });
  A(r.status === 200 && r.body.ok, 'POST /movimientos salida con destino responde ok: ' + JSON.stringify(r.body));
  globalThis.__transf1 = r.body.transferencia_id;
  A(!!globalThis.__transf1, 'devuelve transferencia_id');

  const origenDespues = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  const destinoDespues = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM2}`) ?? 0;
  A(origenDespues === salAntesOrigen - 5, `origen bajo exactamente 5 (antes ${salAntesOrigen}, ahora ${origenDespues})`);
  A(destinoDespues === salAntesDestino, `destino NO subio (antes ${salAntesDestino}, ahora ${destinoDespues})`);

  const estado = sql(`SELECT estado FROM transferencias WHERE id=${globalThis.__transf1}`);
  A(estado === 'pendiente', `transferencia queda pendiente (estado=${estado})`);
}

// ============================================================
// TEST 3: aceptar -> sube destino, estado 'aceptada', movimiento registrado.
// ============================================================
console.log('\n=== TEST 3: aceptar transferencia ===');
{
  const destinoAntes = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM2}`) ?? 0;
  const movsAntes = sqlNum(`SELECT COUNT(*) FROM movimientos WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM2} AND origen_tipo='traslado'`);

  const r = await api('POST', `/api/inventario/transferencias/${globalThis.__transf1}/aceptar`, tokAlm2);
  A(r.status === 200 && r.body.ok, 'aceptar responde ok: ' + JSON.stringify(r.body));

  const destinoDespues = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM2}`) ?? 0;
  A(destinoDespues === destinoAntes + 5, `destino subio exactamente 5 (antes ${destinoAntes}, ahora ${destinoDespues})`);

  const estado = sql(`SELECT estado FROM transferencias WHERE id=${globalThis.__transf1}`);
  A(estado === 'aceptada', `estado paso a aceptada (${estado})`);

  const movsDespues = sqlNum(`SELECT COUNT(*) FROM movimientos WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM2} AND origen_tipo='traslado'`);
  A(movsDespues === movsAntes + 1, `queda 1 movimiento de traslado nuevo (antes ${movsAntes}, ahora ${movsDespues})`);
}

// ============================================================
// TEST 4: segunda transferencia (alm2 -> alm1), cancelar -> vuelve al origen.
// ============================================================
console.log('\n=== TEST 4: cancelar transferencia (vuelve al origen) ===');
let transf2;
{
  const carneOrigenAntes = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_CARNE} AND almacen_id=${ALM2}`);
  const carneDestinoAntes = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_CARNE} AND almacen_id=${ALM1}`) ?? 0;

  const r = await api('POST', '/api/inventario/movimientos', tokAlm2, {
    producto_id: PROD_CARNE, almacen_id: ALM2, tipo: 'salida', cantidad: 7,
    destino_tipo: 'almacen', destino_id: ALM1, nota: 'test transferencia 2 (a cancelar)',
  });
  A(r.status === 200 && r.body.ok, 'crea segunda transferencia: ' + JSON.stringify(r.body));
  transf2 = r.body.transferencia_id;

  const origenTrasSalida = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_CARNE} AND almacen_id=${ALM2}`);
  A(origenTrasSalida === carneOrigenAntes - 7, `origen (alm2) bajo 7 tras la salida (${carneOrigenAntes} -> ${origenTrasSalida})`);

  // alm1 es el destinatario de esta transferencia: la cancela.
  const rc = await api('POST', `/api/inventario/transferencias/${transf2}/cancelar`, tokAlm1);
  A(rc.status === 200 && rc.body.ok, 'cancelar responde ok: ' + JSON.stringify(rc.body));

  const origenTrasCancelar = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_CARNE} AND almacen_id=${ALM2}`);
  const destinoTrasCancelar = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_CARNE} AND almacen_id=${ALM1}`) ?? 0;
  A(origenTrasCancelar === carneOrigenAntes, `mercancia volvio EXACTO al origen (esperado ${carneOrigenAntes}, real ${origenTrasCancelar})`);
  A(destinoTrasCancelar === carneDestinoAntes, `destino (alm1) no cambio (${carneDestinoAntes} -> ${destinoTrasCancelar})`);

  const estado = sql(`SELECT estado FROM transferencias WHERE id=${transf2}`);
  A(estado === 'cancelada', `estado paso a cancelada (${estado})`);
}

// ============================================================
// TEST 5: aceptar/cancelar dos veces -> la segunda falla limpio, sin duplicar.
// ============================================================
console.log('\n=== TEST 5: doble resolucion falla limpio ===');
{
  const destinoAntes = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM2}`);
  const r = await api('POST', `/api/inventario/transferencias/${globalThis.__transf1}/aceptar`, tokAlm2);
  A(r.status === 400, `aceptar ya-aceptada devuelve 400 (real ${r.status}): ${JSON.stringify(r.body)}`);
  const destinoDespues = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM2}`);
  A(destinoDespues === destinoAntes, `NO duplico mercancia al re-aceptar (${destinoAntes} -> ${destinoDespues})`);

  const rc = await api('POST', `/api/inventario/transferencias/${globalThis.__transf1}/cancelar`, tokAlm2);
  A(rc.status === 400, `cancelar ya-aceptada devuelve 400 (real ${rc.status}): ${JSON.stringify(rc.body)}`);

  // También sobre la ya cancelada (transf2).
  const rc2 = await api('POST', `/api/inventario/transferencias/${transf2}/cancelar`, tokAlm1);
  A(rc2.status === 400, `cancelar ya-cancelada devuelve 400 (real ${rc2.status})`);
  const ra2 = await api('POST', `/api/inventario/transferencias/${transf2}/aceptar`, tokAlm1);
  A(ra2.status === 400, `aceptar ya-cancelada devuelve 400 (real ${ra2.status})`);
}

// ============================================================
// TEST 6: salida almacen -> vendedor. Verificar venta_inventario: crea y
// luego SUMA (no duplica fila) en un segundo envio.
// ============================================================
console.log('\n=== TEST 6: salida almacen -> vendedor (venta_inventario) ===');
{
  const filasAntes = sqlNum(`SELECT COUNT(*) FROM venta_inventario WHERE usuario_id=6 AND lower(nombre)=lower('Sal')`);

  const r1 = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'salida', cantidad: 3,
    destino_tipo: 'ventas', destino_id: 6, nota: 'test a vendedor 1',
  });
  A(r1.status === 200, 'salida a vendedor ok: ' + JSON.stringify(r1.body));
  const a1 = await api('POST', `/api/inventario/transferencias/${r1.body.transferencia_id}/aceptar`, tokVend);
  A(a1.status === 200, 'vendedor acepta ok: ' + JSON.stringify(a1.body));

  const filaTrasN1 = sql(`SELECT cantidad FROM venta_inventario WHERE usuario_id=6 AND lower(nombre)=lower('Sal')`);
  A(Number(filaTrasN1) === 3, `venta_inventario tiene cantidad 3 tras primer envio (real ${filaTrasN1})`);
  const filasTrasN1 = sqlNum(`SELECT COUNT(*) FROM venta_inventario WHERE usuario_id=6 AND lower(nombre)=lower('Sal')`);
  A(filasTrasN1 === 1, `sigue habiendo 1 sola fila (${filasTrasN1})`);

  // Segundo envio del mismo producto al mismo vendedor: debe SUMAR.
  const r2 = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'salida', cantidad: 2,
    destino_tipo: 'ventas', destino_id: 6, nota: 'test a vendedor 2',
  });
  A(r2.status === 200, 'segunda salida a vendedor ok');
  const a2 = await api('POST', `/api/inventario/transferencias/${r2.body.transferencia_id}/aceptar`, tokVend);
  A(a2.status === 200, 'vendedor acepta segunda ok: ' + JSON.stringify(a2.body));

  const filaTrasN2 = sql(`SELECT cantidad FROM venta_inventario WHERE usuario_id=6 AND lower(nombre)=lower('Sal')`);
  A(Number(filaTrasN2) === 5, `venta_inventario SUMO a 5 (3+2), no duplico (real ${filaTrasN2})`);
  const filasTrasN2 = sqlNum(`SELECT COUNT(*) FROM venta_inventario WHERE usuario_id=6 AND lower(nombre)=lower('Sal')`);
  A(filasTrasN2 === 1, `sigue habiendo 1 sola fila, no se duplico (${filasTrasN2})`);
}

// ============================================================
// TEST 7: permisos. Destinatario real acepta OK; alguien mas -> 403; dueño puede todo.
// ============================================================
console.log('\n=== TEST 7: permisos aceptar/cancelar ===');
{
  // alm1 envia a vend_nuevo_test (id 7)
  const r = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'salida', cantidad: 1,
    destino_tipo: 'ventas', destino_id: 7, nota: 'test permisos',
  });
  A(r.status === 200, 'crea transferencia para permisos: ' + JSON.stringify(r.body));
  const tId = r.body.transferencia_id;

  // El vendedor ORIGINAL (id 6) no es el destinatario -> 403
  const noDestinatario = await api('POST', `/api/inventario/transferencias/${tId}/aceptar`, tokVend);
  A(noDestinatario.status === 403, `usuario que NO es destinatario recibe 403 (real ${noDestinatario.status}): ${JSON.stringify(noDestinatario.body)}`);

  // alm1 (el que la envio, ni destinatario ni almacenero-central/dueno) tampoco puede
  const remitente = await api('POST', `/api/inventario/transferencias/${tId}/aceptar`, tokAlm1);
  A(remitente.status === 403, `el remitente (alm1) tampoco puede resolverla (real ${remitente.status})`);

  // El destinatario real (vend_nuevo_test) SI puede aceptar
  const siDestinatario = await api('POST', `/api/inventario/transferencias/${tId}/aceptar`, tokVendNuevo);
  A(siDestinatario.status === 200, `el destinatario real acepta OK (real ${siDestinatario.status}): ${JSON.stringify(siDestinatario.body)}`);

  // El dueño puede todo: probamos con OTRA transferencia nueva, canjeada por el dueño.
  const r2 = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'salida', cantidad: 1,
    destino_tipo: 'ventas', destino_id: 7, nota: 'test permisos dueno',
  });
  const tId2 = r2.body.transferencia_id;
  const duenoAcepta = await api('POST', `/api/inventario/transferencias/${tId2}/aceptar`, tokAdmin);
  A(duenoAcepta.status === 200, `el dueño puede aceptar cualquier transferencia (real ${duenoAcepta.status}): ${JSON.stringify(duenoAcepta.body)}`);
}

// ============================================================
// TEST 8: compatibilidad con destino_almacen_id (viejo) y destino_texto solo.
// ============================================================
console.log('\n=== TEST 8: compatibilidad destino_almacen_id / destino_texto ===');
{
  const origenAntes = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  const r = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'salida', cantidad: 2,
    destino_almacen_id: ALM2, nota: 'compat destino_almacen_id viejo',
  });
  A(r.status === 200 && r.body.transferencia_id, `destino_almacen_id (campo viejo) crea transferencia igual: ${JSON.stringify(r.body)}`);
  const origenDespues = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  A(origenDespues === origenAntes - 2, 'origen bajo 2 con el campo viejo destino_almacen_id');
  const estado = sql(`SELECT estado, destino_tipo, destino_almacen_id FROM transferencias WHERE id=${r.body.transferencia_id}`);
  A(estado === `pendiente,almacen,${ALM2}`, `se traduce a destino_tipo=almacen/destino_id=${ALM2} (real: ${estado})`);

  // destino_texto SOLO (nota libre): NO debe crear transferencia, es salida simple.
  const origenAntesTexto = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  const transfsAntes = sqlNum('SELECT COUNT(*) FROM transferencias');
  const r2 = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'salida', cantidad: 1,
    destino_texto: 'Punto de venta del centro',
  });
  A(r2.status === 200, 'salida con destino_texto responde ok: ' + JSON.stringify(r2.body));
  A(!r2.body.transferencia_id, 'destino_texto solo NO genera transferencia_id');
  const transfsDespues = sqlNum('SELECT COUNT(*) FROM transferencias');
  A(transfsDespues === transfsAntes, 'no se creo ninguna fila en transferencias');
  const origenDespuesTexto = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  A(origenDespuesTexto === origenAntesTexto - 1, 'la salida con destino_texto SI descuenta existencia (comportamiento normal)');
}

// ============================================================
// TEST 19/20: regresion basica - entrada y salida SIN destino.
// ============================================================
console.log('\n=== TEST 19/20: regresion entrada/salida normales ===');
{
  const antes = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  const rEnt = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'entrada', cantidad: 10, nota: 'entrada normal',
  });
  A(rEnt.status === 200, 'entrada normal responde ok: ' + JSON.stringify(rEnt.body));
  const trasEntrada = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  A(trasEntrada === antes + 10, `entrada sumo 10 (${antes} -> ${trasEntrada})`);

  const rSal = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: PROD_SAL, almacen_id: ALM1, tipo: 'salida', cantidad: 4, nota: 'salida normal',
  });
  A(rSal.status === 200, 'salida normal responde ok: ' + JSON.stringify(rSal.body));
  const trasSalida = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=${PROD_SAL} AND almacen_id=${ALM1}`);
  A(trasSalida === trasEntrada - 4, `salida resto 4 (${trasEntrada} -> ${trasSalida})`);
  A(!rSal.body.transferencia_id, 'salida normal no genera transferencia_id');
}

console.log(`\n========== TOTAL FALLAS: ${fails} ==========`);
process.exit(fails > 0 ? 1 : 0);
