// ============================================================
//  COSTOS EN DOS MONEDAS (CUP y USD)
//
//  Un solo sitio donde se decide cómo se convierte un costo entre
//  moneda nacional y dólares, y qué se archiva. Lo usan la entrada de
//  almacén y las compras; cualquier pantalla nueva que maneje dinero
//  debería usar esto en vez de volver a dividir por la tasa a mano.
//
//  LA REGLA QUE NO SE PUEDE ROMPER
//  --------------------------------
//  De cada costo se guardan TRES datos: el importe en CUP, el importe
//  en USD y LA TASA EXACTA con la que se relacionaron. Nunca uno solo.
//
//  El motivo es contable, no técnico. La tasa del dólar se mueve todos
//  los días. Si de una compra de enero solo guardáramos los 100 USD y
//  convirtiéramos al mostrarla, esa compra valdría 34 000 CUP hoy y
//  36 000 la semana que viene; la ganancia de enero cambiaría sola, y
//  el margen del punto de venta con ella. Lo archivado tiene que ser
//  una foto del día de la compra, no una cuenta que se rehace cada vez
//  que alguien abre la pantalla.
// ============================================================

import { obtenerTasa } from './tasas.js';

/** Redondeo a 2 decimales, devolviendo null si no hay número válido. */
function dinero(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(2));
}

/**
 * Decide los dos importes y la tasa que se van a archivar.
 *
 * @param {object} datos
 * @param {number} [datos.costo_cup]     importe en moneda nacional
 * @param {number} [datos.costo_usd]     importe en dólares
 * @param {string} [datos.moneda_origen] 'CUP' | 'USD' — en cuál se pagó de verdad
 * @param {number} [datos.tasa]          tasa de esa compra, si fue distinta de la del día
 *
 * @returns {Promise<{cup:number|null, usd:number|null, moneda_origen:string|null,
 *                    tasa:number|null, aviso:string|null}>}
 */
export async function resolverCosto({ costo_cup, costo_usd, moneda_origen, tasa } = {}) {
  const cupPedido = dinero(costo_cup);
  const usdPedido = dinero(costo_usd);

  // Sin ningún importe no hay nada que resolver. No es un error: dar
  // entrada sin declarar costo es legítimo (una devolución, un ajuste).
  if (cupPedido === null && usdPedido === null) {
    return { cup: null, usd: null, moneda_origen: null, tasa: null, aviso: null };
  }

  // La tasa la manda quien registra si la escribió (una compra puede
  // haberse pactado a otro cambio); si no, se usa la del sistema.
  let tasaUsada = Number(tasa);
  if (!Number.isFinite(tasaUsada) || tasaUsada <= 0) {
    tasaUsada = null;
    try {
      const t = await obtenerTasa();
      if (t && t.disponible && Number(t.valor) > 0) tasaUsada = Number(t.valor);
    } catch {
      // Que falle elTOQUE no puede impedir dar entrada a la mercancía.
      tasaUsada = null;
    }
  }

  // Origen: lo declarado si es válido; si no, se deduce de lo que vino.
  let origen = String(moneda_origen || '').toUpperCase();
  if (origen !== 'CUP' && origen !== 'USD') {
    origen = cupPedido !== null ? 'CUP' : 'USD';
  }

  // Los dos importes vienen escritos: se respetan tal cual. Quien
  // registra sabe lo que pagó mejor que cualquier conversión nuestra.
  // Se deja además la tasa que ambos implican, que es el dato real de
  // esa compra aunque no coincida con la del día.
  if (cupPedido !== null && usdPedido !== null) {
    return {
      cup: cupPedido,
      usd: usdPedido,
      moneda_origen: origen,
      tasa: Number((cupPedido / usdPedido).toFixed(4)),
      aviso: null,
    };
  }

  // Falta uno de los dos y no hay tasa con la que calcularlo. Se guarda
  // lo que se sabe y se avisa, en vez de inventar una equivalencia: un
  // número inventado en contabilidad es peor que un hueco.
  if (tasaUsada === null) {
    return {
      cup: cupPedido,
      usd: usdPedido,
      moneda_origen: origen,
      tasa: null,
      aviso: 'No hay tasa del dólar disponible, así que se guardó solo el importe que usted escribió. '
           + 'Puede completarlo más tarde, o fijar la tasa a mano en Contabilidad.',
    };
  }

  if (cupPedido !== null) {
    return {
      cup: cupPedido,
      usd: Number((cupPedido / tasaUsada).toFixed(2)),
      moneda_origen: origen,
      tasa: tasaUsada,
      aviso: null,
    };
  }

  return {
    cup: Number((usdPedido * tasaUsada).toFixed(2)),
    usd: usdPedido,
    moneda_origen: origen,
    tasa: tasaUsada,
    aviso: null,
  };
}
