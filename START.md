# START — Por dónde seguir

> **Lee esto primero.** Es la guía para retomar el trabajo.
> El contexto profundo (historia, decisiones de negocio, trampas viejas) está en
> `MEMORIA-DEL-PROYECTO.md`, pero **ese archivo es del 29 de julio y no incluye las dos
> últimas entregas**. Si los dos se contradicen, manda este.
>
> Última actualización: **2 de agosto de 2026**

---

## 1. Dónde está todo

| Qué | Dónde |
|---|---|
| Carpeta de trabajo (la enlazada a Netlify) | `D:\prueba no borrar\carnicos-myc\` |
| App en producción | https://carnicos-myc-gestion.netlify.app |
| Repositorio | https://github.com/Michel8612/carnicos-myc (**público**) |
| Base de datos | Neon (PostgreSQL), proyecto `withered-sunset-27343021` |
| Último commit desplegado | `e7c6604` — ERP fase 1 |

**Acceso:** `admin` / `admin123`

---

## 2. Qué está hecho y funcionando

Todo lo de abajo está **desplegado y probado contra producción** (45/45).

**Entrega del 29 de julio**
- Carrito dentro del catálogo, con botón flotante.
- Transferencias entre áreas con recepción: la salida queda pendiente hasta que el
  destinatario la acepta. **Si la cancela, la mercancía vuelve al origen.**
- Tasa del dólar de elTOQUE (servicio desacoplado, caché, respaldo manual).
- Módulo tributario, gastos y nómina.

**Entrega del 30 de julio (secciones 1-9 del documento del ERP)**
- **Auditoría** central de todo. *No existe ruta para borrarla, a propósito.*
- **Seguridad**: sesiones, expiración a las 12 h, cierre de sesión auditado,
  y permiso temporal del administrador **de un solo uso**.
- **Historiales protegidos**: almacén solo admin; libro contable con la clave del admin.
- **Tributación**: tipo de empresa "Otro" + corrección manual con motivo obligatorio.
- **Gastos**: borrado con motivo + categorías configurables.
- **Ventas**: ventana de cantidad antes del carrito, que nunca pasa de la existencia.
- **Empresa**: datos fiscales editables.
- **Bancos**: cuentas, movimientos manuales y conciliación.
- **Pagos**: proveedor desacoplado (EnZona + Transfermóvil).
- **Legal**: términos, privacidad y tratamiento de datos, versionados.

---

**Entrega del 2 de agosto**
- **El tributo cambió de base.** Ya NO lo afectan las ventas, el almacén ni las recetas.
  Ahora se calcula con las **entradas de dinero en el banco** más los **gastos**.
  Cada cálculo queda en un historial que **solo el administrador puede borrar**.
- **Contabilidad**: selector para ver el punto de venta, un almacén concreto o la cocina,
  y borrado con la ✕ roja donde faltaba.
- **Almacén**: un producto se puede dar de alta ya con su cantidad inicial. La entrada
  queda en el historial como cualquier otra. El flujo de entradas y salidas no se tocó.
- **Ventas**: «Reiniciar jornada» ahora se llama **«Cierre diario»**, y los cierres se ven
  en un historial.
- **Avisos**: cuando el cocinero produce una receta, al almacenero le llega una notificación
  para darle entrada. Campanita arriba a la derecha en las pantallas principales.
- **Conexiones externas** (`credenciales.html`): el token de elTOQUE, Transfermóvil y lo que
  venga se ponen **desde el panel**, sin tocar código ni volver a desplegar. Lo guardado
  manda sobre la variable de entorno. El valor nunca vuelve al navegador.
- **Copias de seguridad** (`respaldos.html`): descarga de toda la base en JSON y restauración
  con confirmación escrita a mano. La auditoría nunca se sobrescribe.

---

## 3. Qué falta — Sección 10 del documento

De los doce puntos que quedaban, **copias de seguridad ya está hecho** (era el único cuyo
fallo no tenía arreglo). Quedan **once**, agrupados en una segunda entrega:

1. **Reportes exportables (PDF y Excel)** ← *empezar por aquí*
   Sin esto no se puede presentar nada a la ONAT ni al banco.
   Ya está escrita la librería `backend/src/servicios/exportar.js` (CSV y Excel reales con
   exceljs); el PDF se resuelve con vista de impresión, no con un motor en el servidor.
2. **Estado de resultados · Balance general · Flujo de caja**
3. **Cuentas por cobrar · Cuentas por pagar**
4. **Presupuestos · Conciliación de inventario**
5. **Dashboard de indicadores · Centro de notificaciones**
   El centro de avisos ya tiene backend (`routes/notificaciones.js`) y campanita; falta la
   pantalla completa.

**Las tablas de los once puntos YA ESTÁN CREADAS** en `schema.sql` (`cuentas_terceros`,
`cuentas_pagos`, `presupuestos`, `presupuesto_lineas`, `conciliaciones`,
`conciliacion_lineas`, `notificaciones`). Falta el código de las rutas y las pantallas.
Sus montajes en `server.js` están comentados en el bloque «Sección 10 del ERP»:
al crear cada archivo de ruta, se descomenta el suyo.

## 4. Gestiones que dependen del cliente (aquí no se puede avanzar solo)

| Gestión | Dónde | Efecto mientras tanto |
|---|---|---|
| Token de la API de elTOQUE | `tasas.eltoque.com` (2-3 días) | La tasa se pone a mano |
| Credenciales de comercio EnZona | `bulevar.enzona.net` | El adaptador está escrito pero **sin verificar** |
| Contrato de Transfermóvil | `etecsa.cu/es/emprendedores/transfermovil` | Declarado, siempre `disponible:false` |
| Confirmar porcentajes con la ONAT | — | El cálculo es correcto; las cifras son de referencia |

---

## 5. Cómo probar (hacerlo SIEMPRE antes de entregar)

Las baterías están en `pruebas/` — **dentro del repositorio**, para que no se pierdan como
ocurrió con las anteriores.

```bash
# 1) Postgres de prueba
docker start gestion-db-test

# 2) Base LIMPIA (imprescindible: los tests no son idempotentes)
docker exec -e PGPASSWORD=gestion123 gestion-db-test psql -U gestion -d gestion -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# 3) Servidor (recrea el esquema y el usuario admin)
cd "D:\prueba no borrar\carnicos-myc"
$env:DATABASE_URL="postgres://gestion:gestion123@localhost:5433/gestion"; $env:PGSSL="off"; $env:JWT_SECRETO="local"; $env:PUERTO="3012"; node backend/src/server.js

# 4) Sembrar el escenario (usuarios alm1=2, alm2=3, central=4, coci=5, vend=6, clave prueba123)
node pruebas/sembrar.mjs

# 5) Batería principal (45 comprobaciones de todo el contrato + regresión)
node pruebas/test-fase1.mjs

# 6) Baterías por área
node pruebas/test_transferencias.mjs
node pruebas/test_transferencias2.mjs
node pruebas/test_extra_cancelar_vendedor.mjs
node pruebas/test_tributacion.mjs
node pruebas/test_carrito.mjs
node pruebas/test_regresion.mjs
node pruebas/test-compras.mjs
node pruebas/test_tasas.mjs
```

**Contra producción:** `BASE=https://carnicos-myc-gestion.netlify.app/api node pruebas/test-fase1.mjs`

---

## 6. Cómo desplegar

```bash
cd "D:\prueba no borrar\carnicos-myc"
node pruebas/gen-schema.mjs
netlify deploy --prod --skip-functions-cache
git push
```

Si no encuentra `netlify`: `$env:PATH="$env:PATH;$env:APPDATA\npm"`.
La conexión falla a menudo (Cuba): **reintentar varias veces**, no es error del código.

---

## 7. Trampas — no repetirlas

- **`schema.js` se desincroniza de `schema.sql` y no avisa.** Es el que viaja a Netlify (los
  `.sql` no se empaquetan en la función serverless). **Regenerar SIEMPRE con
  `node pruebas/gen-schema.mjs` antes de desplegar.** Ya pasó: llegó a estar 198 líneas atrás.
- **Los tests no son idempotentes.** Base limpia + sembrar + ejecutar cada uno UNA vez. Si no,
  se ven fallos que no existen ("ese usuario ya existe" → todo lo demás cae en cascada).
- **Probar contra la nube, no solo en local.** Una venta ya falló solo en producción.
- **No editar archivos con PowerShell**: rompe los acentos (`Ã`, `â€`). Usar edición normal.
- **El envoltorio de la base añade `RETURNING id` a todo INSERT sin `RETURNING`.** Si la tabla
  no tiene columna `id` (por ejemplo `parametros`), hay que poner un `RETURNING` explícito.
- **`js/sonidos.js` pone un botón flotante abajo a la derecha.** Cualquier otro botón flotante
  tiene que esquivarlo (el del carrito va a `bottom:70px`).

---

## 8. Deudas técnicas conocidas (pequeñas, pero reales)

- **Contabilidad no puede borrar gastos ni categorías.** Decisión deliberada: darle escritura
  en `/api/costos` le daría crear y editar *todo* el módulo de costos. Si hace falta, usar el
  mismo mecanismo de autorización temporal del admin que ya tiene el libro contable.
- **Nómina, electricidad y alquiler solo entran al cálculo tributario si se registran como
  gastos** con esas categorías. El sistema no puede adivinarlos.
- **Las compras solo se registran desde la entrada de almacén** indicando proveedor. No hay
  pantalla de compras aparte, a propósito (sería duplicar la entrada de almacén).
- **Sin probar: concurrencia.** Dos vendedores tocando el mismo producto a la vez.
- **Sin probar: EnZona real.** El mapeo de su respuesta está aislado en una sola función
  marcada como no verificada, para corregirlo en un único sitio cuando lleguen credenciales.

---

## 9. Variables de entorno

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Conexión a Postgres (en Netlify apunta a Neon) |
| `JWT_SECRETO` | Firma de las sesiones |
| `ELTOQUE_TOKEN` | Tasa del dólar. Sin ella, se usa la tasa manual |
| `ENZONA_CLIENT_ID` / `ENZONA_CLIENT_SECRET` | Pasarela EnZona |
| `ENZONA_SANDBOX=true` | Usar `apisandbox.enzona.net` en vez de producción |

---

## 10. Cómo trabaja el cliente (preferencias)

- Español, explicaciones claras y cortas, sin tecnicismos innecesarios.
- **Ahorro de tokens extremo**: razonar con el modelo bueno y ejecutar con los baratos,
  reutilizar código, no reescribir archivos completos, usar agentes en paralelo.
- No cambiar lo que ya funciona: solo lo que se pide.
- Comentarios del código **en español**, explicando el porqué.
