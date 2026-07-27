// ============================================================
//  Función serverless de Netlify — API de Cárnicos M&C
//
//  Envuelve la app de Express (backend/src/server.js) con
//  serverless-http. Netlify redirige /api/* aquí.
//
//  Variables de entorno (panel de Netlify):
//    DATABASE_URL      -> cadena de Neon (Postgres)
//    JWT_SECRETO       -> clave larga y secreta para las sesiones
// ============================================================

import serverless from 'serverless-http';
import { app, inicializar } from '../../backend/src/server.js';

const sls = serverless(app);

export const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await inicializar();

  // Normalizar la ruta para que Express vea /api/...
  let ruta = event.path || '/';
  const prefijo = '/.netlify/functions/api';
  if (ruta.startsWith(prefijo)) ruta = ruta.slice(prefijo.length) || '/';
  if (!ruta.startsWith('/api')) ruta = '/api' + (ruta === '/' ? '' : ruta);
  event.path = ruta;

  return sls(event, context);
};
