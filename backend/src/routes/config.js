// ============================================================
//  Configuración del negocio
//
//  Lo que hace estándar al sistema: cada MIPYME guarda aquí su
//  propio nombre y datos. El nombre aparece en la cabecera, el
//  login y los documentos que se imprimen.
//
//  Leer la configuración es público (la pantalla de login la
//  necesita antes de entrar). Cambiarla es solo del dueño.
// ============================================================

import { Router } from 'express';
import db from '../db/index.js';
import { requiereSesion, soloDueno } from '../middleware/auth.js';

const router = Router();

// GET público: el nombre del negocio para mostrarlo en login, etc.
router.get('/', async (req, res) => {
  const c = await db.prepare('SELECT nombre, tipo_negocio, moneda, configurado FROM config_negocio WHERE id = 1').get();
  res.json(c || { nombre: 'Mi Negocio', tipo_negocio: '', moneda: 'CUP', configurado: 0 });
});

// PUT solo dueño: cambiar los datos del negocio.
router.put('/', requiereSesion, soloDueno, async (req, res) => {
  const { nombre, tipo_negocio, moneda } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre del negocio no puede estar vacío.' });
  }
  await db.prepare(`
    UPDATE config_negocio
       SET nombre = ?, tipo_negocio = ?, moneda = ?, configurado = 1
     WHERE id = 1
  `).run(nombre.trim(), (tipo_negocio || '').trim(), (moneda || 'CUP').trim());
  const c = await db.prepare('SELECT nombre, tipo_negocio, moneda, configurado FROM config_negocio WHERE id = 1').get();
  res.json(c);
});

export default router;
