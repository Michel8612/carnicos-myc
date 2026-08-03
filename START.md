# START — Por dónde seguir

> **Lee esto primero.** Es la guía para retomar el trabajo.
> El contexto profundo (historia, decisiones de negocio, trampas viejas) está en
> `MEMORIA-DEL-PROYECTO.md`, pero **ese archivo es del 29 de julio y no incluye las dos
> últimas entregas**. Si los dos se contradicen, manda este.
>
> Última actualización: **2 de agosto de 2026 (noche)** — sección 10 terminada,
> pendiente de desplegar.

---

## 0. Estado al parar (2 de agosto de 2026, noche)

**La sección 10 está TERMINADA.** Los once puntos que faltaban están escritos y
probados en local: **10 baterías, 0 fallas**, incluida la regresión completa de
todo lo anterior.

**DESPLEGADO Y PROBADO CONTRA PRODUCCIÓN** el 2 de agosto por la noche
(commit `20a2b29`, subido a GitHub): 45/45 de la batería principal contra la URL
real, más una comprobación de solo lectura de las nueve rutas nuevas y una descarga
de Excel de verdad desde la nube. Lo único que queda son las gestiones que dependen
del cliente (punto 4).

**La base de producción se dejó EN BLANCO** el 3 de agosto para entregársela al
cliente. Con esto desapareció también la venta disparatada de 147 000 000 CUP que
tenía el libro (era un error de tecleo y deformaba todos los informes).

- Se hizo con el propio botón de restaurar de la aplicación, mandándole un respaldo
  con las tablas de operación vacías. Nada de SQL por fuera.
- **Sobrevive solo `admin` / `admin123`.** Los usuarios Kevin y lolo se borraron: el
  cliente crea su propio personal. **Lo primero que debe hacer es cambiar esa clave.**
- Se conservó la configuración de fábrica: 14 categorías de gasto, 10 unidades, el
  «Almacén principal», los parámetros de tributación y los documentos legales. Sin
  las categorías de gasto la tributación dejaría de calcular.
- Catálogo, ventas, libro, almacén, bancos y datos fiscales quedaron a cero.
- La copia de antes de limpiar está en el scratchpad de la sesión
  (`respaldo-produccion-antes-de-limpiar.json`, 218 KB). **No está en el repo**: si
  hace falta conservarla, hay que moverla a sitio seguro antes de que se borre.

Aviso de entorno: la base de pruebas pasó del **5433** al **5544**. Windows metió
el rango 5433-5532 en sus puertos reservados y el contenedor dejó de arrancar
(`bind: Intento de acceso a un socket no permitido`). El contenedor de pruebas
sigue llamándose `gestion-db-test`, ahora mapeado a 5544 y **reutilizando el mismo
volumen de datos**; el anterior quedó renombrado como `gestion-db-test-old5433`
por si hiciera falta. TREBOL (`D:\TREBOL`) está en el 5434, así que no chocan.

---

## 1. Dónde está todo

| Qué | Dónde |
|---|---|
| Carpeta de trabajo (la enlazada a Netlify) | `D:\prueba no borrar\carnicos-myc\` |
| App en producción | https://carnicos-myc-gestion.netlify.app |
| Repositorio | https://github.com/Michel8612/carnicos-myc (**público**) |
| Base de datos | Neon (PostgreSQL), proyecto `withered-sunset-27343021` |
| Último commit desplegado | `20a2b29` — sección 10 completa (2 ago, noche) |

**Acceso:** `admin` / `admin123`

---

## 2. Qué está hecho y funcionando

Las entregas del 29 y 30 de julio y la del 2 de agosto por la mañana están
**desplegadas y probadas contra producción** (45/45). La última, la del 2 de agosto
por la noche, está probada **solo en local**: ver el aviso del punto 0.

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

**Entrega del 2 de agosto (noche) — segunda entrega de la sección 10, SIN DESPLEGAR**

Con esto la sección 10 queda cerrada. Once puntos, cinco áreas nuevas:

- **Informes contables** (`informes.html`) — Estado de resultados, Balance general y
  Flujo de caja, con filtro de fechas. Los tres se **descargan en Excel y CSV de verdad**
  y se imprimen (Ctrl+P → Guardar como PDF) con una vista limpia. Esto es lo que se le
  presenta a la ONAT y al banco.
  - El **balance** valora el inventario al costo, suma bancos, caja y lo que deben, resta
    lo que se debe, y el patrimonio sale **por diferencia** (se avisa en la propia pantalla).
  - El **flujo de caja** solo cuenta dinero real (banco + caja). Los cobros y pagos de
    documentos van aparte, marcados como referencia: si ese cobro ya entró al banco,
    sumarlo lo contaría dos veces.
- **Cobros y pagos** (`cuentas.html`) — cuentas por cobrar y por pagar con vencimientos,
  pagos parciales, estado automático (pendiente → parcial → pagada) y **antigüedad de
  saldos** por tramos (0-30 / 31-60 / 61-90 / +90). Un documento nunca se borra: se anula
  con motivo. No se puede cambiar el importe de algo que ya tiene pagos.
- **Presupuestos** (`presupuestos.html`) — lo previsto contra lo real, con semáforo
  (en gastos pasarse es rojo; en ingresos es al revés). El "real" de un gasto sale de la
  tabla de gastos por categoría; el de un ingreso, del libro por tipo o por área.
- **Conteo físico** (`conciliacion.html`) — se abre un conteo por almacén, que **congela la
  existencia de ese instante**, se cuenta a mano desde el teléfono (guarda por fila, sin
  botón de "guardar todo") y al cerrar se ajustan las existencias dejando su movimiento de
  tipo `ajuste` en el historial. **Un conteo cerrado no se reabre ni se edita**: es el acta.
  También se puede cerrar sin ajustar, solo como constancia.
- **Indicadores** (`tablero.html`) — cómo va el negocio en una pantalla: ventas, ganancia,
  gastos, resultado, inventario, bancos, caja, por cobrar/por pagar, alertas de stock bajo
  y un gráfico de 30 días. El gráfico es **SVG dibujado a mano, sin librerías ni CDN**.
- **Centro de avisos** (`avisos.html`) — la pantalla completa que le faltaba a la campanita,
  con filtros y "marcar todas como leídas".

Además se arregló un fallo real de lo ya entregado: **la campanita nunca marcaba nada**
porque leía `total` y el servidor devuelve `sin_leer`.

---

## 3. Qué falta para entregar

El código está terminado y desplegado. Lo que queda no es programar:

1. **Enseñarle al cliente la venta de 147 000 000** (ver el aviso del punto 0) y que decida
   si la corrige. Mientras esté ahí, todos los informes salen deformados.
2. **Las gestiones del punto 4**, que dependen del cliente y no se pueden adelantar aquí.
3. **Recorrer las pantallas nuevas con el cliente delante.** Están probadas por API y
   revisadas de forma estática (que no llamen a métodos inexistentes, que los elementos
   existan, que no haya `return` suelto), pero **nadie las ha recorrido clic a clic**.
4. **Decidir el plan de Neon** y cada cuánto se pulsará el botón de copia de seguridad.

Y conviene saber, antes de prometerle nada al cliente sobre "funcionar para siempre":

- **La base de datos (Neon) y el hosting (Netlify) son gratuitos, y para este negocio
  el plan gratis basta.** La base se duerme a los **5 minutos** sin uso, pero **despierta
  en décimas de segundo**: no se nota. El archivado a almacenamiento frío solo ocurre tras
  14 días de vida y 24 h sin tocarla, y se deshace solo al entrar. **No se pierde nada.**
  Lo que sí hay que vigilar son los dos topes reales del plan gratis: **0,5 GB de
  almacenamiento** y **100 horas de cómputo al mes** (unas 13 h de uso activo al día).
  Revisar el consumo tras un mes de uso real. Si se queda corto, el plan Launch es por uso
  (0,106 USD/hora de cómputo + 0,35 USD/GB al mes): entre 9 y 20 USD al mes según se deje
  dormir la base o no. Consultado el 2 de agosto de 2026 en neon.com/docs/introduction/plans.
- **No hay copia de seguridad automática.** La pantalla de respaldos existe, pero alguien
  tiene que entrar y pulsar. Merece la pena acordar con el cliente cada cuánto lo hará.
- **Sobre "compilarlo"**: esto es una aplicación web, no se compila. Se abre desde el
  navegador con su dirección. Si lo que se quiere es un icono en el teléfono, ya está el
  `capacitor.config.json` para empaquetarla como APK de Android — eso sí sería trabajo
  aparte y todavía no está hecho ni probado.

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
# 1) Postgres de prueba  (OJO: ahora en el 5544, no en el 5433)
docker start gestion-db-test

# 2) Base LIMPIA (imprescindible: los tests no son idempotentes)
docker exec -e PGPASSWORD=gestion123 gestion-db-test psql -U gestion -d gestion -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# 3) Servidor (recrea el esquema y el usuario admin)
cd "D:\prueba no borrar\carnicos-myc"
$env:DATABASE_URL="postgres://gestion:gestion123@localhost:5544/gestion"; $env:PGSSL="off"; $env:JWT_SECRETO="local"; $env:PUERTO="3012"; node backend/src/server.js

# 4) Sembrar el escenario (usuarios alm1=2, alm2=3, central=4, coci=5, vend=6, clave prueba123)
node pruebas/sembrar.mjs

# 5) Batería principal (45 comprobaciones de todo el contrato + regresión)
node pruebas/test-fase1.mjs

# 6) Baterías por área, EN ESTE ORDEN y cada una UNA sola vez
node pruebas/test_transferencias.mjs
node pruebas/test_transferencias2.mjs
node pruebas/test_extra_cancelar_vendedor.mjs
node pruebas/test_tributacion.mjs
node pruebas/test_carrito.mjs
node pruebas/test_regresion.mjs
node pruebas/test-compras.mjs
node pruebas/test_tasas.mjs

# 7) Segunda entrega de la sección 10 — va la ÚLTIMA (crea documentos y conteos)
node pruebas/test_seccion10b.mjs
```

Última ejecución completa (2 de agosto, noche): **10 baterías, 0 fallas**.
`test-fase1` dice «45 pasan, 0 fallan» y `test-compras` «6 pasan, 0 fallan»: cada
batería imprime su resultado con un formato distinto, no todas dicen «TOTAL FALLAS».

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
- **Nada de `return` en el nivel superior de los `.js` de `public/`.** Son scripts clásicos,
  no módulos: un `return` suelto arriba es un error de sintaxis y tumba el archivo entero.
  El patrón de la casa para las guardas de rol es `throw new Error('sin acceso')`.
- **Los puertos que hoy funcionan mañana pueden estar reservados por Windows.** Ya pasó con
  el 5433. Si un contenedor deja de arrancar con «bind: Intento de acceso a un socket no
  permitido», mirar `netsh interface ipv4 show excludedportrange protocol=tcp` y mover el
  puerto fuera de esos rangos, en vez de perder la tarde buscando el fallo en el código.
- **`/api/inventario/existencias` devuelve la existencia SUMADA de todos los almacenes.**
  Para comprobar un almacén concreto hay que ir a la tabla `existencias`.

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
- **El balance valora el inventario de HOY, no el de la fecha de corte.** La tabla
  `existencias` guarda el saldo actual, no su historial: no hay forma de reconstruir cuánto
  había un martes de marzo. Para cortes antiguos, la cifra de inventario es la de hoy.
- **El "real" de una línea de ingreso del presupuesto** se busca por tipo del libro
  (venta/almacen/produccion) o por área (ventas/almacen/cocina). Si la categoría no coincide
  con ninguno, sale en cero y la línea se marca; no es un fallo, es que no hay a qué atarla.
- **El flujo de caja no cuadra solo con la contabilidad.** Cuenta dinero movido, no derechos
  de cobro. Los cobros de documentos van aparte a propósito (ver punto 2).
- **Sin empaquetar como aplicación de teléfono.** El `capacitor.config.json` está, pero no se
  ha generado ni probado ningún APK.
- **⚠️ RESTAURAR UN RESPALDO BORRA LA AUDITORÍA — y el sistema dice que no.**
  `respaldos.js` excluye `auditoria` de la lista a restaurar y responde «La tabla de
  auditoría no se tocó», pero `auditoria.usuario_id` (y `autorizado_por`) tienen llave
  foránea a `usuarios`, así que el `TRUNCATE ... CASCADE` la arrastra igual. Comprobado
  el 3 de agosto al limpiar producción: pasó de 78 registros a 2.
  **Consecuencia real: cualquiera con la clave del dueño puede borrar el rastro de
  auditoría restaurando un respaldo**, que es justo lo que el diseño promete impedir.
  Arreglo correcto: quitarle a `auditoria` esas dos llaves foráneas — ya guarda
  `usuario_nombre` precisamente para sobrevivir al borrado de un usuario. Ojo: hay que
  hacerlo con un `ALTER TABLE`, porque `schema.sql` usa `CREATE TABLE IF NOT EXISTS` y
  no modifica tablas que ya existen. **Pendiente de decidir.**
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
