# Portal de Proveedores — cómo funciona, paso a paso

Documento de lectura. Explica **qué pasa y en qué orden** cuando alguien usa el
sistema. Los otros documentos explican *por qué* está armado así:

| Documento | Para qué |
|---|---|
| `ARQUITECTURA.md` | Las decisiones de diseño y sus razones |
| `CONTRATO-SIESA.md` | Qué se lee y qué se escribe en SIESA |
| `ESTADO-Y-PENDIENTES.md` | Estado real y pendientes con detalle |
| Este | El recorrido completo, en orden, sin justificaciones |

---

## 1. Qué es, en cinco líneas

Un proveedor externo entra con **NIT + sucursal + contraseña**, ve el catálogo de
precios que Merkahorro le compra, y **propone** un ajuste con fecha de activación.
Firma la propuesta. Compras la ve en una bandeja, la aprueba o la rechaza. Al
aprobar, el cambio se escribe en SIESA.

Dos superficies, un solo login: **admin** (compras) y **proveedor** (tercero).

---

## 2. El login, paso a paso

### 2.1 El problema que resuelve

Supabase Auth se autentica con **email + contraseña**. El proveedor entra con
**NIT + sucursal + contraseña**. No son la misma cosa, y hay que traducir.

### 2.2 El email sintético

El par NIT+sucursal se convierte en un email que es la identidad real en Auth:

```
NIT 900123456, sucursal 02
   → identidad Auth:  900123456-02@proveedores.merkahorro.com
   → correo real:     compras@ejemplo.com   (SOLO para notificaciones)
```

Una cuenta **por sucursal**. La sucursal 02 no puede leer datos de la 01, aunque
compartan NIT.

El correo real vive aparte, en `pp_cuentas.correo_notificacion`, y no sirve para
entrar: sirve para avisar.

**Archivos:** `utils/emailSintetico.js` (frontend) y `services/emailSintetico.js`
(backend). Son gemelos y tienen 10 tests cada uno.

### 2.3 Los tres pasos en pantalla

#### PASO 1 — El proveedor escribe su NIT

El NIT se normaliza antes de usarlo: se le sacan puntos y espacios, y el dígito
de verificación si viene con guion.

```
800.186.960-1   →   800186960
800186960       →   800186960     (las dos formas encuentran la misma cuenta)
```

El front llama:

```
GET /api/publico/sucursales?nit=800186960
```

Y recibe **solo esto**, nunca más:

```json
{ "sucursales": [{ "sucursal": "006", "nombre": "Sucursal Medellín" }] }
```

> **Este es el único endpoint del sistema sin autenticar.** Por eso: tiene rate
> limit por IP, jamás devuelve correos ni el estado de la cuenta, y responde
> igual exista o no el NIT — no se puede usar para averiguar quién es proveedor
> de Merkahorro.

#### PASO 2 — Elige su sucursal

De la lista que devolvió el paso 1. Si el NIT no tiene sucursales habilitadas, la
lista viene vacía y se muestra un mensaje que manda a compras.

#### PASO 3 — Escribe su contraseña

El front arma el email sintético y llama a Supabase directo:

```js
const email = emailSintetico(nit, sucursal);   // 800186960-006@proveedores…
await supabase.auth.signInWithPassword({ email, password: clave });
```

Si la clave está mal, muere acá con "Contraseña incorrecta".

#### PASO 4 — El backend valida la cuenta (esto no se ve, pero decide)

Con la sesión ya creada, el front llama:

```
GET /api/proveedor/cuenta      Authorization: Bearer <JWT>
```

El middleware `auth.js` resuelve `user_id → cuenta_id` contra `pp_cuentas` y
mira el **estado** de la cuenta:

| Estado | Qué pasa |
|---|---|
| `activo` | Entra |
| `sin_invitar` / `invitado` | **403** — todavía no activó su cuenta |
| `suspendido` | **403** — comuníquese con compras |
| sin fila en `pp_cuentas` | **403** — no tiene cuenta de proveedor |

Si da 403, el front **cierra la sesión**. No lo deja adentro a medias.

> **La regla que no se rompe:** el `cuenta_id` sale SIEMPRE del JWT. Nunca del
> body, nunca del query, nunca de un header. Si el request trae un `cuenta_id`
> distinto del que dice el JWT: **403 y fila en `pp_auditoria`**. Es lo único
> que separa a un proveedor de los datos de su competencia.

### 2.4 De dónde salen las credenciales

El proveedor no se registra solo. El circuito es:

1. Un **admin** entra al maestro, abre el perfil del proveedor y le asocia un
   **correo real**.
2. El backend crea el usuario en Supabase Auth con el email sintético, **sin
   contraseña utilizable**.
3. Se genera un **token de invitación de un solo uso**, válido **72 horas**. En
   la base se guarda solo su **hash**, nunca el token.
4. Al correo real le llega un **enlace**, no una clave:
   `.../portal-proveedores/activar?token=…`
5. El proveedor abre el enlace y **define su propia contraseña**.
6. El token se quema. Reusarlo o usarlo vencido da el mismo mensaje genérico.

> **Nunca se manda una contraseña por correo.** Una clave en texto plano en un
> buzón queda ahí para siempre: se reenvía, se archiva, se sincroniza a tres
> dispositivos. Un enlace que vence en 72 h y se quema al primer uso, no.

**Archivo:** `services/invitacion.service.js`.

---

## 3. El circuito completo, paso a paso

### 3.1 De noche: el catálogo se refresca solo

Un cron de Vercel corre a las **10:00 UTC (5:00 Colombia)**:

```
POST /api/cron/snapshot     header: x-cron-secret
```

1. Consulta las cotizaciones a SIESA vía Connekta, paginando de a 1.000.
2. Normaliza cada fila: saca el relleno de SQL Server, pivotea los descuentos por
   orden, agrupa los impuestos.
3. Reescribe `pp_cotizaciones`.
4. **Barre** lo que la corrida no tocó — pero solo si el resultado es creíble:
   nunca con cero filas, y nunca si el catálogo encogió a menos de la mitad.
5. Deriva el maestro (`pp_proveedores`, `pp_cuentas`) del mismo snapshot.

Medido en producción: **18.866 cotizaciones, 337 proveedores, 27 segundos.**

**Archivos:** `services/snapshot.service.js`, `services/normalizarCotizacion.js`,
`services/maestro.service.js`.

### 3.2 El proveedor mira su catálogo

```
GET /api/proveedor/catalogo
```

Filtra por el `nit` y la `sucursal` **de la cuenta del JWT**. Devuelve, por
renglón: código, descripción, unidad de medida, precio, descuentos, **impuestos**,
costo neto ya calculado, si hay una solicitud pendiente y si hay cambios
programados a futuro.

En pantalla, el precio se rotula **"Precio antes de impuestos"**. Siempre. Nunca
"precio unitario" a secas: un proveedor lo lee como precio final y propone mal.

Los **impuestos se muestran en modo lectura** junto a cada renglón. El proveedor
pone el precio: tiene que ver la línea completa. Pero no los edita —los fija la
ley, no la negociación.

### 3.3 El proveedor propone un cambio

**PASO 1 — Edita.** Puede cambiar el **precio**, los **descuentos por orden**
(hasta 3) y la **fecha de activación**. Los **impuestos no los edita**: se
muestran y se re-emiten tal cual.

Mientras escribe, la pantalla le muestra el **costo neto** en vivo y la variación.

**PASO 2 — Ve el resumen.** Exactamente lo que va a firmar: precio, descuentos,
impuestos, costo neto y fecha.

**PASO 3 — Firma.** Dibuja su firma. Sin firma no se envía.

**PASO 4 — Se envía.**

```
POST /api/proveedor/solicitudes
```

El backend, en este orden:

1. Busca la cotización vigente **del catálogo de esa cuenta**. Si el `claveItem`
   es de otro proveedor, no encuentra nada → **404**.
2. Valida que la fecha de activación no sea anterior a hoy → **422**.
3. Calcula el costo neto actual y el propuesto, y la variación.
4. Compara contra el tope de la cuenta.
5. Registra la **firma** con su hash.
6. Inserta la solicitud en estado `pendiente`.
7. Deja fila en `pp_auditoria`.

Si ya hay una solicitud pendiente para ese ítem+U.M. → **409**.

### 3.4 El tope porcentual

El admin le pone un tope a cada proveedor (ej: 5%) desde el maestro.

**El tope se mide sobre el COSTO NETO, no sobre el precio:**

```
costo_neto = precio × (1 − d1) × (1 − d2) × (1 − d3)     ← cascada
variacion  = (neto_propuesto − neto_actual) / neto_actual
```

Los descuentos se componen en **cascada** — confirmado contra una captura de
SIESA, y fijado como test.

> **Por qué sobre el costo neto:** el proveedor podría dejar el precio intacto
> —subida 0%, pasa cualquier tope— y bajar un descuento del 3% al 0. Lo que
> Merkahorro paga sube 3,09% y un tope sobre el precio no ve nada.

**EL TOPE AVISA, NO FRENA.** Una propuesta que se pasa **se crea igual**, queda
marcada, y la decide un humano:

- El **proveedor** lo ve al enviar, con el número del tope.
- La **fila** de la bandeja se pinta con borde rojo.
- El **detalle** abre con un cartel antes del comparativo.

`porcentaje_max = NULL` significa **sin tope**, no 0%.

**Archivo:** `services/costoNeto.js` (y su gemelo `utils/costoNeto.js`).

### 3.5 El admin decide

En `/portal-proveedores/maestro`, pestaña **Novedades de precio**:

```
GET /api/admin/solicitudes?estado=pendiente
```

Ve por fila: proveedor, producto, U.M., precio actual → propuesto, costo neto
actual → propuesto, la variación, el tope que regía, y la fecha.

Al abrir el detalle ve además los descuentos, los impuestos que se re-emiten, la
observación del proveedor, y **la firma completa**: el trazo, la fecha y hora, la
IP y la huella SHA-256 del contenido firmado.

Desde ahí:

```
POST /api/admin/solicitudes/:id/aprobar
POST /api/admin/solicitudes/:id/rechazar     (con motivo)
```

### 3.6 Al aprobar: se escribe en SIESA

`aprobar()` hace tres cosas **en este orden, y el orden no se cambia**:

1. **Verifica la firma.** Recalcula el hash del contenido actual y lo compara con
   el firmado. Si alguien tocó la solicitud después de firmada, **se frena acá**
   y no toca SIESA.
2. **Toma la solicitud.** Un UPDATE condicionado a `siesa_aplicado_at IS NULL`.
   Es el candado de idempotencia: el doble clic del admin no dispara un segundo
   empuje.
3. **Empuja a SIESA.** Recién ahora.

El payload lleva **siempre los tres bloques**:

| Bloque | Qué manda |
|---|---|
| Encabezado | La cotización: llave, precio, fecha de activación |
| Impuestos | Los vigentes, **re-emitidos con la fecha nueva** |
| Descuentos | Los propuestos, con la fecha nueva |

> **Por qué se re-emiten los impuestos:** en SIESA la fecha es parte de la llave.
> Una cotización con fecha nueva nace sin impuestos si no se los vuelve a cargar.
> Confirmado en el histórico: `FOUR LOKO PONCHE FRUTAS` tenía ICO de $5.102 el
> 14-ene y el 4-mar quedó sin impuestos. Un ICO no se negocia, lo fija la ley.

Resultado: la solicitud queda `aplicada` o `fallida` con el detalle. **Nunca hay
reintento ciego** — con un write al ERP, "no sé si llegó" es peor que "falló".

**Archivos:** `services/solicitud.service.js`, `services/siesaCotizacion.js`,
`services/formatoSiesa.js`.

### 3.7 No hay cron de activación

El precio no se "activa" desde acá. **`FECHA_ACTIVACION` es parte de la llave
natural en SIESA**: un registro con fecha futura convive con el vigente y entra
en vigor ese día solo. Quien activa es SIESA. Aprobar y empujar es el mismo acto.

---

## 4. Las piezas

### Backend — `BACKEND/backend-proveedores`

```
src/
  config/       supabase.js · connekta.js
  middleware/   auth.js · validators.js (Zod) · rateLimit.js · errorHandler.js
  services/
    costoNeto.js            el tope sobre el costo neto  ← la regla de plata
    normalizarCotizacion.js la forma cruda de SIESA, domada
    formatoSiesa.js         anchos fijos y fechas sin new Date()
    siesaCotizacion.js      arma los tres bloques y hace el POST
    snapshot.service.js     el cron del catálogo
    maestro.service.js      pp_proveedores + pp_cuentas  ← fuente provisional
    solicitud.service.js    crear / aprobar / rechazar
    firma.service.js        hash canónico y verificación
    invitacion.service.js   token de un solo uso, 72 h
    email.service.js        SMTP con modo prueba
  controllers/  routes/  server.js
sql/            001_create_tables · 002_moneda · 003_admins
```

### Frontend — `Pagina-web_React/src/pages/PortalProveedores/`

```
LoginProveedor.jsx     NIT → sucursal → contraseña
ActivarCuenta.jsx      destino del enlace de invitación
ProveedorPanel.jsx     catálogo y mis solicitudes
AdminPanel.jsx         tres pestañas: maestro, novedades y administradores
components/
  AdminsPortal.jsx         quién puede aprobar precios
  PerfilProveedor.jsx      asociar correo, poner el tope, invitar
  EditarPrecioModal.jsx    propuesta + costo neto en vivo + firma
  BandejaAprobaciones.jsx  aprobar / rechazar
hooks/     useMaestro · useCatalogo · useAprobaciones · useAdmins
utils/     costoNeto · emailSintetico · fechas   (los tres con test)
```

### Las tablas

| Tabla | Qué guarda |
|---|---|
| `pp_proveedores` | El maestro. Acá vive `porcentaje_max` y `bloqueado` |
| `pp_cuentas` | Una fila por sucursal. El correo real y el estado |
| `pp_cotizaciones` | El catálogo, refrescado por el cron |
| `pp_invitaciones` | El **hash** del token, vencimiento, uso |
| `pp_solicitudes_precio` | El corazón: la propuesta y sus snapshots |
| `pp_firmas` | **APPEND-ONLY por trigger.** Sin UPDATE, sin DELETE |
| `pp_auditoria` | **APPEND-ONLY por trigger.** Quién hizo qué |
| `pp_admins` | Quién es admin del portal |

---

## 5. Las seis cosas que no hay que romper

Si algo de esto se "simplifica", el sistema sigue compilando y empieza a cobrar mal.

1. **El tope se evalúa sobre el COSTO NETO, no sobre el precio.**
2. **Los impuestos se RE-EMITEN con la fecha nueva**, o el ítem los pierde.
3. **El `cuenta_id` sale del JWT**, nunca del body.
4. **Aprobar TOMA la solicitud antes de empujar** a SIESA.
5. **Ninguna fecha pasa por `new Date()`** — el servidor corre en UTC, Colombia
   es UTC−5. Este proyecto se topó con el huso cuatro veces.
6. **La marca de "supera el tope" tiene que verse.** Desde que el tope avisa en
   vez de frenar, esa marca es la única defensa automática que queda.

---

## 6. Lo que falta por implementar

### 6.1 Bloqueantes

#### a) La consulta de TERCEROS de SIESA — *pedida, no entregada*

Hoy el maestro se **deriva** de la consulta de cotizaciones, y eso alcanza para
trabajar, pero solo ve proveedores **con cotizaciones cargadas**. Un tercero dado
de alta en SIESA al que todavía no se le puso ningún precio no aparece, y a ese
no se le puede asociar un correo.

Cuando llegue:

1. Cargarla en Connekta como consulta nueva (sin `ORDER BY`, sin `;`, sin
   comentarios).
2. **Copiar SU ConniKey y ConniToken** — cada consulta dinámica tiene los suyos.
   Un 401 de "verifique si tiene permisos" casi siempre es esto.
3. Reescribir `sincronizarMaestro()` para leer de ahí. **Solo esa función**: las
   tablas, los endpoints y el panel ya tienen la forma final.
4. Mantener `ignoreDuplicates: true` en los upsert, o cada corrida pisa los topes
   que compras configuró a mano.

#### b) La primera aprobación real contra SIESA — *nunca se ejecutó*

Todo se probó **hasta el borde del POST**. `PROVEEDORES_SANDBOX=true` corta justo
antes de mandar y deja el payload en el log.

**La primera aprobación tiene que hacerse así**, mirando el payload:

- ¿Los tres bloques tienen los nombres exactos?
- ¿Las fechas están en `AAAAMMDD`?
- ¿El precio tiene 20 caracteres — `000000000004900.0000`?
- ¿Los impuestos vigentes se re-emiten con la fecha NUEVA?

Recién después se saca la variable y se aprueba de verdad **en QA**. Pasar a
producción es cambiar una sola variable.

> Los tests verifican que armamos el payload como creemos que hay que armarlo.
> **No verifican que SIESA lo acepte.** Hasta que no haya una cotización creada
> en QA, este punto está en "debería andar".

### 6.2 Para salir a producción

#### c) Desplegar el frontend y apuntar las URLs

Hoy el portal solo corre en localhost.

```
PORTAL_PROVEEDORES_URL=https://merkahorro.com/portal-proveedores
VITE_PROVEEDORES_API_URL=https://backend-proveedores.vercel.app/api
```

**Es lo primero que hay que cambiar.** Mientras apunte a localhost, un proveedor
real recibe un correo con un enlace a su propia máquina. El panel avisa
(`enlaceEsLocal()`), pero el aviso está para que nadie se olvide.

#### d) Sacar `PROVEEDORES_SANDBOX`

Después del punto (b). Mientras esté, **nada se escribe en SIESA**.

#### e) ~~Pantalla para administrar admins del portal~~ — ✅ HECHO (2026-08-27)

Tercera pestaña del panel de compras. Listar, agregar por correo, desactivar.
**Nunca borrar**: la auditoría de quién aprobó qué apunta a esas filas.

Tres guardas: el correo se resuelve contra `profiles` (no contra `auth.users`,
donde también viven los proveedores); nunca se llega a cero admins activos; y no
hay DELETE en ningún lado.

### 6.3 Deuda conocida — no bloquea

- **El sistema de rutas de la app.** `RutaProtegida.jsx` autoriza ~30 rutas a
  cualquier usuario logueado sin mirar el rol. El portal lo esquiva con su propia
  tabla `pp_admins`. Documentado en `PortalProveedores/RUTAS.md`.
- **Rate limit en memoria.** Cuenta por instancia de lambda; en Vercel N
  instancias multiplican el límite por N. Es un lomo de burro, no un muro.
- **`prop-types`.** ESLint se queja en los componentes nuevos. Ningún componente
  del repo los tiene. Si se adopta, se adopta para todo `src/`.
- **¿Aparece `IV03` (IVA) en las cotizaciones?** Se vio en una pantalla de entrada
  por compra, no en la consulta. Conviene confirmarlo antes de la primera
  aprobación real. El código no tiene lista blanca de llaves, así que una llave
  nueva pasa sola.

### 6.4 Preguntas abiertas para el negocio

1. **¿El tope es por NIT o por sucursal?** Hoy por NIT.
2. **¿Qué pasa si el precio de SIESA cambia entre la solicitud y la aprobación?**
   Hoy `precio_actual` queda congelado y el admin ve el comparativo.

---

## 7. Cómo levantarlo

```bash
cd BACKEND/backend-proveedores
npm install
npm test          # 158 pruebas
npm run dev       # localhost:3000
```

```bash
cd Pagina-web_React
npx vitest run src/pages/PortalProveedores   # 32 pruebas
npm run dev                                   # localhost:5173
```

| Entrar como | Dónde |
|---|---|
| Proveedor | `/portal-proveedores/ingreso` — NIT 800186960, suc. 006 |
| Compras | `/portal-proveedores/maestro` — con la sesión de la app |

Las migraciones se corren a mano en el SQL Editor de Supabase, en orden:
`sql/001` → `sql/002` → `sql/003`.
