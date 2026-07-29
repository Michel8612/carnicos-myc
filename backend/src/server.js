// ============================================================
//  Servidor principal
//
//  Es el "cerebro" central. Recibe las peticiones de los
//  dispositivos (registrar un movimiento, consultar inventario…)
//  y responde.
//
//  Este archivo sirve para DOS modos:
//   - Local / servidor propio:  `node src/server.js` arranca y
//     escucha en un puerto (app.listen).
//   - Netlify (serverless):     la función importa `app` e
//     `inicializar` desde aquí SIN llamar a app.listen.
//
//  Por eso el listen solo corre cuando el archivo se ejecuta
//  directamente, no cuando se importa.
// ============================================================

import 'express-async-errors'; // hace que los errores en handlers async
                               // lleguen al middleware de errores (Express 4)
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inicializarBaseDeDatos } from './db/index.js';
import { sembrarSiVacio } from './db/seed-auto.js';
import { respaldarBaseDeDatos } from './db/respaldo.js';
import authRoutes from './routes/auth.js';
import inventarioRoutes from './routes/inventario.js';
import cajaRoutes from './routes/caja.js';
import syncRoutes from './routes/sync.js';
import usuariosRoutes from './routes/usuarios.js';
import produccionRoutes from './routes/produccion.js';
import ventasRoutes from './routes/ventas.js';
import transporteRoutes from './routes/transporte.js';
import costosRoutes from './routes/costos.js';
import ipvRoutes from './routes/ipv.js';
import recetasRoutes from './routes/recetas.js';
import contabilidadRoutes from './routes/contabilidad.js';
import configRoutes from './routes/config.js';
import tasasRoutes from './routes/tasas.js';
import licenciaRoutes, { bloqueoPorLicencia } from './licencia/rutas.js';
import { inicializarLicencia } from './licencia/licencia.js';
import { requiereSesion, escrituraSoloRoles } from './middleware/auth.js';

// Carpeta de este archivo. En Netlify el código se empaqueta y
// `import.meta.url` puede no existir; ahí no se sirven archivos estáticos
// (de eso se encarga Netlify), así que basta con dejarlo vacío.
const __dirname = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return '';
  }
})();

const app = express();
app.use(cors());
app.use(express.json());

// Comprobación rápida de que el servidor está vivo.
app.get('/api/salud', (req, res) => {
  res.json({ estado: 'ok', hora: new Date().toISOString() });
});

// Rutas de licencia (siempre accesibles, para poder activar).
app.use('/api/licencia', licenciaRoutes);

// Configuración del negocio: el GET debe estar accesible antes del
// bloqueo por licencia porque la pantalla de login muestra el nombre.
app.use('/api/config', configRoutes);

// ---- El frontend del cliente (Cárnicos M&C), servido por este servidor ----
// Son páginas estáticas (HTML/CSS/JS) en la carpeta public/. En Netlify las
// sirve el hosting estático; esto solo aplica cuando el backend corre en una
// PC/servidor propio (modo local).
const PUBLIC = join(__dirname, '..', '..', 'public');
if (existsSync(PUBLIC)) {
  app.use(express.static(PUBLIC));
  // Página de inicio -> login del cliente.
  app.get('/', (req, res) => res.sendFile(join(PUBLIC, 'index.html')));
}

// NOTA: el bloqueo por licencia (periodo de prueba) se deja DESACTIVADO:
// esta es la app propia del cliente Cárnicos M&C, no un producto con licencia.
// Si algún día se quiere activar, descomente la línea de abajo.
// app.use(bloqueoPorLicencia);

app.use('/api/auth', authRoutes);
// Control por rol: leer (GET) lo puede todo usuario con sesión; ESCRIBIR
// (crear/editar/borrar) solo el dueño y el rol dueño de esa sección.
// El vendedor al que le mandan mercancía tiene que poder aceptarla o
// cancelarla, pero SIN darle permiso de escritura sobre el resto del
// almacén. Por eso esas dos rutas se dejan pasar aquí y el control fino
// (¿es de verdad el destinatario?) lo hace inventario.js por dentro.
const RESOLVER_TRANSFERENCIA = /^\/transferencias\/\d+\/(aceptar|cancelar)$/;
const permisoInventario = escrituraSoloRoles('almacen', 'almacenero', 'almacen_central');
app.use('/api/inventario', requiereSesion, (req, res, next) => {
  if (RESOLVER_TRANSFERENCIA.test(req.path)) return next();
  return permisoInventario(req, res, next);
}, inventarioRoutes);
app.use('/api/caja', cajaRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/usuarios', usuariosRoutes); // ya es solo-dueño por dentro
app.use('/api/produccion', requiereSesion, escrituraSoloRoles('cocinero'), produccionRoutes);
app.use('/api/ventas', requiereSesion, escrituraSoloRoles('ventas'), ventasRoutes);
app.use('/api/transporte', requiereSesion, escrituraSoloRoles('ventas'), transporteRoutes);
app.use('/api/costos', requiereSesion, escrituraSoloRoles(), costosRoutes); // solo dueño escribe; contabilidad solo lee
app.use('/api/ipv', requiereSesion, escrituraSoloRoles('almacen', 'almacenero', 'almacen_central'), ipvRoutes);
// 'almacen' se incluye aquí porque el almacenero necesita poder llamar a
// POST /recetas/disponibles/:id/al-almacen (dar entrada a lo producido);
// el propio archivo recetas.js restringe fino las demás rutas de cocina
// (crear/editar/borrar receta, producir) a cocinero/dueño solamente.
app.use('/api/recetas', requiereSesion, escrituraSoloRoles('cocinero', 'almacen', 'almacenero'), recetasRoutes);
app.use('/api/contabilidad', contabilidadRoutes);
// Tasa del dólar (elTOQUE): leerla puede cualquiera con sesión; fijarla
// a mano o forzar la actualización, solo el dueño.
app.use('/api/tasas', requiereSesion, escrituraSoloRoles(), tasasRoutes);

// ---- Middleware de errores: cualquier fallo en una ruta cae aquí ----
// Devuelve un JSON claro con 500 en vez de tumbar el servidor.
app.use((err, req, res, next) => {
  console.error('Error en', req.method, req.originalUrl, '->', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Ocurrió un error en el servidor. Intente de nuevo.' });
});

// Inicialización idempotente: crea tablas, respaldo y licencia UNA sola
// vez, aunque se llame varias veces (importante en serverless, donde cada
// invocación reutiliza el módulo ya cargado).
let promesaInit = null;
export function inicializar() {
  if (!promesaInit) {
    promesaInit = (async () => {
      await inicializarBaseDeDatos();
      await sembrarSiVacio();      // crea usuario/almacenes/unidades la 1ª vez
      await respaldarBaseDeDatos();
      await inicializarLicencia();
    })();
  }
  return promesaInit;
}

// Red de seguridad final: que un error inesperado nunca mate el proceso
// (en local/servidor propio). Se registra y se sigue.
process.on('unhandledRejection', (motivo) => {
  console.error('Rechazo no manejado:', motivo);
});
process.on('uncaughtException', (err) => {
  console.error('Excepción no capturada:', err);
});

// Exportado para Netlify (la función serverless envuelve esta app).
export { app };

// ---- Arranque en local / servidor propio ----
// Solo si este archivo se ejecuta directamente (no cuando se importa).
// (En Netlify no aplica: allí la app se importa, nunca se ejecuta directo,
// y `import.meta.url` puede no existir tras el empaquetado.)
const ejecutadoDirecto = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (ejecutadoDirecto) {
  const PUERTO = process.env.PUERTO || 3001;
  inicializar()
    .then(() => {
      app.listen(PUERTO, () => {
        console.log(`Servidor escuchando en el puerto ${PUERTO}`);
      });
    })
    .catch((err) => {
      console.error('No se pudo iniciar:', err);
      process.exit(1);
    });
}

