# Portal de Proveedores — todo lo pendiente

Actualizado el **2026-08-28**.

**Este archivo es la única fuente del ESTADO del proyecto**: qué falta, qué hay en
la base y qué no hay que romper. Si un dato de estado aparece en otro documento y
contradice a este, gana este.

Los otros tres no se pisan con este ni entre ellos:

| Documento | Es dueño de |
|---|---|
| `ARQUITECTURA.md` | El **porqué**: identidad, modelo de datos, aislamiento, regla del % |
| `COMO-FUNCIONA.md` | El **recorrido**: qué pasa y en qué orden |
| `CONTRATO-SIESA.md` | El **ERP**: qué se lee y qué se escribe |
| `README.md` | La **puerta de entrada**: arrancar, variables, endpoints |

---

## Dónde estamos

El sistema funciona de punta a punta y **SIESA ya aceptó una cotización real**
(*"Importacion exitosa"*, solicitud #5). Los cinco puntos del pedido original
están cerrados.

| | |
|---|---|
| Tests | **167** backend · **65** frontend (portal), todos verdes |
| Catálogo | 18.866 cotizaciones · 337 proveedores |
| Cuentas activas | 2 — Altipal 800186960: **006** (CATALOGO GENERAL) y **009** (BABARIA) |
| Admins del portal | 1 |
| Backend | `backend-proveedores.vercel.app`, escribiendo en **QA** |
| Frontend | **desplegado** en `https://merkahorro.com/portal-proveedores` (build viejo) |
| Entrada desde el sitio | Header → **Ingresar → Proveedores** |

**Probado a mano de punta a punta el 2026-08-28**: login de proveedor, correo de
creación de contraseña, selector de sucursal con dos cuentas, y envío de una
propuesta de descuento. El circuito del proveedor no tiene pendientes de código.

---

## 1. BLOQUEANTES — sin esto no se sale a producción

### 1.1 · La consulta de TERCEROS de SIESA

**Estado:** pedida, no entregada. **No depende de nosotros.**

Hoy el maestro se deriva de la consulta de cotizaciones (`maestro.service.js`).
Alcanza para trabajar, pero **solo ve proveedores CON cotizaciones cargadas**: un
tercero dado de alta en SIESA sin precios no aparece, y a ese no se le puede
asociar un correo.

**Cuando llegue:**

1. Cargarla en Connekta como consulta nueva, mismo procedimiento que
   `CONSULTA-COTIZACIONES.sql`: **sin `ORDER BY`, sin `;`, sin comentarios**.
2. **Copiar SU `ConniKey` y `ConniToken`** — cada consulta dinámica tiene los
   suyos. Un 401 que dice *"verifique si tiene permisos"* casi siempre es esto.
   Si son distintos a los actuales, hay que decidir cómo conviven en el `.env`.
3. Reescribir `sincronizarMaestro()` para leer de ahí. **Solo esa función.**
4. **Mantener `ignoreDuplicates: true`** en los upsert, o cada corrida del cron
   borra los topes que Merkahorro configuró a mano.

### 1.2 · Verificar en SIESA QA que el precio entró

**Estado:** pendiente de alguien con acceso al ERP.

SIESA respondió *"Importacion exitosa"*, pero **nuestra consulta no lo puede
comprobar**: lee de PRODUCCIÓN y el conector escribe en QA.

> Ítem **179313** (VINO SAZON BLANCO), tercero **800186960**, sucursal **006**,
> fecha de activación **20/09/2026** → debería estar en **$13.920** con su
> **ICO de $4.974**.

Hasta que alguien lo mire en la pantalla del ERP, lo que tenemos es la palabra de
SIESA, no la confirmación.

### 1.3 · Cerrar el despliegue del frontend

**Verificado el 2026-08-28 contra producción — el frontend YA ESTÁ DESPLEGADO.**
Este documento decía "solo localhost" y era falso.

Lo que se comprobó desde `https://merkahorro.com`:

| | |
|---|---|
| `/portal-proveedores/ingreso` | renderiza el portal |
| Rewrite SPA (`public/.htaccess`) | presente — `/activar?token=` no da 404 |
| CSP | permite el backend en la versión activa y en la endurecida |
| `fetch` real al backend | **200**, devuelve las 2 sucursales |

Faltan **tres** cosas, ninguna de código:

**a) `PORTAL_PROVEEDORES_URL` sigue en localhost (en Vercel).** Es lo único que
rompe a un proveedor real: el correo le llega con un enlace a una máquina ajena.

```
PORTAL_PROVEEDORES_URL=https://merkahorro.com/portal-proveedores
```

**b) `www.merkahorro.com` NO está en `CORS_ORIGENES`.** El apex pasa; el `www`
responde 200 **sin redirigir al apex**, así que un proveedor que escriba "www"
recibe la página y el navegador le bloquea TODAS las llamadas a la API. Se ve
como "el portal está roto", sin un error que lo explique. Agregar el origen, o
redirigir `www` → apex en el hosting.

**c) El build desplegado es viejo.** Todavía dice "área de compras" y tiene el
banner de cookies en voseo. Un `npm run deploy` lo alinea.

**No hace falta que `PORTAL_PROVEEDORES_URL` sirva a localhost y a producción a
la vez** — y no podría: el correo lleva UN enlace. Para desarrollar, el token no
está atado a la URL (`activar()` lo valida por hash contra la base, sin mirar
origen): se copia el token y se pega en `localhost:5173/portal-proveedores/activar?token=…`.
CORS ya admite `localhost:5173`. Y `PROVEEDORES_MAIL_PRUEBA=true` devuelve el
enlace en la respuesta, sin mandar correo.

---

### 1.4 · Pasar el conector a producción

Cambiar `SIESA_COTIZACION_URL` de QA a producción. **Una variable.**

Hacerlo **después** de 1.2, no antes.

---

## 2. PENDIENTE DE OTRA PERSONA

### 2.1 · ¿Hay más llaves de impuesto además de ICO e IBU3?

Son las dos que aparecen en los datos. La documentación del conector decía
"IBUA", que **no existe**. Vale confirmarlo con quien lleve la relación comercial, por si hay más que esta
consulta no muestre.

Ningún código hardcodea la llave —se lee del dato— pero si alguien escribe una
lista de impuestos conocidos, que la copie de los datos y no del correo.

### 2.2 · ¿El tope es por NIT o por sucursal?

Hoy **por NIT**. El modelo aguanta bajarlo a sucursal con una columna nullable en
`pp_cuentas` que pise a la del NIT. Es una decisión de negocio, no técnica.

### 2.3 · ¿Qué pasa si el precio de SIESA cambia entre la solicitud y la aprobación?

Hoy: `precio_actual` quedó congelado y el admin ve el comparativo. Falta decidir
si eso amerita una advertencia más fuerte o un rechazo automático.

---

## 3. LO QUE ESTÁ SIN SUBIR

**Lo dice `git status`, no este archivo.**

```bash
cd BACKEND/backend-proveedores && git status --short
cd Pagina-web_React        && git status --short
```

Acá hubo una lista de 40 archivos enumerados a mano. Envejeció en un día: se
commitearon unos, aparecieron otros, y la lista pasó a describir un pasado que ya
no existía. **Un documento que copia `git status` tiene garantizado mentir.**

Lo único que vale anotar es lo que `git status` NO puede decirte:

> **Vercel corre el backend de la rama subida.** Si tocaste algo del backend y no
> lo subiste, el portal desplegado NO lo tiene, aunque tu local funcione.

---

## 4. DATOS DE PRUEBA EN LA BASE

| Qué | Detalle |
|---|---|
| Cuenta Altipal 800186960/006 | activa, clave `Portal2026.Prueba` |
| Correo asociado | `pruebas.portal@merkahorrosas.com` |
| **Tope de Altipal en 1%** | era `NULL` — se bajó para probar la marca |
| Solicitud #1 | `rechazada`, con motivo — alimenta el inicio del proveedor |
| Solicitudes #2 y #4 | `aplicada` en SANDBOX (**no** llegaron a SIESA) |
| Solicitud #5 | `aplicada` **de verdad en QA** — no borrar sin verificar 1.2 |

```sql
-- Limpieza, cuando corresponda
DELETE FROM pp_solicitudes_precio WHERE cuenta_id = 59;
UPDATE pp_proveedores SET porcentaje_max = NULL WHERE nit = '800186960';
```

`pp_firmas` y `pp_auditoria` son append-only por trigger: las firmas de prueba
quedan, y está bien que queden.

**La firma de las solicitudes #4 y #5 es un SVG que dice "FIRMA DE PRUEBA"** — a
propósito, para que nadie la confunda con la de un proveedor real.

---

## 5. DEUDA CONOCIDA — no bloquea

### 5.1 · El sistema de rutas de la app ⚠️

**Es la más importante de esta sección, y es de toda la app, no del portal.**
Documentado en `PortalProveedores/RUTAS.md`.

- `RutaProtegida.jsx` tiene un arreglo `dashboardRoutes` **hardcodeado** que
  autoriza ~30 rutas a **cualquier usuario logueado**, sin mirar el rol. Los
  permisos de `role_permissions` **no se consultan** para esas rutas.
- `profiles.personal_routes` **PISA** las del rol en vez de sumarlas. Johan tiene
  48 personales que anulan las 12 de `super_admin`.
- `startsWith(r.path)` sobre-autoriza: un permiso a `/portal` abriría
  `/portal-proveedores/maestro`.

**No se tocó a propósito.** Vaciar `dashboardRoutes` puede dejar gente afuera de
pantallas que usa todos los días: se hace ruta por ruta, mirando quién la usa.

El portal esquiva todo esto con `pp_admins`, su propia tabla de autoridad.

### 5.2 · El puente de paleta `--pp-*` → `--sfc-*`

`styles/pp-shared.css` hace que las variables viejas apunten a los tokens
corporativos. **Es un puente, no el destino:** al escribir pantallas nuevas, usar
`--sfc-*` directo. Migrar las viejas se puede hacer de a un archivo, sin apuro.

### 5.3 · Rate limit en memoria

`middleware/rateLimit.js` cuenta por instancia de lambda: en Vercel, N instancias
multiplican el límite por N. **Es un lomo de burro, no un muro.**

La protección real del endpoint público es su forma: devuelve solo sucursal y
nombre, y responde igual exista o no el NIT. Si algún día hace falta un límite de
verdad, va contra Redis o el WAF de Vercel.

### 5.4 · `prop-types`

ESLint se queja en los componentes del portal. **Ningún componente del repo los
tiene** — `Traslados/components/CantidadModal.jsx` marca los mismos errores.
Adoptarlos solo acá introduciría un patrón nuevo en unos pocos archivos. Si se
adopta, se adopta para todo `src/`.

### 5.5 · Verificar el orden 4 de descuento si cambian las condiciones

Verificado el 2026-08-27: solo existen los órdenes 1, 2 y 3. Si algún día aparece
un orden 4, se rompen dos cosas: el costo neto sale **más alto** de lo real (el
tope calcula mal) y ese descuento **se pierde** al re-emitir.

```sql
SELECT f214_orden AS Orden, COUNT(*) AS Cantidad
FROM dbo.t214_mm_cotizacion_dscto GROUP BY f214_orden
```

---

## 6. IDEAS QUE NO SE HICIERON

Ninguna es necesaria. Se anotan para no volver a pensarlas desde cero.

- **Notificar al proveedor por correo** cuando le aprueban o rechazan. Hoy se
  entera entrando al portal. El servicio de correo ya está.
- **Historial de precios por producto**, en el panel del proveedor. El dato está
  en SIESA; la consulta actual lo poda a propósito.
- **Exportar la bandeja a Excel**, como hace Traslados con `xlsx`.
- **Adjuntar un documento** a la propuesta (una carta del proveedor). Necesitaría
  storage y una decisión sobre qué se acepta.
- **Anular una solicitud pendiente** desde el lado del proveedor. Hoy solo puede
  esperar la respuesta.

---

## 7. LAS SEIS COSAS QUE NO HAY QUE ROMPER

Si algo de esto se "simplifica", el sistema sigue compilando y empieza a cobrar mal.

1. **El tope se evalúa sobre el COSTO NETO, no sobre el precio.** Bajar un
   descuento de 3% a 0 sin tocar el precio sube 3,09% lo que Merkahorro paga.
   Y desde el 2026-08-27 el tope **avisa, no frena**: la marca en la bandeja es la
   única defensa automática que queda, así que no se suaviza ni se esconde.
2. **Los impuestos se RE-EMITEN con la fecha nueva.** Confirmado en el histórico:
   `FOUR LOKO PONCHE FRUTAS` perdió un ICO de $5.102 así.
3. **Una sección VACÍA no se manda**, se omite. `"Descuentos": []` devuelve 400.
4. **El `cuenta_id` sale del JWT**, nunca del body.
5. **Aprobar TOMA la solicitud antes de empujar** a SIESA. Al revés, el peor caso
   es mandar el mismo precio dos veces.
6. **Ninguna fecha pasa por `new Date()`.** El servidor corre en UTC y Colombia es
   UTC−5. Este proyecto se topó con el huso cuatro veces.

---

## 8. ARRANCAR

```bash
cd C:/Users/johan.sanchez/Desktop/BACKEND/backend-proveedores && npm test && npm run dev
cd C:/Users/johan.sanchez/Desktop/Pagina-web_React && npm run dev
```

| Entrar como | Dónde |
|---|---|
| Proveedor | `/portal-proveedores/ingreso` — NIT 800186960, suc. 006 |
| Administrador | `/portal-proveedores/maestro` |

Correr el snapshot a mano:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/snapshot
```

**Interruptores para probar sin consecuencias:**

| Variable | Qué hace |
|---|---|
| `PROVEEDORES_SANDBOX=true` | Arma el payload y lo deja en el log, **sin escribir en SIESA** |
| `PROVEEDORES_MAIL_PRUEBA=true` | Escribe el correo en el log en vez de mandarlo |
