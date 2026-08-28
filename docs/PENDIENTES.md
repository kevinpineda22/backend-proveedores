# Portal de Proveedores — todo lo pendiente

Actualizado el **2026-08-28**, después de cubrir la recuperación de contraseña.

Este archivo es la lista de trabajo. Para entender **por qué** el sistema está
armado como está, `ARQUITECTURA.md`; para el detalle de SIESA, `CONTRATO-SIESA.md`;
para el recorrido completo, `COMO-FUNCIONA.md`.

---

## Dónde estamos

El sistema funciona de punta a punta y **SIESA ya aceptó una cotización real**
(*"Importacion exitosa"*, solicitud #5). Los cinco puntos del pedido original
están cerrados.

| | |
|---|---|
| Tests | **167** backend · **65** frontend, todos verdes |
| Catálogo | 18.866 cotizaciones · 337 proveedores |
| Cuentas activas | 1 — Altipal 800186960/006 (de prueba) |
| Admins del portal | 1 |
| Backend | `backend-proveedores.vercel.app`, escribiendo en **QA** |
| Frontend | solo localhost |

---

## 1. BLOQUEANTES — sin esto no se sale a producción

### 1.1 · La consulta de TERCEROS de SIESA

**Estado:** pedida, no entregada. **No depende de nosotros.**

Hoy el maestro se deriva de la consulta de cotizaciones (`maestro.service.js`).
Alcanza para trabajar, pero **solo ve proveedores CON cotizaciones cargadas**: un
tercero dado de alta en SIESA sin precios no aparece, y a ese no se le puede
asociar un correo.

**Cuando llegue** — está detallado en `ESTADO-Y-PENDIENTES.md` §3.1.a:

1. Cargarla en Connekta **sin `ORDER BY`, sin `;`, sin comentarios**.
2. **Copiar SU `ConniKey` y `ConniToken`** — cada consulta dinámica tiene los
   suyos. Un 401 que dice *"verifique si tiene permisos"* casi siempre es esto.
3. Reescribir `sincronizarMaestro()` para leer de ahí. **Solo esa función.**
4. **Mantener `ignoreDuplicates: true`** en los upsert, o cada corrida del cron
   borra los topes que compras configuró a mano.

### 1.2 · Verificar en SIESA QA que el precio entró

**Estado:** pendiente de alguien con acceso al ERP.

SIESA respondió *"Importacion exitosa"*, pero **nuestra consulta no lo puede
comprobar**: lee de PRODUCCIÓN y el conector escribe en QA.

> Ítem **179313** (VINO SAZON BLANCO), tercero **800186960**, sucursal **006**,
> fecha de activación **20/09/2026** → debería estar en **$13.920** con su
> **ICO de $4.974**.

Hasta que alguien lo mire en la pantalla del ERP, lo que tenemos es la palabra de
SIESA, no la confirmación.

### 1.3 · Desplegar el frontend

Al hacerlo, **lo primero**:

```
PORTAL_PROVEEDORES_URL=https://merkahorro.com/portal-proveedores   (en Vercel)
VITE_PROVEEDORES_API_URL=https://backend-proveedores.vercel.app/api  (en el front)
```

Mientras `PORTAL_PROVEEDORES_URL` apunte a localhost, un proveedor real recibe un
correo con un enlace a su propia máquina. El panel avisa (`enlaceEsLocal()`), pero
el aviso está para que nadie se olvide, no para convivir con el problema.

### 1.4 · Pasar el conector a producción

Cambiar `SIESA_COTIZACION_URL` de QA a producción. **Una variable.**

Hacerlo **después** de 1.2, no antes.

---

## 2. PENDIENTE DE OTRA PERSONA

### 2.1 · ¿Hay más llaves de impuesto además de ICO e IBU3?

Son las dos que aparecen en los datos. La documentación del conector decía
"IBUA", que **no existe**. Vale confirmar con compras si hay más que esta consulta
no muestre.

Ningún código hardcodea la llave —se lee del dato— pero si alguien escribe una
lista de impuestos conocidos, que la copie de los datos y no del correo.

### 2.2 · ¿El tope es por NIT o por sucursal?

Hoy **por NIT**. El modelo aguanta bajarlo a sucursal con una columna nullable en
`pp_cuentas` que pise a la del NIT. Es una decisión de compras, no técnica.

### 2.3 · ¿Qué pasa si el precio de SIESA cambia entre la solicitud y la aprobación?

Hoy: `precio_actual` quedó congelado y el admin ve el comparativo. Falta decidir
si eso amerita una advertencia más fuerte o un rechazo automático.

---

## 3. SUBIR LO QUE ESTÁ SIN COMMITEAR

**Backend — 7 archivos** (6 modificados + este documento nuevo):

```
M README.md
M docs/ESTADO-Y-PENDIENTES.md
M src/middleware/validators.js        ← validador de recuperar contraseña
M src/routes/index.js                 ← ruta /publico/recuperar
M src/services/invitacion.service.js  ← solicitarRecuperacion() con fallo seguro al invalidar tokens anteriores
M src/services/invitacion.service.test.js ← recuperación cubierta por pruebas
?? docs/PENDIENTES.md
```

La recuperación quedó cubierta: si Supabase no puede invalidar los tokens
anteriores, el servicio se detiene y no emite otro enlace potencialmente válido.

**Frontend — 33 archivos** (13 modificados + 20 nuevos). Los nuevos:

```
components/AccesoIncorrecto.jsx + .css   la puerta equivocada, explicada
components/AdminsPortal.jsx + .css       gestión de administradores
components/Cargando.jsx                  esqueletos de carga
components/InicioProveedor.jsx + .css    el inicio del proveedor
components/Paginacion.jsx + .css         barra de páginas
components/PortalLayout.jsx + .css       sidebar + contenido
hooks/reintentos.js                      no reintentar los 4xx
hooks/useAdmins.js
styles/pp-shared.css                     primitivos sobre los tokens --sfc-*
utils/bandeja.js + .test.js              orden por tope
utils/paginacion.js + .test.js           paginar y numerosVisibles
utils/resumenProveedor.js + .test.js     el resumen del inicio
```

**Vercel corre sin la recuperación de contraseña** hasta que subas el backend.

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
| Compras | `/portal-proveedores/maestro` |

Correr el snapshot a mano:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/snapshot
```

**Interruptores para probar sin consecuencias:**

| Variable | Qué hace |
|---|---|
| `PROVEEDORES_SANDBOX=true` | Arma el payload y lo deja en el log, **sin escribir en SIESA** |
| `PROVEEDORES_MAIL_PRUEBA=true` | Escribe el correo en el log en vez de mandarlo |
