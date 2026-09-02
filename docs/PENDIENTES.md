# Portal de Proveedores — todo lo pendiente

Actualizado el **2026-09-02**.

**Este archivo es la única fuente del ESTADO del proyecto**: qué falta, qué hay en
la base y qué no hay que romper. Si un dato de estado aparece en otro documento y
contradice a este, gana este.

Los otros no se pisan con este ni entre ellos:

| Documento | Es dueño de |
|---|---|
| `ARQUITECTURA.md` | El **porqué**: identidad, modelo de datos, aislamiento, regla del % |
| `COMO-FUNCIONA.md` | El **recorrido**: qué pasa y en qué orden |
| `CONTRATO-SIESA.md` | El **ERP**: qué se lee y qué se escribe |
| `CONSULTA-COTIZACIONES.sql` · `CONSULTA-TERCEROS.sql` | El **SQL** cargado en Connekta, con el porqué de cada decisión |
| `README.md` | La **puerta de entrada**: arrancar, variables, endpoints |

---

## ⏳ LO QUE FALTA — leé solo esto para saber dónde estás

**Todo cerrado menos una variable de entorno.**

- §1.1 consulta de terceros — ✅ cerrada el 2026-09-01
- §1.2 ¿la solicitud #5 quedó escrita? — ✅ **QA CONFIRMÓ que sí** (2026-09-02)
- §1.3 despliegue del frontend — ✅ cerrado el 2026-09-01
- §1.5 pruebas de descuentos y U.M. — ✅ **QA las validó** (2026-09-02)
- §1.6 el múltiplo exacto entre presentaciones — ✅ medido: no nos afecta
- §1.7 avisos de descuento eliminado — ✅ hechos, a pedido de QA
- §1.8 código de barras en el buscador — ✅ hecho (99,6 % de cobertura)
- §4 datos de prueba — ✅ limpiados el 2026-09-02
- §1.4 conector a producción — ⏳ **es lo único que queda: una variable**

⚠️ **Antes de prender §1.4**, decidir qué pasa con las dos cuentas de prueba de
Altipal, que siguen activas. Ver §4.

### 1. La ronda de pruebas que pidió QA · ✅ **MANDADA — falta que QA la mire**

Al confirmar la #5, QA pidió probar además **los descuentos** y **productos con
unidades de medida distintas**. Es el pedido correcto: son justo los dos lugares
donde este proyecto ya se quemó (§7.1 y §7.2).

**Escritas en QA el 2026-09-02.** Ocho casos con datos reales de Altipal 006:
siete entraron y el octavo se rechazó **como se esperaba** — está para documentar
un límite del conector.

📋 **Lo que QA tiene que mirar:** NIT **800186960**, sucursal **006**, fecha de
activación **15/10/2026**, ítems **9659, 1032, 2092, 10765**. Qué esperar en cada
caso, en la tabla de §1.5.

```bash
node scripts/pruebas-siesa-qa.js            # SANDBOX — arma y muestra, no escribe
node scripts/pruebas-siesa-qa.js --real     # manda a QA
```

**La corrida encontró un bug que el flujo feliz nunca habría mostrado:** SIESA
almacena precios con más decimales de los que su propio conector acepta al
escribir, y eso rompía a 36 proveedores. Detalle completo en §1.5.

### 2. Correr el SQL de permisos · **DEPENDE DE VOS** · no bloquea el portal

**El 2026-09-01 esto pasó de "tarea de datos abierta" a "un archivo para
correr".** El código está hecho y medido; falta ejecutar:

```
Pagina-web_React/scripts/permisos-rutas-2026-09-01.sql
```

Repara 21 permisos que no abrían nada y asigna 30 por evidencia de uso real.
Después de correrlo, **cero pantallas quedan huérfanas** y se pueden empezar a
borrar líneas de `RUTAS_ABIERTAS`.

De las "siete rutas con CERO permisos" que bloqueaban esto, tres no existían en
el router y dos eran secciones con sus hijas ya asignadas. La causa de fondo era
otra: **esas siete faltaban en `masterRoutes`, así que el admin nunca las pudo
asignar.** Detalle completo en §5.1.

**Es del sistema de rutas de TODA la app, no del portal.** Está acá porque de
acá salió, pero el portal sale a producción sin esto: `/portal-proveedores/*` no
depende de `RUTAS_ABIERTAS`. Es lo único que podés avanzar hoy sin esperar a
nadie.

---

## Dónde estamos

El circuito completo funciona y **no tiene pendientes de código**: el proveedor
propone y firma, el admin aprueba, y el precio se empuja al ERP.

| | |
|---|---|
| Tests | **241** backend · **373** frontend, todos verdes |
| Catálogo | 18.748 cotizaciones · **3.535 proveedores · 3.676 cuentas** |
| Maestro | ✅ `merkahorro_terceros_dev_cotiz` — el de verdad, no el derivado |
| Cuentas activas | 2 — Altipal 800186960: **006** (CATALOGO GENERAL) y **009** (BABARIA) |
| Admins del portal | 1 |
| Migraciones | `001` → `005`, todas corridas y verificadas contra la base |
| Backend | `backend-proveedores.vercel.app`, escribiendo en **QA** |
| Frontend | desplegado en `https://merkahorro.com/portal-proveedores` |
| Entrada desde el sitio | Header → **Ingresar → Proveedores** |

**Probado a mano de punta a punta**: login de proveedor, correo de creación de
contraseña, selector de sucursal con dos cuentas, y envío de una propuesta de
descuento.

**Cerrado el 2026-09-01 — la consulta de TERCEROS (§1.1).** Llegó, se corrigió
en Connekta y corre en producción. El maestro pasó de **337 proveedores
derivados de cotizaciones a 3.535 leídos del maestro real**: los que todavía no
tienen precios cargados ya aparecen en el portal, que era el agujero que esto
venía a tapar. Corrida verificada: `proveedoresNoTraidos: 0`.

**Cerrado el 2026-09-01:** el sistema de rutas (§5.1) — tres rutas muertas
sacadas del guard, la lista con un solo dueño en `config/autorizacionRutas.js`,
seis entradas del catálogo corregidas, un segundo `startsWith` que había quedado
sin arreglar, y `scripts/evidencia-rutas.mjs` para saber a quién asignarle cada
ruta. Queda correr un SQL.

**Cerrado el 2026-08-31:** verificación post-escritura en SIESA con estado
`incierto` (§5.6), origen del fallo del empuje (§5.7), retiro del puente de
paleta (§5.2), freno por cuenta en recuperación (§5.3), alarma de órdenes de
descuento (§5.5), comparación de rutas por segmento (§5.1), y cuatro de las cinco
ideas de §6 — revalidación del tope al aprobar, aviso por correo al proveedor,
anular una propuesta y exportar la bandeja a Excel.

---

## 1. BLOQUEANTES — sin esto no se sale a producción

De los cuatro, quedan **§1.4** (una variable) y la ronda de pruebas **§1.5** que
lo precede. §1.1, §1.2 y §1.3 están cerrados.

**El portal no tiene ningún pendiente propio de código.**

#### Las variables de entorno, al 2026-09-02

Verificadas contra lo que el código lee de verdad:

| Variable | Estado |
|---|---|
| `SUPABASE_URL` · `SUPABASE_SERVICE_KEY` | ✅ (sin ellas nada tocaría la base) |
| `CONNI_KEY` · `CONNI_TOKEN` | ✅ sirven para las DOS consultas |
| `SIESA_CONSULTA_COTIZACIONES` · `SIESA_CONSULTA_TERCEROS` | ✅ |
| `CORS_ORIGENES` | ✅ merkahorro.com · www · localhost:5173 |
| `PORTAL_PROVEEDORES_URL` | ✅ |
| `CRON_SECRET` | ✅ |
| `SMTP_HOST/PORT/SECURE` + `EMAIL_USER/PASS` | ✅ el mezclado funciona: `email.service.js` acepta los dos prefijos y `EMAIL_REMITENTE` cae a `EMAIL_USER` |
| `SIESA_COTIZACION_URL` | **ausente a propósito** — el default apunta a QA. Es el interruptor de §1.4 |

Todo lo demás que el código lee (`SIESA_ID_COMPANIA`, `CONNEKTA_TAM_PAGINA`,
`PROVEEDORES_SANDBOX`…) tiene default y no hace falta declararlo.

### 1.1 · La consulta de TERCEROS de SIESA · ✅ **CERRADO (2026-09-01)**

Prendida en producción y verificada:

```
SIESA_CONSULTA_TERCEROS=merkahorro_terceros_dev_cotiz
```

```
fuente: merkahorro_terceros_dev_cotiz   ✅ el maestro de verdad
proveedoresNoTraidos: 0                 ✅ no se perdió ninguno
3.535 proveedores · 3.676 cuentas · corrida en 36 s
```

El SQL quedó copiado en `docs/CONSULTA-TERCEROS.sql` — el original vive en
Connekta y no se versiona solo. **Si alguien lo edita allá, hay que actualizar
esa copia.**

Lo que queda debajo es el registro de cómo se llegó acá. Sirve para la próxima
consulta dinámica que se integre, no para saber qué falta.

#### Los cuatro tropiezos, en orden — y qué enseñó cada uno

| # | Síntoma | Causa |
|---|---|---|
| 1 | **500** `Incorrect syntax near ';'` (a los 250 ms) | Un `;` al final. Connekta envuelve la consulta en `SELECT * FROM ( … )` y el `;` parte el envoltorio |
| 2 | Al guardar: *"las consultas sin where devolveran los primeros 100 datos"* | El `TOP(100)` original hacía explícito un techo que el generador impone igual. **Sacarlo sin agregar `WHERE` deja el mismo problema, escondido** |
| 3 | **200 · 0 registros** | `WHERE f200_id_cia = 7375`. El 7375 es el `idCompania` de **Connekta**, no el `id_cia` de las tablas — por eso `CONSULTA-COTIZACIONES.sql` nunca lo fija a un literal |
| 4 | ✅ **200 · 3.910 filas · 40 páginas** | `WHERE nit IS NOT NULL AND sucursal IS NOT NULL` — lo que `derivarMaestro` ya descarta |

Control con las MISMAS credenciales: `merkahorro_cotizaciones_dev_2` respondía
200 con 18.842 registros mientras la de terceros daba 500. Eso descartó de una
el riesgo que este documento venía anotando —que cada consulta dinámica
necesitara su propio par `conniKey`/`conniToken`— y apuntó al SQL.

**El tropiezo 2 es el que hay que recordar**, porque no da error: recorta el
universo antes de paginar, y el maestro habría quedado con el 3 % del catálogo
sin una sola línea rara en los logs. Los otros tres se quejan solos.

Y el 1 dejó una lección de código: el bucle reintentó el error de sintaxis
**tres veces esperando 60,5 s cada una**. Tres minutos por página, dentro de un
cron, por un error que salía a los 250 ms y que no puede cambiar entre intentos
— y encima esos intentos cuentan contra el rate limit de SIESA. Ya está
arreglado: `esReintentable()` distingue un 500 por deadlock (se reintenta) de un
500 por sintaxis, columna inexistente u objeto inexistente (no se reintenta),
con 9 tests en `src/config/connekta.test.js`.

#### Verificado el 2026-09-01

```
3.910 filas · 40 páginas · 3.535 proveedores · 3.676 cuentas
✅ los 337 NIT de NITS-PROVEEDORES-CONTROL.txt están todos
```

⚠️ **El maestro se multiplica por diez** (337 → 3.535). No rompe nada —el upsert
usa `ignoreDuplicates` y no invita a nadie solo— pero buscar un proveedor en el
panel del admin deja de ser lo mismo que con 337.

Entra también `SUPERMERCADOS MERKAHORRO SAS` (901150440): está registrada como
proveedora, así que el join la trae. No es un error; es un tercero al que no se
le va a habilitar acceso.

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

#### Los pasos que quedan

1. ✅ **La consulta anda.** `node scripts/diagnostico-terceros.js --control`
   sale en verde.
2. ⏳ Poner `SIESA_CONSULTA_TERCEROS` en Vercel y redesplegar.
3. ⏳ Correr el snapshot a mano y mirar `proveedoresNoTraidos`: **tiene que ser 0**.
4. Mantener `ignoreDuplicates: true` en los upsert, o cada corrida borra los
   topes que Merkahorro configuró a mano.

El paso 1 existe para no descubrir los problemas por el cron, y se ganó el
lugar: los cuatro tropiezos de arriba salieron todos de ahí, en segundos.

Sobre el `ConniKey`/`ConniToken` propio de cada consulta: **para ésta no hizo
falta.** Las credenciales de hoy la alcanzan. Si algún día aparece un 401
*"verifique si tiene permisos"*, ahí sí es esto.

**Pendiente de SIESA, no bloqueante:** el CORREO del proveedor (hoy se carga a
mano, una por una, ~400 cuentas) y su ESTADO activo/inactivo.

---

### 1.2 · Encontrar en SIESA QA el registro de la solicitud #5 · ✅ **CERRADO**

> **QA confirmó el 2026-09-02: el registro SÍ quedó escrito.** El conector
> persiste de verdad; el `codigo: 0` no era un acuse vacío.
>
> Lo que lo hacía invisible era buscar por precio vigente: la cotización activa
> el 20/09/2026 y el precio de hoy sigue siendo el anterior (13.132,33). Se
> encontró buscando por **fecha de activación**, que es lo que decía este
> documento desde el 2026-08-28.
>
> Al confirmarlo, QA pidió una ronda más de pruebas —descuentos y unidades de
> medida— antes de dar el visto bueno para producción. Ver §1.5.
>
> Lo que sigue debajo es el registro de la investigación. Sirve para el próximo
> conector que haya que diagnosticar, no para saber qué falta.

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

### 1.3 · Cerrar el despliegue del frontend · ✅ **CERRADO (2026-09-01)**

**Verificado el 2026-08-28 contra producción — el frontend YA ESTÁ DESPLEGADO.**
Este documento decía "solo localhost" y era falso.

Lo que se comprobó desde `https://merkahorro.com`:

| | |
|---|---|
| `/portal-proveedores/ingreso` | renderiza el portal |
| Rewrite SPA (`public/.htaccess`) | presente — `/activar?token=` no da 404 |
| CSP | permite el backend en la versión activa y en la endurecida |
| `fetch` real al backend | **200**, devuelve las 2 sucursales |

**a) ✅ HECHO — `PORTAL_PROVEEDORES_URL` confirmada** en el panel de Vercel
(2026-09-01), Production and Preview:

```
PORTAL_PROVEEDORES_URL=https://merkahorro.com/portal-proveedores
```

Era lo único que todavía rompía a un proveedor real: el correo de activación le
habría llegado con un enlace a otra máquina. **§1.3 queda cerrado.**

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

### 1.8 · Código de barras en el buscador del proveedor · ✅ **HECHO (2026-09-02)**

**No estaba.** El buscador filtraba por código SIESA (`1032`) y descripción — y
ninguno de los dos está impreso en el producto. El proveedor tenía que saber cómo
lo llama Merkahorro por dentro para encontrar lo suyo.

**Los datos ya existían**, en `siesa_codigos_barras` (101.868 filas), que llena el
módulo SiesaPosSync en el mismo proyecto de Supabase. Cobertura medida sobre las
18.748 cotizaciones:

| | |
|---|---|
| Código para ese ítem **Y** esa U.M. | **18.682 · 99,6 %** |
| Código solo en otra U.M. | 13 · 0,1 % |
| Sin ninguno | 53 · 0,3 % |

En el catálogo de Altipal 006 la cobertura es del **100 %**, y el catálogo tarda
**642 ms** con la consulta extra.

#### Las tres reglas que no son obvias

**1. Un ítem+U.M. tiene VARIOS códigos y no todos son escaneables.** El ítem 150
en UND convive con `7702044200486` (el EAN de la etiqueta), `M7702044200486`,
`150UND` y `150+`. Se **muestra** solo el que un humano puede leer de una caja
—EAN de 8 a 14 dígitos, prefiriendo el de 13— y se **busca** por todos: si
alguien tiene anotado el interno, que le sirva igual. Sin código escaneable la
celda dice *"Sin código de barras"*, que es más honesto que mostrar `150UND` y
mandar a buscar algo que no existe.

**2. El `+` final no existe para el lector.** SIESA guarda **19.651** códigos con
`+` y ninguna etiqueta física lo lleva. Se normaliza al guardar y al buscar — por
si alguien lo copia de una pantalla del ERP. Misma regla que `siesaMatching.js`
del módulo ecommerce; no se importa de allá porque acá alcanza con normalizar, y
acoplar dos módulos por una línea sale más caro que la línea.

**3. La unidad de medida es parte de la llave.** Verificado con el ítem 1032:
`7700618020638` en UND y `7700618800575` en P2. Son cajas distintas con etiquetas
distintas — buscar solo por ítem devolvería el código de la presentación
equivocada.

#### Por qué NO se guardó en `pp_cotizaciones`

La alternativa era una columna nueva llenada por el snapshot. Se descartó: el
dato ya vive en `siesa_codigos_barras` y duplicarlo crea **dos verdades que se
desincronizan**. Se paga una consulta más por catálogo —que se pide una vez al
abrir la pantalla— y a cambio no hay nada que mantener sincronizado.

⚠️ `siesa_codigos_barras` **no es una tabla `pp_`**: el portal la LEE y no la
escribe ni la mantiene. Si SiesaPosSync la cambia, `codigosBarras.service.js` es
lo único que hay que tocar. Y si falla, el catálogo sigue andando sin la columna:
un proveedor no puede perder la pantalla entera por no poder mostrar una ayuda.

Archivos: `services/codigosBarras.service.js` (+13 tests) · `solicitud.service.js`
→ `catalogoDe` · en el front `utils/buscarCatalogo.js` (+10 tests) y
`ProveedorPanel.jsx`.

---

### 1.7 · Avisos cuando se elimina un descuento · ✅ **HECHO (2026-09-02)**

Pedido por QA junto con lo anterior: *"un aviso al proveedor cuando está quitando
los descuentos, y que el admin tenga la manera más clara de ver que ese proveedor
ha eliminado un descuento, para no tener que adivinar"*.

Es el pedido correcto, y por una razón que ya estaba escrita en la cabecera de
`BandejaAprobaciones.jsx`: **quitar un descuento no mueve la columna de precio.**
El número grande, el que uno mira, se queda igual — y Merkahorro pasa a pagar
más. Es el cambio más caro que se puede hacer sin darse cuenta.

**Del lado del proveedor** (`EditarPrecioModal.jsx`):

- Al vaciar un descuento aparece un aviso que dice cuál se elimina y **cuánto
  pasa a pagar Merkahorro en pesos** — el porcentaje es abstracto, la plata no.
- Una **casilla de confirmación obligatoria**: sin tildarla no se puede avanzar a
  firmar. Y si después cambia los descuentos, la confirmación se invalida: lo que
  había confirmado era la lista anterior.
- El resumen que se FIRMA muestra los descuentos **antes → después**. Antes solo
  listaba los propuestos, y `Ninguno` no se lee como *"eliminó el 3 %"*.
- Un descuento que BAJA avisa pero no pide confirmación: el número está a la
  vista y es una decisión que ya se tomó al teclearlo. Un aviso que sale siempre
  deja de significar algo.

**Del lado del admin** (`BandejaAprobaciones.jsx`):

- En la **fila del listado**, una etiqueta: *"elimina un descuento"*. Antes había
  que abrir cada solicitud para enterarse.
- En el **detalle**, la frase completa: *"Elimina el descuento de orden 1 (3 %).
  Merkahorro pasa a pagar $6.184 en lugar de $6.059, con el precio sin cambios"*
  — esa última cláusula solo aparece cuando el precio efectivamente no se movió,
  que es el caso engañoso.

La comparación vive en `utils/cambiosDescuentos.js`, **fuera del componente**,
con 8 tests. Distingue eliminar de bajar: mismo efecto sobre lo que se paga, pero
uno cambia la estructura del acuerdo y el otro ajusta un grado, y el admin decide
distinto sobre cada uno.

**En ÁMBAR, no en rojo.** En esa pantalla el rojo está reservado para el tope
superado, que es la única señal automática de que algo se pasó de lo autorizado.
Quitar un descuento es legítimo: solo tiene que verse. Un rojo de más enseña a
ignorar los rojos que sí frenan.

Un detalle del util: un descuento propuesto en **0 %** cuenta como eliminado. Para
SIESA no es lo mismo —la fecha es parte de la llave, y lo que borra el orden es
no emitirlo— pero para quien mira la bandeja sí: en los dos casos deja de
descontar.

---

### 1.6 · El múltiplo exacto entre presentaciones · ✅ **NO NOS AFECTA (medido)**

QA reportó el 2026-09-02: con el UND en 4.000 y el P2 en 8.000 —el doble exacto—
SIESA saca error *"el precio es exactamente igual"* al subir el plano; con una
equivalencia que no dé el múltiplo exacto, entra bien.

**Medido antes de tocar nada, y NO hay que validar nada.** Casos I y J de
`scripts/pruebas-siesa-qa.js`, contra QA:

| Caso | Qué se mandó | Resultado |
|---|---|---|
| I | ítem 1032, **UND**, precio 4.000 | ✅ `codigo: 0` |
| J | ítem 1032, **P2**, precio 8.000 (= 2 × 4.000) | ✅ `codigo: 0` |

**El múltiplo exacto entra sin problema cuando los renglones van en envíos
separados**, que es lo único que hace el portal: `armarPayload()` arma UN
encabezado por solicitud. El rechazo que vio QA es de subir los dos juntos en el
mismo plano.

#### 🔒 Por qué NO se agrega una validación

La tentación era validar "el precio de la presentación no puede ser el múltiplo
exacto del unitario". Habría sido un error, y los datos lo dicen:

> De los pares (UND ↔ PN) del catálogo, **321 tienen hoy ratio entero exacto** y
> 324 no. Casi la mitad del catálogo multi-presentación **ya está** en la
> situación que se iba a prohibir — y está guardado en SIESA, funcionando.

Una regla así habría frenado propuestas legítimas por un error que el portal no
puede provocar. **Si SIESA rechazara el múltiplo exacto, esos 321 pares no
podrían existir.** Esa contradicción era la señal de que había que medir antes
de validar.

⚠️ **Lo que sí hay que recordar:** esto vale mientras el portal mande **un
renglón por envío**. Si algún día se agrupan varias solicitudes en un mismo
plano —por volumen, por ejemplo— este límite vuelve a aparecer, y ahí sí hay que
detectarlo antes de enviar.

**De paso, un dato del catálogo que no estaba documentado:** la unidad de medida
CODIFICA el factor. `P2` son 2 unidades, `P4` son 4, `P6` son 6, `P8` son 8.
Verificado sobre los precios: `1032 P2 = 2 × UND`, `2022 P4 = 4 × UND`,
`2048 P8 = 8 × UND`.

---

### 1.5 · La ronda de pruebas de QA — descuentos y unidades de medida

**Pedida el 2026-09-02**, al confirmar la #5. QA quiere ver el conector con
descuentos y con productos de U.M. distintas antes de habilitar producción.

`scripts/pruebas-siesa-qa.js` arma los siete casos con **datos reales del
catálogo** de Altipal 006 y los manda. Todos activan en la misma fecha futura
para que QA los encuentre juntos (`--fecha` la cambia).

⚠️ **Pasa por `importarCotizacion()`, el mismo código que usa el portal.** No
arma el payload a mano como `diagnostico-siesa.js` — esa diferencia ya costó un
diagnóstico equivocado (§5.7): se concluyó que faltaba una validación que sí
existía, porque el script se saltaba la capa que la hacía. Un banco de pruebas
que no pasa por el código real prueba el banco de pruebas.

| Caso | Ítem · U.M. | Qué prueba |
|---|---|---|
| **A** | 9659 · UND | Descuento que **baja** de 3 % a 1 % **sin tocar el precio**. El costo neto sube 2,06 % — es §7.1 en vivo |
| **B** | 9659 · P3 | Descuento que se **quita**: tiene que verse como AUSENCIA de línea, no como una línea en 0 % |
| **C** | 1032 · UND | **Dos órdenes** en cascada (4 % y 15 %). Confirmar que SIESA las aplica encadenadas, como las calcula el portal |
| **D** | 1032 · P2 | U.M. distinta de UND |
| **E** | 1032 · UND | El **mismo ítem** que D en la otra U.M. Juntos prueban que no se pisan: cada U.M. tiene su propia línea de tiempo |
| **F** | 2092 · UND | El **ICO de 4.313 se re-emite** con la fecha nueva. Es §7.2 — el bug que le costó $5.102 al FOUR LOKO |
| **G** | 10765 · UND | Sin impuestos ni descuentos: las **secciones vacías se omiten**, no se mandan como `[]` (§7.3) |

**Verificado en sandbox el 2026-09-02.** Los siete payloads se arman bien: A y C
llevan sección `Descuentos`, B y D no la llevan, F lleva `Impuestos en Valor` con
el ICO re-emitido, y G no lleva ninguna de las dos.

#### ✅ Corrida real contra QA — 2026-09-02

**7 de 8 escribieron. El octavo (H) es un rechazo esperado, y es el hallazgo.**

| Caso | Resultado |
|---|---|
| A, B, C, D, E, F, G | ✅ `codigo: 0 · Importacion exitosa` |
| H | ✅ Rechazado, como se esperaba — documenta el límite de decimales |

📋 **Para QA:** buscar en SIESA QA el NIT **800186960**, sucursal **006**, con
**fecha de activación 15/10/2026**. Ítems **9659, 1032, 2092, 10765**. Qué
esperar en cada uno, en la tabla de arriba.

#### 🐛 El bug que encontró la corrida real: los decimales del precio

El caso C falló en el primer intento, y no por el descuento:

```
HTTP 400 · f_valor "000000000004891.2750"
"Cotizaciones: el precio no cumple con los decimales unitarios de la moneda"
```

**Ese precio no lo inventó la prueba: lo leyó de SIESA.** El caso C mantenía el
precio vigente sin tocarlo. O sea que **SIESA almacena precios que su propio
conector rechaza al escribir.**

Medido sobre el catálogo: **218 cotizaciones (1,2 %) alcanzando a 36
proveedores** tienen 3 o 4 decimales — `4891.275` es la mitad de `9782.55`,
`4583.3333` un tercio. Todas nacidas de dividir el precio de una presentación.

**El escenario real que rompía:** un proveedor de esos 36 propone bajar un
descuento y dejar el precio igual. Proponía, **firmaba**, el admin aprobaba, y
recién ahí el ERP lo rechazaba con un mensaje sobre "decimales unitarios" que no
le dice nada a nadie — en el punto donde ya no se puede corregir.

Arreglado en dos capas, con 9 tests:

| Dónde | Qué hace |
|---|---|
| `middleware/validators.js` | Frena al proponer, con un mensaje que dice a qué redondear |
| `services/formatoSiesa.js` | Segunda red antes del POST, para el precio que no viene del formulario |

Y una sutileza que costó un rato: **`4891.275` redondea a `4891.27`, no a
`4891.28`** — no existe en punto flotante, la máquina guarda `4891.27499…`. El
mensaje de error y el cálculo tienen que usar la misma función
(`redondearAMoneda`), o el proveedor corrige a un centavo distinto del que el
sistema manda.

`VALOR_IMPUESTO` quedó **sin** ese límite a propósito: el rechazo medido fue del
registro 212. Hay dos ICO reales con 4 decimales (ítems 6213 y 17809) que se
re-emiten tal cual — bloquearlos sin evidencia los dejaría fuera del portal por
una regla inventada.

#### 🐛 Lo que encontró en el primer intento

**El modo `PROVEEDORES_SANDBOX` estaba roto para el caso más común.** El log
leía `payload[BLOQUES.impuestos].length` sobre un payload que OMITE las secciones
vacías — veinte líneas más arriba, en el mismo archivo, y a propósito (§7.3). Con
un ítem sin impuestos ni descuentos reventaba con
`Cannot read properties of undefined`.

No es un caso raro: **892 de las 1.237 cotizaciones de Altipal no tienen ninguno
de los dos.** O sea que el interruptor para "probar sin consecuencias" fallaba
justo en lo más frecuente. Y al reventar caía en el catch de `marcarFallida`,
diciéndole al admin que la solicitud falló — en el modo que existe para que nada
falle.

Arreglado con 2 tests (`siesaCotizacion.test.js`), verificados reintroduciendo el
bug a propósito. **El modo sandbox no tenía un solo test; por eso pasó.**

El banco de pruebas también reporta con honestidad: si `PROVEEDORES_SANDBOX` está
prendido, `--real` dice *"no · backend en sandbox"* en vez de "enviado". Decir
"enviado" sin haber escrito manda a QA a buscar en el ERP unos registros que
nunca salieron de acá — el mismo tipo de reporte engañoso que esto viene a evitar.

Cada caso imprime **qué tiene que verse en SIESA después**. Eso no es adorno: sin
decir antes qué se espera, cualquier resultado parece bien.

**El orden importa.** Correr primero sin `--real` y leer los payloads; el sandbox
corta justo antes del POST y después del armado, que es donde viven los bugs de
formato y re-emisión de este módulo.

---

### 1.4 · Pasar el conector a producción

**Hoy `SIESA_COTIZACION_URL` NO existe en Vercel, y está bien.** El código cae a
su default, que apunta a QA:

```js
// services/siesaCotizacion.js
url: () => process.env.SIESA_COTIZACION_URL ||
           "https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar",
```

Que el default sea QA es deliberado y conviene dejarlo así: un entorno nuevo al
que se le olvide la variable escribe en QA, no en producción. El olvido falla
hacia el lado inofensivo.

Para pasar a producción se **agrega** la variable con la URL real del conector
(`servicios.siesacloud.com`, sin el `qa`). **Una variable.**

§1.2 ya está cerrado; ahora el previo es **§1.5**, la ronda de pruebas que pidió
QA. Hacerlo después de eso, no antes.

Y al hacerlo, §5.6 empieza a verificar de verdad: mientras se lea de producción y
se escriba en QA, toda verificación post-escritura sale `no_verificable` — con
los entornos cruzados la relectura es ciega.

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

### ✅ Limpiado el 2026-09-02

Se borraron **las 5 solicitudes de prueba** (#1, #2, #4, #5 y #6) y se devolvió el
tope de Altipal a `NULL`. Verificado después de correrlo: **0 solicitudes** y
`porcentaje_max = NULL`.

⚠️ **El SQL que había acá estaba incompleto.** Decía
`WHERE cuenta_id = 59` y la #6 es de la cuenta **397** (Altipal 009 / BABARIA):
habría quedado viva. La limpieza se hizo por **ID explícito** —enumerar obliga a
mirar la lista antes de borrar— y así quedó la plantilla:

```sql
-- Ver PRIMERO qué se va a borrar. Un DELETE por `cuenta_id` deja afuera las
-- pruebas hechas desde la otra sucursal.
SELECT id, cuenta_id, item, estado, creado_at FROM pp_solicitudes_precio ORDER BY id;

DELETE FROM pp_solicitudes_precio WHERE id IN (1, 2, 4, 5, 6);
UPDATE pp_proveedores SET porcentaje_max = NULL WHERE nit = '800186960';

-- Verificar: 0 y NULL
SELECT count(*) FROM pp_solicitudes_precio;
SELECT porcentaje_max FROM pp_proveedores WHERE nit = '800186960';
```

`pp_firmas` (6) y `pp_auditoria` (47) **siguen ahí**: son append-only por trigger
y está bien que queden. Las firmas de las #4 y #5 son un SVG que dice "FIRMA DE
PRUEBA", a propósito, para que nadie las confunda con la de un proveedor real.

### ⚠️ Lo que NO se limpió, y hay que decidir antes de producción

| Qué | Por qué sigue |
|---|---|
| Cuenta Altipal 800186960/**006** · `pruebas.portal@merkahorrosas.com` | Es la cuenta con la que se prueba todo. Borrarla deja el portal sin forma de probar de punta a punta |
| Cuenta Altipal 800186960/**009** (BABARIA) · `juanmerkahorro@gmail.com` | Ídem — es la que prueba el selector de sucursal |

Las dos están **activas**. Si el portal sale a producción con ellas, son dos
accesos de prueba vivos contra un proveedor real. La decisión —dejarlas,
desactivarlas o reasignarles el correo del proveedor de verdad— es de Merkahorro,
no del código.

Las pruebas del conector (`scripts/pruebas-siesa-qa.js`) **no dejan filas acá**:
van directo a SIESA con un `solicitudId` de texto (`qa-A`), sin pasar por
`pp_solicitudes_precio`. Lo que dejaron está en SIESA QA, con fecha de activación
15/10/2026.

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

> **Los 163 usuarios tienen `personal_routes`.** Como `personal_routes` PISA lo
> del rol, **`role_permissions` no gobierna a NADIE.** Seis de los diez roles
> tienen cero rutas configuradas y da exactamente lo mismo.

La doc decía "Johan tiene 48 personales que anulan las 12 de super_admin". No es
Johan: son todos.

#### ✅ Hecho (2026-09-01): el corte quedó armado

**El diagnóstico anterior estaba bien planteado y era demasiado pesimista.**
Decía "7 pantallas con CERO permisos, 161 usuarios afuera, y no se puede
arreglar por código". Al medir contra el router y contra el catálogo, cinco de
esas siete se cayeron solas.

**Las tres muertas.** `/dashboard`, `/observacionesph` y `/historial-general` no
existen en `RouterApp.jsx`. Ningún componente navega a ellas y ninguna ruta real
cae bajo su segmento. La auditoría las contaba como "163 usuarios afuera" y
detrás no había pantalla. Ya salieron de la lista, sin asignarle nada a nadie.

`/dashboard` llegó a importar: con el `startsWith` viejo cubría `/dashboards`,
`/dashboardgastos`, `/dashboardFruver`, `/dashboardpostulaciones` y
`/dashboardsociodemografico` de una sola vez — una entrada muerta que abría
cinco pantallas. El fix por segmento de arriba ya la había dejado inofensiva.

**Las dos secciones.** `/traslados` y `/despacho-mega` no son pantallas: son
padres de tres rutas cada uno. Sus hijas SÍ estaban asignadas — 10, 13 y 17
personas. El "0" era del padre, que nadie navega. `auditar-rutas.mjs` ahora mide
contra las pantallas reales, así que dejó de gritar por eso.

**La causa de fondo de las dos que sí faltaban.** No estaban en `masterRoutes`.
Y ahí está lo que explica todo: **las siete rutas con cero permisos eran
exactamente las siete que faltaban en el catálogo.** Nadie las tenía asignadas
porque el admin **nunca las pudo asignar** — no aparecían en el selector de
`UserForm`. La única forma de que funcionaran era `dashboardRoutes`. No se
pueden vaciar dos listas a la vez: el catálogo se llena primero.

**Y de paso, 21 permisos que no abrían nada.** `cubre()` compara carácter por
carácter, igual que el router. Seis entradas del catálogo estaban escritas con
otras mayúsculas que la ruta real (`/dashboardGastos` contra `/dashboardgastos`,
`/adminusuarios` contra `/adminUsuarios`, …). Se asignaban, se veían en la
pantalla del admin, quedaban guardadas, y no abrían nada. Hoy no se nota porque
la lista abierta deja pasar igual; al sacarla, sí.

| Qué se hizo | Dónde |
|---|---|
| La lista salió del componente, con nombre propio y una sola copia | `src/config/autorizacionRutas.js` → `RUTAS_ABIERTAS` |
| Los dos scripts la **importan** en vez de copiarla a mano | `auditar-rutas.mjs`, `evidencia-rutas.mjs` |
| Segundo `startsWith` que había quedado sin arreglar | `RutaProtegida.jsx`, el camino que consulta la base |
| Catálogo corregido: 5 mayúsculas + 1 pantalla inexistente | `src/data/masterRoutes.js` |
| Nuevo: quién USA cada ruta, según el rastro real de cada módulo | `scripts/evidencia-rutas.mjs` |
| 9 tests nuevos, incluida la red que atrapa una ruta muerta | `autorizacionRutas.test.js`, `masterRoutes.test.js` |

**El informe de evidencia** cruza `profiles` con las tablas de cada módulo —
quién auditó un despacho, quién contó fruver, quién aprobó un gasto — porque
todos los backends comparten el mismo Supabase. Asigna la ruta **hija**, no la
sección: darle `/traslados` a un recibo de sede le abre también el panel de
admin, que es la sobre-autorización que estamos sacando.

#### ⏳ Lo que falta, y sí es de DATOS

**Correr `Pagina-web_React/scripts/permisos-rutas-2026-09-01.sql`.** Repara los
21 permisos rotos y asigna 30 por evidencia de uso. Después de eso, **cero
pantallas quedan huérfanas** y se puede empezar a borrar líneas de
`RUTAS_ABIERTAS`.

Quedan **16 rutas cuyos módulos no registran quién entra** (`/epp`,
`/gestion-equipo`, `/query-maria`, `/conversor-imagenes`…). No hay dato que
consultar. Todas tienen ya entre 1 y 16 personas con el permiso puesto a mano;
sacarlas de la lista es confiar en esa lista. Es una decisión de Merkahorro, no
del script, y por eso `evidencia-rutas.mjs` no inventa un SQL para ellas: un
permiso puesto por corazonada es peor que la lista que estamos sacando, porque
queda escrito en la base y parece deliberado.

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

#### Lo que esto destapó, y por qué el detalle no vive acá

`eslint src/` daba **8.176 problemas**. Con ese número nadie corre el linter, y un
problema real queda invisible. Cuatro cambios lo bajaron a **781** (−90 %):

| Cambio | Menos |
|---|---|
| `settings.react.version` → `19.2` y `react/prop-types: off` | 3.523 |
| `no-unused-vars` ignora `^React$` (convención del proyecto, ver CLAUDE.md) | 274 |
| `no-irregular-whitespace` con `skipJSXText` (tipografía del copy en español) | 1.744 |
| Sangría con espacios duros en `Inventario/InventariosFinalizados.jsx` | 1.968 |

En el último se verificó que los 3.688 NBSP estaban **solo en la sangría** —cero
en el contenido— y que el archivo sin espacios queda byte a byte idéntico.

Debajo de esa pila había **19 problemas reales**: 12 hooks llamados
condicionalmente —que rompen la pantalla con *"Rendered more hooks than during the
previous render"*— y 7 `no-undef`. Se arreglaron todos el 2026-08-31.

**Ninguno era del portal.** Estaban en Dotación, ecommerce, SiesaPosSync,
Inventario-General, Programador de Horarios y el dashboard de Fruver. El detalle
por archivo va en el repo del frontend, no acá: **este documento es del Portal de
Proveedores**, y llenarlo de hallazgos de otros módulos es exactamente cómo dejó
de servir para saber qué falta.

Lo que sí nos toca: **la config de ESLint es compartida**, así que el portal se
beneficia igual. Lo que queda ya es señal, no ruido:

| Regla | Casos | Qué es |
|---|---|---|
| `no-unused-vars` | 507 | Código muerto real: imports, parámetros y variables calculadas y nunca usadas |
| `react-hooks/exhaustive-deps` | 116 | Warnings. Pueden esconder *stale closures*; arreglarlos a ciegas es peor que dejarlos |
| `react/no-unescaped-entities` | 96 | Comillas sin escapar en JSX. Cosmético |
| `react/display-name` | 18 | Componentes anónimos |

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

## 7. LAS SIETE COSAS QUE NO HAY QUE ROMPER

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
7. **El PRECIO va con 2 decimales como máximo, aunque el campo admita 4.** El
   conector rechaza el resto: *"no cumple con los decimales unitarios de la
   moneda"*. Y ojo con la trampa — **SIESA almacena precios que su propio conector
   no acepta de vuelta**: 218 cotizaciones (1,2 %, 36 proveedores) tienen 3 o 4
   decimales, nacidas de dividir el precio de una presentación. El caso que lo
   destapa es proponer un cambio de descuento SIN tocar el precio. Se valida en
   `validators.js` (borde de entrada) y en `formatoSiesa.js` (antes del POST).
   `VALOR_IMPUESTO` **no** lleva ese límite: no está verificado ahí, y hay dos ICO
   reales con 4 decimales que se re-emiten tal cual.

---

## 8. ARRANCAR

> ⚠️ **La consola de esta máquina es PowerShell 5.1**, y no es bash. Ya frenó dos
> cosas el 2026-09-02:
>
> - **`curl` no es curl**: es un alias de `Invoke-WebRequest` y no acepta
>   `-H "clave: valor"`. Usar `curl.exe`, o mejor un script (ver
>   `correr-snapshot.js`, que además no deja el secreto en el historial).
> - **`&&` no existe** como separador. Encadenar comandos con `;`, o correrlos
>   de a uno.
>
> Y las variables de bash (`$CRON_SECRET`) llegan vacías: ahí se llaman
> `$env:CRON_SECRET`. Por eso los scripts leen del `.env` y no del entorno de la
> terminal.

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
node scripts/correr-snapshot.js            # contra producción
node scripts/correr-snapshot.js --local    # contra localhost:3000
```

Lee `CRON_SECRET` del `.env` y resalta los dos números que deciden si la corrida
salió bien: la `fuente` del maestro y `proveedoresNoTraidos`.

⚠️ **El `curl` que había acá no corre en PowerShell**, que es la consola de esta
máquina: ahí `curl` es un alias de `Invoke-WebRequest` y no acepta
`-H "clave: valor"`. Y `$CRON_SECRET` tampoco existe en esa consola. Si preferís
el comando crudo, es `curl.exe` — pero entonces el secreto queda en el historial
de la terminal.

Diagnosticar el conector de SIESA sin tocar la base:

```bash
node scripts/diagnostico-siesa.js              # solo diagnóstico, no escribe
node scripts/diagnostico-siesa.js --real       # + reenvía la cotización de la #5
node scripts/diagnostico-siesa.js --tercero    # + prueba si valida el tercero
```

Diagnosticar la consulta de TERCEROS (una página, sin reintentos):

```bash
node scripts/diagnostico-terceros.js            # ¿responde? ¿trae los 5 alias?
node scripts/diagnostico-terceros.js --todo     # + recorre todas las páginas
node scripts/diagnostico-terceros.js --control  # + contrasta los 337 NIT de control
```

**Interruptores para probar sin consecuencias:**

| Variable | Qué hace |
|---|---|
| `PROVEEDORES_SANDBOX=true` | Arma el payload y lo deja en el log, **sin escribir en SIESA** |
| `PROVEEDORES_MAIL_PRUEBA=true` | Escribe el correo en el log en vez de mandarlo |
