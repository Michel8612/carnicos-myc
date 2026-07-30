import { login, api, assert } from './helpers.mjs';

let fails = 0;
function A(cond, msg) { if (!assert(cond, msg)) fails++; }

const tokAdmin = await login('admin', 'admin123');
async function resetYLogin(id, usuario) {
  const r = await api('POST', `/api/usuarios/${id}/reiniciar-clave`, tokAdmin, { clave_temporal: 'prueba123' });
  if (r.status !== 200) throw new Error(`no se pudo reiniciar clave de ${usuario}: ${JSON.stringify(r.body)}`);
  return login(usuario, 'prueba123');
}
const tokAlm3 = await resetYLogin(8, 'alm3_test'); // almacen propio id 6

// TEST 24: almacenero limitado ve SOLO su almacen.
console.log('\n=== TEST 24: almacenero limitado ve solo su almacen ===');
{
  const r = await api('GET', '/api/inventario/almacenes', tokAlm3);
  A(r.status === 200, 'GET /almacenes responde 200');
  A(Array.isArray(r.body) && r.body.length === 1, `devuelve exactamente 1 almacen (real ${r.body.length})`);
  A(r.body[0]?.nombre === 'Almacén de Almacenero Test3', `es su propio almacen (real: ${r.body[0]?.nombre})`);

  const rExist = await api('GET', '/api/inventario/existencias', tokAlm3);
  A(rExist.status === 200, 'GET /existencias responde 200 para almacenero limitado');
}

// TEST 21, 22, 23: regresion de otras rutas.
console.log('\n=== TEST 21/22/23: regresion contabilidad/ventas/almacen ===');
{
  const rResumen = await api('GET', '/api/contabilidad/resumen', tokAdmin);
  A(rResumen.status === 200, `GET /contabilidad/resumen responde 200 (real ${rResumen.status})`);

  const rLibro = await api('GET', '/api/contabilidad/libro', tokAdmin);
  A(rLibro.status === 200, `GET /contabilidad/libro responde 200 (real ${rLibro.status})`);

  const rExistencias = await api('GET', '/api/inventario/existencias', tokAdmin);
  A(rExistencias.status === 200, `GET /inventario/existencias responde 200 (real ${rExistencias.status})`);

  const rAlmacenes = await api('GET', '/api/inventario/almacenes', tokAdmin);
  A(rAlmacenes.status === 200, `GET /inventario/almacenes responde 200 (real ${rAlmacenes.status})`);

  const rRecetas = await api('GET', '/api/recetas', tokAdmin);
  A(rRecetas.status === 200, `GET /recetas responde 200 (real ${rRecetas.status})`);

  const rHoja = await api('GET', '/api/ventas/hoja', tokAdmin);
  A(rHoja.status === 200, `GET /ventas/hoja responde 200 (real ${rHoja.status})`);
}

console.log(`\n========== TOTAL FALLAS: ${fails} ==========`);
process.exit(fails > 0 ? 1 : 0);
