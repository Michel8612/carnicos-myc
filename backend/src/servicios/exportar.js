// ============================================================
//  EXPORTACIÓN DE INFORMES — Excel y CSV
//
//  Un solo sitio para convertir filas en archivos. Cada informe
//  (estado de resultados, cuentas por cobrar, presupuestos...) solo
//  tiene que decir QUÉ columnas tiene y aquí se decide CÓMO se
//  escriben. Si mañana cambia el formato, cambia una vez.
//
//  Sobre el PDF: no se genera en el servidor. Montar un motor de PDF
//  dentro de una función serverless engorda el paquete y alarga el
//  arranque en frío, que con la conexión de Cuba ya duele. En su
//  lugar, cada informe tiene una vista preparada para imprimir y el
//  propio navegador la guarda como PDF (Ctrl+P → Guardar como PDF),
//  respetando además el tamaño de papel de quien imprime.
// ============================================================

import ExcelJS from 'exceljs';

/**
 * Escapa un valor para CSV.
 * Las comas y los saltos de línea dentro de un campo rompen el archivo
 * si no se entrecomilla, y las comillas hay que duplicarlas.
 */
function celdaCsv(valor) {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor);
  return /[",\n;]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/**
 * Convierte filas en CSV.
 *
 * Lleva BOM al principio y separador `;`: es lo que hace que Excel en
 * español abra el archivo con los acentos correctos y las columnas ya
 * separadas al hacer doble clic. Sin el BOM, "Producción" se ve como
 * "ProducciÃ³n"; con coma, todo queda en una sola columna.
 */
export function aCsv(columnas, filas) {
  const cabecera = columnas.map((c) => celdaCsv(c.titulo)).join(';');
  const cuerpo = filas.map((fila) =>
    columnas.map((c) => celdaCsv(fila[c.clave])).join(';'),
  );
  return '﻿' + [cabecera, ...cuerpo].join('\r\n');
}

/**
 * Genera un .xlsx de verdad con una o varias hojas.
 *
 * `hojas` = [{ nombre, columnas: [{clave, titulo, ancho}], filas: [] }]
 */
export async function aXlsx(hojas) {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Cárnicos M&C';
  libro.created = new Date();

  for (const hoja of hojas) {
    // Excel no admite más de 31 caracteres ni : \ / ? * [ ] en el nombre.
    const nombre = String(hoja.nombre || 'Hoja').replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
    const ws = libro.addWorksheet(nombre);

    ws.columns = hoja.columnas.map((c) => ({
      header: c.titulo,
      key: c.clave,
      width: c.ancho ?? Math.max(12, String(c.titulo).length + 4),
    }));

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle' };

    for (const fila of hoja.filas) ws.addRow(fila);

    // Fila de cabecera siempre a la vista al desplazarse: en un informe
    // de cien líneas, sin esto se pierde de qué columna es cada número.
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  return libro.xlsx.writeBuffer();
}

/** Nombre de archivo seguro y con fecha, para no pisar descargas anteriores. */
export function nombreArchivo(base, extension) {
  const fecha = new Date().toISOString().slice(0, 10);
  const limpio = String(base)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${limpio}-${fecha}.${extension}`;
}

/** Responde con un CSV descargable. */
export function enviarCsv(res, base, columnas, filas) {
  const archivo = nombreArchivo(base, 'csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
  res.send(aCsv(columnas, filas));
}

/** Responde con un Excel descargable (una o varias hojas). */
export async function enviarXlsx(res, base, hojas) {
  const archivo = nombreArchivo(base, 'xlsx');
  const buffer = await aXlsx(hojas);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
  res.send(Buffer.from(buffer));
}

/**
 * Punto único para servir un informe en el formato que pida la URL
 * (`?formato=csv|xlsx`). Devuelve `true` si ya respondió, de modo que
 * la ruta pueda seguir con su respuesta JSON normal si no se pidió
 * ninguna descarga.
 */
export async function servirDescarga(req, res, { base, columnas, filas, hojas }) {
  const formato = String(req.query.formato || '').toLowerCase();

  if (formato === 'csv') {
    enviarCsv(res, base, columnas, filas);
    return true;
  }

  if (formato === 'xlsx' || formato === 'excel') {
    await enviarXlsx(res, base, hojas ?? [{ nombre: base, columnas, filas }]);
    return true;
  }

  return false;
}
