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

⏳ **ESPERANDO A QA.** El 2026-08-28 se le pidió a la persona con acceso al ERP
que busque el registro de la solicitud #5 **por fecha de activación 20/09/2026**,
no por precio vigente. Probamos que el conector rechaza ítems, U.M. y terceros
inexistentes con errores precisos, y que aceptó la #5 — así que el registro tiene
que estar. Ver §1.2 para la evidencia completa y qué hacer con cada respuesta.

El resto del sistema sí funciona de punta a punta: el proveedor propone y firma, y
el admin aprueba.

| | |
|---|---|
| Tests | **203** backend · **346** frontend (todo `src/`), todos verdes |
| Lint del front | **8.176 → 1.068** problemas (§5.4) |
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

**Estado:** en construcción del lado de SIESA. **El código de nuestro lado YA
ESTÁ LISTO** (2026-08-31): cuando llegue, es prender una variable de entorno.

```
SIESA_CONSULTA_TERCEROS=<la "Descripción" con la que quedó registrada>
```

Sin esa variable el maestro se sigue derivando de las cotizaciones, exactamente
como hoy. Con ella, se lee el maestro de verdad — incluidos los proveedores que
todavía no tienen precios cargados, que es el agujero que esto viene a tapar.

**Lo que se escribió:**

| Pieza | Qué hace |
|---|---|
| `config/connekta.js` → `consultarTerceros()` | Recorre la consulta paginada. El bucle se extrajo a `recorrer()` y lo comparten las dos consultas: reintentos, techo de páginas y aviso de conjunto movido valen igual para ambas |
| `maestro.service.js` → `normalizarTercero()` | Fila cruda → la forma que consume `derivarMaestro`. Recorta el relleno de los CHAR (`"1020414979      "`) y conserva los ceros de la sucursal |
| `maestro.service.js` → `leerFuente()` | Elige la fuente. Si la consulta de terceros falla, **NO** cae al fallback en silencio |

**Formato confirmado** contra la respuesta real de Connekta (2026-08-31): los
cinco alias son los mismos que ya trae la de cotizaciones — `IdTercero`,
`NitTercero`, `RazonSocial`, `Sucursal`, `DescSucursal`.

#### 🔴 La guarda del filtro — leer antes de prender la variable

La consulta de terceros trae TODO `t200_mm_terceros`: clientes, empleados,
bancos y la propia compañía. Hay que filtrarla, y ahí está el riesgo:

> **De los 337 proveedores con acuerdos de precio vigentes, 57 son PERSONAS
> NATURALES con NIT de cédula.** Ejemplos reales: `10114433 GALLON MARIN CARLOS
> ALBERTO`, `1018226469 VILLEGAS CORREA VALERIA`.

El filtro obvio a primera vista —*"sacar las personas, que son empleados"*— se
lleva al **17 %** de los proveedores reales, y nadie se entera hasta que uno
llama preguntando por qué no puede entrar. **El criterio correcto es el TIPO de
tercero en SIESA, no la forma del NIT.**

Por eso `sincronizarMaestro()` compara cada corrida contra lo que ya hay: si la
fuente no trae proveedores que YA están en el maestro, lo grita con
`console.error` y el número queda en el resultado de la corrida
(`proveedoresNoTraidos`). Nadie se borra —el upsert usa `ignoreDuplicates`—
pero la lista incompleta deja de ser invisible.

La lista de control para validar el filtro está en
`docs/NITS-PROVEEDORES-CONTROL.txt` (337 NIT).

#### Cuando llegue

1. Cargar la consulta en Connekta **sin `ORDER BY`, sin `;`, sin comentarios**.
2. **Copiar SU `ConniKey` y `ConniToken`** — cada consulta dinámica tiene los
   suyos. Un 401 que dice *"verifique si tiene permisos"* casi siempre es esto.
3. Poner `SIESA_CONSULTA_TERCEROS` en Vercel y correr el snapshot a mano.
4. Mirar `proveedoresNoTraidos` en el resultado: **tiene que ser 0**.
5. Mantener `ignoreDuplicates: true` en los upsert, o cada corrida borra los
   topes que Merkahorro configuró a mano.

**Pendiente de SIESA, no bloqueante:** el CORREO del proveedor (hoy se carga a
mano, una por una, ~400 cuentas) y su ESTADO activo/inactivo.

---

### 1.2 · Encontrar en SIESA QA el registro de la solicitud #5

**Estado:** ⏳ **esperando respuesta de QA** (pedido el 2026-08-28). El conector
aceptó el registro; falta ubicarlo en la pantalla correcta del ERP.

**Probado el 2026-08-28** con `scripts/diagnostico-siesa.js`, que reenvía el
payload real y una variante con un ítem inexistente:

| Prueba | Respuesta |
|---|---|
| `ITEM: "999999999"` (9 chars) | 400 · *"El campo ITEM supera el tamaño permitido (**7**)"* |
| `ITEM: "9999999"` (7 chars, inexistente) | 400 · *"el item no existe por código, extensiones, referencia, ni codigo de barras"* + *"la unidad de medida no es valida para el item"* |
| `NIT_PROVEEDOR: "999999999"` con ítem real | 400 · *"el tercero-Sucursal no existe"* (valida el PAR, no cada uno) |
| Solicitud #5 — todo real | 200 · `codigo: 0` · *"Importacion exitosa"* |

**Qué prueba esto:** el conector valida TODO lo que puede — tamaño de campo,
existencia del ítem, U.M. compatible con ese ítem, y el par tercero-sucursal. Y
rechaza con mensajes precisos (`codigo: 1`, HTTP 400, `detalle` por línea y
bloque). **No regala aprobaciones.** La #5 atravesó las cuatro validaciones con
datos reales ⇒ **el registro se escribió**.

Reenviado el 2026-08-28 con `--real` para tener una escritura con hora conocida:
misma respuesta, 200 / `codigo: 0`.

**Qué descarta:** `idCompania 7375`, `idSistema 1` y `idDocumento 253851` están
bien apuntados. Si no lo estuvieran, el conector no podría haber resuelto nada de
eso. Se sospechó de los tres y quedaron limpios.

**Qué hay que hacer:** buscar en QA **por fecha de activación**, no por precio
vigente. La cotización activa el **20/09/2026**, o sea en el futuro: en la
pantalla del precio de hoy no tiene por qué aparecer.

> ítem **179313** · tercero **800186960** · sucursal **006** · U.M. **UND**
> · activación **20/09/2026** → precio **$13.920** con **ICO $4.974**

**Qué hacer con la respuesta:**

| Si contestan… | Entonces |
|---|---|
| **Aparece** | Cerrado. §1.2 sale de bloqueantes y queda solo §1.4 (pasar el conector a producción). |
| **Sigue vacío** | Ya no es pregunta nuestra: un conector que valida todo, confirma éxito y no persiste se escala **a SIESA**, con las tres respuestas de la tabla de arriba como evidencia. En paralelo, implementar la deuda §5.6 (releer para verificar). |

El script queda en el repo para repetir la prueba cuando haga falta:
`node scripts/diagnostico-siesa.js [--real] [--tercero]`. Nunca imprime
credenciales; `--tercero` puede dejar un registro basura en QA si algún día el
conector deja de validar el tercero (hoy lo valida).

---

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

Queda **una** cosa, y no es de código:

**a) ⏳ `PORTAL_PROVEEDORES_URL` — SIN CONFIRMAR.** No se puede verificar desde
afuera: hay que mirarlo en el panel de Vercel. Es lo único que todavía rompe a un
proveedor real — el correo le llegaría con un enlace a una máquina ajena.

```
PORTAL_PROVEEDORES_URL=https://merkahorro.com/portal-proveedores
```

**b) ✅ HECHO — `www.merkahorro.com` ya pasa CORS.** Commit `982e5dc` del
2026-08-28. Verificado el 2026-08-31 contra producción:
`Access-Control-Allow-Origin: https://www.merkahorro.com`.

**c) ✅ HECHO — el frontend se redesplegó.** Verificado el 2026-08-31 leyendo
`https://merkahorro.com/portal-proveedores/ingreso`: dice *"Comuníquese con
Merkahorro"* y el banner de cookies está en usted.

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
| Cuenta Altipal 800186960/**006** | activa, clave `Portal2026.Prueba` |
| Cuenta Altipal 800186960/**009** (BABARIA) | creada el 2026-08-28 para probar el selector de sucursal |
| Correo asociado a la 006 | `pruebas.portal@merkahorrosas.com` |
| **Tope de Altipal en 1%** | era `NULL` — se bajó para probar la marca |
| Solicitud #1 | `rechazada`, con motivo — alimenta el inicio del proveedor |
| Solicitudes #2 y #4 | `aplicada` en SANDBOX (**no** llegaron a SIESA) |
| Solicitud #5 | `aplicada` — reenviada a QA el 2026-08-28. **No borrar hasta cerrar §1.2**. Si QA dice que no está, ya se puede devolver a la cola: `reintentar()` acepta `incierto` (§5.6) |

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

### 5.1 · El sistema de rutas de la app ⚠️ — PARCIALMENTE RESUELTO

**Es de toda la app, no del portal.** Documentado en
`Pagina-web_React/src/pages/PortalProveedores/RUTAS.md`.

#### ✅ Hecho (2026-08-31): la comparación por prefijo

`RutaProtegida.jsx` autorizaba con `currentPath.startsWith(r.path)`. La regla
vive ahora en `src/config/autorizacionRutas.js` y compara por **segmento**, con
5 tests.

**Medido ANTES de tocarlo**, con `scripts/auditar-rutas.mjs` sobre los 161
perfiles: **un solo** par sobre-autorizado en toda la app —
`/dashboards` abría `/dashboardsociodemografico` para 7 `super_admin`. Dos ya
tenían la ruta explícita, así que los otros 5 ya la tienen asignada (2026-08-31). ✅ **Verificado: 0 usuarios perdieron acceso**, 0 duplicados, una sola etiqueta.

El SQL que se usó (queda como plantilla para el próximo caso igual). La etiqueta
se copió LITERAL de la que ya tenían los otros dos: dos formas distintas de
nombrar la misma pantalla es como empiezan los desórdenes que nadie sabe de dónde
salieron.

```sql
-- 1) Ver a quiénes alcanza (deben salir 5, todos super_admin)
SELECT correo, role
FROM profiles
WHERE personal_routes @> '[{"path": "/dashboards"}]'::jsonb
  AND NOT personal_routes @> '[{"path": "/dashboardsociodemografico"}]'::jsonb;

-- 2) Asignarles la ruta explícitamente
UPDATE profiles
SET personal_routes = personal_routes || '[{
      "path": "/dashboardsociodemografico",
      "label": "Dashboard Sociodemográfico",
      "permission": "read_only"
    }]'::jsonb
WHERE personal_routes @> '[{"path": "/dashboards"}]'::jsonb
  AND NOT personal_routes @> '[{"path": "/dashboardsociodemografico"}]'::jsonb;

-- 3) Verificar: ahora tienen que ser 7
SELECT count(*) FROM profiles
WHERE personal_routes @> '[{"path": "/dashboardsociodemografico"}]'::jsonb;
```

El `UPDATE` es idempotente por el `AND NOT`: correrlo dos veces no duplica la
entrada. Y ojo con un detalle operativo: los permisos se leen al iniciar sesión y
quedan en `localStorage`, así que quien esté logueado sigue con los de antes
hasta que cierre sesión y vuelva a entrar.

#### 🔴 Lo que la medición destapó, y es más grave que lo documentado

> **Los 161 usuarios tienen `personal_routes`.** Como `personal_routes` PISA lo
> del rol, **`role_permissions` no gobierna a NADIE.** Seis de los diez roles
> tienen cero rutas configuradas y da exactamente lo mismo.

La doc decía "Johan tiene 48 personales que anulan las 12 de super_admin". No es
Johan: son todos.

#### ⏳ Lo que NO se puede arreglar por código

Vaciar `dashboardRoutes` es una tarea de **datos**, no de programación. Con la
foto de hoy, sacar ese arreglo deja a los **161 usuarios afuera de 7 pantallas**
con CERO permisos explícitos — entre ellas `/traslados` y `/despacho-mega`, que
están en producción todos los días.

Se hace ruta por ruta: primero asignar el permiso a quien la usa, después sacarla
de la lista. `node scripts/auditar-rutas.mjs` (en el repo del front) da la tabla
actualizada de quién quedaría afuera de cada una.

---

### 5.2 · ✅ RESUELTO (2026-08-31) — el puente de paleta se retiró

Las seis hojas del portal usan los tokens `--sfc-*` **directo**. El bloque
puente salió de `styles/pp-shared.css`.

| | |
|---|---|
| Usos migrados | **176** en 6 archivos |
| Fallbacks de la paleta vieja eliminados | **139** |
| Tokens `--sfc-*` en uso | 21 distintos, 299 usos, todos definidos |

**Lo que el puente escondía, y era lo importante.** 139 usos tenían la forma
`var(--pp-primary, #210d65)`. Ese fallback **no era el token**:

| Fallback viejo | Token corporativo |
|---|---|
| `#210d65` | `--sfc-medium: #2d1578` |
| `#64748b` | `--sfc-text-secondary: #86868b` |
| `#d9e2ec` | `--sfc-border: rgba(0,0,0,.06)` |
| `#dc3545` | `--sfc-accent-red: #ff453a` |
| `#1f2933` | `--sfc-text-dark: #1d1d1f` |

O sea: el "segundo sistema de diseño" que se dio por eliminado al adoptar los
tokens **seguía vivo**, agazapado en cada regla, esperando el día que un token no
cargara para repintar el portal con la marca vieja **en silencio**. Migrar sin
sacar los fallbacks habría dejado el trabajo a medias.

Ahora, si un token falta, se nota. Fallar visible es mejor que fallar con la
marca equivocada.

**Regla para el CSS nuevo:** `var(--sfc-*)`, **sin fallback**. Un fallback de
marca es un segundo sistema de diseño esperando su turno.

**Verificado:** capturas antes/después idénticas en la pantalla de ingreso,
botón en `rgb(45,21,120)` = `#2d1578` (el corporativo, no el viejo),
`--pp-primary` ya no resuelve a nada, cero errores de consola, paréntesis
balanceados en los 7 archivos, 336 tests verdes.

---

### 5.3 · ✅ MEJORADO (2026-08-31) — el límite se movió a donde importa

**El diagnóstico anterior era correcto pero incompleto.** Decía que un límite de
verdad necesita Redis o el WAF de Vercel. Cierto para los endpoints que LEEN —
pero se estaba mirando el problema por el lado equivocado.

**Dos cosas se arreglaron sin agregar infraestructura:**

**a) El tope de memoria era un botón de reinicio.** Cuando el `Map` llegaba a
10.000 entradas se hacía `contadores.clear()`: rotar IPs borraba el contador de
TODOS —el del atacante incluido— y el límite volvía a cero. La protección de RAM
era la forma más barata de saltarse el límite.

Ahora se desaloja **por cuenta más baja**, no por antigüedad. Y esa distinción
importa: el primer intento de "desalojar las más viejas" **también fallaba**, y lo
agarró un test — como todas las ventanas duran lo mismo, más viejo es lo mismo que
creado primero, y el que ataca desde hace rato es justamente el primero. Salía él
y entraban sus IPs falsas.

**b) El endpoint que manda correos ya no depende del límite por IP.**
`/publico/recuperar` no filtra datos: **le manda un correo a un tercero**. El daño
no es nuestro, es la bandeja del proveedor y nuestra reputación de envío. Un
límite por IP que se multiplica por instancia no protege eso.

El freno se movió a la **cuenta** y vive en la base, que todas las instancias
comparten: antes de emitir se comprueba si ya salió un enlace para esa cuenta
dentro de `COOLDOWN_MS` (60 s por defecto,
`PROVEEDORES_RECUPERACION_COOLDOWN_MS`). No hizo falta Redis — la marca de tiempo
ya estaba, porque cada pedido inserta su fila en `pp_invitaciones`.

Tres detalles deliberados:
- **Responde igual que el camino feliz.** Decir "espere un minuto" convertiría el
  endpoint en un oráculo que confirma qué NIT+sucursal existe y está activo.
- **Si no se puede comprobar el freno, no se manda.** Un correo de más a un
  tercero no se deshace.
- Hay un test que falla si alguien vuelve a filtrar por IP en vez de por cuenta.

**La lección, para el próximo endpoint parecido:** limitar por IP es limitar un
*proxy* de lo que querés proteger. Cuando se puede identificar el recurso real
—una cuenta, un correo, un documento—, el límite va ahí, y de paso deja de
importar en qué instancia serverless cayó el pedido.

**Lo que sigue abierto:** los endpoints públicos de solo lectura
(`/publico/sucursales`) siguen con el lomo de burro por IP. Para eso alcanza: la
respuesta trae solo sucursal y nombre, y es igual exista o no el NIT.

Archivos: `src/middleware/rateLimit.js` (+5 tests),
`src/services/invitacion.service.js` (+4 tests).

### 5.4 · ✅ RESUELTO (2026-08-31) — se apagó la regla, no se adoptó la API muerta

**La deuda estaba mal planteada.** Decía "si se adopta `prop-types`, se adopta
para todo `src/`". La pregunta correcta era si había que adoptarlos, y la
respuesta es **no**:

- **React 19 IGNORA `propTypes`.** Comprobado a mano contra `react@19.2.3`: un
  validador que rechaza el valor no se ejecuta — React ni lo mira.
- **Cero componentes en todo `src/` los usan.**

O sea que la regla exigía escribir cientos de líneas de una API muerta que el
runtime nunca corre. Si algún día se quiere validación de props, la herramienta
es TypeScript.

**La raíz estaba en la config:** `eslint.config.js` declaraba
`settings: { react: { version: '18.3' } }` sobre un proyecto que corre **19.2**.
El plugin aplicaba las reglas de una versión que no es la que se ejecuta.

#### Lo que esto destapó, que es lo importante

`eslint src/` daba **8.176 problemas**. Con ese número nadie corre el linter, y un
problema real queda invisible. Tres cambios lo bajaron a **1.068** (−87 %):

| Cambio | Menos |
|---|---|
| `settings.react.version` → `19.2` y `react/prop-types: off` | 3.523 |
| `no-irregular-whitespace` con `skipJSXText` (comillas y espacios duros del copy) | 1.744 |
| Sangría con espacios duros en `Inventario/InventariosFinalizados.jsx` | 1.968 |

En ese último se verificó que los 3.688 NBSP estaban **solo en la sangría** —cero
en el contenido— y que el archivo sin espacios queda byte a byte idéntico.

#### 🔴 Los bugs que estaban enterrados

**Uno ya arreglado.** `Dashboards/DSH-Fruver/DashboardFruver.jsx`:
`fetchRegistros` se declaraba DENTRO del `useEffect` y el botón **"Reintentar"**
de la pantalla de error la llamaba desde afuera → `ReferenceError`. El único
botón roto era el que se aprieta justo cuando algo ya falló. Ahora vive en un
`useCallback` fuera del efecto.

**Los que quedan, y NO se tocaron** —son de módulos ajenos al portal y merecen
que los mire quien los conoce:

- **12 × `react-hooks/rules-of-hooks`** (hooks llamados condicionalmente). Rompen
  con *"Rendered fewer hooks than expected"* cuando la condición cambia:
  `Inventario-General/Admin/FiltrosInventarioGeneral.jsx` (2),
  `pages/Dotación/ProximasEntregas.jsx` (5),
  `pages/Programador_horarios/ObservacionesPH.jsx` (1),
  `pages/SiesaPosSync/components/ModalDetalle.jsx` (1),
  `pages/ecommerce/admin/LiveSessionModal.jsx` (2),
  `pages/ecommerce/shared/ManifestInvoiceModal.jsx` (1).
- **6 × `no-undef` de `process`** en código de navegador
  (`Inventario-General/Admin/CargaMaestraExcel.jsx`, `Inventario/maestroController.js`,
  `services/inventarioGeneralService.js`). Vite no define `process`: lo correcto
  es `import.meta.env`.

**La lección:** un linter que grita por todo es un linter apagado. 8.176 errores
no son 8.176 problemas — son un lugar donde esconder los 19 que sí lo eran.

### 5.5 · ✅ RESUELTO (2026-08-31) — la nota se volvió una alarma

Antes esto era una línea que decía *"verificar el orden 4 de descuento si cambian
las condiciones"*, con un SQL para correr a mano. **Una nota no verifica nada.**
Y el día que cambien las condiciones, nadie va a estar leyendo esta sección.

`ORDENES_DESCUENTO` sigue fijo en `[1,2,3]` —verificado el 2026-08-27 contra
SIESA—, pero ahora el sistema **detecta y grita** si aparece otro:

- `ordenesDesconocidos(cruda)` en `normalizarCotizacion.js` mira hasta el orden 9
  y marca los que traen valor. Una columna vacía o en cero **no** cuenta: SIESA
  manda la columna igual aunque no haya descuento, y avisar por eso sería el
  ruido que enseña a ignorar los avisos.
- La marca viaja en cada cotización (`ordenesDesconocidos`) y **sobrevive al
  agrupador** — hay un test que lo fija, porque casi se pierde ahí: el agrupador
  reconstruye el objeto y un campo que no viaja en `...resto` desaparece sin
  error, dejando la alarma muda para siempre.
- El **cron del snapshot** cuenta las afectadas, las reporta con `console.error`
  nombrando ítems de ejemplo, y el número queda en el resultado de la corrida
  (`conOrdenDescuentoNoSoportado`) — así se ve en el histórico y no solo en un
  log de Vercel que rota.

**Marcarlo no es leerlo.** El descuento sigue sin aplicarse, a propósito: meterlo
en el cálculo sin decidir antes si va en cascada sería peor que descartarlo. Lo
que cambia es que ahora se sabe.

**Por qué importa:** un orden que se descarta en silencio infla el costo neto, y
el tope se calcula sobre ese número inflado — deja pasar subidas que debería
marcar. Y ese descuento se pierde al re-emitir, el mismo mecanismo que ya le
costó un ICO de $5.102 al FOUR LOKO.

Si algún día suena: hay que decidir si el orden nuevo va en cascada, sumarlo a
`ORDENES_DESCUENTO` y tocar **también** el gemelo del front
(`utils/costoNeto.js`).

Archivos: `src/services/normalizarCotizacion.js` (+5 tests),
`src/services/snapshot.service.js`.

### 5.6 · ✅ RESUELTO (2026-08-31) — verificación post-escritura

Antes: se daba por escrita una cotización si SIESA respondía `codigo: 0`. Eso es
un acuse de recibo, no una prueba — la solicitud #5 lo demostró.

Ahora, después de importar, `services/verificarCotizacion.js` **relee la consulta
y compara precio e impuestos** contra lo aprobado. Cuatro desenlaces:

| Desenlace | Estado final | Por qué |
|---|---|---|
| `confirmado` | `aplicada` | Se releyó y coincide |
| `no_verificable` | `aplicada` + motivo | No se pudo comprobar (ver abajo) |
| `no_encontrado` | **`incierto`** | SIESA dijo OK y no está |
| `discrepante` | **`incierto`** | Está, pero con otros valores |

**`incierto` es un estado nuevo** (migración `004`). Separa "falló" de "no sé":
`fallida` significa que el ERP rechazó; acá el ERP **aceptó** y no sabemos qué
quedó. Marcarlo `aplicada` era la mentira; marcarlo `fallida` invita a reenviar
un precio que puede estar adentro. Mismo patrón que la migración 033 de
`backend-traslado`.

`reintentar()` ahora acepta `fallida` **y** `incierto` — antes solo `fallida`, y
por eso la #5 quedó trabada sin salida por pantalla.

> ⚠️ **Mientras se lea de producción y se escriba en QA, todo sale
> `no_verificable`.** No es un bug: con los entornos cruzados la relectura es
> ciega, y decirlo es el punto. La verificación empieza a confirmar de verdad al
> cerrar §1.4, sin tocar una línea. Hay un test que impide que alguien
> "arregle" ese caso devolviendo un OK optimista.

Archivos: `src/services/verificarCotizacion.js` (+ 8 tests),
`src/services/solicitud.service.js`, `sql/004_verificacion_siesa.sql`,
y en el front la pestaña **"Sin confirmar"** de la bandeja.

✅ **Migración 004 corrida y verificada** (2026-08-31): la columna
`siesa_verificacion` existe y `'incierto'` está en el CHECK
`pp_solicitudes_estado_valido`.

### 5.7 · ✅ RESUELTO (2026-08-31) — de dónde viene un fallo del empuje

**Ojo: esta deuda estaba MAL PLANTEADA.** Decía que el tope de 7 caracteres de
`ITEM` no se validaba en ningún lado. **Sí se validaba** —
`formatoSiesa.js: campo.item = entero(v, 7, "ITEM")`, con test desde antes
(`assert.throws(() => entero(12345678, 7, "ITEM"), RangeError)`). El error vino
de que `scripts/diagnostico-siesa.js` arma el payload a mano y se saltea esa
capa: SIESA rechazó por tamaño y se concluyó que no había validación, sin ir a
mirar el código.

**El problema real, que sí existía:** ese `RangeError` se lanza ANTES del POST,
caía en el mismo catch que un rechazo del ERP, y el admin leía
*"SIESA rechazó el cambio: ITEM… excede los 7 dígitos"*. SIESA nunca lo vio. El
admin salía a buscar en el ERP un problema propio.

Ahora los errores del empuje llevan `enviadoASiesa`, con **tres** valores —y los
tres importan:

| Valor | Significa | ¿Reintentar es seguro? |
|---|---|---|
| `false` | No salió de acá (formato o configuración) | Sí, nada llegó |
| `true` | El ERP lo rechazó explícitamente | Sí, nada quedó escrito |
| `undefined` | Se cortó la red o venció el timeout | **NO SABEMOS** — puede duplicar |

El tercero es el peligroso y por eso se deja `undefined` a propósito, en vez de
asumir un `false` cómodo.

`marcarFallida()` escribe el mensaje según el origen, y el 502 queda solo para
los rechazos del ERP: un fallo de validación nuestro es un **422**, porque el
admin no tiene nada que revisar allá.

En la bandeja, el aviso *"verifique en SIESA antes de reintentar"* ya **no se
muestra** cuando nada salió. Mostrar siempre el peor caso enseña a ignorar el
aviso, y el día que importe de verdad nadie lo lee.

Archivos: `src/services/siesaCotizacion.js` (+2 tests),
`src/services/solicitud.service.js`, `components/BandejaAprobaciones.jsx`.

---

## 6. IDEAS QUE NO SE HICIERON

### ✅ Hechas el 2026-08-31

Cuatro de las cinco. Ninguna dependía de SIESA ni de la consulta de terceros —
eran las que se podían adelantar mientras se espera.

**a) Revalidar el tope al aprobar** (cerraba también §2.3 en su mitad segura).
El tope se evaluaba UNA vez, al proponer, y quedaba congelado en la fila. Desde
que el tope *avisa* en vez de *frenar*, esa marca es la única defensa automática
que queda — y estaba calculada contra un precio que SIESA pudo haber movido.

Ahora la bandeja revalida las pendientes contra el precio de hoy y muestra las
dos lecturas. Si con el precio de hoy la propuesta **pasa a superar** el tope
(`empeora`), aprobar exige una confirmación aparte. Solo frena ese caso: si ya lo
superaba, el admin está viendo la marca roja y un aviso que sale siempre deja de
significar algo.

`src/services/revalidarTope.js` (+7 tests) · `solicitud.service.js` ·
`admin.controller.js` · bandeja.

**Decisión abierta que queda:** rechazar automáticamente. Hoy avisa y decide un
humano.

**b) Avisar al proveedor por correo** cuando le aprueban o le rechazan.
`src/services/notificacion.service.js` (+5 tests). Dos reglas: un fallo de correo
**nunca** deshace la resolución (cuando corre, el precio ya está en SIESA), y un
estado `incierto` **no se avisa** — no se le dice a un proveedor que su precio
quedó aplicado sin haberlo comprobado.

De paso: las plantillas de invitación y recuperación usaban `#210d65`, la paleta
vieja. El correo es lo primero que ve un proveedor y llegaba con la marca
anterior. Ahora usan los mismos hexes que los tokens (§5.2).

**c) Anular una propuesta pendiente** desde el lado del proveedor.
Migración `005` ✅ corrida y verificada (2026-08-31): `'anulada'` en el CHECK de
estados, y `pp_solicitudes_anulada_sin_empuje` en su lugar. Estado `anulada`. No se reusó `rechazada` a propósito: eso dice
"Merkahorro la revisó y dijo que no", y ensuciaría el historial del proveedor y
las métricas de la bandeja con rechazos que nadie hizo. La firma no se borra.
Solo en `pendiente`, con `cuenta_id` del JWT.

**d) Exportar la bandeja a Excel**, con el filtro puesto.
`utils/exportarBandeja.js` (+10 tests). Las columnas se nombran y ordenan a mano:
`json_to_sheet` sobre la fila cruda saca `clave_item` y `firma_id` con
encabezados en snake_case, y el archivo termina en una reunión, no en una consola.

### Sigue sin hacerse

- **Historial de precios por producto** en el panel del proveedor. El dato está
  en SIESA; la consulta actual lo poda a propósito.
- **Adjuntar un documento** a la propuesta. Necesitaría storage y una decisión
  sobre qué se acepta.
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

Diagnosticar el conector de SIESA sin tocar la base:

```bash
node scripts/diagnostico-siesa.js              # solo diagnóstico, no escribe
node scripts/diagnostico-siesa.js --real       # + reenvía la cotización de la #5
node scripts/diagnostico-siesa.js --tercero    # + prueba si valida el tercero
```

**Interruptores para probar sin consecuencias:**

| Variable | Qué hace |
|---|---|
| `PROVEEDORES_SANDBOX=true` | Arma el payload y lo deja en el log, **sin escribir en SIESA** |
| `PROVEEDORES_MAIL_PRUEBA=true` | Escribe el correo en el log en vez de mandarlo |
