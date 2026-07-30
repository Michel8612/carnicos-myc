# START — Por dónde seguir

> **Lee esto primero.** Es la guía para retomar el trabajo.
> El contexto profundo (historia, decisiones de negocio, trampas viejas) está en
> `MEMORIA-DEL-PROYECTO.md`, pero **ese archivo es del 29 de julio y no incluye las dos
> últimas entregas**. Si los dos se contradicen, manda este.
>
> Última actualización: **30 de julio de 2026**

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

## 3. Qué falta — Sección 10 del documento

Cuatro puntos de esa sección ya quedaron cubiertos (configuración de impuestos, de monedas,
de permisos, y registro de actividad por usuario). Faltan **doce**:

**Orden recomendado:**

1. **Copias de seguridad y restauración** ← *empezar por aquí*
   Es el único punto cuyo fallo no tiene arreglo. Todo el negocio del cliente vive en una
   sola base de datos de Neon.
2. **Reportes exportables (PDF y Excel)**
   Sin esto no se puede presentar nada a la ONAT ni al banco.
3. **Estado de resultados · Balance general · Flujo de caja**
   Los tres informes que dicen si el negocio gana dinero.
4. **Cuentas por cobrar · Cuentas por pagar**
5. **Presupuestos · Conciliación de inventario**
6. **Dashboard de indicadores · Centro de notificaciones**
   Los últimos: se ven bien, pero hoy no resuelven ningún problema real.

---

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
