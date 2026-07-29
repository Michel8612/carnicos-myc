// ============================================================
//  Tasas.js — helper de la tasa de cambio USD/CUP (frontend)
//
//  Se carga como script normal (no módulo) y expone `window.Tasas`.
//  Habla con el backend UNA sola vez por carga de página (Tasas.cargar())
//  y guarda el resultado en memoria; el resto de la página usa
//  Tasas.convertir() y Tasas.etiqueta() sin volver a pedir nada.
//
//  Si la tasa no está disponible (sin token, sin tasa manual, sin
//  conexión), convertir() devuelve null y quien lo llama simplemente
//  no muestra el USD. Nunca revienta la página.
// ============================================================

(function () {
  let info = null; // último resultado de GET /tasas/actual (o null si nunca cargó)

  // Pide la tasa actual al backend. Se llama una vez por página
  // (normalmente al iniciar), pero es seguro llamarla de nuevo.
  async function cargar() {
    try {
      info = await API.tasaActual();
    } catch (e) {
      // Sin conexión o error del servidor: seguimos sin tasa, sin romper la página.
      info = null;
    }
    return info;
  }

  // Convierte un importe en CUP a USD, usando la tasa cargada.
  // Devuelve { usd, usdVenta, tasa, pendiente } o null si no hay tasa disponible.
  // Redondea solo al mostrar (aquí, al construir el objeto de salida),
  // nunca antes de terminar los cálculos.
  function convertir(cup) {
    if (!info || !info.disponible || !info.valor) return null;
    const monto = Number(cup) || 0;
    const tasa = Number(info.valor);
    const margen = Number(info.margen ?? 0.02);
    const usd = monto / tasa;
    const usdVenta = usd * (1 + margen);
    return {
      usd: Math.round(usd * 100) / 100,
      usdVenta: Math.round(usdVenta * 100) / 100,
      tasa,
      pendiente: Boolean(info.pendiente),
    };
  }

  // Texto corto para citar la fuente (elTOQUE lo exige en sus términos).
  // Ej: "1 USD = 415.00 CUP · elTOQUE · hoy 10:00"
  function etiqueta() {
    if (!info || !info.disponible || !info.valor) {
      return 'Tasa de cambio no disponible todavía.';
    }
    const tasa = Number(info.valor).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fuente = info.fuente || '—';
    let cuando = '';
    if (info.actualizada) {
      const fecha = new Date(info.actualizada);
      if (!isNaN(fecha.getTime())) {
        const hoy = new Date();
        const esHoy = fecha.toDateString() === hoy.toDateString();
        const hora = fecha.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
        cuando = esHoy ? `hoy ${hora}` : fecha.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' }) + ` ${hora}`;
      }
    }
    let texto = `1 USD = ${tasa} CUP · ${fuente}`;
    if (cuando) texto += ` · ${cuando}`;
    if (info.pendiente) texto += ' (actualización pendiente)';
    return texto;
  }

  window.Tasas = { cargar, convertir, etiqueta };
})();
