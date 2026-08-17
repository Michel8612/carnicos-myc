// ============================================================
//  VENTAS MAYORISTAS — vender directo desde el almacén
//
//  Lo que se protege aquí:
//   · que la mercancía salga DE VERDAD del almacén,
//   · que no se pueda vender más de lo que hay,
//   · que si una línea falla NO se descuente ninguna (todo o nada),
//   · que el cobro llegue al dinero disponible y al libro,
//   · que el historial se conserve y solo el dueño pueda limpiarlo,
//   · y que el almacenero no pueda entrar, porque esto lleva precios.
//
//  Corre DESPUÉS de sembrar.
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

const tok = await login('admin', 'admin123');
const almacenes = (await api('GET', '/api/inventario/almacenes', tok)).body;
const almacenId = (almacenes.almacenes || almacenes)[0].id;

console.log('\n=== 1. QUÉ HAY PARA VENDER ===');

let r = await api('GET', `/api/mayoristas/productos?almacen_id=${almacenId}`, tok);
A(r.status === 200 && Array.isArray(r.body), 'lista los productos con existencia');
A(r.body.length > 0, `hay productos que vender (${r.body.length})`);
A(r.body.every((p) => Number(p.existencia) > 0),
  'solo salen los que TIENEN existencia: no se ofrece vender lo que no hay');
A(r.body[0].costo !== undefined && r.body[0].precio_sugerido !== undefined,
  'trae el costo y un precio sugerido para no vender a ciegas');

const uno = r.body[0];
const antes = Number(sql(
  `SELECT cantidad FROM existencias WHERE producto_id = ${uno.id} AND almacen_id = ${almacenId}`,
));

console.log('\n=== 2. NO SE PUEDE VENDER MÁS DE LO QUE HAY ===');

r = await api('POST', '/api/mayoristas', tok, {
  almacen_id: almacenId,
  lineas: [{ producto_id: uno.id, cantidad: antes + 1000, precio_unitario: 100 }],
});
A(r.status === 400, `rechaza vender de más (status ${r.status})`);
A(Array.isArray(r.body.faltantes) && r.body.faltantes.length,
  'dice producto por producto qué falta');
A(/no hay existencia suficiente/i.test(r.body.error || ''),
  'y lo explica en castellano');

const trasFallo = Number(sql(
  `SELECT cantidad FROM existencias WHERE producto_id = ${uno.id} AND almacen_id = ${almacenId}`,
));
A(trasFallo === antes, 'una venta rechazada NO descuenta nada del almacén');

console.log('\n=== 3. TODO O NADA CON VARIAS LÍNEAS ===');

if (r.body && Array.isArray(r.body.faltantes)) {
  const productos = (await api('GET', `/api/mayoristas/productos?almacen_id=${almacenId}`, tok)).body;
  if (productos.length >= 2) {
    // Una línea buena y otra imposible: no debe descontar la buena.
    const [a, b] = productos;
    const antesA = Number(sql(
      `SELECT cantidad FROM existencias WHERE producto_id = ${a.id} AND almacen_id = ${almacenId}`,
    ));
    r = await api('POST', '/api/mayoristas', tok, {
      almacen_id: almacenId,
      lineas: [
        { producto_id: a.id, cantidad: 1, precio_unitario: 500 },
        { producto_id: b.id, cantidad: b.existencia + 9999, precio_unitario: 500 },
      ],
    });
    A(r.status === 400, 'una línea imposible tumba la venta entera');
    const despuesA = Number(sql(
      `SELECT cantidad FROM existencias WHERE producto_id = ${a.id} AND almacen_id = ${almacenId}`,
    ));
    A(despuesA === antesA, 'y la línea que sí se podía TAMPOCO se descontó');
  }
}

console.log('\n=== 4. LA VENTA BUENA ===');

const CANT = 2;
const PRECIO = 1500;
r = await api('POST', '/api/mayoristas', tok, {
  almacen_id: almacenId,
  cliente: 'Distribuidora Prueba',
  forma_pago: 'transferencia',
  moneda: 'CUP',
  lineas: [{ producto_id: uno.id, cantidad: CANT, precio_unitario: PRECIO }],
});
A(r.status === 200 && r.body.ok, 'se registra la venta');
A(Number(r.body.total) === CANT * PRECIO,
  `el total es cantidad x precio: ${CANT} x ${PRECIO} = ${CANT * PRECIO} (real ${r.body.total})`);
A(Number(r.body.ganancia) === Number((CANT * PRECIO - CANT * uno.costo).toFixed(2)),
  `la ganancia descuenta el costo (real ${r.body.ganancia})`);

const ventaId = r.body.id;
const despues = Number(sql(
  `SELECT cantidad FROM existencias WHERE producto_id = ${uno.id} AND almacen_id = ${almacenId}`,
));
A(despues === antes - CANT,
  `la mercancía SALIÓ del almacén: ${antes} - ${CANT} = ${antes - CANT} (real ${despues})`);

const mov = sql(
  `SELECT tipo||'|'||origen_tipo FROM movimientos WHERE origen_id = ${ventaId} AND origen_tipo = 'mayorista' LIMIT 1`,
);
A(mov === 'salida|mayorista', `deja su movimiento en el historial del almacén (${mov})`);

console.log('\n=== 5. EL DINERO Y EL LIBRO ===');

const bal = (await api('GET', '/api/dinero', tok)).body;
const cup = bal.monedas.find((m) => m.moneda === 'CUP');
A(cup && Number(cup.transferencia) >= CANT * PRECIO,
  `el cobro entró a transferencias (${cup && cup.transferencia})`);

const enLibro = sql(
  `SELECT COUNT(*) FROM contabilidad_registros WHERE area = 'mayorista'`,
);
A(Number(enLibro) > 0, `queda anotado en el libro como área "mayorista" (${enLibro} línea/s)`);

console.log('\n=== 6. EL HISTORIAL SE CONSERVA ===');

r = await api('GET', '/api/mayoristas', tok);
A(r.status === 200 && r.body.ventas.length > 0, 'el historial trae la venta');
const v = r.body.ventas.find((x) => x.id === ventaId);
A(v && v.lineas.length === 1, 'con sus líneas');
A(v && v.cliente === 'Distribuidora Prueba', 'y el cliente');
A(v && v.usuario_nombre, 'y quién la hizo');
A(v && v.lineas[0].producto_nombre,
  'el nombre del producto se copia a la línea: el historial sobrevive si el producto se borra');
A(Number(r.body.totales.total) >= CANT * PRECIO, 'y los totales del período');

console.log('\n=== 7. QUIÉN PUEDE ENTRAR Y QUIÉN NO ===');

const tokAlm = await login('alm1', 'prueba123');
r = await api('GET', '/api/mayoristas/productos', tokAlm);
A(r.status === 403, `el almacenero NO entra: esto lleva precios (status ${r.status})`);

r = await api('POST', '/api/mayoristas', tokAlm, {
  almacen_id: almacenId, lineas: [{ producto_id: uno.id, cantidad: 1, precio_unitario: 1 }],
});
A(r.status === 403, 'ni puede vender');

const tokVend = await login('vend', 'prueba123');
r = await api('DELETE', `/api/mayoristas/${ventaId}`, tokVend);
A(r.status === 403, 'un vendedor no puede borrar del historial');

console.log('\n=== 8. SOLO EL DUEÑO LIMPIA EL HISTORIAL ===');

r = await api('DELETE', `/api/mayoristas/${ventaId}`, tok, { motivo: 'prueba' });
A(r.status === 200, 'el dueño sí puede borrar');
A(/NO volvió al almacén/i.test(r.body.aviso || ''),
  'y se le avisa que la mercancía no vuelve ni se deshace el cobro');

const quedan = sql(`SELECT COUNT(*) FROM ventas_mayoristas WHERE id = ${ventaId}`);
A(quedan === '0', 'la venta salió del historial');
const lineasHuerfanas = sql(`SELECT COUNT(*) FROM ventas_mayoristas_lineas WHERE venta_id = ${ventaId}`);
A(lineasHuerfanas === '0', 'sus líneas cayeron con ella, sin dejar huérfanas');

// Lo borrado tiene que quedar reconstruible desde la auditoría.
const enAuditoria = sql(
  // entidad_id es TEXT en auditoria: se compara como texto, sin castear.
  `SELECT COUNT(*) FROM auditoria WHERE entidad = 'ventas_mayoristas' AND entidad_id = '${ventaId}'`,
);
A(Number(enAuditoria) > 0, 'pero queda entera en la auditoría, con sus líneas');

const trasBorrar = Number(sql(
  `SELECT cantidad FROM existencias WHERE producto_id = ${uno.id} AND almacen_id = ${almacenId}`,
));
A(trasBorrar === antes - CANT,
  'borrar del historial NO devuelve la mercancía: es limpieza, no anulación');

console.log(`\n========== TOTAL FALLAS: ${fallas} ==========`);
process.exit(fallas ? 1 : 0);
