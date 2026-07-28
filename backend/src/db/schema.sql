-- ============================================================
--  Sistema de Gestión - Centro de Elaboración de Alimentos
--  Esquema de base de datos  —  PostgreSQL (Neon)
--
--  Convertido desde SQLite. Reglas aplicadas:
--   - INTEGER PRIMARY KEY AUTOINCREMENT   -> SERIAL PRIMARY KEY
--   - REAL                                -> DOUBLE PRECISION
--   - fechas TEXT con datetime('now')     -> TIMESTAMPTZ DEFAULT now()
--     (excepto la fecha del IPV, que es un 'AAAA-MM-DD' escrito a mano)
--   - INSERT OR IGNORE                    -> INSERT ... ON CONFLICT DO NOTHING
--
--  Todo usa CREATE TABLE IF NOT EXISTS: correr este archivo varias
--  veces es seguro (no borra ni duplica nada).
-- ============================================================

-- ---------- CATÁLOGO ----------

CREATE TABLE IF NOT EXISTS unidades (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  abreviatura TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS almacenes (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  zona        TEXT NOT NULL,            -- seco | embutido | refrigerado
  descripcion TEXT
);

CREATE TABLE IF NOT EXISTS productos (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  tipo          TEXT NOT NULL,          -- materia_prima | terminado | reventa
  categoria     TEXT,                   -- libre: embutidos, panadería, lácteos...
  unidad_id     INTEGER REFERENCES unidades(id),
  precio_costo  DOUBLE PRECISION DEFAULT 0,
  precio_venta  DOUBLE PRECISION DEFAULT 0,
  stock_minimo  DOUBLE PRECISION DEFAULT 0,
  activo        INTEGER NOT NULL DEFAULT 1   -- 1 = sí, 0 = no
);

-- ---------- USUARIOS ----------

CREATE TABLE IF NOT EXISTS usuarios (
  id           SERIAL PRIMARY KEY,
  nombre       TEXT NOT NULL,
  usuario      TEXT NOT NULL UNIQUE,
  clave_hash   TEXT NOT NULL,
  rol          TEXT NOT NULL,           -- dueno | almacenero | proveedor
  almacen_id   INTEGER REFERENCES almacenes(id),
  debe_cambiar INTEGER NOT NULL DEFAULT 0,
  activo       INTEGER NOT NULL DEFAULT 1,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- INVENTARIO ----------

CREATE TABLE IF NOT EXISTS existencias (
  id              SERIAL PRIMARY KEY,
  producto_id     INTEGER NOT NULL REFERENCES productos(id),
  almacen_id      INTEGER NOT NULL REFERENCES almacenes(id),
  cantidad        DOUBLE PRECISION NOT NULL DEFAULT 0,
  lote            TEXT,
  fecha_caducidad TEXT
);

CREATE TABLE IF NOT EXISTS movimientos (
  id          SERIAL PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  almacen_id  INTEGER NOT NULL REFERENCES almacenes(id),
  tipo        TEXT NOT NULL,           -- entrada | salida | traslado | ajuste | produccion
  cantidad    DOUBLE PRECISION NOT NULL,
  origen_tipo TEXT,                    -- compra | venta | produccion | manual
  origen_id   INTEGER,
  usuario_id  INTEGER REFERENCES usuarios(id),
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  nota        TEXT
);

-- ---------- DINERO ----------

CREATE TABLE IF NOT EXISTS caja (
  id          SERIAL PRIMARY KEY,
  tipo        TEXT NOT NULL,           -- ingreso | egreso
  concepto    TEXT NOT NULL,
  monto       DOUBLE PRECISION NOT NULL,
  moneda      TEXT NOT NULL DEFAULT 'CUP',
  origen_tipo TEXT,
  origen_id   INTEGER,
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id  INTEGER REFERENCES usuarios(id)
);

-- ---------- COMPRAS E IMPORTACIÓN ----------

CREATE TABLE IF NOT EXISTS compras (
  id            SERIAL PRIMARY KEY,
  tipo          TEXT NOT NULL DEFAULT 'nacional',
  proveedor     TEXT,
  fecha_llegada TIMESTAMPTZ NOT NULL DEFAULT now(),
  almacen_id    INTEGER REFERENCES almacenes(id),
  costo_total   DOUBLE PRECISION DEFAULT 0,
  moneda        TEXT NOT NULL DEFAULT 'CUP',
  tasa_cambio   DOUBLE PRECISION DEFAULT 1,
  referencia    TEXT,
  usuario_id    INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS compras_detalle (
  id             SERIAL PRIMARY KEY,
  compra_id      INTEGER NOT NULL REFERENCES compras(id),
  producto_id    INTEGER NOT NULL REFERENCES productos(id),
  cantidad       DOUBLE PRECISION NOT NULL,
  costo_unitario DOUBLE PRECISION DEFAULT 0
);

-- ---------- PRODUCCIÓN Y MOTOR DE FÓRMULAS ----------

CREATE TABLE IF NOT EXISTS formulas (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  tipo       TEXT NOT NULL,
  guardada   INTEGER NOT NULL DEFAULT 1,
  usuario_id INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS formula_valores (
  id         SERIAL PRIMARY KEY,
  formula_id INTEGER NOT NULL REFERENCES formulas(id),
  variable   TEXT NOT NULL,
  valor_fijo DOUBLE PRECISION,
  unidad_id  INTEGER REFERENCES unidades(id)
);

CREATE TABLE IF NOT EXISTS ordenes_produccion (
  id                 SERIAL PRIMARY KEY,
  formula_id         INTEGER REFERENCES formulas(id),
  producto_origen_id INTEGER REFERENCES productos(id),
  producto_final_id  INTEGER REFERENCES productos(id),
  cantidad_usada     DOUBLE PRECISION,
  cantidad_obtenida  DOUBLE PRECISION,
  merma              DOUBLE PRECISION,
  fecha              TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id         INTEGER REFERENCES usuarios(id),
  nota               TEXT
);

-- ---------- VENTAS ----------

CREATE TABLE IF NOT EXISTS ventas (
  id         SERIAL PRIMARY KEY,
  cliente    TEXT,
  fecha      TIMESTAMPTZ NOT NULL DEFAULT now(),
  total      DOUBLE PRECISION DEFAULT 0,
  pagado     DOUBLE PRECISION DEFAULT 0,
  estado     TEXT NOT NULL DEFAULT 'pendiente',  -- pagada | parcial | pendiente
  usuario_id INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS ventas_detalle (
  id              SERIAL PRIMARY KEY,
  venta_id        INTEGER NOT NULL REFERENCES ventas(id),
  producto_id     INTEGER NOT NULL REFERENCES productos(id),
  cantidad        DOUBLE PRECISION NOT NULL,
  precio_unitario DOUBLE PRECISION DEFAULT 0
);

-- ---------- TRANSPORTE ----------

CREATE TABLE IF NOT EXISTS transporte (
  id        SERIAL PRIMARY KEY,
  chofer    TEXT,
  fecha     TIMESTAMPTZ NOT NULL DEFAULT now(),
  destino   TEXT,
  venta_id  INTEGER REFERENCES ventas(id),
  costo     DOUBLE PRECISION DEFAULT 0,
  nota      TEXT
);

-- ---------- COSTOS Y GASTOS ----------

CREATE TABLE IF NOT EXISTS gastos (
  id          SERIAL PRIMARY KEY,
  categoria   TEXT NOT NULL,
  concepto    TEXT NOT NULL,
  monto       DOUBLE PRECISION NOT NULL,
  moneda      TEXT NOT NULL DEFAULT 'CUP',
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  origen_tipo TEXT,
  origen_id   INTEGER,
  usuario_id  INTEGER REFERENCES usuarios(id),
  nota        TEXT
);

CREATE TABLE IF NOT EXISTS gastos_fijos (
  id              SERIAL PRIMARY KEY,
  concepto        TEXT NOT NULL,
  monto           DOUBLE PRECISION NOT NULL,
  moneda          TEXT NOT NULL DEFAULT 'CUP',
  dia_del_mes     INTEGER DEFAULT 1,
  activo          INTEGER NOT NULL DEFAULT 1,
  ultimo_aplicado TEXT
);

CREATE TABLE IF NOT EXISTS combustible (
  id          SERIAL PRIMARY KEY,
  litros      DOUBLE PRECISION NOT NULL,
  costo       DOUBLE PRECISION NOT NULL,
  moneda      TEXT NOT NULL DEFAULT 'CUP',
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  nota        TEXT,
  usuario_id  INTEGER REFERENCES usuarios(id)
);

-- ---------- IPV DIARIO EDITABLE ----------

CREATE TABLE IF NOT EXISTS ipv_diario (
  id            SERIAL PRIMARY KEY,
  fecha         TEXT NOT NULL,               -- AAAA-MM-DD (escrito a mano)
  almacen_id    INTEGER REFERENCES almacenes(id),
  estado        TEXT NOT NULL DEFAULT 'abierto',  -- abierto | cerrado
  nota          TEXT,
  creado        TIMESTAMPTZ NOT NULL DEFAULT now(),
  cerrado_en    TIMESTAMPTZ,
  cerrado_por   INTEGER REFERENCES usuarios(id),
  UNIQUE(fecha, almacen_id)
);

CREATE TABLE IF NOT EXISTS ipv_diario_lineas (
  id              SERIAL PRIMARY KEY,
  ipv_id          INTEGER NOT NULL REFERENCES ipv_diario(id) ON DELETE CASCADE,
  producto_id     INTEGER NOT NULL REFERENCES productos(id),
  inicial_manual  DOUBLE PRECISION DEFAULT 0,
  entradas_manual DOUBLE PRECISION DEFAULT 0,
  salidas_manual  DOUBLE PRECISION DEFAULT 0,
  precio          DOUBLE PRECISION DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ipv_correcciones (
  id           SERIAL PRIMARY KEY,
  ipv_id       INTEGER NOT NULL REFERENCES ipv_diario(id),
  usuario_id   INTEGER REFERENCES usuarios(id),
  fecha        TIMESTAMPTZ NOT NULL DEFAULT now(),
  descripcion  TEXT NOT NULL
);

-- ---------- RECETAS DE PRODUCCIÓN ----------

CREATE TABLE IF NOT EXISTS recetas (
  id                SERIAL PRIMARY KEY,
  producto_final_id INTEGER NOT NULL REFERENCES productos(id),
  nombre            TEXT NOT NULL,
  rinde_cantidad    DOUBLE PRECISION NOT NULL DEFAULT 1,   -- cuánto produce la receta base
  rinde_unidad      TEXT DEFAULT 'lb',                     -- lb | g | kg (peso del producto final)
  activa            INTEGER NOT NULL DEFAULT 1,
  creada            TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id        INTEGER REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS receta_ingredientes (
  id            SERIAL PRIMARY KEY,
  receta_id     INTEGER NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
  producto_id   INTEGER NOT NULL REFERENCES productos(id),
  cantidad      DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS producciones (
  id                 SERIAL PRIMARY KEY,
  receta_id          INTEGER REFERENCES recetas(id),
  producto_final_id  INTEGER NOT NULL REFERENCES productos(id),
  cantidad_producida DOUBLE PRECISION NOT NULL,
  factor_escala      DOUBLE PRECISION NOT NULL DEFAULT 1,
  costo_total        DOUBLE PRECISION DEFAULT 0,
  almacen_id         INTEGER REFERENCES almacenes(id),
  fecha              TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id         INTEGER REFERENCES usuarios(id),
  nota               TEXT
);

CREATE TABLE IF NOT EXISTS produccion_consumo (
  id             SERIAL PRIMARY KEY,
  produccion_id  INTEGER NOT NULL REFERENCES producciones(id) ON DELETE CASCADE,
  producto_id    INTEGER NOT NULL REFERENCES productos(id),
  cantidad       DOUBLE PRECISION NOT NULL,
  costo_unitario DOUBLE PRECISION DEFAULT 0,
  costo          DOUBLE PRECISION DEFAULT 0
);

-- ---------- CONFIGURACIÓN DEL NEGOCIO ----------

CREATE TABLE IF NOT EXISTS config_negocio (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  nombre        TEXT NOT NULL DEFAULT 'Mi Negocio',
  tipo_negocio  TEXT DEFAULT '',
  moneda        TEXT NOT NULL DEFAULT 'CUP',
  configurado   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO config_negocio (id, nombre) VALUES (1, 'Mi Negocio')
  ON CONFLICT (id) DO NOTHING;

-- ---------- INVENTARIO PROPIO DEL PUNTO DE VENTA ----------
-- El área de ventas NO depende del almacén: son cosas distintas. Cada
-- vendedor lleva su propia lista de productos (los agrega él), con su
-- costo y su precio de venta. Lo vendido se anota durante el día y se
-- descuenta al cerrar la jornada.
CREATE TABLE IF NOT EXISTS venta_inventario (
  id             SERIAL PRIMARY KEY,
  usuario_id     INTEGER NOT NULL REFERENCES usuarios(id),  -- de quién es la hoja
  nombre         TEXT NOT NULL,
  unidad         TEXT DEFAULT 'u',            -- lb, kg, g, u...
  cantidad       DOUBLE PRECISION NOT NULL DEFAULT 0,   -- existencia
  costo_unitario DOUBLE PRECISION NOT NULL DEFAULT 0,   -- lo que le costó
  precio_venta   DOUBLE PRECISION NOT NULL DEFAULT 0,   -- a cómo lo vende
  vendido        DOUBLE PRECISION NOT NULL DEFAULT 0,   -- vendido en la jornada
  creado         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- LIBRO DE CONTABILIDAD ----------
-- Todo hecho económico queda aquí con su fecha y hora: ventas del día,
-- entradas y salidas del almacén, producciones y gastos. Se conserva por
-- tiempo indefinido hasta que el contador (o el dueño) decida borrarlo.
CREATE TABLE IF NOT EXISTS contabilidad_registros (
  id          SERIAL PRIMARY KEY,
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  tipo        TEXT NOT NULL,        -- venta | almacen | produccion | gasto
  concepto    TEXT NOT NULL,        -- descripción legible
  producto    TEXT,                 -- a qué producto se refiere
  cantidad    DOUBLE PRECISION DEFAULT 0,
  unidad      TEXT,
  costo       DOUBLE PRECISION DEFAULT 0,   -- lo que costó (afecta el resultado)
  ingreso     DOUBLE PRECISION DEFAULT 0,   -- lo que entró de dinero
  ganancia    DOUBLE PRECISION DEFAULT 0,   -- ingreso - costo
  valor       DOUBLE PRECISION DEFAULT 0,   -- valor de referencia (mercancía movida)
  area        TEXT,                 -- ventas | almacen | cocina
  usuario_id  INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,              -- se guarda el nombre por si el usuario se borra
  nota        TEXT
);
CREATE INDEX IF NOT EXISTS idx_contab_fecha ON contabilidad_registros (fecha DESC);

-- ---------- JORNADA DE VENTAS (IPV editable del día por almacén) ----------
-- Guarda cuánto se ha "vendido" hoy de cada producto en cada almacén.
-- No toca la existencia hasta que se pulsa "Reiniciar jornada", que resta
-- lo vendido de la existencia, borra los productos en cero y deja vendido=0.
CREATE TABLE IF NOT EXISTS jornada_ventas (
  id          SERIAL PRIMARY KEY,
  almacen_id  INTEGER NOT NULL REFERENCES almacenes(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  vendido     DOUBLE PRECISION NOT NULL DEFAULT 0,
  UNIQUE(almacen_id, producto_id)
);

-- ---------- LICENCIA (periodo de prueba / activación) ----------

CREATE TABLE IF NOT EXISTS licencia (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  instalada_en   TEXT NOT NULL,
  id_instalacion TEXT NOT NULL,
  activada       INTEGER NOT NULL DEFAULT 0
);
