// Batería de humo de la Fase 1 del ERP: comprueba que TODO el contrato
// de API nuevo responde y se comporta. No sustituye a las pruebas de
// cada agente; sirve para detectar que una pieza se quedó sin conectar.
//
// Uso:  node test-fase1.mjs            (por defecto contra localhost:3012)
//       BASE=https://.../api node test-fase1.mjs
const BASE = process.env.BASE || 'http://localhost:3012/api';

let token = '';
let pasan = 0, fallan = 0;
const fallos = [];

const api = async (metodo, ruta, cuerpo, tok) => {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...((tok ?? token) ? { Authorization: `Bearer ${tok ?? token}` } : {}),
    },
    ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { estado: r.status, datos: b };
};

const ok = (nombre, condicion, detalle = '') => {
  if (condicion) { pasan++; console.log(`  OK    ${nombre}`); }
  else { fallan++; fallos.push(nombre); console.log(`  FALLO ${nombre} ${String(detalle).slice(0, 160)}`); }
};

const seccion = (t) => console.log(`\n=== ${t} ===`);

// ------------------------------------------------------------
const login = await api('POST', '/auth/login', { usuario: 'admin', clave: 'admin123' });
token = login.datos?.token;
if (!token) { console.error('No se pudo entrar:', login); process.exit(1); }
console.log('Sesión de admin iniciada.');

seccion('§9 Auditoría');
{
  const r = await api('GET', '/auditoria?limite=5');
  ok('GET /auditoria responde 200', r.estado === 200, JSON.stringify(r.datos));
  const f = await api('GET', '/auditoria/filtros');
  ok('GET /auditoria/filtros responde 200', f.estado === 200, JSON.stringify(f.datos));
  // El login que acabamos de hacer debería haber dejado rastro.
  const filas = r.datos?.filas || r.datos || [];
  ok('la auditoría tiene registros', Array.isArray(filas) && filas.length > 0,
    `filas=${Array.isArray(filas) ? filas.length : 'no es array'}`);
  // Regla dura: no puede existir forma de borrar auditoría.
  const del = await api('DELETE', '/auditoria/1');
  ok('NO se puede borrar auditoría (404/405/403)', [403, 404, 405].includes(del.estado), `estado=${del.estado}`);
}

seccion('§7 Reautenticación y sesiones');
{
  const bien = await api('POST', '/auth/reautenticar', { usuario: 'admin', clave: 'admin123' });
  ok('reautenticar con admin correcto', bien.estado === 200, JSON.stringify(bien.datos));
  const mal = await api('POST', '/auth/reautenticar', { usuario: 'admin', clave: 'noesesta' });
  ok('reautenticar con clave mala se rechaza', mal.estado >= 400, `estado=${mal.estado}`);
  ok('la respuesta NO devuelve la contraseña',
    !JSON.stringify(bien.datos).toLowerCase().includes('admin123'), JSON.stringify(bien.datos));
  const ses = await api('GET', '/auth/sesiones');
  ok('GET /auth/sesiones responde 200', ses.estado === 200, JSON.stringify(ses.datos));
}

seccion('§1 Tributación: régimen "Otro" y correcciones');
{
  const reg = await api('GET', '/contabilidad/tributacion/regimenes');
  ok('GET regimenes responde 200', reg.estado === 200);
  const per = await api('GET', '/contabilidad/tributacion/personalizado');
  ok('GET tributacion/personalizado responde 200', per.estado === 200, JSON.stringify(per.datos));
  const guardar = await api('PUT', '/contabilidad/tributacion/personalizado', {
    tributos: [
      { clave: 'utilidades', nombre: 'Impuesto sobre Utilidades', base: 'utilidad_neta', porcentaje: 20 },
      { clave: 'ventas', nombre: 'Impuesto sobre Ventas', base: 'ventas_brutas', porcentaje: 5 },
    ],
  });
  ok('PUT tributacion/personalizado guarda', guardar.estado === 200, JSON.stringify(guardar.datos));
  const calc = await api('GET', '/contabilidad/tributacion?periodo=mes&tipo_empresa=otro');
  ok('el cálculo con tipo_empresa=otro responde 200', calc.estado === 200, JSON.stringify(calc.datos).slice(0, 200));

  const corr = await api('POST', '/contabilidad/tributacion/correcciones', {
    clave: 'ventas_brutas', valor_nuevo: 12345, motivo: 'Prueba automática de corrección',
    periodo_desde: '2026-07-01', periodo_hasta: '2026-07-31',
  });
  ok('POST corrección con motivo se acepta', corr.estado === 200, JSON.stringify(corr.datos));
  const sinMotivo = await api('POST', '/contabilidad/tributacion/correcciones', {
    clave: 'ventas_brutas', valor_nuevo: 999,
  });
  ok('corrección SIN motivo se rechaza', sinMotivo.estado >= 400, `estado=${sinMotivo.estado}`);
  const lista = await api('GET', '/contabilidad/tributacion/correcciones');
  ok('GET correcciones responde 200', lista.estado === 200);
}

seccion('§1 Gastos: borrado y categorías');
{
  const cats = await api('GET', '/costos/categorias');
  ok('GET /costos/categorias responde 200', cats.estado === 200);
  const arr = cats.datos?.categorias || cats.datos || [];
  ok('hay categorías', Array.isArray(arr) && arr.length >= 10, `n=${Array.isArray(arr) ? arr.length : '?'}`);

  // Contra una base limpia esto crea la categoría (200). Contra producción,
  // donde una tanda anterior ya la creó, la API responde 400 "ya existe":
  // también es una respuesta correcta, así que la prueba la acepta en vez
  // de exigir una base virgen que en producción no va a existir nunca.
  const nueva = await api('POST', '/costos/categorias', { clave: 'agua', etiqueta: 'Agua', deducible: 1 });
  const yaExistia = nueva.estado === 400 && /ya existe/i.test(nueva.datos?.error || '');
  ok('crear categoría nueva', [200, 409].includes(nueva.estado) || yaExistia, JSON.stringify(nueva.datos));

  const noBorrable = await api('DELETE', '/costos/categorias/nomina');
  ok('la categoría "nomina" NO se puede borrar', noBorrable.estado >= 400, `estado=${noBorrable.estado}`);

  const gasto = await api('POST', '/costos/gastos', {
    categoria: 'electricidad', concepto: 'Prueba de luz', monto: 500, moneda: 'CUP',
  });
  ok('registrar un gasto sigue funcionando', gasto.estado === 200, JSON.stringify(gasto.datos));
  const idGasto = gasto.datos?.id;
  if (idGasto) {
    const sinMotivo = await api('DELETE', `/costos/gastos/${idGasto}`, {});
    ok('borrar gasto SIN motivo se rechaza', sinMotivo.estado >= 400, `estado=${sinMotivo.estado}`);
    const conMotivo = await api('DELETE', `/costos/gastos/${idGasto}`, { motivo: 'Prueba automática' });
    ok('borrar gasto CON motivo funciona', conMotivo.estado === 200, JSON.stringify(conMotivo.datos));
  }
}

seccion('§4 Configuración fiscal');
{
  const g = await api('PUT', '/empresa', {
    nombre_fiscal: 'Cárnicos M&C', razon_social: 'Cárnicos M&C S.R.L.', nit: 'TEST123',
    provincia: 'Cienfuegos', municipio: 'Cienfuegos', moneda_principal: 'CUP',
    monedas_secundarias: ['USD', 'MLC'],
  });
  ok('PUT /empresa guarda', g.estado === 200, JSON.stringify(g.datos));
  const l = await api('GET', '/empresa');
  ok('GET /empresa devuelve lo guardado', l.estado === 200 && String(JSON.stringify(l.datos)).includes('TEST123'),
    JSON.stringify(l.datos).slice(0, 200));
}

seccion('§5 Bancos y conciliación');
{
  const c = await api('POST', '/bancos/cuentas', {
    banco: 'BANDEC', numero: '9227060000000000', alias: 'Cuenta principal',
    moneda: 'CUP', usar_en: ['ventas', 'cobros'],
  });
  ok('crear cuenta bancaria', c.estado === 200, JSON.stringify(c.datos));
  const idCuenta = c.datos?.id;
  const lc = await api('GET', '/bancos/cuentas');
  ok('listar cuentas', lc.estado === 200);

  if (idCuenta) {
    const m = await api('POST', '/bancos/movimientos', {
      cuenta_id: idCuenta, tipo: 'ingreso', monto: 2500, concepto: 'Cobro de prueba',
    });
    ok('registrar movimiento bancario a mano', m.estado === 200, JSON.stringify(m.datos));
    const idMov = m.datos?.id;
    if (idMov) {
      const con = await api('POST', `/bancos/movimientos/${idMov}/conciliar`, {
        conciliado_tipo: 'venta', conciliado_id: 1,
      });
      ok('conciliar movimiento', con.estado === 200, JSON.stringify(con.datos));
    }
    const borrar = await api('DELETE', `/bancos/cuentas/${idCuenta}`);
    ok('borrar cuenta con movimientos la desactiva (no la borra)',
      borrar.estado === 200 || borrar.estado === 409, JSON.stringify(borrar.datos));
  }

  const p = await api('GET', '/bancos/pasarelas');
  ok('GET /bancos/pasarelas responde sin credenciales', p.estado === 200, JSON.stringify(p.datos).slice(0, 200));
}

seccion('§8 Documentos legales');
{
  const d = await api('GET', '/legal/documentos');
  ok('GET /legal/documentos responde 200', d.estado === 200);
  const arr = d.datos?.documentos || d.datos || [];
  ok('los 3 documentos están sembrados', Array.isArray(arr) && arr.length >= 3,
    `n=${Array.isArray(arr) ? arr.length : '?'}`);
  const e = await api('GET', '/legal/estado');
  ok('GET /legal/estado responde 200', e.estado === 200, JSON.stringify(e.datos).slice(0, 160));
}

seccion('Regresión: lo que ya funcionaba');
{
  for (const [nombre, ruta] of [
    ['resumen contable', '/contabilidad/resumen'],
    ['libro contable', '/contabilidad/libro'],
    ['tributación (régimen de siempre)', '/contabilidad/tributacion?periodo=mes'],
    ['existencias', '/inventario/existencias'],
    ['almacenes', '/inventario/almacenes'],
    ['destinos de transferencia', '/inventario/destinos'],
    ['transferencias pendientes', '/inventario/transferencias/pendientes'],
    ['hoja de ventas', '/ventas/hoja'],
    ['tasa del dólar', '/tasas/actual'],
    ['categorías de gasto', '/costos/categorias'],
    ['nómina', '/costos/nomina'],
    ['recetas', '/recetas'],
  ]) {
    const r = await api('GET', ruta);
    ok(`${nombre} responde 200`, r.estado === 200, `estado=${r.estado}`);
  }
}

console.log(`\n${'='.repeat(50)}\nRESULTADO: ${pasan} pasan, ${fallan} fallan`);
if (fallos.length) console.log('Fallos:\n - ' + fallos.join('\n - '));
process.exit(fallan ? 1 : 0);
