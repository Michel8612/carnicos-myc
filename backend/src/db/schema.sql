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

-- OJO: "usuario_id" NO lleva REFERENCES aquí porque en este punto del
-- script la tabla "usuarios" todavía no existe (se crea más abajo, y
-- usuarios.almacen_id apunta a almacenes: son referencias cruzadas). La
-- restricción de llave foránea real se agrega al final del archivo, en
-- el bloque de migraciones, una vez que "usuarios" ya existe.
CREATE TABLE IF NOT EXISTS almacenes (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  zona        TEXT NOT NULL,            -- seco | embutido | refrigerado
  descripcion TEXT,
  usuario_id  INTEGER                   -- responsable de este almacén (ver usuarios)
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

-- Costo de cada ENTRADA, en las dos monedas y con la tasa de ese día.
--
-- Por qué se guardan los tres datos y no solo uno: la tasa del dólar cambia
-- a diario. Si se guardara únicamente el importe en USD y se convirtiera al
-- mostrarlo, el costo de una compra de enero cambiaría cada mañana, y con él
-- la ganancia y el margen. Lo que se archiva tiene que ser una foto fija del
-- día de la compra, no un cálculo que se rehace cada vez que alguien mira.
--
-- `moneda_origen` dice en cuál de las dos se pagó DE VERDAD; la otra es la
-- equivalencia. Hace falta para el valor del inventario, que se pide separado
-- por moneda de adquisición.
--
-- Van como ALTER y no dentro del CREATE porque la tabla ya existe en las
-- instalaciones en marcha, y `CREATE TABLE IF NOT EXISTS` no añade columnas a
-- una tabla que ya está: no pasaría nada y el campo nunca aparecería.
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS costo_unitario_cup DOUBLE PRECISION;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS costo_unitario_usd DOUBLE PRECISION;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS moneda_origen      TEXT;
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS tasa_usada         DOUBLE PRECISION;

-- Para el resumen del almacén por fecha de entrada (valor del inventario).
CREATE INDEX IF NOT EXISTS idx_mov_fecha_tipo ON movimientos (tipo, fecha DESC);

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

-- OJO: "producto_id" no lleva llave foránea a propósito. Una línea de
-- venta puede apuntar a un producto del almacén o a uno de la lista
-- propia del vendedor (venta_inventario), que son tablas distintas. Se
-- guarda también el nombre para que el historial siga siendo legible.
CREATE TABLE IF NOT EXISTS ventas_detalle (
  id              SERIAL PRIMARY KEY,
  venta_id        INTEGER NOT NULL REFERENCES ventas(id),
  producto_id     INTEGER NOT NULL,
  producto_nombre TEXT,
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

-- Lo que la cocina produjo y AÚN no se ha llevado al almacén. El
-- almacenero (o el dueño) lo revisa y le da entrada cuando corresponda;
-- hasta entonces no cuenta como existencia de ningún almacén.
CREATE TABLE IF NOT EXISTS produccion_disponible (
  id              SERIAL PRIMARY KEY,
  produccion_id   INTEGER REFERENCES producciones(id),
  producto_nombre TEXT NOT NULL,
  cantidad        DOUBLE PRECISION NOT NULL,
  unidad          TEXT,
  costo_unitario  DOUBLE PRECISION DEFAULT 0,
  fecha           TIMESTAMPTZ NOT NULL DEFAULT now(),
  entregado       INTEGER NOT NULL DEFAULT 0   -- 0 = pendiente, 1 = ya entró al almacén
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

-- ---------- CÁLCULOS DE RECETAS GUARDADOS ----------
-- Cada cálculo que el cocinero decide guardar queda aquí con su fecha y
-- hora, y se conserva hasta que él mismo lo borre. El detalle (qué
-- componente, cuánto hacía falta y cuánto costaba) se guarda en JSON para
-- que el historial muestre el cálculo tal como se hizo ese día.
CREATE TABLE IF NOT EXISTS calculos_guardados (
  id             SERIAL PRIMARY KEY,
  fecha          TIMESTAMPTZ NOT NULL DEFAULT now(),
  receta_id      INTEGER REFERENCES recetas(id) ON DELETE SET NULL,
  receta_nombre  TEXT NOT NULL,
  cantidad_final DOUBLE PRECISION NOT NULL DEFAULT 0,
  unidad         TEXT,
  costo_total    DOUBLE PRECISION NOT NULL DEFAULT 0,
  costo_unitario DOUBLE PRECISION NOT NULL DEFAULT 0,
  almacen_id     INTEGER REFERENCES almacenes(id) ON DELETE SET NULL,
  almacen_nombre TEXT,
  detalle        TEXT,                -- JSON con las líneas del cálculo
  usuario_id     INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  nota           TEXT
);
CREATE INDEX IF NOT EXISTS idx_calculos_fecha ON calculos_guardados (fecha DESC);

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

-- ============================================================
--  MIGRACIONES IDEMPOTENTES
--  Para bases de datos que ya existían antes de este cambio:
--  agregan columnas nuevas solo si todavía no están. Correr este
--  archivo varias veces sigue siendo seguro.
-- ============================================================

-- Cada almacén puede tener un responsable (el almacenero dueño de esa
-- área). En instalaciones nuevas la columna ya viene en el CREATE TABLE
-- de más arriba (sin llave foránea, por el orden de creación); aquí se
-- agrega para instalaciones viejas, ahora sí con su REFERENCES porque
-- en este punto "usuarios" ya existe seguro.
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id);

-- Imagen de recetas, productos y del inventario propio de ventas: se
-- guarda como data URL (base64) en una columna TEXT; el frontend ya
-- redimensiona la imagen antes de enviarla, así que no hace falta un
-- storage externo.
ALTER TABLE recetas ADD COLUMN IF NOT EXISTS imagen TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS imagen TEXT;
ALTER TABLE venta_inventario ADD COLUMN IF NOT EXISTS imagen TEXT;

-- Historial de ventas: se pueden ocultar de la vista (sin borrar el
-- registro ni tocar inventario/caja/contabilidad) y se guarda cómo
-- se cobró (efectivo, transferencia...).
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS oculto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ventas ADD COLUMN IF NOT EXISTS metodo_pago TEXT;

-- El detalle de una venta puede referirse a dos cosas distintas: a un
-- producto del almacén, o a un producto de la lista propia del vendedor
-- (que es otra tabla). Por eso "producto_id" ya no puede estar atado por
-- llave foránea a "productos": impedía guardar las ventas del carrito.
-- Se quita esa atadura y se guarda el nombre junto con la línea, que
-- además hace el historial más fiel: sigue diciendo qué se vendió aunque
-- después se borre o se renombre el producto.
ALTER TABLE ventas_detalle DROP CONSTRAINT IF EXISTS ventas_detalle_producto_id_fkey;
ALTER TABLE ventas_detalle ADD COLUMN IF NOT EXISTS producto_nombre TEXT;

-- ============================================================
--  Transferencias entre áreas (almacén → almacén, almacén → vendedor)
-- ============================================================
-- Antes, una salida con destino entraba SOLA en el almacén de destino.
-- Ahora el destinatario tiene que aceptarla: la mercancía sale del
-- origen y queda "en tránsito" hasta que la aceptan o la cancelan.
-- Si se cancela, la mercancía vuelve al origen (no se puede perder).
CREATE TABLE IF NOT EXISTS transferencias (
  id SERIAL PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  producto_nombre TEXT,
  cantidad DOUBLE PRECISION NOT NULL,
  costo_unitario DOUBLE PRECISION DEFAULT 0,
  origen_almacen_id INTEGER REFERENCES almacenes(id),
  origen_almacen_nombre TEXT,
  -- A dónde va: a otro almacén o a la lista de venta de un vendedor.
  destino_tipo TEXT NOT NULL CHECK (destino_tipo IN ('almacen', 'ventas')),
  destino_almacen_id INTEGER REFERENCES almacenes(id),
  destino_usuario_id INTEGER REFERENCES usuarios(id),
  destino_nombre TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'aceptada', 'cancelada')),
  enviado_por INTEGER REFERENCES usuarios(id),
  enviado_nombre TEXT,
  fecha_envio TIMESTAMPTZ DEFAULT NOW(),
  resuelto_por INTEGER REFERENCES usuarios(id),
  resuelto_nombre TEXT,
  fecha_resolucion TIMESTAMPTZ,
  nota TEXT
);
CREATE INDEX IF NOT EXISTS idx_transf_estado ON transferencias(estado);
CREATE INDEX IF NOT EXISTS idx_transf_destino_alm ON transferencias(destino_almacen_id);
CREATE INDEX IF NOT EXISTS idx_transf_destino_usr ON transferencias(destino_usuario_id);

-- ============================================================
--  Tasa de cambio del dólar (fuente: API de elTOQUE)
-- ============================================================
-- Guarda cada tasa que se logra obtener. El sistema siempre usa la
-- última válida, así sigue funcionando aunque se caiga la conexión.
CREATE TABLE IF NOT EXISTS tasas_cambio (
  id SERIAL PRIMARY KEY,
  moneda TEXT NOT NULL DEFAULT 'USD',
  valor DOUBLE PRECISION NOT NULL,
  fuente TEXT NOT NULL DEFAULT 'eltoque',
  fecha_tasa TEXT,
  obtenida_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasas_moneda_fecha ON tasas_cambio(moneda, obtenida_en DESC);

-- ============================================================
--  Parámetros del sistema (clave/valor)
-- ============================================================
-- Tabla genérica para ajustes que el dueño puede cambiar sin tocar
-- código: margen de venta en USD, tipo de empresa para tributación,
-- porcentajes de impuestos que se aparten de los de fábrica, etc.
CREATE TABLE IF NOT EXISTS parametros (
  clave TEXT PRIMARY KEY,
  valor TEXT,
  actualizado_en TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  Nómina (salarios del personal)
-- ============================================================
-- Hacía falta para calcular la contribución a la seguridad social:
-- sin salarios registrados ese tributo salía siempre en cero.
-- Cada pago de nómina genera además su fila en "gastos" (categoría
-- 'nomina') y su egreso en caja, para no llevar dos contabilidades
-- distintas: "gastos" sigue siendo la única fuente de lo deducible.
CREATE TABLE IF NOT EXISTS nomina (
  id SERIAL PRIMARY KEY,
  empleado TEXT NOT NULL,
  cargo TEXT,
  salario DOUBLE PRECISION NOT NULL,
  periodo TEXT,                 -- 'AAAA-MM', el mes que se paga
  fecha_pago TIMESTAMPTZ DEFAULT NOW(),
  moneda TEXT DEFAULT 'CUP',
  gasto_id INTEGER REFERENCES gastos(id),
  usuario_id INTEGER REFERENCES usuarios(id),
  nota TEXT
);
CREATE INDEX IF NOT EXISTS idx_nomina_periodo ON nomina(periodo);

-- ============================================================
--  AUDITORÍA CENTRALIZADA
-- ============================================================
-- Todo lo que se crea, cambia o borra en el sistema deja huella aquí.
-- Es la base de las eliminaciones autorizadas del libro contable y del
-- historial de almacén: sin esta tabla no se puede saber quién hizo qué.
-- No se borra nunca desde la aplicación (solo lectura y filtrado).
CREATE TABLE IF NOT EXISTS auditoria (
  id SERIAL PRIMARY KEY,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  rol TEXT,
  modulo TEXT NOT NULL,        -- ventas, almacen, contabilidad, usuarios, config, sesion...
  accion TEXT NOT NULL,        -- login, logout, crear, modificar, eliminar, autorizar
  entidad TEXT,                -- qué objeto se tocó
  entidad_id TEXT,
  descripcion TEXT,
  valor_anterior TEXT,
  valor_nuevo TEXT,
  motivo TEXT,
  -- Cuando alguien actúa con permiso prestado (p. ej. contabilidad
  -- borrando con clave del administrador), aquí queda quién autorizó.
  autorizado_por INTEGER REFERENCES usuarios(id),
  autorizado_nombre TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_fecha ON auditoria(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_audit_usuario ON auditoria(usuario_id);
CREATE INDEX IF NOT EXISTS idx_audit_modulo ON auditoria(modulo);
CREATE INDEX IF NOT EXISTS idx_audit_accion ON auditoria(accion);

-- ============================================================
--  CONFIGURACIÓN FISCAL DE LA EMPRESA (fila única)
-- ============================================================
-- Datos oficiales del negocio: los necesitan las facturas y los
-- reportes que se presentan a la ONAT.
CREATE TABLE IF NOT EXISTS empresa_fiscal (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nombre_fiscal TEXT,
  razon_social TEXT,
  nit TEXT,
  direccion TEXT,
  provincia TEXT,
  municipio TEXT,
  telefono TEXT,
  correo TEXT,
  moneda_principal TEXT DEFAULT 'CUP',
  monedas_secundarias TEXT,     -- JSON: ["USD","MLC"]
  regimen_tributario TEXT,
  datos_facturacion TEXT,       -- JSON libre (pie de factura, serie...)
  datos_reportes TEXT,          -- JSON libre (encabezados oficiales)
  actualizado_en TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  CUENTAS BANCARIAS
-- ============================================================
CREATE TABLE IF NOT EXISTS cuentas_bancarias (
  id SERIAL PRIMARY KEY,
  banco TEXT NOT NULL,
  numero TEXT NOT NULL,
  alias TEXT,
  titular TEXT,
  moneda TEXT NOT NULL DEFAULT 'CUP',
  estado TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'inactiva')),
  usar_en TEXT,                 -- JSON: ["ventas","compras","pagos","cobros"]
  -- El QR guarda SOLO lo público (alias/número de cobro), nunca claves.
  qr_datos TEXT,
  qr_imagen TEXT,               -- data URL, opcional
  creado_en TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  MOVIMIENTOS BANCARIOS Y CONCILIACIÓN
-- ============================================================
-- Mientras no haya integración oficial con el banco, se registran a
-- mano. La estructura ya contempla el día que llegue la integración:
-- "origen" dirá de qué pasarela vino y "estado" si está conciliado.
CREATE TABLE IF NOT EXISTS movimientos_bancarios (
  id SERIAL PRIMARY KEY,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas_bancarias(id),
  fecha TIMESTAMPTZ DEFAULT NOW(),
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  monto DOUBLE PRECISION NOT NULL,
  moneda TEXT NOT NULL DEFAULT 'CUP',
  concepto TEXT,
  referencia TEXT,
  origen TEXT NOT NULL DEFAULT 'manual',   -- manual, enzona, transfermovil
  origen_referencia TEXT,                   -- id de la pasarela, si viene de una
  estado TEXT NOT NULL DEFAULT 'registrado'
    CHECK (estado IN ('registrado', 'conciliado', 'anulado')),
  conciliado_tipo TEXT,        -- venta, compra, gasto...
  conciliado_id INTEGER,
  conciliado_en TIMESTAMPTZ,
  usuario_id INTEGER REFERENCES usuarios(id),
  nota TEXT
);
CREATE INDEX IF NOT EXISTS idx_movban_cuenta ON movimientos_bancarios(cuenta_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_movban_estado ON movimientos_bancarios(estado);

-- ============================================================
--  CATEGORÍAS DE GASTO CONFIGURABLES
-- ============================================================
-- Antes estaban fijas en el código. Ahora el dueño puede crear las
-- suyas. Las de fábrica (fija=1) no se pueden borrar porque hay
-- cálculos que dependen de ellas (p. ej. 'nomina' para la seguridad social).
CREATE TABLE IF NOT EXISTS categorias_gasto (
  clave TEXT PRIMARY KEY,
  etiqueta TEXT NOT NULL,
  deducible INTEGER NOT NULL DEFAULT 1,
  fija INTEGER NOT NULL DEFAULT 0,
  activa INTEGER NOT NULL DEFAULT 1,
  creado_en TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  CORRECCIONES MANUALES DE TRIBUTACIÓN
-- ============================================================
-- El cálculo automático es una ayuda, no un dogma: el contador puede
-- sustituir cualquier cifra. Cada corrección queda con su motivo y su
-- autor para que una auditoría futura pueda reconstruirlo todo.
CREATE TABLE IF NOT EXISTS tributacion_correcciones (
  id SERIAL PRIMARY KEY,
  periodo_desde DATE,
  periodo_hasta DATE,
  clave TEXT NOT NULL,          -- qué cifra se corrige (ventas_brutas, un tributo...)
  etiqueta TEXT,
  valor_anterior DOUBLE PRECISION,
  valor_nuevo DOUBLE PRECISION NOT NULL,
  motivo TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  anulada INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tribcorr_periodo ON tributacion_correcciones(periodo_desde, periodo_hasta);

-- ============================================================
--  DOCUMENTOS LEGALES Y SU ACEPTACIÓN
-- ============================================================
CREATE TABLE IF NOT EXISTS documentos_legales (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,           -- terminos, privacidad, datos
  version TEXT NOT NULL,
  titulo TEXT,
  contenido TEXT NOT NULL,
  vigente INTEGER NOT NULL DEFAULT 1,
  creado_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS aceptaciones_legales (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  documento_id INTEGER REFERENCES documentos_legales(id),
  tipo TEXT,
  version TEXT,
  fecha TIMESTAMPTZ DEFAULT NOW(),
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_acept_usuario ON aceptaciones_legales(usuario_id);

-- ============================================================
--  SESIONES ACTIVAS
-- ============================================================
-- Permite ver quién está dentro, cerrar sesiones y caducarlas por
-- inactividad. El token sigue siendo JWT; aquí se guarda su "jti"
-- para poder invalidarlo antes de que expire por sí solo.
CREATE TABLE IF NOT EXISTS sesiones (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  jti TEXT UNIQUE,
  creada_en TIMESTAMPTZ DEFAULT NOW(),
  ultima_actividad TIMESTAMPTZ DEFAULT NOW(),
  expira_en TIMESTAMPTZ,
  cerrada INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  agente TEXT
);
CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones(usuario_id, cerrada);

-- ============================================================
--  AUTORIZACIONES YA GASTADAS
-- ============================================================
-- El permiso temporal que firma un administrador (para que
-- contabilidad pueda borrar del libro) dura 5 minutos. Sin esta tabla,
-- dentro de esa ventana el mismo permiso serviría para borrar muchas
-- cosas: el administrador autorizó UNA acción, no un rato entero.
-- Aquí se anota el identificador del permiso en cuanto se usa, para
-- que un segundo intento con el mismo sea rechazado.
CREATE TABLE IF NOT EXISTS autorizaciones_usadas (
  jti TEXT PRIMARY KEY,
  usada_en TIMESTAMPTZ DEFAULT NOW(),
  usada_por INTEGER REFERENCES usuarios(id),
  accion TEXT
);
CREATE INDEX IF NOT EXISTS idx_autz_usada_en ON autorizaciones_usadas(usada_en);

-- ============================================================
--  SECCIÓN 10 DEL ERP — tablas nuevas
--  Se declaran TODAS aquí, de una vez, para que cada área pueda
--  desarrollarse por separado sin tocar este archivo y sin que dos
--  cambios simultáneos se pisen.
-- ============================================================

-- ---- Copias de seguridad -----------------------------------
-- No se guarda el contenido del respaldo: en Netlify la función no
-- tiene disco donde dejarlo. El respaldo se genera y se descarga en
-- el momento; aquí solo queda constancia de quién lo hizo y qué
-- contenía, que es lo que permite auditar si hubo copia antes de un
-- desastre.
CREATE TABLE IF NOT EXISTS respaldos (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL DEFAULT 'manual',
  tablas INTEGER,
  filas INTEGER,
  tamano_bytes INTEGER,
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  resultado TEXT NOT NULL DEFAULT 'ok',
  detalle TEXT,
  creado_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_respaldos_fecha ON respaldos(creado_en DESC);

-- ---- Cuentas por cobrar y por pagar ------------------------
-- Una sola tabla con `tipo` en lugar de dos: las dos caras son
-- simétricas (un tercero, un documento, un vencimiento y un saldo) y
-- duplicar la tabla obligaría a duplicar también cada consulta.
CREATE TABLE IF NOT EXISTS cuentas_terceros (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,                       -- 'cobrar' | 'pagar'
  tercero TEXT NOT NULL,                    -- cliente o proveedor
  documento TEXT,                           -- factura, vale, contrato
  concepto TEXT,
  monto NUMERIC(14,2) NOT NULL,
  saldo NUMERIC(14,2) NOT NULL,
  moneda TEXT NOT NULL DEFAULT 'CUP',
  fecha_emision DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_vencimiento DATE,
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | parcial | pagada | anulada
  referencia_tipo TEXT,                     -- 'venta' | 'compra' | null
  referencia_id INTEGER,
  nota TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cuentas_tipo_estado ON cuentas_terceros(tipo, estado);
CREATE INDEX IF NOT EXISTS idx_cuentas_vencimiento ON cuentas_terceros(fecha_vencimiento);

CREATE TABLE IF NOT EXISTS cuentas_pagos (
  id SERIAL PRIMARY KEY,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas_terceros(id) ON DELETE CASCADE,
  monto NUMERIC(14,2) NOT NULL,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  metodo TEXT,                              -- efectivo, transferencia, enzona...
  referencia TEXT,
  nota TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cuentas_pagos_cuenta ON cuentas_pagos(cuenta_id);

-- ---- Presupuestos ------------------------------------------
CREATE TABLE IF NOT EXISTS presupuestos (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  periodo_inicio DATE NOT NULL,
  periodo_fin DATE NOT NULL,
  nota TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS presupuesto_lineas (
  id SERIAL PRIMARY KEY,
  presupuesto_id INTEGER NOT NULL REFERENCES presupuestos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,                       -- 'ingreso' | 'gasto'
  categoria TEXT NOT NULL,                  -- coincide con categorias_gasto cuando es gasto
  previsto NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_presupuesto_lineas ON presupuesto_lineas(presupuesto_id);

-- ---- Conciliación de inventario ----------------------------
-- El conteo físico se guarda ANTES de tocar las existencias: primero
-- se anota lo que hay de verdad, y solo al cerrar la conciliación se
-- ajusta el sistema. Así queda constancia de la diferencia, que es
-- justo lo que interesa investigar.
CREATE TABLE IF NOT EXISTS conciliaciones (
  id SERIAL PRIMARY KEY,
  almacen_id INTEGER REFERENCES almacenes(id),
  estado TEXT NOT NULL DEFAULT 'abierta',   -- abierta | cerrada | anulada
  nota TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado_en TIMESTAMPTZ DEFAULT NOW(),
  cerrada_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_conciliaciones_estado ON conciliaciones(estado, almacen_id);

CREATE TABLE IF NOT EXISTS conciliacion_lineas (
  id SERIAL PRIMARY KEY,
  conciliacion_id INTEGER NOT NULL REFERENCES conciliaciones(id) ON DELETE CASCADE,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  existencia_sistema NUMERIC(14,3) NOT NULL DEFAULT 0,
  existencia_fisica NUMERIC(14,3),
  diferencia NUMERIC(14,3),
  motivo TEXT
);
CREATE INDEX IF NOT EXISTS idx_concil_lineas ON conciliacion_lineas(conciliacion_id);

-- ---- Centro de notificaciones ------------------------------
-- Se guarda en la base y no solo en pantalla: un aviso de stock bajo
-- que solo existe mientras la página está abierta no sirve de nada
-- para quien entra por la mañana.
CREATE TABLE IF NOT EXISTS notificaciones (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,                       -- stock_bajo, vencimiento, cierre...
  titulo TEXT NOT NULL,
  mensaje TEXT,
  severidad TEXT NOT NULL DEFAULT 'info',   -- info | aviso | urgente
  destino_rol TEXT,                         -- null = todos
  referencia_tipo TEXT,
  referencia_id INTEGER,
  leida_por TEXT NOT NULL DEFAULT '',       -- ids de usuario separados por coma
  creada_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_fecha ON notificaciones(creada_en DESC);

-- ---- Historial de cálculos de tributación ------------------
-- Cada vez que se calcula el tributo de un periodo se guarda aquí lo
-- que se obtuvo y con qué cifras. Sin este historial no hay forma de
-- explicarle a la ONAT por qué en marzo se declaró una cantidad y en
-- abril otra. Solo el administrador puede borrar líneas: quien calcula
-- no puede hacer desaparecer un cálculo que no le gustó.
CREATE TABLE IF NOT EXISTS tributacion_historial (
  id SERIAL PRIMARY KEY,
  periodo TEXT NOT NULL,                    -- 'YYYY-MM' o rango
  base_ingresos NUMERIC(14,2) NOT NULL DEFAULT 0,
  base_gastos NUMERIC(14,2) NOT NULL DEFAULT 0,
  base_imponible NUMERIC(14,2) NOT NULL DEFAULT 0,
  tributo NUMERIC(14,2) NOT NULL DEFAULT 0,
  detalle TEXT,                             -- JSON con las partidas
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nombre TEXT,
  creado_en TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tributacion_hist ON tributacion_historial(periodo, creado_en DESC);

-- ---- Credenciales de servicios externos --------------------
-- Token de elTOQUE, datos de Transfermóvil, EnZona... Se guardan en la
-- base y no en variables de entorno para que el dueño pueda ponerlos
-- desde el panel sin tocar código ni volver a desplegar. El valor
-- nunca se devuelve entero al navegador: solo si está puesto y sus
-- últimos caracteres, lo justo para reconocerlo.
CREATE TABLE IF NOT EXISTS credenciales (
  clave TEXT PRIMARY KEY,
  valor TEXT,
  descripcion TEXT,
  actualizado_en TIMESTAMPTZ DEFAULT NOW(),
  actualizado_por INTEGER REFERENCES usuarios(id)
);

-- ============================================================
--  DINERO DISPONIBLE DEL NEGOCIO (Parte 2)
-- ============================================================
-- Cuánto dinero hay ahora mismo, separado por dónde está (efectivo o
-- transferencia) y en qué moneda. El dueño lo declara y el sistema
-- lleva la cuenta a partir de ahí.
--
-- Por qué una tabla de MOVIMIENTOS y no un simple saldo editable: si
-- solo se guardara el número final, cada corrección borraría la
-- anterior y nadie podría explicar por qué el efectivo bajó de 50 000 a
-- 30 000. Aquí cada cambio deja su línea, y el saldo es la suma. Es la
-- misma idea del libro contable: los saldos se calculan, no se guardan.
CREATE TABLE IF NOT EXISTS dinero_movimientos (
  id          SERIAL PRIMARY KEY,
  forma       TEXT NOT NULL,            -- efectivo | transferencia
  moneda      TEXT NOT NULL DEFAULT 'CUP',
  monto       DOUBLE PRECISION NOT NULL, -- positivo suma, negativo resta
  concepto    TEXT NOT NULL,
  origen_tipo TEXT,                     -- ajuste | venta | gasto | traspaso
  origen_id   INTEGER,
  usuario_id  INTEGER REFERENCES usuarios(id),
  fecha       TIMESTAMPTZ NOT NULL DEFAULT now(),
  nota        TEXT
);
CREATE INDEX IF NOT EXISTS idx_dinero_fecha ON dinero_movimientos (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_dinero_saldo ON dinero_movimientos (forma, moneda);

-- ============================================================
--  DIRECCIÓN Y TELÉFONO DE LOS DESTINOS
-- ============================================================
-- Para el aviso por WhatsApp al transportista: sin la dirección, el
-- mensaje no sirve de nada. Se guardan en el destino (almacén o
-- vendedor) y no en cada transferencia, porque son datos del SITIO:
-- repetirlos en cada envío obligaría a teclearlos veinte veces y a
-- corregirlos veinte veces el día que el punto se mude.
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE almacenes ADD COLUMN IF NOT EXISTS telefono  TEXT;
ALTER TABLE usuarios  ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE usuarios  ADD COLUMN IF NOT EXISTS telefono  TEXT;

-- ============================================================
--  UNIDADES QUE FALTABAN
-- ============================================================
-- Las unidades solo se siembran cuando la base esta vacia, asi que anadirlas
-- a la semilla no servia de nada para una instalacion en marcha. Esto corre
-- en cada arranque y solo mete las que no estan.
--
-- Las de DISTANCIA hacen falta de verdad: la vicora (tripa) de los embutidos
-- y las etiquetas se compran por metros, y sin unidad no se podian anadir a
-- las fichas tecnicas de formulacion.
INSERT INTO unidades (nombre, abreviatura)
SELECT v.nombre, v.abrev
  FROM (VALUES
        ('Metro', 'm'),
        ('Centímetro', 'cm'),
        ('Rollo', 'rollo'),
        ('Mililitro', 'ml'),
        ('Litro', 'L'),
        ('Gramo', 'g')
       ) AS v(nombre, abrev)
 WHERE NOT EXISTS (SELECT 1 FROM unidades u WHERE u.abreviatura = v.abrev);
