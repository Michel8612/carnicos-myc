// ============================================================
//  Rutas de Tasa de Cambio (USD/CUP)
//
//  Capa fina sobre servicios/tasas.js: aquí NO vive lógica de
//  consulta a elTOQUE, solo el mapeo HTTP. Ver ese archivo para
//  entender caché, respaldo y manejo de fallos.
//
//  Montada en server.js como:
//    app.use('/api/tasas', requiereSesion, escrituraSoloRoles(), tasasRoutes);
//  Es decir: GET libre para cualquiera con sesión; PUT/POST solo
//  dueño/admin (ya lo garantiza ese middleware antes de llegar aquí).
// ============================================================

import { Router } from 'express';
import { obtenerTasa, fijarTasaManual } from '../servicios/tasas.js';

const router = Router();

// GET /api/tasas/actual — la tasa vigente (con caché de 1 hora).
router.get('/actual', async (req, res) => {
  try {
    const info = await obtenerTasa({ forzar: false });
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: 'No se pudo obtener la tasa de cambio.' });
  }
});

// POST /api/tasas/actualizar — fuerza la consulta al proveedor (botón "actualizar ahora").
router.post('/actualizar', async (req, res) => {
  try {
    const info = await obtenerTasa({ forzar: true });
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: 'No se pudo actualizar la tasa de cambio.' });
  }
});

// PUT /api/tasas/manual — fija la tasa manual (respaldo mientras no hay token).
router.put('/manual', async (req, res) => {
  const { valor } = req.body || {};
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) {
    return res.status(400).json({ error: 'La tasa debe ser un número positivo.' });
  }
  try {
    const info = await fijarTasaManual(n);
    res.json(info);
  } catch (e) {
    res.status(400).json({ error: e.message || 'No se pudo fijar la tasa manual.' });
  }
});

export default router;
