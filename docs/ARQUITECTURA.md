# Portal de Proveedores — Arquitectura

> Documento maestro. Toda decisión de diseño se toma acá primero y después se
> escribe el código. Si el código y este documento no coinciden, uno de los dos
> está mal — y hay que arreglarlo, no ignorarlo.

Estado: **implementado y desplegado en producción** (2026-08-27).

El contrato exacto con SIESA (consultas, conector, formatos, riesgos) vive en
**[CONTRATO-SIESA.md](./CONTRATO-SIESA.md)**. Leerlo junto con este.

Bloqueado por:
- Consulta de **terceros** SIESA (falta) — el maestro se deriva provisionalmente
  de las cotizaciones, así que un proveedor sin precios cargados no aparece.
- La **primera aprobación real** contra SIESA, nunca ejecutada.

Ya NO bloquea:
- ~~Prueba en QA del riesgo de impuestos/descuentos huérfanos~~ — **confirmado
  con datos de producción**, sin necesidad de QA: el propio histórico de SIESA
  mostró un ICO de $5.102 que desapareció al cambiar de fecha. La re-emisión de
  los tres bloques es obligatoria y está implementada. Ver CONTRATO-SIESA §3.

### Desplegado en producción (2026-08-27)

`https://backend-proveedores.vercel.app` — verificado de punta a punta:

| Chequeo | Resultado |
|---|---|
| `/api/salud` | 200 |
| `/api/publico/sucursales?nit=800186960` | 200 — devuelve la sucursal 006 |
| `/api/proveedor/catalogo` sin token | 401 |
| `/api/cron/snapshot` sin secreto | 401 |
| CORS desde `localhost:5173` y `merkahorro.com` | permitido |
| CORS desde otro origen | **sin** `Access-Control-Allow-Origin` |
| Snapshot completo | **27 s**, 18.866 cotizaciones, 337 proveedores |

Los 27 segundos importan: `vercel.json` da 300 de `maxDuration`, así que el cron
de las 10:00 UTC (5:00 Colombia) tiene margen de sobra aun si SIESA se pone lenta.

#### Variables en Vercel

```
SUPABASE_URL · SUPABASE_SERVICE_KEY · CONNI_KEY · CONNI_TOKEN · CRON_SECRET
SIESA_CONSULTA_COTIZACIONES=merkahorro_cotizaciones_dev_2
CORS_ORIGENES=https://merkahorro.com,http://localhost:5173
PORTAL_PROVEEDORES_URL=http://localhost:5173/portal-proveedores   ← provisional
PROVEEDORES_SANDBOX=true                                          ← provisional
```

**`PORTAL_PROVEEDORES_URL` apunta a localhost a propósito**: el frontend todavía
no está desplegado, así que ese ES el lugar donde vive el portal hoy. El día que
suba, se cambia.

Mientras tanto, `enlaceEsLocal()` lo detecta y el panel avisa al invitar: *"la
cuenta quedó invitada, pero el enlace apunta a una dirección local y NO le va a
funcionar al proveedor"*. Sin ese aviso, compras invitaría a un proveedor real, el
correo saldría perfecto, y nadie se enteraría hasta que el proveedor llame.

#### CSP: no hubo que tocarlo

`public/.htaccess` tiene hoy `connect-src *`, y la versión endurecida que está
preparada para la Fase 3 ya incluye `https://*.vercel.app` — el dominio nuevo
entra por ese comodín. Checklist de `CSP_MIGRATION_GUIDE.md` §5 cumplido sin
cambios.

---

### Estado de implementación

Actualizado 2026-08-27. `npm test` → **142 pruebas, 142 pasan.**

Migraciones: `001` ✅ · `002` ✅ — las dos ejecutadas.

Consulta SIESA: ✅ `merkahorro_cotizaciones_dev_2` cargada y en uso.

**Snapshot corriendo contra datos reales (2026-08-27):**

```
18.960 crudas → 18.866 cotizaciones · 0 descartadas · 27,7 s
barrido: 3.651 borradas (el histórico muerto, exacto)
337 proveedores · solo COP · 134 con precio futuro cargado
```

`pp_cotizaciones` tiene 18.866 filas y ninguna anterior a 2020. El catálogo del
portal está poblado.

| Módulo | Estado | Qué resuelve |
|---|---|---|
| `services/costoNeto.js` | ✅ 16 tests | Tope % sobre costo neto (§6) |
| `services/formatoSiesa.js` | ✅ 16 tests | Anchos fijos del conector, fechas sin `Date` |
| `services/normalizarCotizacion.js` | ✅ 21 tests | Relleno CHAR, pivote de descuentos, ICO/IBUA, vigente vs. programada |
| `services/siesaCotizacion.js` | ✅ 17 tests | Armado de los tres bloques, re-emisión de impuestos, POST al conector |
| `services/snapshot.service.js` | ✅ 11 tests | Cron consulta → `pp_cotizaciones`, con válvula de barrido |
| `services/firma.service.js` | ✅ 17 tests | `payload_hash` canónico, verificación previa a aprobar (§8) |
| `sql/001_create_tables.sql` | ✅ **ejecutada** | Tablas `pp_*`, RLS, append-only por trigger |
| `middleware/auth.js` | ✅ 14 tests | JWT → `cuenta_id`, suplantación, estados de cuenta (§5) |
| `middleware/errorHandler.js` | ✅ | 5xx sin filtrar internals; 4xx con mensaje accionable |
| `config/supabase.js` `config/connekta.js` | ✅ | Service-key; consulta sin paginación con reintentos |
| `vercel.json` | ✅ | Cron del snapshot, 10:00 UTC = 5:00 Colombia |
| `services/solicitud.service.js` | ✅ | Crear / aprobar / rechazar + empuje idempotente |
| `services/maestro.service.js` | ✅ 7 tests | `pp_proveedores` + `pp_cuentas` — **fuente provisional** |
| `services/invitacion.service.js` | ✅ 5 tests | Token de un solo uso, 72 h. Los tests cubren el aviso de enlace local (§3.4) |
| `services/email.service.js` | ✅ | SMTP con modo prueba |
| `services/emailSintetico.js` | ✅ 10 tests | Gemelo del front |
| `middleware/validators.js` | ✅ | Zod en todo lo que entra |
| `middleware/rateLimit.js` | ✅ | Lomo de burro del endpoint público |
| `controllers/` `routes/` `server.js` | ✅ **en producción** | API completa. Falta solo el ABM de `pp_admins` |
| Front `utils/emailSintetico.js` | ✅ 10 tests | Gemelo del backend |
| Front `utils/costoNeto.js` | ✅ 16 tests | Vista previa del tope |
| Front `LoginProveedor.jsx` | ✅ probado | NIT → sucursal → contraseña |
| Front `ActivarCuenta.jsx` | ✅ | Destino del enlace de invitación |
| Front `AdminPanel.jsx` + `PerfilProveedor` | ✅ | Maestro, correo y tope |
| Front `utils/fechas.js` | ✅ 6 tests | `hoyEnColombia`, formato sin `Date` |
| Front `ProveedorPanel.jsx` | ✅ probado | Catálogo, solicitudes, cierre de sesión |
| Front `EditarPrecioModal.jsx` | ✅ probado | Propuesta + costo neto en vivo + firma |
| Front `BandejaAprobaciones.jsx` | ✅ | Aprobar / rechazar, montada en `AdminPanel.jsx` |

### Rutas del frontend

| Ruta | Acceso |
|---|---|
| `/portal-proveedores/ingreso` | pública |
| `/portal-proveedores/activar?token=` | pública |
| `/portal-proveedores` | pública en el router, **cerrada por el backend** |
| `/portal-proveedores/maestro` | protegida (compras) |

Las tres primeras van en `publicRoutes` de `RouterApp.jsx` **a propósito**: el
guard de `protectedRoutes` exige una fila en `profiles`, y el proveedor —un
tercero externo— no la tiene. Ponerlas ahí redirige al login corporativo.

Que el panel esté en `publicRoutes` **no lo deja abierto**: sin sesión de
Supabase, `/api/proveedor/*` devuelve 401 y la pantalla queda vacía. La autoridad
es el backend, no el router — que es donde tiene que estar.

### Verificado en pantalla con datos reales (2026-08-27)

Entrando como Altipal 800186960 / sucursal 006:

- **198 cotizaciones** en el catálogo de esa sucursal.
- `SARDINAS ISABEL` — $8.256,63 con 3% → costo neto **$8.008,93**. La cuenta da.
- `ATUN ALAMAR` aparece en `P2` a $9.782,55 y en `UND` a $4.891,28 — el doble
  exacto. El multi-UM se ve como dos renglones distintos, que es lo correcto.
- **El agujero del descuento, en vivo:** bajando el descuento de 3% a 0 sin tocar
  el precio, el panel muestra `$8.008,93 → $8.256,63` y **▲ 3.09%**. El proveedor
  ve la subida que un tope sobre el precio jamás habría detectado.
- El paso de firma muestra el resumen exacto de lo que se firma, con el aviso de
  que la firma deja de valer si el contenido cambia.

### Sobre `prop-types`

Los componentes nuevos no declaran `propTypes`, y ESLint se queja. Es una regla
que **ningún componente del repo cumple** —`Traslados/components/CantidadModal.jsx`
tiene los mismos errores— y nadie usa la librería. Agregarla solo acá
introduciría un patrón nuevo en cuatro archivos y dejaría el resto igual. Si algún
día se adopta, se adopta para todo el `src/`.

### Endpoints

| Método | Ruta | Quién |
|---|---|---|
| GET | `/api/salud` | público |
| GET | `/api/publico/sucursales?nit=` | público (rate-limited) |
| GET | `/api/proveedor/cuenta` | proveedor |
| GET | `/api/proveedor/catalogo` | proveedor |
| GET | `/api/proveedor/solicitudes` | proveedor |
| POST | `/api/proveedor/solicitudes` | proveedor (no bloqueado) |
| GET | `/api/admin/proveedores` | admin |
| PATCH | `/api/admin/proveedores/:nit` | admin |
| GET | `/api/admin/solicitudes?estado=` | admin |
| GET | `/api/admin/firmas/:id` | admin |
| POST | `/api/admin/solicitudes/:id/aprobar` | admin |
| POST | `/api/admin/solicitudes/:id/rechazar` | admin |
| POST/GET | `/api/cron/snapshot` | `CRON_SECRET` |

Verificado arrancando el server: `/api/salud` responde 200, el catálogo sin token
da 401, el cron sin secreto da 503, y el público sin NIT da 422 con el campo que
falta.

### Dos detalles de `server.js` que parecen menores y no lo son

**`trust proxy`.** Sin eso, detrás de Vercel `req.ip` devuelve la IP del proxy
para todos los requests: el límite por IP se vuelve un límite global —un visitante
agota la cuota de todos— y las IPs guardadas en `pp_firmas` y `pp_auditoria` son
todas la misma, o sea inútiles como prueba.

**`express.json({ limit: "2mb" })`.** El trazo de la firma viaja como data URI
base64 y pesa cientos de KB. Con los 100 KB que trae Express por defecto, el
proveedor firma, envía, y recibe un 413 sin explicación en el último paso.

### El barrido del snapshot tiene freno

`pp_cotizaciones` se repuebla entera en cada corrida, y lo que la corrida no tocó
se borra — así una cotización que desapareció de SIESA desaparece del portal.

Pero borrar es destructivo. Una consulta que devuelve de menos —SIESA a medio
responder, un timeout parcial, un filtro que cambió— borraría medio catálogo y
dejaría a los proveedores sin poder cotizar productos que sí existen.

Por eso el barrido corre solo si el resultado es **creíble**: nunca con cero
filas, y nunca si el catálogo encogió a menos de la mitad
(`SNAPSHOT_RETENCION_MINIMA`). Si no barre, quedan filas viejas de más — un
problema menor y visible. Borrar de más es grave y silencioso.

### Qué hace válida la firma

El `payload_hash` se calcula sobre una serialización **canónica**, armada campo
por campo en orden fijo. No con `JSON.stringify`: el orden de las claves depende
de cómo se construyó el objeto, y dos llamadas con los mismos datos podrían dar
hashes distintos. Una verificación que falla de a ratos es peor que no verificar,
porque destruye la confianza en las que sí pasan.

`verificarFirmaDeSolicitud()` se llama **antes de aprobar**. Ahí la firma pasa de
ser un registro a ser una garantía: si alguien tocó la solicitud entre la firma y
la aprobación, lo detecta y frena el empuje.

El motor de escritura a SIESA está completo y probado, **pero no se puede dar por
bueno hasta la prueba en QA de CONTRATO-SIESA §3**: los tests verifican que
re-emitimos los impuestos, no que SIESA los necesite. Si resulta que los conserva
solo, el bloque sobra; si no los conserva —lo que sugiere la documentación—, era
obligatorio. En los dos casos el código ya está del lado seguro.

Se escribió primero el núcleo de plata —las tres reglas que deciden cuánto se
paga— y recién después va la infraestructura. El orden es deliberado: una
pantalla linda sobre una regla de precios sin probar es una pantalla linda que
cobra mal.

---

## 1. Qué es esto

Un portal donde nuestros proveedores ven los productos que nos venden y pueden
**proponer** un cambio de precio. Proponer, no cambiar: nada llega a SIESA hasta
que un admin de Merkahorro lo aprueba.

Dos superficies, dos roles, un solo login:

| Superficie | Quién entra | Qué ve |
|---|---|---|
| Admin | Merkahorro (compras) | Maestro de proveedores, bandeja de aprobaciones |
| Proveedor | Tercero externo | Solo sus cotizaciones y sus solicitudes |

El proveedor **nunca** ve el maestro. No es que se le oculte el menú: es que el
backend no le responde esos endpoints. Ver §5.

---

## 2. Nombres — leer antes de escribir código

`admin_proveedor` y `admin_proveedores` **YA EXISTEN** en la app y pertenecen a
Trazabilidad Contable (`/trazabilidad/crear-proveedor`). No son este proyecto.
Reusar esos roles le daría a un contador acceso a la aprobación de precios.

Nomenclatura de este proyecto — prefijo `pp_` (Portal Proveedores):

| Cosa | Nombre |
|---|---|
| Rol del proveedor | `pp_proveedor` |
| Rol del admin de compras | `pp_admin` |
| Tablas Supabase | `pp_proveedores`, `pp_cuentas`, `pp_solicitudes_precio`, … |
| Prefijo CSS | `pp-` |
| Carpeta frontend | `src/pages/PortalProveedores/` |
| Rutas | `/portal-proveedores/*` |

---

## 3. Identidad y login

### 3.1 El problema

Supabase Auth se autentica con **email + contraseña**. El proveedor entra con
**NIT + sucursal + contraseña**. No son la misma cosa.

### 3.2 La decisión (Opción A)

El par NIT+sucursal se traduce a un **email sintético** que es la identidad real
en Supabase Auth. El correo verdadero del proveedor vive aparte, en
`pp_cuentas.correo_notificacion`, y sirve **solo para mandarle avisos**.

```
NIT 900123456, sucursal 02
  → identidad Auth:  900123456-02@proveedores.merkahorro.com
  → correo real:     compras@ejemplo.com   (solo notificaciones)
```

Una cuenta por **sucursal**. Aislamiento limpio: la sucursal 02 no puede leer
datos de la 01 aunque compartan NIT.

Por qué así y no con el correo real como identidad: si el correo real fuera la
identidad, el front necesitaría un endpoint público que dado un NIT devuelva
correos de contacto. Eso es una fuga de datos de terceros y una lista de
enumeración de proveedores servida en bandeja.

### 3.3 El flujo de ingreso

```
1. El proveedor escribe su NIT
2. El front pide  GET /api/publico/sucursales?nit=900123456
   → devuelve SOLO  [{ sucursal: "01", nombre: "Sucursal Medellín" }, ...]
   → NUNCA devuelve correos, ni si la cuenta está activa, ni datos de contacto
3. Elige sucursal
4. Escribe contraseña
5. El front arma el email sintético y llama signInWithPassword
```

**El endpoint del paso 2 es la única superficie sin autenticar del sistema.**
Por eso: rate limit por IP, devuelve lista vacía si el NIT no existe (mismo
tiempo de respuesta, sin distinguir "no existe" de "no tiene portal"), y jamás
más campos que los dos de arriba.

### 3.4 Alta de credenciales — enlace de invitación (decidido)

El admin asocia un correo al proveedor. A partir de ahí:

1. Se crea el usuario en Supabase Auth con el email sintético, **sin contraseña
   utilizable**.
2. Se genera un **token de invitación de un solo uso** (`pp_invitaciones`), con
   vencimiento de 72 h.
3. Al correo real le llega un enlace, no una clave. El proveedor abre el enlace y
   **define su propia contraseña**.
4. El token se quema al usarse. Un token vencido o ya usado da el mismo mensaje
   genérico.

Por qué no mandar la contraseña en el correo: una clave en texto plano en un
buzón queda ahí **para siempre**, se reenvía, se archiva, se sincroniza a tres
dispositivos. Si mañana ese buzón se compromete, tu portal de precios se va con
él. Un enlace que vence en 72 h y se quema al primer uso, no.

Decidido así por Johan el 2026-08-26. La alternativa de clave temporal por correo
queda descartada.

---

## 4. Modelo de datos

```
pp_proveedores          espejo local del maestro de terceros de SIESA
  nit                   PK
  razon_social
  porcentaje_max        NUMERIC(5,2)  ← el tope de subida. NULL = sin tope
  bloqueado             BOOLEAN
  actualizado_at

pp_cuentas              una fila por sucursal habilitada
  id                    PK
  nit                   FK → pp_proveedores
  sucursal
  nombre_sucursal
  correo_notificacion   ← el correo REAL, solo para avisos
  user_id               FK → auth.users  (el email sintético)
  estado                'sin_invitar' | 'invitado' | 'activo' | 'suspendido'
  UNIQUE (nit, sucursal)

pp_invitaciones
  token_hash            ← se guarda el HASH, nunca el token
  cuenta_id, expira_at, usado_at

pp_solicitudes_precio   el corazón del sistema
  id                    PK
  cuenta_id             FK  ← de acá sale quién es el dueño. Del JWT, no del body
  item_codigo, item_descripcion
  unidad_medida         ← PARTE DE LA LLAVE en SIESA. No es un adorno
  precio_actual         el que tenía SIESA al momento de solicitar
  precio_propuesto
  variacion_pct         calculada en el servidor
  porcentaje_max_vigente snapshot del tope que regía ← auditoría
  fecha_activacion      DATE
  impuestos_vigentes    JSONB  ← snapshot [{llave:'ICO', valor:1200}, ...]
  descuentos_vigentes   JSONB  ← snapshot [{orden:1, pct:5, valor:0}, ...]
  estado                'pendiente'|'aprobada'|'rechazada'|'aplicada'|'fallida'
  motivo_rechazo
  firma_id              FK → pp_firmas  (NOT NULL para salir de 'pendiente')
  siesa_aplicado_at     ← ancla de idempotencia. Ver §7
  creado_at, resuelto_at, resuelto_por

  UNIQUE (cuenta_id, item_codigo, unidad_medida) WHERE estado = 'pendiente'
```

> **Por qué `unidad_medida` y los dos snapshots JSONB.**
>
> La llave de una cotización en SIESA es
> `(nit, sucursal, moneda, item, fecha_activacion, unidad_medida)`. Un ítem NO
> tiene un precio: tiene un precio **por unidad de medida**. Guardar solo
> `item_codigo` haría que dos renglones del mismo ítem en unidades distintas se
> pisen. Es el mismo problema multi-UM de Traslados.
>
> Los snapshots de impuestos y descuentos existen porque la fecha también está en
> la llave: al crear la cotización con fecha nueva hay que **re-emitir** los
> impuestos y descuentos vigentes, o nacen huérfanos. Ver CONTRATO-SIESA §3 —
> es el riesgo más caro del proyecto.

```

pp_firmas               APPEND-ONLY. Sin UPDATE, sin DELETE
  id, cuenta_id, user_id
  payload_hash          SHA-256 del contenido exacto firmado
  trazo                 PNG base64 (la parte visible)
  ip, user_agent, firmado_at

pp_auditoria            APPEND-ONLY
  entidad, entidad_id, accion, estado_anterior, estado_nuevo,
  actor_user_id, actor_rol, detalle JSONB, creado_at
```

---

## 5. Aislamiento entre proveedores — regla no negociable

> **El `cuenta_id` de cualquier operación sale SIEMPRE del JWT. Nunca del body,
> nunca del query string, nunca de un header que mande el cliente.**

Es la única regla que, si se rompe, convierte esto en una fuga de datos entre
competidores. Un proveedor viendo los precios de otro no es un bug menor: es un
problema legal.

Tres capas, porque una sola falla:

1. **Middleware** — resuelve `user_id → cuenta_id` contra `pp_cuentas` en cada
   request. Si el body trae un `cuenta_id` distinto: **403 y log de auditoría**,
   no un filtro silencioso. Alguien está probando.
2. **RLS en Supabase** — políticas por `auth.uid()` sobre todas las tablas `pp_`.
   Es la red debajo del trapecio: si mañana alguien escribe una query sin filtro,
   la base la corta igual.
3. **Endpoints separados** — `/api/proveedor/*` y `/api/admin/*` no comparten
   router ni middleware. El proveedor no puede ni llegar al maestro.

### Por qué RLS no alcanza sola

El backend se conecta con la **service key**, que pasa por encima de RLS. Con esa
llave, una consulta sin filtro devuelve las filas de todos. RLS no protege del
backend: protege del **otro camino**, el frontend, que tiene sesión de Supabase
con la anon key y podría consultar las tablas directo.

Son dos superficies distintas y cada una necesita su capa. Confiar solo en RLS
deja al backend sin red; confiar solo en el middleware deja abierto el acceso
directo desde el navegador.

### Tres decisiones del `sql/001` que conviene no revertir

**Append-only con TRIGGER, no con RLS.** `pp_firmas` y `pp_auditoria` tienen un
trigger que lanza en `UPDATE` y `DELETE`. Quitar la política de RLS no alcanzaba:
la service key la ignora, así que un bug nuestro podía editar una firma. El
trigger ata a todos. Una firma que se puede editar no es una firma.

**`pp_proveedores` no tiene política de RLS: el proveedor nunca la lee.** Ahí vive
`porcentaje_max`. El tope es configuración interna, y el proveedor solo necesita
conocerlo en el momento en que lo choca — la respuesta a su solicitud se lo dice
con el número exacto.

**La escritura de solicitudes no se expone al cliente.** RLS da `SELECT` sobre las
propias, nada más. Un `INSERT` directo desde el navegador se saltearía la
validación del tope contra el precio que el servidor leyó de SIESA, que es
justamente lo único que la hace valer.

### Un intento de suplantación es un 403, no un filtro

Si el request trae un `cuenta_id` distinto del que dice el JWT: **403 y fila en
`pp_auditoria`**. Nunca un filtro silencioso.

La diferencia importa. Filtrando en silencio, el intento se ve igual que "no hay
datos": nadie se entera de que alguien está probando. Con un 403 registrado,
queda el usuario, la ruta, el valor que mandó y la IP.

Si el `cuenta_id` viene **igual**, pasa: hay clientes que reenvían lo que
recibieron, y romperlos no aporta seguridad.

### `bloqueado` corta proponer, no mirar

Un proveedor bloqueado sigue viendo su catálogo y sus solicitudes anteriores;
solo no puede proponer cambios. Un bloqueo que además esconde la información deja
al proveedor sin entender por qué lo llamaron, y a compras sin nada que mostrarle
en la llamada.

---

## 6. La regla del porcentaje

El admin le pone un tope a cada proveedor (ej: 5%).

> **EL TOPE AVISA, NO FRENA** — decidido por Johan el 2026-08-27.
>
> Antes, una subida por encima del tope moría en un 422 y la solicitud no nacía.
> Ya no: se crea igual, queda marcada, y **la decide un humano**.
>
> El tope pasó de candado a **etiqueta**, y eso mueve la única defensa automática
> al escritorio del admin. Es sostenible porque nada llega a SIESA sin su
> aprobación explícita — pero **solo mientras la marca se vea**. Un aviso discreto
> en una bandeja de treinta filas se vuelve invisible al tercer día, y ahí el
> tope deja de existir sin que nadie lo haya derogado.
>
> Por eso la marca vive en tres lugares y ninguno es decorativo:
> la respuesta al proveedor (`excede`), la fila de la bandeja
> (`pp-bandeja__fila--excede`) y un cartel arriba del comparativo en el detalle.
> Si algún día alguien "limpia" el diseño de la bandeja, esto es lo que no se toca.

### El tope se evalúa sobre el COSTO NETO, no sobre el precio

El proveedor edita el precio **y los descuentos por orden**. Un tope que mira solo
el precio tiene un agujero por el que se cuela cualquiera. Con data real de
Altipal:

```
ATÚN ALAMAR    Precio 4.672    PorcDsctoOrden1 = 3%
               Costo real = 4.672 × 0,97 = 4.531,84
```

El proveedor deja el precio intacto —subida 0%, pasa cualquier tope— y baja el
descuento a 0. Lo que Merkahorro paga sube a 4.672: **+3,09% que el tope nunca
vio**, porque miraba la columna equivocada. Combinado con un +4,9% de precio
—justo debajo del tope— da un **+8,14%** efectivo.

Por eso:

```
costo_neto = precio × (1 − d1) × (1 − d2) × (1 − d3)
variacion  = (costo_neto_propuesto − costo_neto_actual) / costo_neto_actual
```

Implementado y probado en `src/services/costoNeto.js` (16 tests, incluidos los dos
escenarios de arriba con los números de Altipal).

> **✅ CONFIRMADO: es CASCADA.** Y no por la palabra de nadie — por una captura
> de la pantalla de ítems de SIESA (2026-08-27), donde el ERP muestra su propia
> cuenta. `MODO_DESCUENTO = "cascada"` queda firme. Ver ESTADO §3.1.b.
>
> El snapshot COMPLETO (18.866 cotizaciones) mostró **76 renglones con dos o tres
> descuentos**: 53 con dos y 23 con tres. En esos 76, los dos modos dan números
> distintos, y el número es el que decide si una propuesta pasa el tope. Hay que
> preguntarlo antes de producción.
>
> (Órdenes observados: 1, 2 y **3** — 11.321 / 233 / 53 filas. No hay orden 4,
> verificado el 2026-08-27. El validador acepta hasta 3, que es lo que la consulta
> sabe leer.)
>
> Cambiar de modo es UNA constante: `MODO_DESCUENTO` en `services/costoNeto.js`.
> La rama `aditivo` ya está escrita y probada. **Y su gemelo del frontend**
> (`utils/costoNeto.js`), o divergen.

Reglas:

- **Se valida en el backend.** El front oculta el botón y muestra el aviso — eso
  es UX. La validación que manda corre en el servidor. Esto es plata: si vive
  solo en React, cualquiera con DevTools sube un 40%.
- **`precio_actual` y los descuentos vigentes los lee el servidor de SIESA**, no
  los manda el front. Si el front dijera cuál es el costo actual, mentir sobre él
  vuelve trivial saltarse el tope.
- **Solo aplica a subidas.** Una baja de costo nos favorece: no se bloquea.
- **`porcentaje_max = NULL` significa sin tope**, no 0%. Un 0 mal interpretado
  congelaría a todos los proveedores sin que nadie entienda por qué.
- Excedido → la solicitud **se crea igual**, marcada. El proveedor recibe un
  **201** con `excede: true` y el número del tope, para que sepa que se pasó en
  el momento y no tres días después con el rechazo. El admin la ve señalada.
- `excedeTope()` en `services/costoNeto.js` es la **única** definición de
  "excede". La usan la creación (con números recién calculados) y la bandeja (con
  números ya guardados). Si cada lugar la resolviera por su cuenta, un día el
  proveedor leería "dentro del tope" y el admin "lo excede" sobre la misma fila.
- El tope vigente se **congela** en la solicitud (`porcentaje_max_vigente`). Si
  el admin lo cambia después, el histórico sigue diciendo cuál regía ese día.

La fórmula vive en `src/services/costoNeto.js`, es pura y **está probada**. Es la
regla que decide si entra plata de más: se prueba, no se confía.

El frontend tiene un gemelo (`utils/costoNeto.js`) que sirve **solo** para mostrar
el número mientras el proveedor escribe. Si los dos divergen, el peor caso es una
vista previa confusa — nunca un precio mal aprobado, porque decide el backend.
Aun así, si tocás uno, tocá el otro: es el mismo trato que los gemelos de
`ecommerce/shared/`.

---

## 7. Aprobación y empuje a SIESA

```
pendiente ──aprobar──> [empuje inmediato a SIESA] ──> aplicada
    │                                             └─> fallida
    └──rechazar──> rechazada
```

### No hay cron. El empuje ocurre al aprobar

Esta decisión cambió al leer la documentación del conector, y conviene entender
por qué: **`FECHA_ACTIVACION` es parte de la llave natural en SIESA.** El ERP
soporta precios futuros de forma nativa — un registro con fecha `20260901` no
pisa al vigente, convive con él y entra en vigor ese día solo.

O sea que quien activa es SIESA, no nosotros. Aprobar y empujar es el mismo acto.

El diseño anterior —cron el día de la activación— agregaba un punto de falla que
se paga caro: si ese día Vercel tiene un incidente o el conector está caído, el
precio no entra y **nadie se entera hasta que llega una factura con el precio
viejo**. Empujando al aprobar, cualquier fallo aparece en pantalla mientras el
admin está mirando.

¿Y si el admin se arrepiente después? Es reversible: se reenvía la misma llave
con `F_ACTUALIZA_REG=1` y el precio anterior. La llave es estable — por eso se
puede deshacer.

**El empuje incluye siempre los tres bloques**: encabezado, impuestos y
descuentos re-emitidos con la fecha nueva. Ver CONTRATO-SIESA §3.

### Idempotencia — obligatoria, no opcional

En Traslados ya pasó: sin un ancla de idempotencia, el mismo documento se mandó a
SIESA tres veces. Acá el ancla es `siesa_aplicado_at`:

- Se aprueba con un UPDATE condicionado a `siesa_aplicado_at IS NULL`. Si la fila
  ya estaba marcada, el doble clic del admin no dispara un segundo empuje.
- Se marca **antes** de considerar cerrada la operación.
- Cada intento deja fila en `pp_auditoria`, exitoso o no.
- Un fallo de red tras enviar deja la solicitud en `fallida` con el detalle, para
  revisión manual. **Nunca reintento ciego** — con un write al ERP, "no sé si
  llegó" es peor que "falló".
- No delegamos la idempotencia al `F_ACTUALIZA_REG` del ERP: en el bloque de
  descuentos vale `0` (no reemplaza), así que el reenvío no se comporta igual que
  en el encabezado.

---

## 8. Firma digital — qué la hace válida

El trazo dibujado es la parte **visible**. No es la parte válida.

Lo que hace que la firma signifique algo:

```
payload_hash = SHA-256( item + precio_actual + precio_propuesto + fecha_activacion + cuenta_id )
```

Más: timestamp **del servidor** (no del cliente), `user_id`, IP y user-agent.

Si después alguien modifica cualquier campo de la solicitud, el hash deja de
coincidir y la firma queda inválida. Eso es exactamente lo que se quiere: una
firma que no está atada al contenido firmado no prueba absolutamente nada — es un
dibujito.

La tabla es **append-only**. Una firma que se puede editar no es una firma.

Reutilizar el patrón de `src/pages/Traslados/components/SignatureModal.jsx`, que
ya está resuelto y probado en producción.

---

## 9. Etiquetas de interfaz

- El campo `precio_unitario` de SIESA se muestra como **"Precio antes de
  impuestos"**. Siempre, en toda la UI. Nunca "precio unitario" a secas: un
  proveedor lo lee como precio final y propone mal.
- Textos de interfaz en **español neutro, tratamiento de usted**. Es un portal
  externo, con terceros. Nada de voseo en la UI.

---

## 10. Estructura

### Frontend — `src/pages/PortalProveedores/`

```
LoginProveedor.jsx        NIT → sucursal → contraseña
AdminPanel.jsx            maestro + bandeja de aprobaciones
ProveedorPanel.jsx        cotizaciones + mis solicitudes
components/
  MaestroProveedores.jsx  PerfilProveedor.jsx    (asociar correo, tope %)
  TablaCotizaciones.jsx   EditarPrecioModal.jsx
  BandejaAprobaciones.jsx DetalleSolicitud.jsx   FirmaModal.jsx
hooks/     usePortalProveedores.js  useCotizaciones.js  useSolicitudes.js
services/  portalProveedoresApi.js
utils/     variacionPrecio.js(+test)  estadoSolicitud.js(+test)  emailSintetico.js(+test)
styles/
```

JSX plano, un `.css` por componente, prefijo `pp-`, modificadores con `--`.
Igual que el resto de la app. **No se introduce stack nuevo.**

### Backend — `BACKEND/backend-proveedores`

```
src/
  config/      supabase.js  connekta.js  siesa.js
  middleware/  auth.js  validators.js(zod)  rateLimit.js  errorHandler.js
  models/      Proveedor  Cuenta  SolicitudPrecio  Firma  Auditoria  Invitacion
  services/    terceros  cotizaciones  precios  siesaPrecio  email  invitacion
  controllers/ routes/
sql/    migraciones numeradas 001_…
docs/   ARQUITECTURA.md (este)  SEGURIDAD.md
```

Express + Supabase + Zod + helmet + nodemailer, ESM. Mismo molde que
`backend-traslado`. Despliegue en Vercel desde GitHub.

---

## 11. Al desplegar

El dominio nuevo del backend **debe agregarse al CSP** en
`Pagina-web_React/public/.htaccess`, siguiendo el checklist de §5 de
`docs/CSP_MIGRATION_GUIDE.md`. Se edita `public/`, nunca `dist/`.

---

## 12. Decisiones abiertas

Bloqueantes (hay que resolverlas antes de escribir el servicio de empuje):

1. **¿El proveedor edita solo el precio, o también impuestos y descuentos?**
   Supuesto actual: **solo el precio**. Impuestos y descuentos se muestran en
   modo lectura y se re-emiten tal cual con la fecha nueva. Si el proveedor
   pudiera tocarlos, cada uno necesita su propia regla de tope: un descuento que
   baja del 5% al 0% le cuesta a Merkahorro lo mismo que una subida de precio del
   5%, y hoy no habría nada bloqueándolo.

2. **Prueba en QA de impuestos/descuentos huérfanos** — CONTRATO-SIESA §3.

No bloqueantes (supuestos que el modelo aguanta cambiar):

3. **¿El tope % es por NIT o por sucursal?** Supuesto: **por NIT**, el perfil del
   proveedor. Se puede bajar a sucursal con una columna nullable en `pp_cuentas`
   que pise a la del NIT.
4. **¿Varias solicitudes pendientes del mismo ítem+U.M.?** Supuesto: **no**. El
   índice único parcial de §4 lo impide; la nueva reemplaza a la anterior y deja
   rastro en auditoría.
5. **¿Qué pasa si el precio en SIESA cambia entre la solicitud y la aprobación?**
   Supuesto: `precio_actual` quedó congelado y el admin ve la advertencia. El
   empuje usa el precio propuesto igual, pero el aviso tiene que ser visible.
