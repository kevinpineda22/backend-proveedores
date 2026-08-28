# Portal de Proveedores — estado y pendientes

---

> **La lista de trabajo vive en [`PENDIENTES.md`](PENDIENTES.md).** Este archivo
> guarda el detalle y la historia de cada decisión.

## 0. PARA MAÑANA — leé solo esto para arrancar

**Cierre del 2026-08-27.** El sistema funciona de punta a punta: un proveedor
propone y firma, compras aprueba, y **SIESA aceptó una cotización real**
(*"Importacion exitosa"*). Los cinco puntos del pedido original están cerrados.

### Estado al cerrar

| | |
|---|---|
| Tests | **159** backend · **40** frontend, todos verdes |
| Catálogo | 18.866 cotizaciones · 337 proveedores · 403 cuentas |
| Cuentas activas | 1 (Altipal 800186960/006, de prueba) |
| Admins del portal | 1 (johanmerkahorro777) |
| Backend | `backend-proveedores.vercel.app`, escribiendo en **QA** |
| Frontend | solo localhost |

### Lo PRIMERO al abrir mañana

**1. Subir lo que quedó sin commitear.** El backend tiene 1 archivo (este doc); el
frontend tiene **9**, entre ellos la pantalla de administradores y las guardas del
tope:

```
M  src/pages/PortalProveedores/AdminPanel.jsx
M  src/pages/PortalProveedores/components/BandejaAprobaciones.jsx  (+ .css)
M  src/pages/PortalProveedores/hooks/useAprobaciones.js
?? src/pages/PortalProveedores/components/AdminsPortal.jsx  (+ .css)
?? src/pages/PortalProveedores/hooks/useAdmins.js
?? src/pages/PortalProveedores/utils/bandeja.js  (+ .test.js)
```

**2. Verificar en SIESA QA que el precio entró de verdad.** Es lo único de ayer
que quedó sin confirmar con los ojos:

> Ítem **179313** (VINO SAZON BLANCO), tercero **800186960**, sucursal **006**,
> fecha de activación **20/09/2026** → debería estar en **$13.920** con su
> **ICO de $4.974**.

SIESA respondió "Importacion exitosa", pero **nuestra consulta no lo puede
comprobar**: lee de PRODUCCIÓN y el conector escribe en QA. Hay que mirarlo desde
la pantalla del ERP.

### Etapa A cerrada (2026-08-27)

El modelo de acceso quedó completo. Lo que se agregó:

| | |
|---|---|
| **Recuperar contraseña** | `POST /api/publico/recuperar`. Mismo token de un solo uso, misma pantalla. Respuesta idéntica exista o no la cuenta; 3 pedidos cada 5 min; solo cuentas activas |
| **Inicio del proveedor** | Qué espera respuesta, qué se aprobó y **qué le rechazaron con el motivo**. Deriva del catálogo y las solicitudes, sin endpoint nuevo |
| **Puerta equivocada** | `AccesoIncorrecto` explica dónde está y ofrece **las dos** salidas, en vez de una redirección muda |
| **Design system** | Se adoptaron los tokens `--sfc-*` y se creó `styles/pp-shared.css` con primitivos `.pp-*`, igual que `traslados-shared.css` |

**Un bug que apareció probando sin sesión:** TanStack Query reintenta 3 veces por
defecto, así que durante ~7 segundos `error` seguía en `null` y la pantalla se
dibujaba con datos vacíos — un proveedor con la sesión vencida veía su catálogo
en cero y creía que se le había borrado todo. Se agregó `hooks/reintentos.js`:
**los 4xx no se reintentan**, porque la respuesta va a ser la misma.

### Etapa B cerrada (2026-08-27) — el pase de UI/UX

| | |
|---|---|
| **Design system** | `styles/pp-shared.css` con primitivos `.pp-*` sobre los tokens `--sfc-*` |
| **Puente de paleta** | `--pp-*` ahora APUNTA a `--sfc-*`: seis archivos de CSS toman el color de la casa sin reescribirlos |
| **Esqueletos de carga** | Reemplazan los "Cargando…" en catálogo, maestro y bandeja |
| **Estados vacíos** | Con ícono, explicación y **una salida** — nadie queda mirando una pantalla en blanco |
| **Tipografía** | Los títulos del portal ya no quedan en otra fuente que su propio panel |

**Cómo se hizo el cambio de paleta sin romper nada:** en vez de reescribir cada
regla, las variables viejas pasaron a apuntar a los tokens corporativos. Es un
puente, no el destino: **al escribir pantallas nuevas, usar `--sfc-*` directo.**

**Los estados vacíos siempre ofrecen una salida.** "Ningún producto coincide con
«zzzzz»" trae un botón para limpiar la búsqueda; "no hay productos cotizados"
explica que el catálogo lo carga SIESA y a quién preguntarle. Un estado vacío sin
salida es un callejón, y el usuario no sabe si se rompió algo o si está bien así.

**Por qué esqueletos y no un spinner:** un spinner dice "esperá" y deja la
pantalla en blanco; cuando llegan los datos, todo salta de lugar. Un esqueleto
ocupa el mismo espacio que el contenido real y la espera se siente más corta
aunque dure exactamente lo mismo. Con 198 filas de catálogo, esa diferencia es la
que separa "se colgó" de "está cargando".

### Etapa B, segunda parte — layout de la casa y paginación

**Sidebar.** El portal usa ahora el mismo armazón que el admin de picking
(`ecommerce/admin/PedidosAdmin`): barra oscura con degradado, navegación con
íconos, contadores por sección y el pie con quién está conectado. `PortalLayout`
sirve para los DOS lados —compras y proveedor— con la misma pieza y distinta
navegación.

**El ROL siempre visible** en el sidebar ("Compras" / "Proveedor"). Con dos mundos
que no se cruzan, la pregunta "¿como quién estoy viendo esto?" tiene que tener
respuesta sin hacer un clic.

**Paginación** en el maestro (337 proveedores) y en el catálogo (198 renglones).
`utils/paginacion.js`, función pura con 15 tests. Tres decisiones:

- **La página se CORRIGE si queda fuera de rango.** Pasa siempre: alguien está en
  la página 12, escribe en el buscador y quedan 8 resultados. Sin la corrección
  vería una tabla en blanco y creería que su búsqueda no encontró nada.
- **Los números colapsan con elipsis**, pero un hueco de UNA sola página se
  rellena: la elipsis ocupa lo mismo que el número, así que esconderlo pierde
  información sin ahorrar espacio.
- **Cambiar un filtro vuelve a la página 1**, por lo mismo del primer punto.

**Contadores solo cuando hay algo.** Un "0" permanente en el sidebar enseña a
ignorar el lugar donde después aparece el número que sí importa. El rojo se
reserva para lo que pide una decisión.

### Lo que falta, en orden

| # | Qué | Depende de |
|---|---|---|
| 1 | **Consulta de TERCEROS** — reemplaza el maestro provisional | SIESA |
| 2 | **Desplegar el frontend** + apuntar `PORTAL_PROVEEDORES_URL` | vos |
| 3 | **Pasar a producción**: `SIESA_COTIZACION_URL` de QA a prod | decisión |
| 4 | Limpiar los datos de prueba | cuando estorben |

Ninguno bloquea a los otros. El (1) es una función; el (3) es **una variable**.

### Bugs conocidos, sin resolver

**Ninguno abierto en el portal.** Los cuatro que aparecieron ayer están
arreglados y documentados en §3.2 bis — vale leerlos antes de tocar el empuje o
el manejo de errores, porque los cuatro fueron del tipo que los tests no agarran.

Lo que sí queda es **deuda ajena al portal**: el sistema de rutas de la app
(`dashboardRoutes` abre 30 rutas a cualquier usuario logueado). Está en §3.3.g y
en `PortalProveedores/RUTAS.md`, con el plan por pasos. **No se tocó a propósito.**

### Datos de prueba en la base

| Qué | Detalle |
|---|---|
| Cuenta Altipal 800186960/006 | activa, clave `Portal2026.Prueba` |
| Tope de Altipal | **1%** (era `NULL` — se bajó para probar la marca) |
| Solicitud #1 | `pendiente`, SARDINAS, +2,95% — **marcada**, sirve para probar la guarda |
| Solicitudes #2, #4 | `aplicada` en SANDBOX (no llegaron a SIESA) |
| Solicitud #5 | `aplicada` **de verdad en QA** — no la borres sin verificar el ERP |

```sql
-- Limpieza, cuando corresponda
DELETE FROM pp_solicitudes_precio WHERE cuenta_id = 59;
UPDATE pp_proveedores SET porcentaje_max = NULL WHERE nit = '800186960';
```

`pp_firmas` y `pp_auditoria` son append-only por trigger: las firmas de prueba
quedan, y está bien que queden.

### Cuando llegue la consulta de terceros

Está detallado en §3.1.a. El resumen:

1. Cargarla en Connekta **sin `ORDER BY`, sin `;`, sin comentarios** — el
   generador envuelve el query y esas tres cosas lo rompen.
2. **Copiar SU ConniKey y ConniToken**: cada consulta dinámica tiene los suyos.
   Un 401 que dice "verifique si tiene permisos" casi siempre es esto.
3. Reescribir `sincronizarMaestro()` para leer de ahí. **Solo esa función** — las
   tablas, los endpoints y el panel ya tienen la forma final.
4. **Mantener `ignoreDuplicates: true`** en los upsert, o cada corrida del cron
   borra los topes que compras configuró a mano.

### Arrancar

```bash
cd C:/Users/johan.sanchez/Desktop/BACKEND/backend-proveedores && npm test && npm run dev
cd C:/Users/johan.sanchez/Desktop/Pagina-web_React && npm run dev
```

| Entrar como | Dónde |
|---|---|
| Proveedor | `/portal-proveedores/ingreso` — NIT 800186960, suc. 006 |
| Compras | `/portal-proveedores/maestro` |

---

Documento de retomada. Escrito el **2026-08-27**, al cierre de la primera etapa.

Si volvés a este proyecto dentro de un mes y no te acordás de nada, leé este
archivo primero. Los otros tres son de consulta:

| Documento | Para qué |
|---|---|
| `COMO-FUNCIONA.md` | El recorrido completo paso a paso: login, circuito, piezas |
| `ARQUITECTURA.md` | Por qué el sistema está armado así. Las decisiones y sus razones |
| `CONTRATO-SIESA.md` | Qué se lee y qué se escribe en SIESA. Formatos y trampas |
| `CONSULTA-COTIZACIONES.sql` | La consulta cargada en Connekta, comentada |
| `../../Pagina-web_React/src/pages/PortalProveedores/RUTAS.md` | El circuito de rutas y permisos de la app, y su reguero |

---

## 1. Qué hace el sistema, en cinco líneas

Un proveedor externo entra con **NIT + sucursal + contraseña**, ve el catálogo de
precios que Merkahorro le compra, y **propone** un ajuste con fecha de activación.
Firma la propuesta. Compras la ve en una bandeja, la aprueba o la rechaza. Al
aprobar, el cambio se escribe en SIESA. Un tope porcentual por proveedor impide
que la subida pase de lo autorizado.

---

## 2. Qué funciona HOY, verificado con datos reales

Nada de esta lista es "debería andar". Todo se probó contra SIESA y Supabase
de producción el 2026-08-27.

### Ingreso y cuentas
- Login por NIT → sucursal → contraseña. El NIT se acepta con puntos y con dígito
  de verificación (`800.186.960-1` encuentra la misma cuenta que `800186960`).
- Invitación por enlace de un solo uso, 72 h. El proveedor define su clave.
  **Nunca se manda una contraseña por correo.**
- Probado: token falso rechazado, clave corta rechazada, token reusado rechazado.

### Catálogo
- Snapshot de SIESA a `pp_cotizaciones`: **18.866 cotizaciones, 337 proveedores**,
  27 segundos, paginado de a 1.000.
- El maestro (`pp_proveedores`, `pp_cuentas`) se **deriva** del snapshot:
  337 proveedores, 403 cuentas.
- El proveedor ve solo lo suyo: 198 renglones para Altipal sucursal 006.

### La regla de plata
- El tope se evalúa sobre el **costo neto**, no sobre el precio.
- Probado en producción con tope 1% sobre Altipal:

| Caso | Resultado |
|---|---|
| +4,93% | **201** creada y **marcada** — desde el 2026-08-27 el tope avisa, no frena |
| Una marcada en la bandeja | va **primera**, la fila en ámbar, contador arriba |
| Aprobar una marcada | el botón dice **"Aprobar pese al tope"** y pide **segundo clic** |
| +0,50% | **201** creada |
| Repetir el mismo ítem | **409** ya hay una pendiente |
| Ítem de **otro proveedor** | **404** no está en su catálogo |

Ese último es la prueba del aislamiento: se mandó el `claveItem` de Andigranos
con la sesión de Altipal y el backend no devolvió nada.

### Firma
- Probado: se modificó el precio de una solicitud ya firmada directamente en la
  base → la firma quedó inválida y **`aprobar()` se frenó antes de tocar SIESA**.

### Producción
- `https://backend-proveedores.vercel.app` — los cuatro endpoints responden lo que
  corresponde, CORS filtra por origen, y el snapshot completo corre en 27 s.

---

## 3. Lo que falta, en orden

### 3.1 BLOQUEANTES — no se puede cerrar el proyecto sin esto

#### a) La consulta de TERCEROS de SIESA

**Estado:** pedida, no entregada.

Hoy el maestro se deriva de la consulta de cotizaciones (`maestro.service.js`), y
eso alcanza para trabajar — pero **solo ve proveedores CON cotizaciones cargadas**.
Un tercero dado de alta en SIESA al que todavía no se le puso ningún precio no
aparece en el maestro, y a ese no se le puede asociar un correo.

**Qué hacer cuando llegue:**
1. Cargarla en Connekta como consulta nueva (mismo procedimiento que
   `CONSULTA-COTIZACIONES.sql`: sin `ORDER BY`, sin `;`, sin comentarios).
2. **Copiar SU ConniKey y ConniToken** — cada consulta dinámica tiene los suyos.
   Si son distintos a los actuales, hay que decidir cómo conviven en el `.env`.
3. Reescribir `sincronizarMaestro()` para leer de ahí en vez de las cotizaciones.
   **Solo esa función.** Las tablas, los endpoints y el panel ya tienen la forma
   final; `pp_proveedores` y `pp_cuentas` no cambian.
4. Mantener `ignoreDuplicates: true` en los upsert. Sin eso, cada corrida pisa
   `porcentaje_max` y `bloqueado` con los defaults y borra los topes que compras
   configuró a mano.

#### b) ¿Los descuentos son en CASCADA o ADITIVOS? — ✅ RESUELTO

**Estado:** **CASCADA**, confirmado el 2026-08-27 — y no de palabra: **con una
captura de SIESA** que muestra la cuenta hecha por el propio ERP.

**La prueba, desde la pantalla de ítems de SIESA (2026-08-27):**

```
JABON PROTEX BARRA OMEGA 3 X 110 GR · P3-EMPAQUE X 3
Precio unitario $9.524,15 · Cantidad 5 · Valor bruto $47.621

  Orden 1   4%  →  descuento  $1.905
  Orden 2  25%  →  descuento  $11.429      ← acá se decide

Dscto lineal $13.334 · Subtotal $34.287 · IVA 19% $6.515 · Neto $40.802
```

El orden 2 es justo donde los dos modos se separan:

| Modo | 25% aplicado sobre | Da | ¿Coincide con SIESA? |
|---|---|---|---|
| **Cascada** | el saldo tras el 4% — 45.715,92 | **11.428,98** | ✅ |
| Aditivo | el bruto — 47.620,75 | 11.905,19 | ❌ |

La cadena cierra hasta el último peso, y `costoNeto(9524.15, [4, 25])` da
6.857,388 × 5 = **34.286,94**, el subtotal exacto. En aditivo daría 33.810,73:
**476 pesos de diferencia en UN solo renglón.**

Está fijado como test en `costoNeto.test.js` con estos mismos números, así que
si alguien cambia `MODO_DESCUENTO` sin querer, la prueba lo agarra.

```
cascada:  4.672 × 0,97 × 0,98 = 4.441,20
aditivo:  4.672 × 0,95        = 4.438,40
```

**Ya no es teórico:** hay **76 renglones** del catálogo con dos o tres descuentos
(53 con dos, 23 con tres). En esos 76, los dos modos dan números distintos — y ese
número decide si una propuesta pasa el tope.

Se buscaron por fuerza bruta las combinaciones donde el modo **voltea** la
decisión del tope: aparecieron **4.862**. Ejemplo con tope del 5% — descuentos de
20% y 20%, bajando el segundo a 16% sin tocar el precio: cascada da +5,00% (pasa)
y aditivo +6,67% (bloquea). Por eso valía preguntarlo.

**Resultado:** el supuesto era correcto. **No hubo que cambiar una sola línea de
cálculo.** Si algún día compras cambia de criterio, es la constante
`MODO_DESCUENTO` en `services/costoNeto.js` **y su gemelo del frontend**
(`utils/costoNeto.js`). Los dos, o divergen.

#### c) La primera aprobación real contra SIESA

**Estado:** ✅ **CERRADO — SIESA aceptó una cotización real el 2026-08-27.**

```
Solicitud #5 · VINO SAZON BLANCO X 750 ML · ítem 179313
$13.132,33 → $13.920 (+6,00%, con tope 1% — marcada y aprobada como excepción)

Respuesta de SIESA:
  { "codigo": 0, "detalle": "Importacion exitosa", "mensaje": "Transacción Exitosa" }
```

El payload que aceptó llevaba **dos** bloques —encabezado e impuestos, sin la
sección vacía de descuentos— y el **ICO de $4.974 re-emitido con la fecha nueva**
(20260920). Es el circuito completo: proponer, firmar, marcar por tope, aprobar
como excepción, y escribir en el ERP.

<details>
<summary>El camino hasta acá (vale leerlo antes de tocar el empuje)</summary>

Antes de esto se verificó en SANDBOX contra el backend desplegado.

Solicitud #4 (FOUR LOKO SANDIA, ítem 177791, ICO de $5.131,73). Payload armado,
tal como salió en el log de Vercel:

```jsonc
{
  "Encabezado Cotizaciones": [{
    "NIT_PROVEEDOR": "800186960",        // trimeado, sin relleno CHAR
    "SUCURSAL": "006",                   // ceros a la izquierda conservados
    "ITEM": "177791",
    "FECHA_ACTIVACION": "20260920",      // AAAAMMDD, SIN tilde
    "U.M": "UND",
    "PRECIO": "000000000008197.0000",    // 20 caracteres exactos
    "NOTAS": "Ajuste de lista septiembre"
  }],
  "Impuestos en Valor": [{
    "FECHA_ACTIVACIÓN": "20260920",      // CON tilde — y la fecha NUEVA
    "LLAVE_IMPUESTO": "ICO",
    "VALOR_IMPUESTO": "000000000005131.7300"
  }],
  "Descuentos": []
}
```

**Lo que esto confirma**, y era el riesgo más caro del proyecto: el ICO se
**re-emite con la fecha nueva**. Es exactamente el caso del `FOUR LOKO PONCHE
FRUTAS`, que en el histórico de SIESA perdió su ICO de $5.102 al crearse la
cotización del 4-mar. Con este payload, no se pierde.

También quedó verificada la trampa de la tilde: `FECHA_ACTIVACION` en el
encabezado y `FECHA_ACTIVACIÓN` en los otros bloques. Escribirlas iguales haría
que SIESA rechace el bloque.

</details>

<details>
<summary>Cómo se hizo (por si hay que repetirlo)</summary>

`PROVEEDORES_SANDBOX=true` corta justo antes de mandar y deja el payload en el
log. **La primera aprobación tiene que hacerse así**, mirando el payload:

- ¿Los tres bloques tienen los nombres exactos?
- ¿Las fechas están en `AAAAMMDD`?
- ¿El precio tiene 20 caracteres, `000000000004900.0000`?
- ¿Los impuestos vigentes se re-emiten con la fecha NUEVA?

Recién después se saca la variable y se aprueba de verdad **en QA**
(`SIESA_COTIZACION_URL` ya apunta ahí). Pasar a producción es cambiar esa única
variable.

</details>

---

### 3.2 PARA SALIR A PRODUCCIÓN

#### d) Desplegar el frontend y apuntar las URLs

Hoy el portal solo corre en localhost. Al desplegarlo:

```
PORTAL_PROVEEDORES_URL=https://merkahorro.com/portal-proveedores
```

**Es lo primero que hay que cambiar.** Mientras apunte a localhost, un proveedor
real recibe un correo con un enlace a su propia máquina. El panel avisa
(`enlaceEsLocal()`), pero el aviso está para que nadie se olvide, no para
convivir con el problema.

Y en el frontend:

```
VITE_PROVEEDORES_API_URL=https://backend-proveedores.vercel.app/api
```

#### e) Sacar `PROVEEDORES_SANDBOX`

Después del punto (c). Mientras esté, **nada se escribe en SIESA**.

#### f) Pantalla para administrar admins del portal — ✅ RESUELTO

**Hecho el 2026-08-27**, backend y pantalla. Compras ya no necesita desarrollo
para sumar o quitar a alguien. Tres endpoints, sin DELETE:

| | Ruta | Qué hace |
|---|---|---|
| GET | `/api/admin/admins` | Lista activos e inactivos |
| POST | `/api/admin/admins` | Alta o reactivación, **por correo** |
| PATCH | `/api/admin/admins/:userId` | Activa o desactiva |

Tres reglas que no se negocian, y están comentadas en el controlador:

1. **Nunca se borra, solo se desactiva.** `pp_auditoria` apunta a estas filas.
2. **Nunca cero admins activos.** `dejariaSinAdmins()` lo frena antes de escribir
   — es función pura y tiene 7 tests. Sin esa guarda, el último admin puede
   dejarse afuera y solo se sale con SQL contra producción.
3. **El correo se resuelve contra `profiles`, no contra `auth.users`.** Un
   proveedor también vive en `auth.users` con su email sintético: buscar ahí
   permitiría darle permiso de aprobar precios a un proveedor.

La pantalla es la tercera pestaña del panel de compras
(`components/AdminsPortal.jsx`). Va última porque se toca una vez cada tanto.
El botón de desactivar aparece deshabilitado cuando queda un solo admin activo:
el backend lo rechaza igual, pero un botón que siempre falla es una trampa.

Desactivarse a uno mismo **sí** se permite —puede ser justo lo que la persona
quiere al irse— pero se avisa antes, porque el efecto es inmediato: el siguiente
request de esa misma pantalla devuelve 403.

---

### 3.2 bis — LO QUE ENSEÑÓ EL PRIMER RECHAZO REAL (2026-08-27)

El primer POST de verdad a SIESA falló, y destapó **tres** problemas. Vale
leerlos juntos, porque el tercero es el que hace difícil encontrar los otros dos.

#### 1. Una sección vacía se rechaza (SIESA)

`"Descuentos": []` devuelve **HTTP 400**: el conector recorre las variables que
tiene declaradas para esa sección y no encuentra ninguna. Ahora el encabezado va
siempre y los otros dos bloques **solo si tienen filas**. Ver CONTRATO-SIESA §5bis.

#### 2. El error se enmascaraba justo cuando más se necesitaba (nuestro)

`errorHandler` ocultaba **todos** los 5xx para no filtrar internals — una regla
correcta por defecto. Pero el rechazo de SIESA sale como **502**, así que el admin
veía *"Error interno del servidor"* en lugar del mensaje del ERP, que es lo único
que dice qué corregir.

Se agregó `createErrorExpuesto()`: un 5xx cuyo mensaje **sí** llega al usuario,
para los casos en que el texto lo escribimos nosotros y no contiene nada de
adentro. El log sigue recibiendo el error completo siempre.

> **La regla:** enmascarar por defecto, exponer a propósito. Un error que solo
> vive en los logs de Vercel obliga a abrir el panel de un proveedor de servicios
> para operar el sistema — y eso, en la práctica, es no tener manejo de errores.

#### 3. `fallida` era un callejón sin salida (nuestro)

Al fallar el empuje, la solicitud pasa a `fallida` — correcto — pero **no había
ninguna acción disponible desde ahí**. Una solicitud que falló por una causa
ARREGLABLE quedaba muerta, y el proveedor tenía que volver a proponer y firmar
todo de nuevo.

La regla que se había escrito era *"nunca reintento ciego"*. Se implementó como
*"nunca reintento"*, que no es lo mismo: **la diferencia es quién decide.**

Se agregó `POST /admin/solicitudes/:id/reintentar` — botón **"Devolver a
pendientes"** en el detalle. Devuelve la solicitud a la cola y limpia el ancla de
idempotencia; el empuje vuelve a pasar por `aprobar()`, con verificación de firma
y candado atómico. **No re-empuja por su cuenta**: un segundo camino hacia SIESA
sería un segundo camino que mantener sincronizado.

La pantalla avisa lo que hay que mirar ANTES:

> Un fallo puede ser "SIESA rechazó" (no entró nada) o "se cortó la respuesta"
> (pudo haber entrado). En el segundo caso, reintentar carga el precio dos veces.

Por eso es una decisión humana explícita, y queda en `pp_auditoria` con el fallo
anterior adjunto: si alguien reintenta tres veces lo mismo, el registro muestra
contra qué se estrelló cada vez.

#### 4. Y aunque no se enmascarara, tampoco se veía (nuestro)

El aviso de error se pintaba en la **lista**, con el modal de detalle **abierto
encima**. Nunca llegaba al ojo. Ahora el error de aprobar y rechazar se muestra
**dentro del modal**, con la respuesta cruda del ERP en un `<details>`
desplegable.

> Un mensaje de error que la pantalla no muestra es exactamente igual a no
> tenerlo. Al escribir feedback, la pregunta no es "¿lo estoy seteando?" sino
> "¿dónde va a quedar parado el usuario cuando esto pase?".

---

### 3.3 DEUDA CONOCIDA — no bloquea, pero conviene saberla

#### g) El sistema de rutas de la app

Documentado en `PortalProveedores/RUTAS.md`. Resumen:

- `RutaProtegida.jsx` tiene un array `dashboardRoutes` **hardcodeado** que
  autoriza ~30 rutas a **cualquier usuario logueado**, sin mirar el rol. Los
  permisos por rol no se consultan para esas rutas.
- `profiles.personal_routes` **PISA** las del rol en vez de sumarlas.
- `startsWith(r.path)` sobre-autoriza: un permiso a `/portal` abriría
  `/portal-proveedores/maestro`.

**No se tocó a propósito.** Vaciar `dashboardRoutes` puede dejar gente afuera de
pantallas que usa todos los días; se hace ruta por ruta, mirando quién la usa.

El portal esquiva todo esto con `pp_admins`: su propia tabla de autoridad, que no
depende de `profiles.role`.

#### h) ¿Existe un orden 4 de descuento?

Verificado el 2026-08-27: **no**. Solo 1, 2 y 3 (11.321 / 233 / 53 filas).

Vale re-verificarlo si cambian las condiciones comerciales, porque un orden 4
rompe dos cosas a la vez: el costo neto sale más alto de lo real y ese descuento
**se pierde** al re-emitir.

```sql
SELECT f214_orden AS Orden, COUNT(*) AS Cantidad
FROM dbo.t214_mm_cotizacion_dscto GROUP BY f214_orden
```

#### i) Rate limit en memoria

`middleware/rateLimit.js` cuenta por instancia de lambda. En Vercel, N instancias
multiplican el límite por N. Es un lomo de burro, no un muro.

La protección real del endpoint público es su **forma**: devuelve solo sucursal y
nombre, y responde igual exista o no el NIT. Si algún día hace falta un límite de
verdad, va contra Redis o el WAF de Vercel.

#### j) `prop-types`

ESLint se queja en los componentes nuevos. **Ningún componente del repo los
tiene** — `Traslados/components/CantidadModal.jsx` marca los mismos errores.
Agregarlos solo acá introduciría un patrón nuevo en cinco archivos. Si se adopta,
se adopta para todo `src/`.

---

## 4. Datos de prueba que hay en la base

Creados para probar. Limpiar cuando estorben:

| Qué | Dónde |
|---|---|
| Cuenta Altipal 800186960 / 006, activa | `pp_cuentas` id 59 |
| Correo `pruebas.portal@merkahorrosas.com` | esa cuenta |
| Contraseña `Portal2026.Prueba` | Supabase Auth |
| **Tope de Altipal en 1%** (era `NULL`) | `pp_proveedores` |
| Solicitudes #1 y #2 pendientes | `pp_solicitudes_precio` |

```sql
-- Limpieza (en este orden: las solicitudes referencian las firmas)
DELETE FROM pp_solicitudes_precio WHERE cuenta_id = 59;
UPDATE pp_proveedores SET porcentaje_max = NULL WHERE nit = '800186960';
```

`pp_firmas` y `pp_auditoria` son **append-only por trigger**: no se pueden borrar,
y así tiene que ser. Las firmas de prueba van a quedar ahí, y no molestan.

---

## 5. Cómo retomar en cinco minutos

```bash
cd C:/Users/johan.sanchez/Desktop/BACKEND/backend-proveedores
npm test          # 142 pruebas
npm run dev       # localhost:3000
```

```bash
cd C:/Users/johan.sanchez/Desktop/Pagina-web_React
npx vitest run src/pages/PortalProveedores   # 32 pruebas
npm run dev                                   # localhost:5173
```

| Entrar como | Dónde |
|---|---|
| Proveedor | `/portal-proveedores/ingreso` — NIT 800186960, suc. 006 |
| Compras | `/portal-proveedores/maestro` — con la sesión de la app |

Correr el snapshot a mano:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/snapshot
```

---

## 6. Las cinco cosas que NO hay que romper

Si algo de esto se "simplifica", el sistema sigue compilando y empieza a cobrar mal.

1. **El tope se evalúa sobre el COSTO NETO, no sobre el precio.**
   Con datos reales: bajando un descuento de 3% a 0 sin tocar el precio, lo que
   Merkahorro paga sube 3,09% — y un tope sobre el precio no ve nada.

2. **Los impuestos se RE-EMITEN con la fecha nueva.**
   Confirmado en el histórico de SIESA: `FOUR LOKO PONCHE FRUTAS` tenía ICO de
   $5.102 el 14-ene y el 4-mar quedó sin impuestos. Un ICO no se negocia.

3. **El `cuenta_id` sale del JWT, nunca del body.**
   Es lo único que separa a un proveedor de los datos de su competencia.

4. **Aprobar TOMA la solicitud antes de empujar a SIESA.**
   Al revés, el peor caso es mandar el mismo precio dos veces. En Traslados ya
   pasó: la misma salida se importó tres veces.

5. **Ninguna fecha pasa por `new Date()`.**
   El servidor corre en UTC, Colombia es UTC−5. Este proyecto se topó con el huso
   cuatro veces: al formatear para SIESA, al decidir qué precio rige, al mostrar
   la tabla y al validar la fecha de activación. Las cuatro con test.

---

## 7. Preguntas abiertas para el negocio

1. ~~**¿Cascada o aditivo?**~~ ✅ **CASCADA**, confirmado por compras el 2026-08-27.
2. **¿El tope es por NIT o por sucursal?** Hoy por NIT. El modelo aguanta bajarlo
   a sucursal con una columna nullable en `pp_cuentas` que pise a la del NIT.
3. **¿Qué pasa si el precio de SIESA cambia entre la solicitud y la aprobación?**
   Hoy: `precio_actual` quedó congelado y el admin ve el comparativo. Falta
   decidir si eso amerita una advertencia más fuerte o un rechazo automático.
4. **¿Hay más llaves de impuesto además de ICO e IBU3?** Son las dos que aparecen
   en los datos de la consulta de cotizaciones. La documentación del conector
   decía "IBUA", que no existe.

   **Pista nueva (2026-08-27):** la captura de la pantalla de ítems de SIESA
   muestra `IV03 — IVA 19% BIENES`. Ojo: esa es una pantalla de **entrada por
   compra**, no la consulta de cotizaciones, así que no prueba que `IV03` aparezca
   en `IdLlaveImpto`. Vale confirmarlo antes de la primera aprobación real: si
   apareciera y no se re-emitiera, sería el mismo agujero del ICO pero con IVA.

   **No es urgente para el código:** `agruparCotizaciones()` NO tiene lista
   blanca de llaves — acumula las que vengan, así que una llave nueva pasa sola.
   Se escribió tolerante justamente por esto.
