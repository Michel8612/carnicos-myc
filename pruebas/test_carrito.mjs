import { login, api, assert } from './helpers.mjs';
import { execSync } from 'node:child_process';

let fails = 0;
function A(cond, msg) { if (!assert(cond, msg)) fails++; }
function sql(q) {
  return execSync(`docker exec gestion-db-test psql -U gestion -d gestion -t -A -F"," -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
}

const tokAdmin = await login('admin', 'admin123');
async function resetYLogin(id, usuario) {
  await api('POST', `/api/usuarios/${id}/reiniciar-clave`, tokAdmin, { clave_temporal: 'prueba123' });
  return login(usuario, 'prueba123');
}
const tokVend = await resetYLogin(6, 'vend');

console.log('\n=== TEST 22: flujo de venta con carrito sigue funcionando ===');
{
  // El vendedor 'vend' ya tiene "Sal" en su hoja (cantidad 5, de la prueba anterior).
  const hoja = await api('GET', '/api/ventas/hoja', tokVend);
  const item = hoja.body.productos.find(i => i.nombre === 'Sal');
  A(!!item, 'la hoja del vendedor tiene el producto Sal (sembrado por transferencias)');
  if (!item) { console.log('No se puede continuar test carrito sin item'); process.exit(1); }

  // Ponerle un precio de venta (0 por defecto) para poder facturar algo > 0.
  await api('PUT', `/api/ventas/producto/${item.id}`, tokVend, {
    nombre: item.nombre, unidad: item.unidad, cantidad: item.cantidad,
    costo_unitario: item.costo_unitario, precio_venta: 20,
  });

  const cantidadAntes = Number((await api('GET', '/api/ventas/hoja', tokVend)).body.productos.find(i => i.id === item.id).cantidad);
  const ventasAntes = Number(sql('SELECT COUNT(*) FROM ventas'));

  const r = await api('POST', '/api/ventas/carrito', tokVend, {
    items: [{ producto_id: item.id, cantidad: 2 }],
    cliente: 'Cliente prueba', metodo_pago: 'efectivo',
  });
  A(r.status === 200 && r.body.ok, 'POST /ventas/carrito responde ok: ' + JSON.stringify(r.body));
  A(r.body.total === 40, `total correcto 2*20=40 (real ${r.body.total})`);

  const cantidadDespues = Number((await api('GET', '/api/ventas/hoja', tokVend)).body.productos.find(i => i.id === item.id).cantidad);
  A(cantidadDespues === cantidadAntes - 2, `existencia de la hoja descontada en 2 (${cantidadAntes} -> ${cantidadDespues})`);

  const ventasDespues = Number(sql('SELECT COUNT(*) FROM ventas'));
  A(ventasDespues === ventasAntes + 1, 'se registro una venta nueva');
}

console.log(`\n========== TOTAL FALLAS: ${fails} ==========`);
process.exit(fails > 0 ? 1 : 0);
