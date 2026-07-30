import { login, api, assert } from './helpers.mjs';

let fails = 0;
function A(cond, msg) { if (!assert(cond, msg)) fails++; }

const tokAdmin = await login('admin', 'admin123');

// Reiniciamos la clave de los usuarios de prueba ya sembrados (no sabemos
// su clave original) para poder loguearnos como ellos.
async function resetYLogin(id, usuario) {
  const r = await api('POST', `/api/usuarios/${id}/reiniciar-clave`, tokAdmin, { clave_temporal: 'prueba123' });
  if (r.status !== 200) throw new Error(`no se pudo reiniciar clave de ${usuario}: ${JSON.stringify(r.body)}`);
  return login(usuario, 'prueba123');
}

const tokAlm1 = await resetYLogin(2, 'alm1');   // almacen_id 4
const tokAlm2 = await resetYLogin(3, 'alm2');   // almacen_id 5
const tokCentral = await resetYLogin(4, 'central');
const tokVend = await resetYLogin(6, 'vend');

console.log('Logins OK:', { tokAlm1: !!tokAlm1, tokAlm2: !!tokAlm2, tokCentral: !!tokCentral, tokVend: !!tokVend });

// ============================================================
// TEST 1: /destinos + crear vendedor y almacen nuevos, deben aparecer solos
// ============================================================
console.log('\n=== TEST 1: destinos ===');
{
  const antes = await api('GET', '/api/inventario/destinos', tokAlm1);
  const nombresAntes = antes.body.destinos.map(d => d.nombre);
  A(antes.status === 200, 'GET /destinos responde 200');
  A(antes.body.destinos.some(d => d.tipo === 'almacen'), 'incluye almacenes');
  A(antes.body.destinos.some(d => d.tipo === 'ventas'), 'incluye vendedores');
  A(!antes.body.destinos.some(d => d.tipo === 'almacen' && d.nombre.includes('Almacen Uno')), 'alm1 no se ofrece a si mismo como destino');

  // Crear un vendedor nuevo y un almacenero nuevo (con almacen propio auto-creado)
  const nuevoVend = await api('POST', '/api/usuarios', tokAdmin, {
    nombre: 'Vendedor Nuevo Test', usuario: 'vend_nuevo_test', rol: 'ventas', clave_temporal: 'prueba123',
  });
  A(nuevoVend.status === 200, 'crear vendedor nuevo ok: ' + JSON.stringify(nuevoVend.body));

  const nuevoAlm = await api('POST', '/api/usuarios', tokAdmin, {
    nombre: 'Almacenero Test3', usuario: 'alm3_test', rol: 'almacen', clave_temporal: 'prueba123',
  });
  A(nuevoAlm.status === 200, 'crear almacenero nuevo (con almacen propio) ok: ' + JSON.stringify(nuevoAlm.body));

  const despues = await api('GET', '/api/inventario/destinos', tokAlm1);
  const nombresDespues = despues.body.destinos.map(d => d.nombre);
  A(nombresDespues.some(n => n.includes('Vendedor Nuevo Test')), 'el vendedor nuevo aparece SIN reiniciar nada');
  A(nombresDespues.some(n => n.includes('Almacenero Test3')), 'el almacen nuevo aparece SIN reiniciar nada');
  A(nombresDespues.length === nombresAntes.length + 2, `aumentaron exactamente 2 destinos (antes ${nombresAntes.length}, despues ${nombresDespues.length})`);

  globalThis.__vendNuevoUsuario = nuevoVend.body.id;
  globalThis.__almNuevoId = nuevoAlm.body.id;
}

console.log(`\nFALLAS hasta ahora: ${fails}`);
process.exit(fails > 0 ? 1 : 0);
