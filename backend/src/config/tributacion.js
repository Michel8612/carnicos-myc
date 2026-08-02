// ============================================================
//  tributacion.js — Parámetros tributarios de las MIPYMES cubanas
//
//  ⚠️  AVISO LEGAL MUY IMPORTANTE (escrito el 2026-07-29) ⚠️
//  Los porcentajes de este archivo son VALORES DE REFERENCIA que se
//  tomaron del régimen general conocido para las MIPYMES en Cuba en la
//  fecha de arriba. NO son asesoría legal ni fiscal, y la legislación
//  tributaria cambia (resoluciones de la ONAT, gacetas, exenciones por
//  actividad o municipio, etc.). ANTES de declarar o pagar impuestos
//  reales con estas cifras, el dueño del negocio DEBE confirmarlas con
//  la ONAT (Oficina Nacional de Administración Tributaria) o con un
//  contador autorizado. Este sistema calcula un ESTIMADO para que el
//  dueño tenga una idea de cuánto debe apartar; no sustituye la
//  declaración oficial.
//
//  Cómo está organizado (para que cambiar la ley sea editar datos,
//  no código):
//   - Cada régimen (microempresa, pequeña empresa, mediana empresa)
//     tiene una lista de "tributos". Cada tributo es un objeto plano:
//       { clave, nombre, base, porcentaje, minimo_exento, notas }
//     donde `base` dice sobre qué magnitud del negocio se calcula:
//       'utilidad_neta'   -> ingresos bancarios del período menos gastos
//       'ventas_brutas'   -> ingresos bancarios del período (entradas de
//                            dinero en las cuentas de `cuentas_bancarias`,
//                            ver `calcularTributacion` en
//                            routes/contabilidad.js). El nombre de la
//                            clave se conserva tal cual (aunque ya no
//                            mide "ventas") por compatibilidad con las
//                            correcciones manuales guardadas y con el
//                            régimen "Otro" que el usuario ya haya
//                            configurado: cambiar la clave las hubiera
//                            invalidado en silencio. Cambio pedido por el
//                            cliente (2026-08): declara sobre lo que le
//                            ENTRA por el banco, no sobre lo que mueve el
//                            almacén; ventas, almacén, recetas y
//                            producción quedaron fuera del cálculo.
//       'nomina'          -> gastos del período con categoría de nómina
//   - El motor de cálculo (ver `calcularTributos` más abajo, y la ruta
//     GET /contabilidad/tributacion en routes/contabilidad.js) NO conoce
//     los tributos concretos: simplemente recorre esta lista y aplica
//     `base_valor * porcentaje / 100` (respetando `minimo_exento`).
//     Para AÑADIR un tributo nuevo (o quitar uno), solo hay que tocar
//     este archivo — nunca el motor.
//   - Cualquier porcentaje se puede corregir en caliente desde la tabla
//     `parametros`, sin tocar código, con una clave del tipo:
//       trib.<regimen>.<clave_tributo>.porcentaje
//     Ejemplo: trib.microempresa.utilidades.porcentaje = "30"
//     (ver `combinarConParametros` más abajo).
// ============================================================

export const AVISO_LEGAL =
  'Los porcentajes usados aquí son valores de referencia (fijados el 2026-07-29) ' +
  'y NO tienen valor legal. Confirme siempre los tipos vigentes con la ONAT o ' +
  'con un contador antes de declarar o pagar impuestos reales.';

// Clave en `parametros` donde se guarda el tipo de empresa elegido por
// el dueño, para no tener que escogerlo cada vez que entra a la pestaña.
export const CLAVE_TIPO_EMPRESA = 'contabilidad.tipo_empresa';

export const TIPOS_EMPRESA = ['microempresa', 'pequena_empresa', 'mediana_empresa', 'otro'];

// Bases que el motor de cálculo entiende (ver `calcularTributosConRegimen`
// más abajo). El régimen "Otro" (definido a mano por el usuario) solo
// puede usar estas: así el motor genérico sigue sin cambios.
// Nota: 'ventas_brutas' ya NO se llena con ventas — se llena con los
// ingresos bancarios del período (ver comentario grande más arriba).
export const BASES_VALIDAS = ['utilidad_neta', 'ventas_brutas', 'nomina'];

// Clave en `parametros` donde se guarda la definición completa del
// régimen "Otro": un JSON con la lista de tributos que el usuario armó
// a mano (puede incluir los 4 de siempre con su porcentaje propio, más
// los tributos que quiera añadir).
export const CLAVE_REGIMEN_OTRO = 'trib.otro.definicion';

// ------------------------------------------------------------
//  Régimen tributario por defecto (mismos tributos en los tres
//  tamaños porque el régimen general cubano para MIPYMES no distingue
//  tipos impositivos por tamaño en estos cuatro tributos base; lo que
//  cambia en la práctica entre micro/pequeña/mediana suele ser el
//  tratamiento simplificado o topes de algunas exenciones, que aquí se
//  modelan con `minimo_exento` y `notas`). Si la ONAT confirma tipos
//  distintos por tamaño, se edita SOLO este archivo.
// ------------------------------------------------------------
function tributosBase() {
  return [
    {
      clave: 'utilidades',
      nombre: 'Impuesto sobre Utilidades',
      base: 'utilidad_neta',
      porcentaje: 35,
      minimo_exento: 0,
      notas: 'Se aplica sobre la utilidad neta del período (ingresos bancarios del período menos gastos ' +
        'deducibles; ya NO es ganancia de ventas menos gastos). Tipo general de referencia ~35%.',
    },
    {
      clave: 'seguridad_social',
      nombre: 'Contribución a la Seguridad Social',
      base: 'nomina',
      porcentaje: 12.5,
      minimo_exento: 0,
      notas: 'Se aplica sobre la nómina del período. Requiere que los salarios se registren como gasto con categoría de nómina/salario; si no se registra, esta base sale en 0.',
    },
    {
      clave: 'ventas_servicios',
      nombre: 'Impuesto sobre Ventas y Servicios',
      base: 'ventas_brutas',
      porcentaje: 10,
      minimo_exento: 0,
      notas: 'Se aplica sobre los ingresos bancarios del período (entradas de dinero en las cuentas ' +
        'bancarias, antes de descontar gastos). Ya NO se calcula sobre las ventas ni el movimiento de almacén.',
    },
    {
      clave: 'territorial',
      nombre: 'Contribución Territorial para el Desarrollo Local',
      base: 'ventas_brutas',
      porcentaje: 1,
      minimo_exento: 0,
      notas: 'Contribución local de referencia ~1% sobre los ingresos bancarios del período (entradas de dinero en las cuentas bancarias).',
    },
    // Para añadir un tributo nuevo: agregar aquí un objeto más con la
    // misma forma. El motor lo recoge automáticamente.
  ];
}

export const REGIMENES = {
  microempresa: {
    nombre: 'Microempresa',
    notas: 'Hasta 10 trabajadores (referencia). Puede tener tratamiento simplificado según resolución vigente: confirmar con la ONAT.',
    tributos: tributosBase(),
  },
  pequena_empresa: {
    nombre: 'Pequeña empresa',
    notas: 'De 11 a 35 trabajadores (referencia).',
    tributos: tributosBase(),
  },
  mediana_empresa: {
    nombre: 'Mediana empresa',
    notas: 'De 36 a 100 trabajadores (referencia).',
    tributos: tributosBase(),
  },
};

// ------------------------------------------------------------
//  Régimen "Otro": el usuario define a mano sus propios tributos
//  (nombre + base + porcentaje, y puede añadir los que quiera). Se
//  guarda como JSON en `parametros` bajo CLAVE_REGIMEN_OTRO y esta
//  función lo convierte en un régimen con la MISMA forma que los de
//  arriba, para que `calcularTributosConRegimen` no tenga que saber
//  nada especial de él. Si todavía no se ha configurado nada, el
//  régimen sale con una lista de tributos vacía (0 a tributar), nunca
//  con datos inventados.
// ------------------------------------------------------------
export function regimenOtroDesdeParametros(mapaParametros = {}) {
  const crudo = mapaParametros[CLAVE_REGIMEN_OTRO];
  let tributos = [];
  if (crudo) {
    try {
      const datos = JSON.parse(crudo);
      if (Array.isArray(datos?.tributos)) {
        tributos = datos.tributos
          .filter((t) => t && t.clave && BASES_VALIDAS.includes(t.base))
          .map((t) => ({
            clave: String(t.clave),
            nombre: String(t.nombre || t.clave),
            base: t.base,
            porcentaje: Number.isFinite(Number(t.porcentaje)) ? Number(t.porcentaje) : 0,
            minimo_exento: Number.isFinite(Number(t.minimo_exento)) ? Number(t.minimo_exento) : 0,
            notas: t.notas || '',
          }));
      }
    } catch {
      // JSON corrupto (no debería pasar, se valida al guardar): régimen
      // vacío en vez de tumbar la pantalla de tributación.
    }
  }
  return {
    nombre: 'Otro (definido a mano)',
    notas: 'Régimen configurado manualmente por el usuario: porcentajes y tributos propios. No es un cálculo automático de la ONAT.',
    tributos,
  };
}

// ------------------------------------------------------------
//  Combina los regímenes de arriba con lo que el dueño haya
//  corregido a mano en la tabla `parametros`. `mapaParametros` es un
//  objeto simple { clave: valor_texto } ya leído de esa tabla.
// ------------------------------------------------------------
export function combinarConParametros(mapaParametros = {}) {
  const resultado = {};
  for (const regimenClave of Object.keys(REGIMENES)) {
    const regimen = REGIMENES[regimenClave];
    resultado[regimenClave] = {
      ...regimen,
      tributos: regimen.tributos.map((t) => {
        const claveParam = `trib.${regimenClave}.${t.clave}.porcentaje`;
        const valorGuardado = mapaParametros[claveParam];
        const porcentaje =
          valorGuardado !== undefined && valorGuardado !== null && valorGuardado !== ''
            ? Number(valorGuardado)
            : t.porcentaje;
        return {
          ...t,
          porcentaje: Number.isFinite(porcentaje) ? porcentaje : t.porcentaje,
          sobrescrito: valorGuardado !== undefined && valorGuardado !== null && valorGuardado !== '',
        };
      }),
    };
  }
  // El régimen "Otro" no se combina con overrides de porcentaje (él ES
  // la definición completa que el usuario guardó); se añade tal cual.
  resultado.otro = regimenOtroDesdeParametros(mapaParametros);
  return resultado;
}

// ------------------------------------------------------------
//  El motor: recorre los tributos de un régimen (ya combinado con los
//  parámetros guardados por el dueño) y calcula el importe de cada
//  uno sobre las bases reales del período. No sabe nada de
//  "utilidades" ni "seguridad social" en concreto: solo mira `base`.
//  Añadir un tributo nuevo = añadir un objeto en `tributosBase()`;
//  esta función no cambia.
// ------------------------------------------------------------
export function calcularTributosConRegimen(regimen, bases) {
  const tributos = regimen.tributos.map((t) => {
    const baseValor = Number(bases[t.base] ?? 0);
    const baseGravable = Math.max(0, baseValor); // no se tributa sobre bases negativas (pérdida)
    const exento = baseGravable <= Number(t.minimo_exento || 0);
    const importe = exento ? 0 : Number((baseGravable * (t.porcentaje / 100)).toFixed(2));
    return {
      clave: t.clave,
      nombre: t.nombre,
      base: t.base,
      base_valor: Number(baseGravable.toFixed(2)),
      porcentaje: t.porcentaje,
      importe,
      sobrescrito: !!t.sobrescrito,
    };
  });
  const total = Number(tributos.reduce((s, t) => s + t.importe, 0).toFixed(2));
  return { tributos, total_tributos: total };
}
