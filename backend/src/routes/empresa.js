// ============================================================
//  Configuración fiscal de la empresa (§4)
//
//  Fila única (id=1), mismo patrón que config_negocio (ver
//  routes/config.js): se crea vacía la primera vez que se pide y
//  desde entonces siempre existe. Todo es editable después: esto
//  no es un formulario que se rellena una vez y se olvida, es la
//  ficha oficial del negocio que alimenta facturas y reportes.
//
//  El montaje en server.js ya trae requiereSesion (lectura libre
//  para cualquier sesión) y escrituraSoloRoles() (solo escriben
//  dueño/admin/proveedor) — aquí no hace falta repetirlo.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { auditar } from '../auditoria.js';

const router = Router();

// Columnas de la fila única, en el orden en que se guardan y leen.
const COLUMNAS = [
  'nombre_fiscal', 'razon_social', 'nit', 'direccion', 'provincia',
  'municipio', 'telefono', 'correo', 'moneda_principal',
  'monedas_secundarias', 'regimen_tributario', 'datos_facturacion', 'datos_reportes',
];

// Campos que viajan como JSON dentro de una columna TEXT.
const CAMPOS_JSON = ['monedas_secundarias', 'datos_facturacion', 'datos_reportes'];

// Crea la fila 1 si todavía no existe. Idempotente: se puede llamar
// en cada GET sin peligro (ON CONFLICT no hace nada si ya está).
async function asegurarFila() {
  await db.prepare(`
    INSERT INTO empresa_fiscal (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `).run();
}

// Convierte las columnas TEXT que guardan JSON a su forma real
// (array/objeto) para que el frontend no tenga que parsear nada.
// Si el contenido está corrupto o vacío, se devuelve un valor por
// defecto en vez de romper la respuesta.
function formatearSalida(fila) {
  if (!fila) return null;
  const salida = { ...fila };
  for (const campo of CAMPOS_JSON) {
    const crudo = salida[campo];
    if (crudo == null || crudo === '') {
      salida[campo] = campo === 'monedas_secundarias' ? [] : {};
      continue;
    }
    try {
      salida[campo] = JSON.parse(crudo);
    } catch {
      // Contenido corrupto de antes (no debería pasar, pero por si acaso):
      // no tumbamos la pantalla, devolvemos vacío.
      salida[campo] = campo === 'monedas_secundarias' ? [] : {};
    }
  }
  return salida;
}

const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// NIT cubano: letras, dígitos, espacios y guiones. Sin ser tiquismiquis
// (no es un formulario de banco), solo se rechaza si trae algo raro.
const RE_NIT = /^[A-Za-z0-9\-\s]*$/;

function validar({ correo, nit }) {
  if (correo && correo.trim() && !RE_CORREO.test(correo.trim())) {
    return 'El correo no tiene un formato válido.';
  }
  if (nit && nit.trim() && !RE_NIT.test(nit.trim())) {
    return 'El NIT solo puede tener letras, números, espacios y guiones.';
  }
  return null;
}

// GET: libre para cualquier sesión (lo necesita también la
// pantalla de facturación aunque el usuario no sea el dueño).
router.get('/', async (req, res) => {
  await asegurarFila();
  const fila = await db.prepare('SELECT * FROM empresa_fiscal WHERE id = 1').get();
  res.json(formatearSalida(fila));
});

// PUT: solo dueño/admin/proveedor (lo filtra escrituraSoloRoles() en server.js).
router.put('/', async (req, res) => {
  await asegurarFila();
  const antes = await db.prepare('SELECT * FROM empresa_fiscal WHERE id = 1').get();

  const b = req.body || {};
  const error = validar(b);
  if (error) return res.status(400).json({ error });

  const valores = {
    nombre_fiscal: (b.nombre_fiscal ?? '').toString().trim() || null,
    razon_social: (b.razon_social ?? '').toString().trim() || null,
    nit: (b.nit ?? '').toString().trim() || null,
    direccion: (b.direccion ?? '').toString().trim() || null,
    provincia: (b.provincia ?? '').toString().trim() || null,
    municipio: (b.municipio ?? '').toString().trim() || null,
    telefono: (b.telefono ?? '').toString().trim() || null,
    correo: (b.correo ?? '').toString().trim() || null,
    moneda_principal: (b.moneda_principal ?? 'CUP').toString().trim() || 'CUP',
    monedas_secundarias: JSON.stringify(Array.isArray(b.monedas_secundarias) ? b.monedas_secundarias : []),
    regimen_tributario: (b.regimen_tributario ?? '').toString().trim() || null,
    datos_facturacion: JSON.stringify(b.datos_facturacion && typeof b.datos_facturacion === 'object' ? b.datos_facturacion : {}),
    datos_reportes: JSON.stringify(b.datos_reportes && typeof b.datos_reportes === 'object' ? b.datos_reportes : {}),
  };

  await db.prepare(`
    UPDATE empresa_fiscal SET
      nombre_fiscal = ?, razon_social = ?, nit = ?, direccion = ?, provincia = ?,
      municipio = ?, telefono = ?, correo = ?, moneda_principal = ?,
      monedas_secundarias = ?, regimen_tributario = ?, datos_facturacion = ?,
      datos_reportes = ?, actualizado_en = NOW()
    WHERE id = 1
  `).run(...COLUMNAS.map((c) => valores[c]));

  const despues = await db.prepare('SELECT * FROM empresa_fiscal WHERE id = 1').get();

  await auditar({
    modulo: 'empresa',
    accion: 'modificar',
    req,
    entidad: 'empresa_fiscal',
    entidad_id: 1,
    descripcion: 'Actualización de los datos fiscales de la empresa',
    antes: formatearSalida(antes),
    despues: formatearSalida(despues),
  });

  res.json(formatearSalida(despues));
});

export default router;
