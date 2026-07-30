import { login, api, assert } from './helpers.mjs';
import { execSync } from 'node:child_process';

let fails = 0;
function A(cond, msg) { if (!assert(cond, msg)) fails++; }
function sql(q) {
  const qFlat = q.replace(/\s+/g, ' ').trim();
  return execSync(`docker exec gestion-db-test psql -U gestion -d gestion -t -A -F"," -c "${qFlat.replace(/"/g, '\\"')}"`).toString().trim();
}
function sqlNum(q) { const s = sql(q); return s === '' ? 0 : Number(s); }

const tokAdmin = await login('admin', 'admin123');
async function resetYLogin(id, usuario) {
  await api('POST', `/api/usuarios/${id}/reiniciar-clave`, tokAdmin, { clave_temporal: 'prueba123' });
  return login(usuario, 'prueba123');
}
const tokVend = await resetYLogin(6, 'vend');

// ============================================================
// TEST 14: regimenes
// ============================================================
console.log('\n=== TEST 14: GET /tributacion/regimenes ===');
{
  const r = await api('GET', '/api/contabilidad/tributacion/regimenes', tokAdmin);
  A(r.status === 200, `responde 200 (real ${r.status})`);
  const tipos = Object.keys(r.body.regimenes || {});
  A(tipos.length === 3, `3 tipos de empresa (real ${tipos.length}: ${tipos.join(',')})`);
  A(r.body.tipos_empresa.length === 3, 'tipos_empresa trae 3');
  for (const t of tipos) {
    A(Array.isArray(r.body.regimenes[t].tributos) && r.body.regimenes[t].tributos.length === 4,
      `${t} tiene 4 tributos (real ${r.body.regimenes[t].tributos?.length})`);
  }
}

// ============================================================
// Sembrar datos reales: un gasto y una venta conocidos.
// ============================================================
console.log('\n=== Sembrando datos ===');
const GASTO_MONTO = 55.5;
{
  const r = await api('POST', '/api/costos/gastos', tokAdmin, {
    categoria: 'directo', concepto: 'Test tributacion gasto', monto: GASTO_MONTO, moneda: 'CUP',
  });
  A(r.status === 200, `gasto sembrado ok (real ${r.status}): ${JSON.stringify(r.body)}`);
}
{
  const hoja = await api('GET', '/api/ventas/hoja', tokVend);
  const item = hoja.body.productos.find(i => i.nombre === 'Sal');
  await api('PUT', `/api/ventas/producto/${item.id}`, tokVend, {
    nombre: item.nombre, unidad: item.unidad, cantidad: item.cantidad,
    costo_unitario: item.costo_unitario, precio_venta: 25,
  });
  const r = await api('POST', '/api/ventas/carrito', tokVend, {
    items: [{ producto_id: item.id, cantidad: 1 }], cliente: 'Test tributacion venta',
  });
  A(r.status === 200, `venta sembrada ok (real ${r.status}): ${JSON.stringify(r.body)}`);
  globalThis.__ventaCosto = item.costo_unitario * 1;
  globalThis.__ventaIngreso = 25 * 1;
}

const hoy = sql(`SELECT (now() AT TIME ZONE 'America/Havana')::date::text`);
console.log('  Fecha Havana hoy:', hoy);

// ============================================================
// TEST 15/17: ventas_brutas y gastos_deducibles coinciden con la DB;
// cada tributo = base * pct/100; total_tributos = suma exacta.
// ============================================================
console.log('\n=== TEST 15/17: bases y tributos exactos (rango = hoy) ===');
{
  const ventasEsperadas = sqlNum(`
    SELECT COALESCE(SUM(ingreso),0) FROM contabilidad_registros
    WHERE tipo='venta' AND (fecha AT TIME ZONE 'America/Havana')::date = '${hoy}'
  `);
  const gananciaEsperada = sqlNum(`
    SELECT COALESCE(SUM(ganancia),0) FROM contabilidad_registros
    WHERE tipo='venta' AND (fecha AT TIME ZONE 'America/Havana')::date = '${hoy}'
  `);
  const gastosEsperados = sqlNum(`
    SELECT COALESCE(SUM(monto),0) FROM gastos
    WHERE (fecha AT TIME ZONE 'America/Havana')::date = '${hoy}'
  `);

  const r = await api('GET', `/api/contabilidad/tributacion?periodo=rango&desde=${hoy}&hasta=${hoy}`, tokAdmin);
  A(r.status === 200, `responde 200 (real ${r.status})`);
  A(r.body.ventas_brutas === Number(ventasEsperadas.toFixed(2)), `ventas_brutas coincide con DB (esperado ${ventasEsperadas}, real ${r.body.ventas_brutas})`);
  A(r.body.gastos_deducibles.total === Number(gastosEsperados.toFixed(2)), `gastos_deducibles.total coincide con DB (esperado ${gastosEsperados}, real ${r.body.gastos_deducibles.total})`);

  const utilidadEsperada = Number((gananciaEsperada - gastosEsperados).toFixed(2));
  A(r.body.utilidad_neta === utilidadEsperada, `utilidad_neta = ganancia-gastos (esperado ${utilidadEsperada}, real ${r.body.utilidad_neta})`);
  const baseEsperada = Number(Math.max(0, utilidadEsperada).toFixed(2));
  A(r.body.base_imponible === baseEsperada, `base_imponible = max(0,utilidad) (esperado ${baseEsperada}, real ${r.body.base_imponible})`);

  // TEST 17: cada tributo a mano.
  let sumaManual = 0;
  for (const t of r.body.tributos) {
    const importeManual = Number((t.base_valor * (t.porcentaje / 100)).toFixed(2));
    A(t.importe === importeManual, `tributo ${t.clave}: importe=${t.base_valor}*${t.porcentaje}%=${importeManual} (real ${t.importe})`);
    sumaManual += t.importe;
  }
  sumaManual = Number(sumaManual.toFixed(2));
  A(r.body.total_tributos === sumaManual, `total_tributos es la suma exacta (esperado ${sumaManual}, real ${r.body.total_tributos})`);

  // Confirmamos el "agujero" de nomina: como el gasto se registro con
  // categoria 'directo' (las unicas 4 categorias validas del sistema no
  // incluyen 'nomina'), la base nomina sigue en 0 siempre.
  const tribSS = r.body.tributos.find(t => t.clave === 'seguridad_social');
  console.log(`  (info) seguridad_social base_valor=${tribSS.base_valor} (nomina real: ${gastosEsperados > 0 ? 'no probamos nomina, ver informe' : 'n/a'})`);
}

// ============================================================
// TEST 16: los 4 periodos, fechas coherentes; periodo vacio -> ceros.
// ============================================================
console.log('\n=== TEST 16: los 4 periodos ===');
{
  for (const periodo of ['mes', 'trimestre', 'ano']) {
    const r = await api('GET', `/api/contabilidad/tributacion?periodo=${periodo}`, tokAdmin);
    A(r.status === 200, `periodo=${periodo} responde 200 (real ${r.status})`);
    A(r.body.resumen.periodo === periodo, `resumen.periodo=${periodo} (real ${r.body.resumen.periodo})`);
    A(r.body.resumen.hasta === hoy, `hasta = hoy (${hoy}) (real ${r.body.resumen.hasta})`);
    A(r.body.resumen.desde <= r.body.resumen.hasta, `desde <= hasta (${r.body.resumen.desde} <= ${r.body.resumen.hasta})`);
    if (periodo === 'mes') A(r.body.resumen.desde.endsWith('-01'), `mes empieza el dia 1 (real ${r.body.resumen.desde})`);
    if (periodo === 'ano') A(r.body.resumen.desde.endsWith('-01-01'), `ano empieza el 1-ene (real ${r.body.resumen.desde})`);
  }

  // Rango personalizado sin desde/hasta -> 400 claro.
  const rMalo = await api('GET', `/api/contabilidad/tributacion?periodo=rango`, tokAdmin);
  A(rMalo.status === 400, `rango sin desde/hasta -> 400 (real ${rMalo.status})`);

  // Periodo vacio (fechas en el pasado remoto, sin datos) -> ceros, no error.
  const rVacio = await api('GET', `/api/contabilidad/tributacion?periodo=rango&desde=2019-01-01&hasta=2019-01-02`, tokAdmin);
  A(rVacio.status === 200, `periodo vacio responde 200 (real ${rVacio.status})`);
  A(rVacio.body.ventas_brutas === 0, `ventas_brutas=0 en periodo vacio (real ${rVacio.body.ventas_brutas})`);
  A(rVacio.body.gastos_deducibles.total === 0, `gastos=0 en periodo vacio (real ${rVacio.body.gastos_deducibles.total})`);
  A(rVacio.body.total_tributos === 0, `total_tributos=0 en periodo vacio (real ${rVacio.body.total_tributos})`);
}

// ============================================================
// TEST 18: utilidad negativa -> base_imponible no negativa, tributos
// sobre utilidad en 0.
// ============================================================
console.log('\n=== TEST 18: utilidad negativa ===');
{
  // Un gasto enorme para forzar utilidad_neta negativa en el rango de hoy.
  await api('POST', '/api/costos/gastos', tokAdmin, {
    categoria: 'fijo', concepto: 'Gasto enorme para forzar perdida', monto: 999999, moneda: 'CUP',
  });
  const r = await api('GET', `/api/contabilidad/tributacion?periodo=rango&desde=${hoy}&hasta=${hoy}`, tokAdmin);
  A(r.status === 200, `responde 200 (real ${r.status})`);
  A(r.body.utilidad_neta < 0, `utilidad_neta quedo negativa (real ${r.body.utilidad_neta})`);
  A(r.body.base_imponible === 0, `base_imponible NO es negativa, es 0 (real ${r.body.base_imponible})`);
  const tribUtil = r.body.tributos.find(t => t.base === 'utilidad_neta');
  A(tribUtil.importe === 0, `impuesto sobre utilidad = 0 (real ${tribUtil.importe})`);
  A(r.body.advertencias.some(a => a.includes('pérdida')), 'trae advertencia de perdida');
}

console.log(`\n========== TOTAL FALLAS: ${fails} ==========`);
process.exit(fails > 0 ? 1 : 0);
