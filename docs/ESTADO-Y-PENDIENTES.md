# Portal de Proveedores — estado y pendientes

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

**Estado:** nunca se ejecutó. Todo se probó hasta el borde del POST.

`PROVEEDORES_SANDBOX=true` corta justo antes de mandar y deja el payload en el
log. **La primera aprobación tiene que hacerse así**, mirando el payload:

- ¿Los tres bloques tienen los nombres exactos?
- ¿Las fechas están en `AAAAMMDD`?
- ¿El precio tiene 20 caracteres, `000000000004900.0000`?
- ¿Los impuestos vigentes se re-emiten con la fecha NUEVA?

Recién después se saca la variable y se aprueba de verdad **en QA**
(`SIESA_COTIZACION_URL` ya apunta ahí). Pasar a producción es cambiar esa única
variable.

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
