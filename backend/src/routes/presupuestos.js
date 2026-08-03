// ============================================================
//  Presupuestos: previsto vs. real (§10)
//
//  El montaje en server.js ya trae requiereSesion (lectura libre
//  para cualquier sesión) y escrituraSoloRoles('contabilidad')
//  (escriben dueño/admin/proveedor + contabilidad) — aquí no hace
//  falta repetirlo.
//
//  Cómo se arma el REAL de una línea (el corazón del módulo, en
//  /:id/comparativo):
//   - Línea de GASTO: se suma `gastos.monto` de la categoría de la
//     línea, con `fecha` dentro del período del presupuesto (el día
//     final se incluye completo, no solo su medianoche).
//   - Línea de INGRESO: el libro (`contabilidad_registros`) no tiene
//     una columna "categoría" como los gastos, así que la categoría
//     de la línea tiene que decir a qué corte del libro corresponde:
//     si es uno de los TIPOS del libro (venta/almacen/produccion) se
//     suma `ingreso` filtrando por `tipo`; si no, pero es una de las
//     ÁREAS del negocio (ventas/almacen/cocina) se filtra por `area`.
//     Se mira primero por TIPO y después por ÁREA —en ese orden—
//     porque "almacen" existe igual en las dos listas con sentidos
//     distintos (tipo de hecho económico vs. área física) y hay que
//     decidir sin ambigüedad cuál gana. Si la categoría no coincide
//     con nada de eso, el real es 0 y la línea se marca
//     `sin_correspondencia: true` para que la pantalla avise por qué
//     salió en cero (si no, parece un error del sistema y no lo es).
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';
import { servirDescarga } from '../servicios/exportar.js';

const router = Router();

const TIPOS_LINEA = ['ingreso', 'gasto'];

// Ver comentario de cabecera: el orden de estas dos listas importa.
const TIPOS_LIBRO = ['venta', 'almacen', 'produccion'];
const AREAS_LIBRO = ['ventas', 'almacen', 'cocina'];

function limpiar(v) {
  const s = (v ?? '').toString().trim();
  return s || null;
}

// Dos decimales siempre: NUMERIC/DOUBLE llegan con cola de flotante
// (12.339999999) y eso en pantalla se ve como un fallo del sistema.
function redondear(x) {
  return Number((Number(x) || 0).toFixed(2));
}

// % de desviación sobre lo previsto. Si lo previsto es 0, dividir da
// Infinity (o NaN si además la desviación es 0): ninguno de los dos
// sirve para mostrar ni para exportar, así que se devuelve null y la
// pantalla decide cómo pintarlo ("—", "sin base de comparación"...).
function porcentaje(desviacion, previsto) {
  if (!previsto) return null;
  return redondear((desviacion / previsto) * 100);
}

// periodo_inicio/periodo_fin son DATE; según cómo los devuelva el
// driver (objeto Date o texto) esto los deja siempre en 'YYYY-MM-DD',
// que es lo único que hace falta para comparar y para construir la
// fecha límite del período.
function comoFecha(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function validarLinea(b) {
  const tipo = limpiar(b.tipo);
  if (!TIPOS_LINEA.includes(tipo)) {
    return { error: 'El tipo de línea debe ser "ingreso" o "gasto".' };
  }
  const categoria = limpiar(b.categoria);
  if (!categoria) return { error: 'La categoría es obligatoria.' };
  const previsto = Number(b.previsto);
  if (!Number.isFinite(previsto) || previsto < 0) {
    return { error: 'El previsto debe ser un número mayor o igual que cero.' };
  }
  return { tipo, categoria, previsto };
}

function formatearLinea(l) {
  return { ...l, previsto: redondear(l.previsto) };
}

// ------------------------------------------------------------
//  Presupuestos (cabecera)
// ------------------------------------------------------------

router.get('/', async (req, res) => {
  const filas = await db.prepare(`
    SELECT p.*,
           COUNT(l.id) AS lineas,
           COALESCE(SUM(CASE WHEN l.tipo = 'ingreso' THEN l.previsto ELSE 0 END), 0) AS previsto_ingresos,
           COALESCE(SUM(CASE WHEN l.tipo = 'gasto'   THEN l.previsto ELSE 0 END), 0) AS previsto_gastos
      FROM presupuestos p
      LEFT JOIN presupuesto_lineas l ON l.presupuesto_id = p.id
     GROUP BY p.id
     ORDER BY p.creado_en DESC, p.id DESC
  `).all();

  res.json(filas.map((f) => {
    const previstoIngresos = redondear(f.previsto_ingresos);
    const previstoGastos = redondear(f.previsto_gastos);
    return {
      ...f,
      lineas: Number(f.lineas),
      previsto_ingresos: previstoIngresos,
      previsto_gastos: previstoGastos,
      resultado_previsto: redondear(previstoIngresos - previstoGastos),
    };
  }));
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const presupuesto = await db.prepare('SELECT * FROM presupuestos WHERE id = ?').get(id);
  if (!presupuesto) return res.status(404).json({ error: 'Presupuesto no encontrado.' });

  // El JOIN solo trae etiqueta cuando la línea es de gasto: una línea
  // de ingreso no tiene categoría de gasto que traducir.
  const lineas = await db.prepare(`
    SELECT l.*, cg.etiqueta AS categoria_etiqueta
      FROM presupuesto_lineas l
      LEFT JOIN categorias_gasto cg ON cg.clave = l.categoria AND l.tipo = 'gasto'
     WHERE l.presupuesto_id = ?
     ORDER BY l.tipo ASC, l.categoria ASC
  `).all(id);

  res.json({ ...presupuesto, lineas: lineas.map(formatearLinea) });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const nombre = limpiar(b.nombre);
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });

  const periodoInicio = limpiar(b.periodo_inicio);
  const periodoFin = limpiar(b.periodo_fin);
  if (!periodoInicio || !periodoFin) {
    return res.status(400).json({ error: 'Las dos fechas del período son obligatorias.' });
  }
  if (periodoFin < periodoInicio) {
    return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la de inicio.' });
  }
  const nota = limpiar(b.nota);

  // Se validan TODAS las líneas antes de tocar la base: si una viene
  // mal, mejor no crear el presupuesto a medias.
  const lineasEntrada = Array.isArray(b.lineas) ? b.lineas : [];
  const lineasValidas = [];
  const vistas = new Set();
  for (const l of lineasEntrada) {
    const v = validarLinea(l);
    if (v.error) return res.status(400).json({ error: v.error });
    const clave = `${v.tipo}:${v.categoria}`;
    if (vistas.has(clave)) {
      return res.status(400).json({
        error: `La línea de ${v.tipo} "${v.categoria}" está repetida: dos líneas iguales contarían el real dos veces en el comparativo.`,
      });
    }
    vistas.add(clave);
    lineasValidas.push(v);
  }

  const presupuestoId = await db.transaction(async () => {
    const r = await db.prepare(`
      INSERT INTO presupuestos (nombre, periodo_inicio, periodo_fin, nota, usuario_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(nombre, periodoInicio, periodoFin, nota, req.usuario?.id ?? null);

    for (const l of lineasValidas) {
      await db.prepare(`
        INSERT INTO presupuesto_lineas (presupuesto_id, tipo, categoria, previsto)
        VALUES (?, ?, ?, ?)
      `).run(r.lastInsertRowid, l.tipo, l.categoria, l.previsto);
    }

    return r.lastInsertRowid;
  })();

  const presupuesto = await db.prepare('SELECT * FROM presupuestos WHERE id = ?').get(presupuestoId);
  const lineas = await db.prepare(
    'SELECT * FROM presupuesto_lineas WHERE presupuesto_id = ? ORDER BY tipo, categoria',
  ).all(presupuestoId);

  await auditar({
    modulo: 'contabilidad', accion: 'crear', req, entidad: 'presupuestos', entidad_id: presupuestoId,
    descripcion: `Alta de presupuesto "${nombre}" (${periodoInicio} a ${periodoFin})`,
    despues: { ...presupuesto, lineas },
  });

  res.json({ ...presupuesto, lineas: lineas.map(formatearLinea) });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const antes = await db.prepare('SELECT * FROM presupuestos WHERE id = ?').get(id);
  if (!antes) return res.status(404).json({ error: 'Presupuesto no encontrado.' });

  const b = req.body || {};
  const nombre = limpiar(b.nombre) || antes.nombre;
  const periodoInicio = limpiar(b.periodo_inicio) || comoFecha(antes.periodo_inicio);
  const periodoFin = limpiar(b.periodo_fin) || comoFecha(antes.periodo_fin);
  if (periodoFin < periodoInicio) {
    return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la de inicio.' });
  }
  const nota = 'nota' in b ? limpiar(b.nota) : antes.nota;

  await db.prepare(`
    UPDATE presupuestos SET nombre = ?, periodo_inicio = ?, periodo_fin = ?, nota = ? WHERE id = ?
  `).run(nombre, periodoInicio, periodoFin, nota, id);

  const despues = await db.prepare('SELECT * FROM presupuestos WHERE id = ?').get(id);

  await auditar({
    modulo: 'contabilidad', accion: 'modificar', req, entidad: 'presupuestos', entidad_id: id,
    descripcion: `Cambio en presupuesto "${nombre}"`,
    antes, despues,
  });

  res.json(despues);
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const presupuesto = await db.prepare('SELECT * FROM presupuestos WHERE id = ?').get(id);
  if (!presupuesto) return res.status(404).json({ error: 'Presupuesto no encontrado.' });

  // La llave foránea (ON DELETE CASCADE) se lleva las líneas por
  // delante al borrar la cabecera. Si no las guardamos aquí en
  // "antes", el borrado queda sin forma de reconstruirse desde la
  // auditoría: se perdería para siempre qué previsto tenía cada línea.
  const lineas = await db.prepare('SELECT * FROM presupuesto_lineas WHERE presupuesto_id = ?').all(id);

  await db.prepare('DELETE FROM presupuestos WHERE id = ?').run(id);

  await auditar({
    modulo: 'contabilidad', accion: 'eliminar', req, entidad: 'presupuestos', entidad_id: id,
    descripcion: `Baja de presupuesto "${presupuesto.nombre}" (con ${lineas.length} línea(s))`,
    antes: { ...presupuesto, lineas },
  });

  res.json({ borrado: true });
});

// ------------------------------------------------------------
//  Líneas
// ------------------------------------------------------------

router.post('/:id/lineas', async (req, res) => {
  const id = Number(req.params.id);
  const presupuesto = await db.prepare('SELECT id, nombre FROM presupuestos WHERE id = ?').get(id);
  if (!presupuesto) return res.status(404).json({ error: 'Presupuesto no encontrado.' });

  const v = validarLinea(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // Dos líneas con el mismo tipo+categoría harían que el comparativo
  // sumara el mismo real dos veces (una vez por cada línea).
  const repetida = await db.prepare(`
    SELECT id FROM presupuesto_lineas WHERE presupuesto_id = ? AND tipo = ? AND categoria = ?
  `).get(id, v.tipo, v.categoria);
  if (repetida) {
    return res.status(400).json({
      error: `Ya hay una línea de ${v.tipo} para "${v.categoria}" en este presupuesto.`,
    });
  }

  const r = await db.prepare(`
    INSERT INTO presupuesto_lineas (presupuesto_id, tipo, categoria, previsto) VALUES (?, ?, ?, ?)
  `).run(id, v.tipo, v.categoria, v.previsto);

  const linea = await db.prepare('SELECT * FROM presupuesto_lineas WHERE id = ?').get(r.lastInsertRowid);

  await auditar({
    modulo: 'contabilidad', accion: 'crear', req, entidad: 'presupuesto_lineas', entidad_id: r.lastInsertRowid,
    descripcion: `Línea de ${v.tipo} "${v.categoria}" añadida a "${presupuesto.nombre}"`,
    despues: linea,
  });

  res.json(formatearLinea(linea));
});

router.put('/lineas/:id', async (req, res) => {
  const id = Number(req.params.id);
  const antes = await db.prepare('SELECT * FROM presupuesto_lineas WHERE id = ?').get(id);
  if (!antes) return res.status(404).json({ error: 'Línea no encontrada.' });

  const b = req.body || {};
  const tipo = 'tipo' in b ? limpiar(b.tipo) : antes.tipo;
  if (!TIPOS_LINEA.includes(tipo)) {
    return res.status(400).json({ error: 'El tipo de línea debe ser "ingreso" o "gasto".' });
  }
  const categoria = 'categoria' in b ? limpiar(b.categoria) : antes.categoria;
  if (!categoria) return res.status(400).json({ error: 'La categoría es obligatoria.' });
  const previsto = 'previsto' in b ? Number(b.previsto) : antes.previsto;
  if (!Number.isFinite(previsto) || previsto < 0) {
    return res.status(400).json({ error: 'El previsto debe ser un número mayor o igual que cero.' });
  }

  if (tipo !== antes.tipo || categoria !== antes.categoria) {
    const repetida = await db.prepare(`
      SELECT id FROM presupuesto_lineas WHERE presupuesto_id = ? AND tipo = ? AND categoria = ? AND id <> ?
    `).get(antes.presupuesto_id, tipo, categoria, id);
    if (repetida) {
      return res.status(400).json({
        error: `Ya hay una línea de ${tipo} para "${categoria}" en este presupuesto.`,
      });
    }
  }

  await db.prepare(`
    UPDATE presupuesto_lineas SET tipo = ?, categoria = ?, previsto = ? WHERE id = ?
  `).run(tipo, categoria, previsto, id);

  const despues = await db.prepare('SELECT * FROM presupuesto_lineas WHERE id = ?').get(id);

  await auditar({
    modulo: 'contabilidad', accion: 'modificar', req, entidad: 'presupuesto_lineas', entidad_id: id,
    descripcion: `Cambio en línea de presupuesto (${despues.tipo} "${despues.categoria}")`,
    antes, despues,
  });

  res.json(formatearLinea(despues));
});

router.delete('/lineas/:id', async (req, res) => {
  const id = Number(req.params.id);
  const linea = await db.prepare('SELECT * FROM presupuesto_lineas WHERE id = ?').get(id);
  if (!linea) return res.status(404).json({ error: 'Línea no encontrada.' });

  await db.prepare('DELETE FROM presupuesto_lineas WHERE id = ?').run(id);

  await auditar({
    modulo: 'contabilidad', accion: 'eliminar', req, entidad: 'presupuesto_lineas', entidad_id: id,
    descripcion: `Línea de ${linea.tipo} "${linea.categoria}" borrada`,
    antes: linea,
  });

  res.json({ borrado: true });
});

// ------------------------------------------------------------
//  Comparativo: previsto vs. real
// ------------------------------------------------------------

// Calcula el real de UNA línea. Ver el comentario de cabecera del
// archivo para la explicación completa de la regla.
async function calcularReal(linea, periodoInicio, hastaCompleto) {
  if (linea.tipo === 'gasto') {
    const { total } = await db.prepare(`
      SELECT COALESCE(SUM(monto), 0) AS total
        FROM gastos
       WHERE categoria = ? AND fecha >= ? AND fecha <= ?
    `).get(linea.categoria, periodoInicio, hastaCompleto);
    return { real: Number(total) || 0, sinCorrespondencia: false };
  }

  if (TIPOS_LIBRO.includes(linea.categoria)) {
    const { total } = await db.prepare(`
      SELECT COALESCE(SUM(ingreso), 0) AS total
        FROM contabilidad_registros
       WHERE tipo = ? AND fecha >= ? AND fecha <= ?
    `).get(linea.categoria, periodoInicio, hastaCompleto);
    return { real: Number(total) || 0, sinCorrespondencia: false };
  }

  if (AREAS_LIBRO.includes(linea.categoria)) {
    const { total } = await db.prepare(`
      SELECT COALESCE(SUM(ingreso), 0) AS total
        FROM contabilidad_registros
       WHERE area = ? AND fecha >= ? AND fecha <= ?
    `).get(linea.categoria, periodoInicio, hastaCompleto);
    return { real: Number(total) || 0, sinCorrespondencia: false };
  }

  return { real: 0, sinCorrespondencia: true };
}

router.get('/:id/comparativo', async (req, res) => {
  const id = Number(req.params.id);
  const presupuesto = await db.prepare('SELECT * FROM presupuestos WHERE id = ?').get(id);
  if (!presupuesto) return res.status(404).json({ error: 'Presupuesto no encontrado.' });

  const periodoInicio = comoFecha(presupuesto.periodo_inicio);
  const periodoFin = comoFecha(presupuesto.periodo_fin);
  // El día final se cuenta completo: sin esto, un gasto anotado a las
  // 20:00 del último día quedaría fuera del comparativo.
  const hastaCompleto = `${periodoFin} 23:59:59`;

  const lineas = await db.prepare(`
    SELECT l.*, cg.etiqueta AS categoria_etiqueta
      FROM presupuesto_lineas l
      LEFT JOIN categorias_gasto cg ON cg.clave = l.categoria AND l.tipo = 'gasto'
     WHERE l.presupuesto_id = ?
     ORDER BY l.tipo ASC, l.categoria ASC
  `).all(id);

  const filasComparativo = [];
  for (const linea of lineas) {
    const { real, sinCorrespondencia } = await calcularReal(linea, periodoInicio, hastaCompleto);
    const previsto = redondear(linea.previsto);
    const realRedondeado = redondear(real);
    const desviacion = redondear(realRedondeado - previsto);
    filasComparativo.push({
      id: linea.id,
      tipo: linea.tipo,
      categoria: linea.categoria,
      categoria_etiqueta: linea.categoria_etiqueta || linea.categoria,
      previsto,
      real: realRedondeado,
      desviacion,
      desviacion_pct: porcentaje(desviacion, previsto),
      sin_correspondencia: sinCorrespondencia,
    });
  }

  const sumar = (tipo, campo) => redondear(
    filasComparativo.filter((f) => f.tipo === tipo).reduce((acc, f) => acc + f[campo], 0),
  );

  const previstoIngresos = sumar('ingreso', 'previsto');
  const realIngresos = sumar('ingreso', 'real');
  const previstoGastos = sumar('gasto', 'previsto');
  const realGastos = sumar('gasto', 'real');
  const resultadoPrevisto = redondear(previstoIngresos - previstoGastos);
  const resultadoReal = redondear(realIngresos - realGastos);
  const desviacionIngresos = redondear(realIngresos - previstoIngresos);
  const desviacionGastos = redondear(realGastos - previstoGastos);
  const desviacionResultado = redondear(resultadoReal - resultadoPrevisto);

  const totales = {
    previsto_ingresos: previstoIngresos,
    real_ingresos: realIngresos,
    desviacion_ingresos: desviacionIngresos,
    desviacion_ingresos_pct: porcentaje(desviacionIngresos, previstoIngresos),
    previsto_gastos: previstoGastos,
    real_gastos: realGastos,
    desviacion_gastos: desviacionGastos,
    desviacion_gastos_pct: porcentaje(desviacionGastos, previstoGastos),
    resultado_previsto: resultadoPrevisto,
    resultado_real: resultadoReal,
    desviacion_resultado: desviacionResultado,
    desviacion_resultado_pct: porcentaje(desviacionResultado, resultadoPrevisto),
  };

  // Filas planas para exportar: las líneas y, debajo, los totales.
  const columnas = [
    { clave: 'tipo', titulo: 'Tipo' },
    { clave: 'categoria', titulo: 'Categoría' },
    { clave: 'previsto', titulo: 'Previsto' },
    { clave: 'real', titulo: 'Real' },
    { clave: 'desviacion', titulo: 'Desviación' },
    { clave: 'desviacion_pct', titulo: 'Desviación %' },
  ];
  const filas = [
    ...filasComparativo.map((f) => ({
      tipo: f.tipo === 'ingreso' ? 'Ingreso' : 'Gasto',
      categoria: f.categoria_etiqueta + (f.sin_correspondencia ? ' (sin datos)' : ''),
      previsto: f.previsto,
      real: f.real,
      desviacion: f.desviacion,
      desviacion_pct: f.desviacion_pct,
    })),
    { tipo: 'TOTAL', categoria: 'Ingresos', previsto: previstoIngresos, real: realIngresos, desviacion: desviacionIngresos, desviacion_pct: totales.desviacion_ingresos_pct },
    { tipo: 'TOTAL', categoria: 'Gastos', previsto: previstoGastos, real: realGastos, desviacion: desviacionGastos, desviacion_pct: totales.desviacion_gastos_pct },
    { tipo: 'TOTAL', categoria: 'Resultado (ingresos - gastos)', previsto: resultadoPrevisto, real: resultadoReal, desviacion: desviacionResultado, desviacion_pct: totales.desviacion_resultado_pct },
  ];

  const formato = String(req.query.formato || '').toLowerCase();
  if (formato === 'csv' || formato === 'xlsx' || formato === 'excel') {
    // Constancia de la exportación ANTES de generar el archivo: si algo
    // falla al construirlo, igual queda el rastro de quién lo pidió.
    await auditar({
      modulo: 'contabilidad', accion: 'exportar', req, entidad: 'presupuestos', entidad_id: id,
      descripcion: `Exportación (${formato}) del comparativo de "${presupuesto.nombre}"`,
    });
  }
  if (await servirDescarga(req, res, { base: 'comparativo-presupuesto', columnas, filas })) return;

  res.json({
    presupuesto: {
      id: presupuesto.id,
      nombre: presupuesto.nombre,
      periodo_inicio: periodoInicio,
      periodo_fin: periodoFin,
      nota: presupuesto.nota,
    },
    lineas: filasComparativo,
    totales,
  });
});

export default router;
