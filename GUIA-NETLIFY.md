# Cárnicos M&C — Montar en la nube (Netlify + Neon)

La app ya está reparada y probada en local. Esta guía la deja funcionando en internet,
accesible desde **PC, teléfono y tablet**. Base de datos: **PostgreSQL en Neon** (gratis
para empezar). Son unos 10 minutos.

Estructura del proyecto:
- `public/` → el frontend (las pantallas del cliente, ya sin Firebase).
- `backend/` → el servidor (Node + PostgreSQL).
- `netlify/functions/api.js` → el backend empaquetado como función de Netlify.
- `netlify.toml` → la configuración (ya lista).

---

## Paso 1 — Base de datos (Neon)

**Opción A (fácil):** en Netlify, dentro del sitio → **Integrations/Extensions** → **Neon**
→ *Add database*. Netlify define sola `NETLIFY_DATABASE_URL` y la app la usa. No copias nada.

**Opción B:** crea una gratis en https://neon.tech → copia la *connection string*
(`postgresql://...`) y ponla como variable `DATABASE_URL` (Paso 3).

> La app crea las tablas sola la primera vez y crea el usuario inicial
> el usuario **admin** con datos de ejemplo (almacenes y unidades). La clave inicial
> se genera en la instalación y **no se publica en este repositorio**.

---

## Paso 2 — Subir y crear el sitio

**Con GitHub (recomendado):**
1. Sube la carpeta `carnicos-myc` a un repositorio de GitHub.
2. En https://app.netlify.com → **Add new site → Import an existing project** → elige el repo.
3. Netlify lee `netlify.toml` y usa: publish `public`, functions `netlify/functions`.
   Si subiste todo el repo grande, pon **Base directory:** `carnicos-myc`.

**Sin GitHub (línea de comandos):**
```bash
npm install -g netlify-cli
cd carnicos-myc
netlify deploy --build --prod
```

---

## Paso 3 — Variables de entorno

En el sitio → **Site configuration → Environment variables**:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | La cadena de Neon (solo si usaste la **Opción B**). |
| `JWT_SECRETO` | Una clave larga inventada (para las sesiones). |

Luego **Deploy → Trigger deploy**.

---

## Paso 4 — Entrar

1. Abre la URL de Netlify (ej. `https://carnicos-myc.netlify.app`).
2. Entra con el usuario **admin** y la clave que se te entregó aparte, y **cámbiala en el acto**
   desde el panel: “Cambiar Usuario/Contraseña Admin”.

### Instalar como app en el teléfono/PC
- **Android (Chrome):** menú ⋮ → *Agregar a pantalla de inicio*.
- **Windows (Chrome/Edge):** icono de instalar en la barra de direcciones.

> Más adelante se puede empaquetar como **APK real (Android)** y **.exe (Windows)** apuntando
> a esta misma nube. La web no cambia; solo se envuelve.

---

## Notas
- **Backups:** Neon guarda copias automáticas.
- **Seguridad:** cambia `JWT_SECRETO` por un valor propio y no lo compartas.
- **Local (para pruebas):** `cd backend` y con `DATABASE_URL` en el entorno,
  `node src/server.js` → abre `http://localhost:3001`.
