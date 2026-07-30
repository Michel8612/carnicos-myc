// Siembra el escenario que dan por supuesto las baterías de prueba.
// Se ejecuta sobre una BASE LIMPIA, justo después de arrancar el servidor
// (que crea solo el usuario admin). El orden importa: las baterías se
// refieren a los usuarios por id (2=alm1, 3=alm2, 4=central, 6=vend).
const BASE = 'http://localhost:3012';

const login = async (usuario, clave) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, clave }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`login ${usuario}: ${JSON.stringify(j)}`);
  return j.token;
};

const api = async (metodo, ruta, token, cuerpo) => {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};

const tok = await login('admin', 'admin123');

// Usuarios, EN ESTE ORDEN (los ids salen correlativos desde el 2).
const usuarios = [
  { nombre: 'Almacenero Uno', usuario: 'alm1', rol: 'almacen' },
  { nombre: 'Almacenero Dos', usuario: 'alm2', rol: 'almacen' },
  { nombre: 'Central', usuario: 'central', rol: 'almacen_central' },
  { nombre: 'Cocinero', usuario: 'coci', rol: 'cocinero' },
  { nombre: 'Vendedor', usuario: 'vend', rol: 'ventas' },
];
for (const u of usuarios) {
  const r = await api('POST', '/api/usuarios', tok, { ...u, clave_temporal: 'prueba123' });
  console.log(`usuario ${u.usuario} -> ${r.status}`, r.body.id ? `id ${r.body.id}` : JSON.stringify(r.body));
}

// Productos con los que trabajar.
const productos = [
  { nombre: 'Carne', tipo: 'materia_prima', unidad_id: 2, precio_costo: 100, precio_venta: 0 },
  { nombre: 'Sal', tipo: 'materia_prima', unidad_id: 2, precio_costo: 5, precio_venta: 0 },
  { nombre: 'Jamon', tipo: 'terminado', unidad_id: 2, precio_costo: 120, precio_venta: 200 },
];
for (const p of productos) {
  const r = await api('POST', '/api/inventario/productos', tok, p);
  console.log(`producto ${p.nombre} -> ${r.status}`, r.body.id ? `id ${r.body.id}` : JSON.stringify(r.body));
}

// Existencia inicial en todos los almacenes, para que haya de dónde sacar.
const alm = await api('GET', '/api/inventario/almacenes?todos=1', tok);
const lista = alm.body.almacenes || alm.body;
console.log('almacenes:', lista.map((a) => `${a.id}:${a.nombre}`).join(' | '));
for (const a of lista) {
  for (const pid of [1, 2, 3]) {
    await api('POST', '/api/inventario/movimientos', tok, {
      producto_id: pid, almacen_id: a.id, tipo: 'entrada', cantidad: 100,
      nota: 'siembra de prueba',
    });
  }
}
console.log('Siembra lista.');
