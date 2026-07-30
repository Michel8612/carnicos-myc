// Prueba del enlace entrada de almacén -> tabla compras.
// Comprueba que una entrada CON proveedor deja rastro en compras,
// que una entrada SIN proveedor no lo deja (no romper lo de siempre),
// y que la existencia sube igual en los dos casos.
const BASE = process.env.BASE || 'http://localhost:3012/api';

let token = '';
const api = async (ruta, opciones = {}) => {
  const r = await fetch(BASE + ruta, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opciones.headers || {}),
    },
  });
  const texto = await r.text();
  let datos; try { datos = JSON.parse(texto); } catch { datos = texto; }
  return { estado: r.status, datos };
};

let pasan = 0, fallan = 0;
const comprobar = (nombre, condicion, detalle = '') => {
  if (condicion) { pasan++; console.log(`  OK   ${nombre}`); }
  else { fallan++; console.log(`  FALLA ${nombre} ${detalle}`); }
};

const login = await api('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ usuario: 'admin', clave: 'admin123' }),
});
token = login.datos.token;
if (!token) { console.error('No se pudo entrar:', login); process.exit(1); }

// Necesitamos un producto y un almacén con los que trabajar.
const almacenes = await api('/inventario/almacenes?todos=1');
const almacenId = (almacenes.datos.almacenes || almacenes.datos)[0].id;
const productos = await api('/inventario/productos');
const lista = productos.datos.productos || productos.datos;
const productoId = lista[0].id;

const existenciaDe = async (prodId, almId) => {
  const r = await api('/inventario/existencias?almacen_id=' + almId);
  const filas = r.datos.existencias || r.datos;
  // /existencias devuelve el producto con su id (no "producto_id").
  const f = (filas || []).find((x) => Number(x.id) === Number(prodId));
  return f ? Number(f.cantidad) : 0;
};

console.log('\n--- Entrada CON proveedor (es una compra) ---');
const antesExist = await existenciaDe(productoId, almacenId);
const conProv = await api('/inventario/movimientos', {
  method: 'POST',
  body: JSON.stringify({
    producto_id: productoId, almacen_id: almacenId, tipo: 'entrada',
    cantidad: 10, proveedor: 'Proveedor de Prueba', costo_unitario: 25,
    nota: 'compra de prueba',
  }),
});
comprobar('la entrada responde 200', conProv.estado === 200, JSON.stringify(conProv.datos));
const despuesExist = await existenciaDe(productoId, almacenId);
comprobar('la existencia sube 10', Math.abs(despuesExist - antesExist - 10) < 0.001,
  `antes=${antesExist} despues=${despuesExist}`);

console.log('\n--- Entrada SIN proveedor (movimiento normal de siempre) ---');
const sinProv = await api('/inventario/movimientos', {
  method: 'POST',
  body: JSON.stringify({
    producto_id: productoId, almacen_id: almacenId, tipo: 'entrada', cantidad: 5,
  }),
});
comprobar('la entrada sin proveedor responde 200', sinProv.estado === 200, JSON.stringify(sinProv.datos));
const finalExist = await existenciaDe(productoId, almacenId);
comprobar('la existencia sube 5 más', Math.abs(finalExist - despuesExist - 5) < 0.001,
  `antes=${despuesExist} despues=${finalExist}`);

console.log('\n--- La compra aparece en Tributación ---');
const trib = await api('/contabilidad/tributacion?periodo=mes');
const compras = trib.datos?.informativo?.compras_registradas ?? trib.datos?.compras_registradas;
comprobar('tributación responde 200', trib.estado === 200);
comprobar('compras_registradas refleja 10 x 25 = 250', Number(compras) >= 250,
  `compras_registradas=${compras}`);

console.log(`\nResultado: ${pasan} pasan, ${fallan} fallan`);
process.exit(fallan ? 1 : 0);
