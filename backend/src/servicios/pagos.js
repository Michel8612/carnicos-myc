// ============================================================
//  Proveedor de Pagos — pasarelas bancarias cubanas (§6)
//
//  Mismo espíritu que servicios/tasas.js: pieza CENTRAL y única
//  que sabe hablar con las pasarelas de pago. Ninguna otra parte
//  del sistema debe llamar directo a EnZona o a nadie: todos pasan
//  por aquí, a través de la interfaz de abajo (crearCobro,
//  consultarEstado, listarMovimientos).
//
//  Filosofía:
//   - disponible() NUNCA hace una llamada de red: solo comprueba si
//     hay credenciales configuradas. Así GET /bancos/pasarelas
//     responde siempre al instante y sin colgarse, haya o no
//     Internet, y sin gastar ni una petición real.
//   - Ningún método lanza excepción hacia arriba: todos devuelven
//     { ok:false, motivo } si algo falla, para que la ruta nunca
//     reviente por un problema de la pasarela.
//   - Mientras no haya integración real (o no haya credenciales),
//     los movimientos se registran a mano (routes/bancos.js) y la
//     conciliación es manual. Esta interfaz ya deja el hueco listo
//     para el día que la automática llegue: enchufar una pasarela
//     nueva es escribir un objeto más en PASARELAS y nada más.
// ============================================================

const TIMEOUT_MS = 8000; // conexión mala en Cuba: que nunca cuelgue la app

// ------------------------------------------------------------
//  EnZona — API oficial (OAuth2, variante sin renovación de token)
//  Producción:  https://api.enzona.net
//  Sandbox:     https://apisandbox.enzona.net
//  El comercio se registra en https://bulevar.enzona.net/ y las
//  credenciales se obtienen en https://api.enzona.net/store/.
// ------------------------------------------------------------

function esSandboxEnzona() {
  return process.env.ENZONA_SANDBOX === '1' || process.env.ENZONA_SANDBOX === 'true';
}

function baseUrlEnzona() {
  return esSandboxEnzona() ? 'https://apisandbox.enzona.net' : 'https://api.enzona.net';
}

function credencialesEnzona() {
  return { clientId: process.env.ENZONA_CLIENT_ID, clientSecret: process.env.ENZONA_CLIENT_SECRET };
}

// Cache del token OAuth2 en memoria del proceso (no en base de datos:
// es un secreto derivado y de vida corta). Se renueva solo cuando expira.
let tokenEnzona = null; // { valor, expiraEn(ms) }

async function obtenerTokenEnzona() {
  if (tokenEnzona && Date.now() < tokenEnzona.expiraEn) return tokenEnzona.valor;
  const { clientId, clientSecret } = credencialesEnzona();
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    // OJO: sin credenciales de comercio no se ha podido verificar en vivo
    // el endpoint exacto de autenticación. Según la documentación pública
    // de EnZona (variante OAuth2 "sin renovación de token"), el token se
    // pide contra /token con client_credentials y Basic Auth. Si el
    // contrato real difiere, este es el ÚNICO sitio que hay que tocar.
    const resp = await fetch(`${baseUrlEnzona()}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: 'grant_type=client_credentials',
      signal: controlador.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const datos = await resp.json();
    const accessToken = datos?.access_token;
    if (!accessToken) throw new Error('La respuesta de EnZona no trajo access_token.');
    // Si no viene expires_in se asume 55 minutos, con margen para renovar
    // antes de que el token real caduque.
    const segundos = Number(datos?.expires_in) || 3300;
    tokenEnzona = { valor: accessToken, expiraEn: Date.now() + segundos * 1000 };
    return accessToken;
  } finally {
    clearTimeout(temporizador);
  }
}

async function llamarEnzona(ruta, opciones = {}) {
  const token = await obtenerTokenEnzona();
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrlEnzona()}${ruta}`, {
      ...opciones,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(opciones.headers || {}),
      },
      signal: controlador.signal,
    });
    const datos = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(datos?.message || datos?.error || `HTTP ${resp.status}`);
    return datos;
  } finally {
    clearTimeout(temporizador);
  }
}

// Único punto donde se traduce la respuesta cruda de EnZona al formato
// que usa el resto del sistema. Sin credenciales de comercio no se pudo
// confirmar el contrato exacto (nombres de campo, formatos...), así que
// aquí NO se inventan campos que no se han visto de verdad: se intenta
// leer los nombres más probables según la documentación pública y se
// conserva la respuesta completa en `crudo` para no perder información.
function mapearRespuestaEnzona(datos) {
  return {
    id: datos?.transaction_id ?? datos?.id ?? null,
    estado: datos?.status ?? datos?.state ?? null,
    monto: datos?.amount != null ? Number(datos.amount) : null,
    fecha: datos?.date ?? datos?.created_at ?? null,
    crudo: datos,
  };
}

function motivoLegibleEnzona(err) {
  if (err?.name === 'AbortError') return 'La consulta a EnZona tardó demasiado y se canceló (conexión lenta).';
  if (err instanceof TypeError) return 'No hay conexión con EnZona en este momento.';
  return err?.message || 'No se pudo completar la operación con EnZona.';
}

// ------------------------------------------------------------
//  Mapa de proveedores — añadir uno nuevo = un objeto más aquí
//  con { nombre, disponible(), crearCobro(), consultarEstado(),
//  listarMovimientos() } y nada más.
// ------------------------------------------------------------
const PASARELAS = {
  enzona: {
    nombre: 'EnZona',
    entorno: () => (esSandboxEnzona() ? 'sandbox' : 'producción'),
    variablesRequeridas: ['ENZONA_CLIENT_ID', 'ENZONA_CLIENT_SECRET', 'ENZONA_SANDBOX (opcional: "true" para pruebas)'],
    // Sin credenciales no tiene sentido ni intentar la llamada.
    disponible() {
      const { clientId, clientSecret } = credencialesEnzona();
      return Boolean(clientId && clientSecret);
    },
    motivoNoDisponible: 'Faltan las credenciales de comercio (ENZONA_CLIENT_ID / ENZONA_CLIENT_SECRET). El negocio se registra en https://bulevar.enzona.net/ y las credenciales se obtienen en https://api.enzona.net/store/.',

    // Crea un cobro (genera QR de cobro del lado de EnZona). El payload
    // exacto no se ha podido confirmar sin credenciales reales: se sigue
    // la forma más probable de la documentación pública. El mapeo de la
    // respuesta está aislado en mapearRespuestaEnzona() por si hay que
    // corregirlo el día que se pruebe con credenciales de verdad.
    async crearCobro({ monto, concepto, referencia } = {}) {
      if (!this.disponible()) return { ok: false, motivo: this.motivoNoDisponible };
      try {
        const datos = await llamarEnzona('/payment/rest/v3/generateqr', {
          method: 'POST',
          body: JSON.stringify({ amount: monto, description: concepto, transaction_uuid: referencia }),
        });
        return { ok: true, cobro: mapearRespuestaEnzona(datos) };
      } catch (err) {
        return { ok: false, motivo: motivoLegibleEnzona(err) };
      }
    },

    async consultarEstado(idTransaccion) {
      if (!this.disponible()) return { ok: false, motivo: this.motivoNoDisponible };
      try {
        const datos = await llamarEnzona(`/payment/rest/v3/transaction/${encodeURIComponent(idTransaccion)}`);
        return { ok: true, estado: mapearRespuestaEnzona(datos) };
      } catch (err) {
        return { ok: false, motivo: motivoLegibleEnzona(err) };
      }
    },

    async listarMovimientos({ desde, hasta } = {}) {
      if (!this.disponible()) return { ok: false, motivo: this.motivoNoDisponible };
      try {
        const qs = new URLSearchParams();
        if (desde) qs.set('from', desde);
        if (hasta) qs.set('to', hasta);
        const datos = await llamarEnzona(`/payment/rest/v3/transactions?${qs.toString()}`);
        const lista = Array.isArray(datos) ? datos : datos?.transactions || [];
        return { ok: true, movimientos: lista.map(mapearRespuestaEnzona) };
      } catch (err) {
        return { ok: false, motivo: motivoLegibleEnzona(err) };
      }
    },
  },

  // ------------------------------------------------------------
  //  Transfermóvil — declarado pero NO disponible.
  //  ETECSA no publica documentación abierta de su API de comercio.
  //  Existe una modalidad de pasarela para "tienda virtual" con
  //  integración, pero se contrata directamente con ETECSA
  //  (etecsa.cu/es/emprendedores/transfermovil) y no hay contrato
  //  público que seguir. Está PROHIBIDO hacer ingeniería inversa o
  //  usar métodos no documentados, así que este adaptador queda con
  //  la misma interfaz pero siempre inerte, hasta que haya un
  //  contrato y documentación real que implementar.
  // ------------------------------------------------------------
  transfermovil: {
    nombre: 'Transfermóvil',
    entorno: () => null,
    variablesRequeridas: [],
    disponible: () => false,
    motivoNoDisponible: 'Transfermóvil no tiene API pública documentada. La pasarela para comercios ("tienda virtual") se contrata directamente con ETECSA (etecsa.cu/es/emprendedores/transfermovil); hasta que exista ese contrato y su documentación, no se puede integrar.',

    async crearCobro() { return { ok: false, motivo: this.motivoNoDisponible }; },
    async consultarEstado() { return { ok: false, motivo: this.motivoNoDisponible }; },
    async listarMovimientos() { return { ok: false, motivo: this.motivoNoDisponible }; },
  },
};

function pasarela(clave) {
  const p = PASARELAS[clave];
  if (!p) throw new Error(`Pasarela desconocida: ${clave}`);
  return p;
}

// ------------------------------------------------------------
//  Interfaz única que consume el resto del sistema (routes/bancos.js
//  y, el día de mañana, cualquier otro módulo que necesite cobrar).
// ------------------------------------------------------------

// Estado de todas las pasarelas para la pantalla Empresa → Pasarelas
// de pago. NUNCA hace llamadas de red: solo mira si hay credenciales.
export async function estadoPasarelas() {
  return Object.entries(PASARELAS).map(([clave, p]) => ({
    clave,
    nombre: p.nombre,
    disponible: p.disponible(),
    entorno: p.entorno(),
    variables_requeridas: p.variablesRequeridas,
    motivo: p.disponible() ? null : p.motivoNoDisponible,
  }));
}

export async function crearCobro(clave, datos) { return pasarela(clave).crearCobro(datos); }
export async function consultarEstado(clave, idTransaccion) { return pasarela(clave).consultarEstado(idTransaccion); }
export async function listarMovimientosPasarela(clave, filtros) { return pasarela(clave).listarMovimientos(filtros); }

export default { estadoPasarelas, crearCobro, consultarEstado, listarMovimientosPasarela };
