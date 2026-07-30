import { login, api, assert } from './helpers.mjs';
import { execSync } from 'node:child_process';

let fails = 0;
function A(cond, msg) { if (!assert(cond, msg)) fails++; }
function sql(q) {
  const qFlat = q.replace(/\s+/g, ' ').trim();
  return execSync(`docker exec gestion-db-test psql -U gestion -d gestion -t -A -c "${qFlat.replace(/"/g, '\\"')}"`).toString().trim();
}
function sqlNum(q) { const s = sql(q); return s === '' ? 0 : Number(s); }

const tokAdmin = await login('admin', 'admin123');
async function resetYLogin(id, usuario) {
  await api('POST', `/api/usuarios/${id}/reiniciar-clave`, tokAdmin, { clave_temporal: 'prueba123' });
  return login(usuario, 'prueba123');
}
const tokAlm1 = await resetYLogin(2, 'alm1');
const tokVend = await resetYLogin(6, 'vend');

console.log('\n=== EXTRA: el vendedor destinatario CANCELA de punta a punta ===');
{
  const origenAntes = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=2 AND almacen_id=4`);
  const salVendAntes = sqlNum(`SELECT COALESCE(cantidad,0) FROM venta_inventario WHERE usuario_id=6 AND lower(nombre)=lower('Sal')`);

  const r = await api('POST', '/api/inventario/movimientos', tokAlm1, {
    producto_id: 2, almacen_id: 4, tipo: 'salida', cantidad: 2,
    destino_tipo: 'ventas', destino_id: 6, nota: 'test cancelar por vendedor',
  });
  A(r.status === 200, `salida a vendedor ok: ${JSON.stringify(r.body)}`);
  const tId = r.body.transferencia_id;

  const origenTrasSalida = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=2 AND almacen_id=4`);
  A(origenTrasSalida === origenAntes - 2, `origen bajo 2 (${origenAntes} -> ${origenTrasSalida})`);

  // El VENDEDOR (destinatario real) cancela, no acepta.
  const rc = await api('POST', `/api/inventario/transferencias/${tId}/cancelar`, tokVend);
  A(rc.status === 200, `el vendedor destinatario cancela OK (real ${rc.status}): ${JSON.stringify(rc.body)}`);

  const origenTrasCancelar = sqlNum(`SELECT cantidad FROM existencias WHERE producto_id=2 AND almacen_id=4`);
  A(origenTrasCancelar === origenAntes, `mercancia volvio EXACTO al origen (esperado ${origenAntes}, real ${origenTrasCancelar})`);

  const salVendDespues = sqlNum(`SELECT COALESCE(cantidad,0) FROM venta_inventario WHERE usuario_id=6 AND lower(nombre)=lower('Sal')`);
  A(salVendDespues === salVendAntes, `la hoja de venta del vendedor NO se toco (sigue en ${salVendAntes})`);

  const estado = sql(`SELECT estado FROM transferencias WHERE id=${tId}`);
  A(estado === 'cancelada', `estado paso a cancelada (real ${estado})`);
}

console.log(`\n========== TOTAL FALLAS: ${fails} ==========`);
process.exit(fails > 0 ? 1 : 0);
