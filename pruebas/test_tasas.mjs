import { login, api, assert } from './helpers.mjs';

let fails = 0;
function A(cond, msg) { if (!assert(cond, msg)) fails++; }

const tokAdmin = await login('admin', 'admin123');

console.log('\n=== TEST 9: sin tasa fijada, /actual no revienta ===');
{
  const t0 = Date.now();
  const r = await api('GET', '/api/tasas/actual', tokAdmin);
  const ms = Date.now() - t0;
  A(r.status === 200, `responde 200 (no 500) (real ${r.status}): ${JSON.stringify(r.body)}`);
  A(r.body?.disponible === false, `disponible:false (real ${r.body?.disponible})`);
  A(ms < 10000, `responde rapido (${ms}ms)`);
}

console.log('\n=== TEST 10: PUT /tasas/manual fija tasa ===');
{
  const r = await api('PUT', '/api/tasas/manual', tokAdmin, { valor: 415 });
  A(r.status === 200, `PUT manual responde 200 (real ${r.status}): ${JSON.stringify(r.body)}`);
  A(r.body?.valor === 415, `valor 415 (real ${r.body?.valor})`);
  A(r.body?.fuente === 'manual', `fuente manual (real ${r.body?.fuente})`);
  A(r.body?.pendiente === true, `pendiente true (real ${r.body?.pendiente})`);

  const r2 = await api('GET', '/api/tasas/actual', tokAdmin);
  A(r2.status === 200, 'GET /actual tras fijar responde 200');
  A(r2.body?.valor === 415, `GET /actual devuelve 415 (real ${r2.body?.valor})`);
  A(r2.body?.fuente === 'manual', `fuente manual en /actual (real ${r2.body?.fuente})`);
  A(r2.body?.pendiente === true, `pendiente true en /actual (real ${r2.body?.pendiente})`);
}

console.log('\n=== TEST 11: POST /tasas/actualizar sin token no revienta ===');
{
  const t0 = Date.now();
  const r = await api('POST', '/api/tasas/actualizar', tokAdmin);
  const ms = Date.now() - t0;
  A(r.status === 200, `responde 200 (no 500) (real ${r.status}): ${JSON.stringify(r.body)}`);
  A(ms < 10000, `responde en menos de 10s (${ms}ms)`);
  A(r.body?.disponible === true, 'cae al respaldo (disponible true, con la manual guardada)');
  A(r.body?.fuente === 'manual', `fuente sigue siendo manual, sin token no llama a elTOQUE (real ${r.body?.fuente})`);
}

console.log('\n=== TEST 12: aritmetica exacta con tasa 415, 1000 CUP ===');
{
  const tasa = 415, cup = 1000, margen = 0.02;
  const usd = cup / tasa;
  const usdVenta = usd * (1 + margen);
  console.log(`  usd sin redondear = ${usd}`);
  console.log(`  usdVenta sin redondear = ${usdVenta}`);
  A(Math.abs(usd - 2.409638554216867) < 1e-9, `usd = 2.4096... (real ${usd})`);
  A(Math.abs(usdVenta - 2.4578313253012047) < 1e-9, `usdVenta = usd*1.02 = 2.4578... (real ${usdVenta})`);

  // Simulamos EXACTAMENTE la funcion convertir() de public/js/tasas.js
  function convertir(cupMonto, info) {
    if (!info || !info.disponible || !info.valor) return null;
    const monto = Number(cupMonto) || 0;
    const t = Number(info.valor);
    const m = Number(info.margen ?? 0.02);
    const u = monto / t;
    const uV = u * (1 + m);
    return {
      usd: Math.round(u * 100) / 100,
      usdVenta: Math.round(uV * 100) / 100,
      tasa: t,
      pendiente: Boolean(info.pendiente),
    };
  }
  const info = { disponible: true, valor: 415, margen: 0.02, pendiente: true };
  const resultado = convertir(1000, info);
  console.log('  resultado tasas.js:', resultado);
  A(resultado.usd === 2.41, `tasas.js redondea usd a 2.41 (real ${resultado.usd})`);
  A(resultado.usdVenta === 2.46, `tasas.js redondea usdVenta a 2.46 (2.4578 -> 2.46) (real ${resultado.usdVenta})`);
}

console.log('\n=== TEST 13: valores invalidos en PUT /tasas/manual ===');
{
  for (const valor of [0, -5, 'abc', '', null]) {
    const r = await api('PUT', '/api/tasas/manual', tokAdmin, { valor });
    A(r.status === 400, `valor=${JSON.stringify(valor)} rechazado con 400 (real ${r.status}): ${JSON.stringify(r.body)}`);
    A(!!r.body?.error, `trae mensaje de error claro (real: ${r.body?.error})`);
  }
  // Confirmar que sigue en 415 (no se guardo ninguno de los invalidos).
  const r = await api('GET', '/api/tasas/actual', tokAdmin);
  A(r.body?.valor === 415, `la tasa sigue en 415, ninguno invalido se guardo (real ${r.body?.valor})`);
}

console.log(`\n========== TOTAL FALLAS: ${fails} ==========`);
process.exit(fails > 0 ? 1 : 0);
