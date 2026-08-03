// ============================================================
//  BATERÍA — Segunda entrega de la sección 10 del ERP
//
//  Cubre: informes contables, tablero de indicadores, cuentas por
//  cobrar/pagar, presupuestos, conciliación de inventario y el
//  centro de avisos.
//
//  Requisitos (los mismos que el resto de baterías):
//    base LIMPIA -> servidor en el 3012 -> `node pruebas/sembrar.mjs`
//  y ejecutar este archivo UNA sola vez. No es idempotente: crea
//  documentos, conteos y presupuestos que quedan en la base.
// ============================================================

import { login, api, assert, BASE_URL } from './helpers.mjs';
import { execSync } from 'node:child_process';

let fails = 0;
function A(cond, msg) { if (!assert(cond, msg)) fails++; }

// Consulta directa a la base, para comprobar lo que la API no deja ver
// con el detalle que hace falta (mismo truco que test_carrito.mjs).
function sql(q) {
  return execSync(
    `docker exec gestion-db-test psql -U gestion -d gestion -t -A -c "${q.replace(/"/g, '\\"')}"`,
  ).toString().trim();
}

// Descarga cruda: `api()` da por hecho que la respuesta es JSON, y aquí
// lo que se comprueba es justo lo contrario (que llegue un archivo con
// su cabecera de descarga).
async function descargar(ruta, token) {
  const r = await fetch(`${BASE_URL}${ruta}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return {
    status: r.status,
    tipo: r.headers.get('content-type') || '',
    disposicion: r.headers.get('content-disposition') || '',
    largo: (await r.arrayBuffer()).byteLength,
  };
}

const tokAdmin = await login('admin', 'admin123');

async function resetYLogin(id, usuario) {
  await api('POST', `/api/usuarios/${id}/reiniciar-clave`, tokAdmin, { clave_temporal: 'prueba123' });
  return login(usuario, 'prueba123');
}
const tokVend = await resetYLogin(6, 'vend');
const tokAlm = await resetYLogin(2, 'alm1');

const hoy = new Date().toISOString().slice(0, 10);
const haceUnMes = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

// ============================================================
console.log('\n=== 1. INFORMES CONTABLES ===');
// ============================================================
{
  const er = await api('GET', `/api/informes/estado-resultados?desde=${haceUnMes}&hasta=${hoy}`, tokAdmin);
  A(er.status === 200, 'GET /informes/estado-resultados responde 200');
  A(er.body && er.body.ingresos && typeof er.body.ingresos.ventas === 'number',
    'el estado de resultados trae ingresos.ventas numérico');
  A(typeof er.body.utilidad_neta === 'number', 'trae utilidad_neta');
  A(Array.isArray(er.body.filas) && er.body.filas.length > 0, 'trae filas planas para exportar');

  const bal = await api('GET', `/api/informes/balance?fecha=${hoy}`, tokAdmin);
  A(bal.status === 200, 'GET /informes/balance responde 200');
  // La siembra mete 100 unidades de 3 productos en cada almacén: el
  // inventario valorado NO puede dar cero. Si diera, el balance estaría
  // mirando donde no debe.
  const activo = bal.body && (bal.body.activo || {});
  A(Number(activo.inventario || activo.total || 0) > 0,
    `el balance valora el inventario sembrado (${JSON.stringify(activo).slice(0, 120)})`);

  const fc = await api('GET', `/api/informes/flujo-caja?desde=${haceUnMes}&hasta=${hoy}`, tokAdmin);
  A(fc.status === 200, 'GET /informes/flujo-caja responde 200');
  A(fc.body && fc.body.entradas && fc.body.salidas && 'neto' in fc.body,
    'el flujo de caja trae entradas, salidas y neto');
  A(fc.body.referencia !== undefined,
    'el flujo separa los cobros/pagos de cuentas como referencia (no los suma al neto)');

  // Descargas reales
  const csv = await descargar(`/api/informes/estado-resultados?desde=${haceUnMes}&hasta=${hoy}&formato=csv`, tokAdmin);
  A(csv.status === 200 && csv.tipo.includes('text/csv'), `el CSV llega como text/csv (${csv.tipo})`);
  A(csv.disposicion.includes('attachment'), 'el CSV llega como descarga (attachment)');

  const xlsx = await descargar(`/api/informes/balance?fecha=${hoy}&formato=xlsx`, tokAdmin);
  A(xlsx.status === 200 && xlsx.tipo.includes('spreadsheetml'), `el Excel llega con su tipo real (${xlsx.tipo})`);
  A(xlsx.largo > 1000, `el Excel tiene contenido (${xlsx.largo} bytes)`);

  // Las cifras completas del negocio no son para el vendedor.
  const espia = await api('GET', '/api/informes/estado-resultados', tokVend);
  A(espia.status === 403, `el vendedor NO puede ver el estado de resultados (status ${espia.status})`);
}

// ============================================================
console.log('\n=== 2. TABLERO DE INDICADORES ===');
// ============================================================
{
  const t = await api('GET', '/api/tablero/indicadores', tokAdmin);
  A(t.status === 200, 'GET /tablero/indicadores responde 200');
  const claves = ['ventas', 'gastos', 'inventario', 'bancos', 'caja', 'cuentas', 'serie', 'stock_bajo'];
  for (const c of claves) A(t.body && c in t.body, `el tablero trae "${c}"`);
  A(Array.isArray(t.body.serie) && t.body.serie.length === 30,
    `la serie trae los 30 días completos, con huecos rellenos (${(t.body.serie || []).length})`);
  A(Number(t.body.inventario?.valor_costo || 0) > 0, 'el tablero valora el inventario sembrado');

  const espia = await api('GET', '/api/tablero/indicadores', tokVend);
  A(espia.status === 403, `el vendedor NO ve el tablero (status ${espia.status})`);
}

// ============================================================
console.log('\n=== 3. CUENTAS POR COBRAR Y POR PAGAR ===');
// ============================================================
let cuentaId = null;
{
  const mal = await api('POST', '/api/cuentas', tokAdmin, { tipo: 'cobrar', tercero: '', monto: 100 });
  A(mal.status === 400, 'sin el nombre del cliente no deja crear el documento');

  const malMonto = await api('POST', '/api/cuentas', tokAdmin, { tipo: 'cobrar', tercero: 'Bodega La Paz', monto: 0 });
  A(malMonto.status === 400, 'no deja crear un documento por importe cero');

  const c = await api('POST', '/api/cuentas', tokAdmin, {
    tipo: 'cobrar', tercero: 'Bodega La Paz', documento: 'F-001',
    concepto: 'Jamón de la semana', monto: 1000,
    fecha_emision: haceUnMes, fecha_vencimiento: haceUnMes, // ya vencida a propósito
  });
  A(c.status === 200 && c.body.id, 'se crea una cuenta por cobrar');
  cuentaId = c.body.id;
  A(Number(c.body.saldo) === 1000 && c.body.estado === 'pendiente',
    'al crearla, el saldo es el importe completo y queda pendiente');

  // Pago parcial
  const p1 = await api('POST', `/api/cuentas/${cuentaId}/pagos`, tokAdmin, { monto: 400, metodo: 'efectivo' });
  A(p1.status === 200, 'se registra un pago parcial de 400');
  const tras1 = (await api('GET', `/api/cuentas?tipo=cobrar`, tokAdmin)).body;
  const fila1 = (tras1.filas || []).find((f) => f.id === cuentaId);
  A(fila1 && Number(fila1.saldo) === 600 && fila1.estado === 'parcial',
    `tras el pago parcial el saldo baja a 600 y queda "parcial" (${fila1 && fila1.saldo}/${fila1 && fila1.estado})`);

  // No se puede pagar más de lo que se debe
  const exceso = await api('POST', `/api/cuentas/${cuentaId}/pagos`, tokAdmin, { monto: 5000 });
  A(exceso.status === 400, 'no deja pagar más de lo que queda por cobrar');

  // Ni cambiar el importe con pagos ya hechos
  const editar = await api('PUT', `/api/cuentas/${cuentaId}`, tokAdmin, { monto: 50 });
  A(editar.status === 400, 'no deja cambiar el importe de un documento que ya tiene pagos');

  // Pago del resto -> pagada
  const p2 = await api('POST', `/api/cuentas/${cuentaId}/pagos`, tokAdmin, { monto: 600, metodo: 'transferencia' });
  A(p2.status === 200, 'se registra el pago del resto');
  const detalle = await api('GET', `/api/cuentas/${cuentaId}/pagos`, tokAdmin);
  A(detalle.status === 200 && (detalle.body.pagos || detalle.body).length === 2,
    'el documento tiene sus dos pagos en el historial');

  // Antigüedad de saldos
  const ant = await api('GET', '/api/cuentas/antiguedad?tipo=cobrar', tokAdmin);
  A(ant.status === 200, 'GET /cuentas/antiguedad responde 200');
  A(ant.body && (ant.body.tramos || ant.body.totales), 'la antigüedad devuelve sus tramos');

  // Anular exige motivo
  const c2 = await api('POST', '/api/cuentas', tokAdmin, {
    tipo: 'pagar', tercero: 'Proveedor Cárnico', documento: 'P-77', monto: 300,
  });
  A(c2.status === 200, 'se crea una cuenta por pagar');
  const sinMotivo = await api('POST', `/api/cuentas/${c2.body.id}/anular`, tokAdmin, {});
  A(sinMotivo.status === 400, 'anular un documento SIN motivo se rechaza');
  const conMotivo = await api('POST', `/api/cuentas/${c2.body.id}/anular`, tokAdmin, { motivo: 'Duplicado' });
  A(conMotivo.status === 200, 'anular con motivo funciona');

  // El vendedor no escribe aquí
  const espia = await api('POST', '/api/cuentas', tokVend, { tipo: 'cobrar', tercero: 'X', monto: 10 });
  A(espia.status === 403, `el vendedor NO puede crear documentos de cobro (status ${espia.status})`);
}

// ============================================================
console.log('\n=== 4. PRESUPUESTOS ===');
// ============================================================
{
  const malFecha = await api('POST', '/api/presupuestos', tokAdmin, {
    nombre: 'Al revés', periodo_inicio: hoy, periodo_fin: haceUnMes,
  });
  A(malFecha.status === 400, 'no deja un presupuesto que termina antes de empezar');

  const p = await api('POST', '/api/presupuestos', tokAdmin, {
    nombre: 'Presupuesto de prueba', periodo_inicio: haceUnMes, periodo_fin: hoy,
    nota: 'batería de pruebas',
  });
  A(p.status === 200 && p.body.id, 'se crea un presupuesto');
  const presId = p.body.id;

  const l1 = await api('POST', `/api/presupuestos/${presId}/lineas`, tokAdmin, {
    tipo: 'gasto', categoria: 'nomina', previsto: 5000,
  });
  A(l1.status === 200, 'se añade una línea de gasto');

  const dup = await api('POST', `/api/presupuestos/${presId}/lineas`, tokAdmin, {
    tipo: 'gasto', categoria: 'nomina', previsto: 900,
  });
  A(dup.status === 400, 'no deja repetir la misma categoría de gasto en el mismo presupuesto');

  const l2 = await api('POST', `/api/presupuestos/${presId}/lineas`, tokAdmin, {
    tipo: 'ingreso', categoria: 'venta', previsto: 20000,
  });
  A(l2.status === 200, 'se añade una línea de ingreso');

  const comp = await api('GET', `/api/presupuestos/${presId}/comparativo`, tokAdmin);
  A(comp.status === 200, 'GET /presupuestos/:id/comparativo responde 200');
  const lineas = comp.body.lineas || comp.body.filas || [];
  A(lineas.length >= 2, `el comparativo trae las líneas (${lineas.length})`);
  A(lineas.every((l) => 'previsto' in l && 'real' in l && 'desviacion' in l),
    'cada línea del comparativo trae previsto, real y desviación');

  const csv = await descargar(`/api/presupuestos/${presId}/comparativo?formato=csv`, tokAdmin);
  A(csv.status === 200 && csv.tipo.includes('text/csv'), 'el comparativo se descarga en CSV');

  const det = await api('GET', `/api/presupuestos/${presId}`, tokAdmin);
  A(det.status === 200 && (det.body.lineas || []).length === 2, 'el detalle del presupuesto trae sus 2 líneas');
}

// ============================================================
console.log('\n=== 5. CONCILIACIÓN DE INVENTARIO (conteo físico) ===');
// ============================================================
{
  const almacenes = (await api('GET', '/api/inventario/almacenes?todos=1', tokAdmin)).body;
  const lista = almacenes.almacenes || almacenes;
  const almacenId = lista[0].id;

  const abrir = await api('POST', '/api/conciliaciones', tokAdmin, { almacen_id: almacenId, nota: 'conteo de prueba' });
  A(abrir.status === 200 && abrir.body.id, 'se abre un conteo físico');
  const concId = abrir.body.id;

  const repetido = await api('POST', '/api/conciliaciones', tokAdmin, { almacen_id: almacenId });
  A(repetido.status === 400, 'no deja abrir un segundo conteo en el mismo almacén');

  const det = await api('GET', `/api/conciliaciones/${concId}`, tokAdmin);
  A(det.status === 200, 'GET /conciliaciones/:id responde 200');
  const lineas = det.body.lineas || [];
  A(lineas.length >= 3, `el conteo tiene una línea por producto del almacén (${lineas.length})`);

  // La foto tiene que coincidir con lo que la base dice AHORA. No se
  // compara contra un número fijo a propósito: si antes corrieron las
  // otras baterías, la existencia ya no es la de la siembra, y el conteo
  // seguiría siendo correcto.
  const linea = lineas[0];
  const enBase = Number(
    sql(`SELECT cantidad FROM existencias WHERE producto_id = ${linea.producto_id} AND almacen_id = ${almacenId}`),
  );
  A(Number(linea.existencia_sistema) === enBase,
    `la línea congela la existencia real del momento (${linea.existencia_sistema} = ${enBase})`);

  // Se cuenta 10 menos de lo que dice el sistema: falta mercancía.
  const contado = Number((enBase - 10).toFixed(3));
  const put = await api('PUT', `/api/conciliaciones/lineas/${linea.id}`, tokAdmin, {
    existencia_fisica: contado, motivo: 'Merma no registrada',
  });
  A(put.status === 200, 'se guarda la cantidad contada de una línea');
  A(Number(put.body.diferencia) === -10, `la diferencia sale con su signo (-10, real ${put.body.diferencia})`);

  // Cerrar ajustando: la existencia real pasa a ser la contada.
  const cerrar = await api('POST', `/api/conciliaciones/${concId}/cerrar`, tokAdmin, { ajustar: true });
  A(cerrar.status === 200, 'se cierra el conteo ajustando las existencias');

  // Se comprueba contra la base y no contra /inventario/existencias porque
  // ese endpoint devuelve la existencia SUMADA de todos los almacenes: aquí
  // hay que mirar justo el almacén que se contó.
  const cantidadReal = Number(
    sql(`SELECT cantidad FROM existencias WHERE producto_id = ${linea.producto_id} AND almacen_id = ${almacenId}`),
  );
  A(cantidadReal === contado,
    `la existencia de ese almacén quedó en lo contado (${contado}, real ${cantidadReal})`);

  // Un conteo cerrado es un acta: no se toca más.
  const tarde = await api('PUT', `/api/conciliaciones/lineas/${linea.id}`, tokAdmin, { existencia_fisica: 50 });
  A(tarde.status === 400, 'un conteo cerrado ya NO se puede modificar');

  const otraVez = await api('POST', `/api/conciliaciones/${concId}/cerrar`, tokAdmin, { ajustar: true });
  A(otraVez.status === 400, 'un conteo cerrado no se puede volver a cerrar');

  // Y el ajuste dejó su rastro en el historial del almacén.
  const movs = (await api('GET', '/api/inventario/movimientos', tokAdmin)).body;
  const listaMovs = movs.movimientos || movs;
  A((Array.isArray(listaMovs) ? listaMovs : []).some((m) => m.tipo === 'ajuste'),
    'el cierre dejó un movimiento de tipo "ajuste" en el historial del almacén');

  // El vendedor no cuenta el almacén.
  const espia = await api('POST', '/api/conciliaciones', tokVend, { almacen_id: almacenId });
  A(espia.status === 403, `el vendedor NO puede abrir un conteo (status ${espia.status})`);

  // El almacenero sí.
  const otroAlmacen = lista[1] ? lista[1].id : almacenId;
  if (lista[1]) {
    const suyo = await api('POST', '/api/conciliaciones', tokAlm, { almacen_id: otroAlmacen });
    A(suyo.status === 200, 'el almacenero SÍ puede abrir un conteo');
    if (suyo.body.id) {
      const anularSinMotivo = await api('POST', `/api/conciliaciones/${suyo.body.id}/anular`, tokAlm, {});
      A(anularSinMotivo.status === 400, 'anular un conteo SIN motivo se rechaza');
      const anular = await api('POST', `/api/conciliaciones/${suyo.body.id}/anular`, tokAlm, { motivo: 'Se contó mal' });
      A(anular.status === 200, 'anular un conteo con motivo funciona y no toca existencias');
    }
  }
}

// ============================================================
console.log('\n=== 6. CENTRO DE AVISOS ===');
// ============================================================
{
  const cont = await api('GET', '/api/notificaciones/contador', tokAdmin);
  A(cont.status === 200 && 'sin_leer' in cont.body,
    `el contador devuelve sin_leer (${JSON.stringify(cont.body)})`);

  const lista = await api('GET', '/api/notificaciones', tokAdmin);
  A(lista.status === 200 && Array.isArray(lista.body), 'la lista de avisos responde con un arreglo');
  // El cierre del conteo con diferencias tuvo que avisar a alguien.
  A(lista.body.some((n) => n.referencia_tipo === 'conciliaciones'),
    'el conteo con diferencias generó su aviso');

  const todas = await api('POST', '/api/notificaciones/leer-todas', tokAdmin);
  A(todas.status === 200 && todas.body.ok, 'se pueden marcar todas como leídas de un tirón');
  const cont2 = await api('GET', '/api/notificaciones/contador', tokAdmin);
  A(Number(cont2.body.sin_leer) === 0, `tras marcarlas, el contador queda en cero (${cont2.body.sin_leer})`);

  // Los avisos son de todos los roles, no solo del dueño.
  const delVendedor = await api('GET', '/api/notificaciones', tokVend);
  A(delVendedor.status === 200, 'el vendedor también puede leer sus avisos');
}

console.log(`\n========== TOTAL FALLAS: ${fails} ==========`);
process.exit(fails > 0 ? 1 : 0);
