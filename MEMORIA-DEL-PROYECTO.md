# Cárnicos M&C — Memoria del proyecto

> **Para retomar el trabajo en otra ventana:** lee este archivo primero. Contiene el estado,
> las decisiones tomadas y cómo se prueba y se despliega, para no tener que redescubrirlo.
>
> Última actualización: **29 de julio de 2026**

---

## 1. Qué es

Sistema de gestión para **Cárnicos M&C**, un negocio de embutidos (cliente real, es un
entregable que se cobra). Maneja almacén, recetas, producción, ventas y contabilidad.

**Origen:** el cliente lo tenía como web estática en **Firebase** ("Copia de la web 50000.rar",
internamente "Control Económico App"): login, admin, recetas, almacén, ventas, contabilidad,
cálculos y usuarios, pero incompleto y desconectado (recetas con insumos en texto libre, sin
enlace al inventario). Se pidió repararlo **conservando su diseño**, migrarlo a **PostgreSQL**
y ponerlo **en la nube**.

Silicon Bay (otro proyecto) se usó **solo como referencia**: su backend Node/Postgres ya probado
se reutilizó como motor.

---

## 2. Dónde está todo

| Qué | Dónde |
|---|---|
| **Carpeta de trabajo** | `D:\prueba no borrar\carnicos-myc\` ← es la enlazada a Netlify |
| Copia sincronizada | `D:\Proyectos claude\carnicos-myc\` (puede estar atrasada) |
| **App en producción** | https://carnicos-myc-gestion.netlify.app |
| Repositorio | https://github.com/Michel8612/carnicos-myc (**público**) |
| Sitio Netlify | `carnicos-myc-gestion`, id `4e865ec4-cd06-422c-8c8d-9f02a074f08e`, equipo *Taino Labs* |
| Base de datos | **Neon** (PostgreSQL), proyecto `withered-sunset-27343021`, base `carnicos-myc` |
| APK Android | GitHub → Actions → artefacto `carnicos-myc-apk` |

**Acceso inicial:** usuario `admin`; la clave se entrega aparte, nunca en este repositorio.

> ⚠️ La contraseña de la base **no se escribe aquí** porque este repositorio es público.
> Está en las variables de entorno de Netlify (`DATABASE_URL`). **Pendiente: rotarla**, porque
> en su momento se compartió por chat.

---

## 3. Arquitectura

```
public/          → el frontend del cliente (HTML/CSS/JS plano, sin frameworks, en español)
backend/src/     → Express + PostgreSQL
netlify/functions/api.mjs → el mismo Express empaquetado como función serverless
netlify.toml     → publish=public, functions=netlify/functions, /api/* → la función
assets/          → imágenes del icono y la pantalla de inicio de la app Android
.github/workflows/android-apk.yml → compila el APK
```

- **Sin frameworks en el frontend**: son páginas sueltas que comparten `js/api.js`.
- `js/api.js` expone `window.API` con todos los métodos, más `apiFetch` (global, sin IIFE),
  `soloRoles()`, `esDueno()`, `etiquetaRol()`, `homeDeRol()`.
- `js/sonidos.js` da sonido a los botones (se genera con Web Audio, sin archivos).
- El esquema vive **dos veces**: `backend/src/db/schema.sql` (fuente) y `schema.js` (módulo JS).
  En Netlify los `.sql` no viajan con la función, por eso hay que **regenerar** tras cada cambio:

```bash
python "C:\Users\Romer\AppData\Local\Temp\claude\D--Proyectos-claude\<sesión>\scratchpad\gen-schema.py"
```

Si no está ese script: genera `schema.js` exportando `SCHEMA_SQL` con el contenido de `schema.sql`
dentro de un *template literal* (escapando `` ` `` , `\` y `${`).

---

## 4. Roles y qué puede cada uno

| Rol (en la base) | Se ve como | Puede |
|---|---|---|
| `dueno` / `admin` | Dueño | **Todo, en todas las áreas** |
| `cocinero` | Cocinero | Recetas, cálculos y producción |
| `almacen` | Almacén | Su **propio** almacén (se le crea "Almacén de *nombre*" al darlo de alta) |
| `almacen_central` | Almacenero Central | **Todos** los almacenes, sin tener uno propio |
| `ventas` | Ventas | Su hoja de venta, catálogo, carrito e historial |
| `contabilidad` | Contabilidad | **Solo mirar** + borrar líneas del libro |

- Los permisos se aplican en `server.js` con `escrituraSoloRoles(...)`: **leer** puede cualquiera
  con sesión; **escribir** solo el dueño y el rol de esa sección.
- El límite "solo tu almacén" está centralizado en `ES_ALMACENERO_LIMITADO` (`inventario.js`).
  `almacen_central` queda fuera de ese límite, igual que el dueño.
- Cada usuario tiene **su área**: el almacenero su almacén, el vendedor su hoja de ventas.
  Al eliminar un usuario con datos, se avisa y se elige: **pasar el área a otro** o borrarla.

---

## 5. Reglas de negocio (decisiones tomadas — no cambiar sin preguntar)

1. **La receta ES el producto.** No se elige un "producto final": el nombre de la receta crea o
   enlaza solo el producto terminado. Si se renombra la receta, se renombra el producto.

2. **Las recetas no dependen del almacén.** El cocinero puede crear sus componentes desde su
   propia área (`POST /recetas/componente`) aunque el almacén esté vacío.

3. **Producir SÍ descuenta del almacén elegido** (regla vigente desde el 29/07/2026; antes era
   al revés). Es **todo o nada**: si falta un ingrediente responde `400` con `faltantes[]` y no
   escribe nada. El producto terminado **no entra solo** al almacén: queda en
   `produccion_disponible` esperando a que el almacenero le dé entrada.

4. **Ventas es independiente del almacén.** Cada vendedor tiene su propia lista
   (`venta_inventario`) con su costo y su precio. Son áreas distintas a propósito.

5. **Criterio contable — importante:** comprar mercancía o producir **no resta ganancia**: es
   cambiar dinero por inventario. Se guardan en la columna `valor`, no en `costo`. La ganancia
   sale de **ventas menos el costo de lo vendido**. La "ganancia potencial" del almacén solo se
   calcula sobre productos con precio de venta (una materia prima no se vende tal cual).

6. **Borrar del historial no deshace nada.** La X roja del historial de ventas solo pone
   `ventas.oculto=1`; no devuelve inventario ni anula la venta. Igual en el libro de contabilidad.

7. **Las imágenes van en la base** como *data URL* (columna `imagen TEXT`), comprimidas en el
   navegador a 400px / JPEG 0.7. El producto **hereda** la imagen de su receta y esa imagen
   aparece en inventario, almacén y ventas sin volver a cargarla.

---

## 6. Cómo probar (hazlo siempre antes de entregar)

Hay 5 baterías en el `scratchpad` de la sesión (`test-*.mjs`). En total **159 comprobaciones**.

```bash
# 1) Postgres de prueba (contenedor ya creado)
docker start gestion-db-test

# 2) Base limpia + servidor
docker exec -e PGPASSWORD=gestion123 gestion-db-test psql -U gestion -d gestion -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
cd "D:\prueba no borrar\carnicos-myc"
$env:DATABASE_URL="postgres://gestion:gestion123@localhost:5433/gestion"; $env:PGSSL="off"; $env:JWT_SECRETO="local"; $env:PUERTO="3012"
node backend/src/server.js

# 3) Correr cada batería (reiniciando la base entre una y otra)
node <scratchpad>/test-v3.mjs        # 39 — rol central, producción, imágenes, carrito
node <scratchpad>/test-integral.mjs  # 49 — recorrido completo
node <scratchpad>/test-contab.mjs    # 33 — ventas y contabilidad
node <scratchpad>/test-nuevos.mjs    # 22 — áreas, eliminar usuarios, salidas
node <scratchpad>/test-calculos.mjs  # 16 — historial de cálculos y unidades
```

Para probar **contra la nube**: `$env:BASE="https://carnicos-myc-gestion.netlify.app/api"`.

> **Lección aprendida (importante):** una venta falló **solo en la nube** y en local pasaba por
> casualidad (los números de dos tablas coincidían). **Prueba siempre contra la nube con la base
> limpia**, no te fíes solo del local. Los tests dejan datos: límpialos antes de sacar
> conclusiones, o verás fallos que no existen.

---

## 7. Cómo desplegar

```bash
cd "D:\prueba no borrar\carnicos-myc"
netlify deploy --prod --skip-functions-cache
git push
```

Si `netlify` no se encuentra: `$env:PATH="$env:PATH;$env:APPDATA\npm"`.

La conexión falla a menudo (Cuba): **reintenta varias veces**, no es un error del código.

**Dejar la base lista para el cliente:** hay un script que borra todos los datos y deja solo
el usuario `admin` con un almacén. Se crea temporalmente en la carpeta del proyecto (para usar
sus dependencias `pg` y `bcryptjs`), se ejecuta con `NEON_URL` y **se borra después** — no debe
quedar en el repositorio.

---

## 8. La app de Android

- Es un **contenedor Capacitor** que solo abre la URL de Netlify: al desplegar la web,
  **la app se actualiza sola**, no hay que reinstalarla.
- Se compila en **GitHub Actions con imagen Docker** `ghcr.io/cirruslabs/android-sdk:34`.
  Con la imagen normal de GitHub **falla**: trae Java 21 y Capacitor necesita **Java 17**.
- Abre siempre en **vertical**; la orientación se fija editando el manifiesto **con Node**, no con
  `sed` (el nombre de la actividad cambia según la versión de Capacitor y fallaba en silencio).
- Los iconos salen de `assets/`, generados desde `public/img/logo.png`. **El logo trae mucho
  espacio transparente: hay que recortarlo antes de centrarlo** o sale descuadrado.
- GitHub entrega el artefacto en un `.zip`; **dentro** está el `.apk` (unos 10 MB). Es normal.

---

## 9. Trampas conocidas (ya resueltas, pero no las repitas)

- **`pg` debe empaquetarse** en la función serverless; solo `pg-native` va como externo. Si no,
  la función no arranca y da 502.
- **`import.meta.url`** queda indefinido tras empaquetar: está protegido con `try/catch`.
- **`netlify db init` no sirve**: instala dependencias que apuntan a una Postgres *local* y pisan
  `DATABASE_URL`. La base se creó directo en neon.tech.
- **El MCP de Netlify miente al guardar variables**: dice "upserted" pero no las guarda.
  Usa siempre `netlify env:set`.
- **Editar archivos con PowerShell rompe los acentos** (quedan `Ã`, `â€`, `Â`). Usa las
  herramientas de edición normales, y revisa que no quede *mojibake* ni BOM.
- **`ventas_detalle.producto_id` no lleva llave foránea** a propósito: una línea puede apuntar al
  catálogo del almacén o a la lista propia del vendedor, que son tablas distintas.

---

## 10. Qué queda pendiente

1. **Rotar la contraseña de Neon** (se compartió por chat). En Neon → Roles → `neondb_owner` →
   *Reset password*, y actualizar `DATABASE_URL` en Netlify.
2. **El `.exe` de Windows** (se haría igual que el APK: Docker + GitHub Actions, con Tauri o Electron).
3. Dominio propio en lugar de `.netlify.app`.

---

## 11. Cómo trabaja el usuario (preferencias)

- Habla en español; **prefiere explicaciones claras y cortas**, sin tecnicismos innecesarios.
- Pide **ahorrar tokens**: razonar con el modelo bueno y ejecutar con los baratos, reutilizar
  código, no reescribir archivos completos, y usar **agentes en paralelo** para avanzar más.
- No cambiar lo que ya funciona: solo lo que pide.
- Los comentarios del código van **en español**, explicando el porqué.
