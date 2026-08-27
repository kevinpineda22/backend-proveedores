# Contrato SIESA — Cotizaciones de Compras

> Este documento describe **exactamente** qué se lee y qué se escribe en SIESA.
> Si un campo no está acá, no se manda. Si un formato no coincide con esta tabla,
> el registro se rechaza o —peor— entra mal.

---

## 1. Entornos

| Operación | URL | Entorno |
|---|---|---|
| Leer cotizaciones | `servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta` | **Producción** |
| Escribir cotizaciones | `serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar` | **QA** |

```
idCompania       7375
descripcion      merkahorro_cotizaciones_dev      (consulta)
idDocumento      253851                            (conector)
nombreDocumento  Cotizaciones_Compras
idSistema        1     ← default de backend-traslado (SIESA_IMPORTAR_ID_SISTEMA)
paginacion       numPag=N|tamPag=100
```

> **Ojo con la asimetría.** Se lee de PRODUCCIÓN y se escribe en QA. Durante las
> pruebas eso significa dos cosas:
> 1. Los precios que ve el proveedor en el portal son **precios reales**. No son
>    datos de juguete.
> 2. **El ciclo no cierra en pruebas**: una solicitud aprobada escribe en QA, pero
>    la consulta sigue leyendo prod, así que el precio nuevo nunca aparece en el
>    portal. Es esperado, no es un bug. No perder medio día persiguiéndolo.
>
> Al pasar a producción se cambia **una sola** variable de entorno
> (`SIESA_CONECTOR_URL`). Nunca hardcodear el host.

Reutilizar de `backend-traslado`:
- `src/config/connekta.js` → `ejecutarConsulta()` (reintentos por deadlock y 429)
- `src/services/siesaRequisicion.service.js` → `postConector()` (POST crudo,
  `validateStatus: () => true`, sin reintento interno)

---

## 1 bis. Cómo viene la consulta de verdad

Fila real de `merkahorro_cotizaciones_dev`:

```jsonc
{
  "IdTercero":   "800186960      ",   // ← relleno CHAR(15)
  "NitTercero":  "800186960",
  "Sucursal":    "006",
  "DescSucursal":"ALTIPAL CATALOGO GENERAL",
  "RazonSocial": "ALTIPAL SAS",
  "CodigoItem":  1032,
  "DescItem":    "ATUN ALAMAR ENSALADA NATURAL X160GR     ",
  "UM":          "UND ",              // ← relleno CHAR(4)
  "Precio":      4672.0000,
  "FechaActivacion": "2023-09-01T00:00:00",
  "IdLlaveImpto": null,
  "ValorImpto":   null,
  "PorcDsctoOrden1": 3.0000,
  "PorcDsctoOrden2": null,
  "PorcDsctoOrden3": null
}
```

Cinco cosas que no se ven a simple vista:

### a) Todo viene con relleno de SQL Server

`"UND "`, `"800186960      "`, `"ATUN ALAMAR … X160GR     "`. Son columnas `CHAR`.

**Se trima todo, siempre, en el borde.** Sin trim, `"UND "` ≠ `"UND"`, la llave
compuesta no cruza contra sí misma, el deduplicado falla y el proveedor ve el
mismo ítem dos veces. Es la misma lección que ya está aprendida en
`backend-traslado/src/services/snapshot.service.js:47`.

### b) La consulta ya viene pivoteada

Los descuentos no llegan como filas: llegan como columnas `PorcDsctoOrden1/2/3`.
Un `null` significa "sin descuento en ese orden", o sea 0% — **no** significa
dato faltante. El conector, en cambio, espera **una fila por orden**. La
conversión pivote → filas es del servicio de empuje.

La consulta expone 3 órdenes; el conector admite hasta 9 (`F214_ORDEN` 1–9). Nos
quedamos en los 3 que la consulta puede leer: no se puede escribir un orden que
después no se puede volver a leer.

### c) ✅ `IdLlaveImpto` es UNA columna y la consulta SÍ duplica el renglón

Resuelto con datos reales (2026-08-27). Un ítem con dos impuestos aparece como
**dos filas idénticas salvo el impuesto**. En la corrida completa: 4.899 filas
crudas → 4.888 cotizaciones, y las 11 que se colapsaron son exactamente las 11 que
tienen dos impuestos.

El normalizador ya lo maneja: agrupa por la llave compuesta y acumula los
impuestos en un array. **Sin ese agrupado, esos 11 ítems saldrían duplicados en el
portal y al re-emitir uno perdería su impuesto.**

> **La llave no es `IBUA`, es `IBU3`.** La documentación decía IBUA; los datos
> dicen `IBU3`. Las llaves observadas son **`ICO`** e **`IBU3`**, y nada más.
> Ningún código hardcodea la llave —se lee del dato—, pero si mañana alguien
> escribe una lista de impuestos conocidos, que la copie de acá y no del correo.
> Vale confirmar con compras si hay más llaves que esta consulta no muestra.

Ojo con un caso que apareció: hay filas con impuesto declarado en **valor 0**
(`{"llave":"IBU3","valor":0}`). El normalizador las conserva, porque un impuesto
declarado en cero **es** información: dice que el ítem está sujeto a ese impuesto
aunque hoy no pague. Perderlo al re-emitir cambiaría la clasificación del producto.

### d) `IdTercero` ≠ `NitTercero`

Vienen con el mismo valor, pero son campos distintos y pueden divergir:

- `IdTercero` (15, con relleno) → es lo que va en `NIT_PROVEEDOR` del conector.
- `NitTercero` (limpio) → es lo que el proveedor teclea en el login y lo que se
  le muestra.

Se guardan los dos. No asumir que son intercambiables porque hoy coinciden.

### d bis) ⚠️ La consulta `_dev` trae UN SOLO proveedor

Primera corrida real (2026-08-27): **4.899 filas, un único NIT** (800186960,
Altipal). O sea que `merkahorro_cotizaciones_dev` está acotada a un proveedor —
el nombre lo dice.

Eso vuelve engañoso el número que muestra bien hoy: **7 segundos y 4.888
cotizaciones son la carga de UN proveedor.** La consulta de producción, con todos,
multiplica eso por la cantidad de terceros. Con 200 proveedores serían del orden
de un millón de filas en una sola respuesta HTTP sin paginación.

**Antes de apuntar a la consulta de producción hay que resolver esto**, y la
decisión es de SIESA, no nuestra: o la consulta acepta paginación, o acepta un
parámetro de NIT para traerla por proveedor. Descargar un millón de filas en una
sola llamada no va a terminar bien — timeout, memoria, o las dos.

También cambia el volumen del snapshot: 4.888 filas entran en un upsert de 5 lotes;
un millón necesita otra estrategia.

### e) ✅ La consulta NUEVA sí acepta paginación

La `_dev` no la aceptaba. `merkahorro_cotizaciones_dev_2` sí, y eso resolvió el
problema de volumen sin necesidad del parámetro por NIT.

Medido 2026-08-27 sobre el catálogo completo:

```
18.960 filas crudas  →  18.866 cotizaciones  ·  0 descartadas  ·  15,7 s
337 proveedores  ·  18.732 ítems+U.M.  ·  134 con precio futuro cargado
```

`consultarCotizaciones()` recorre las páginas solo (`CONNEKTA_TAM_PAGINA`, 1.000
por defecto). Igual **no se llama nunca en un request de usuario**: son 19 viajes
a SIESA. La hace el cron del snapshot.

Y sigue valiendo lo otro: **la respuesta cruda contiene a los 337 proveedores.**
Jamás se manda al frontend sin filtrar por la cuenta autenticada. Un `console.log`
de eso en el navegador es la fuga completa. Ver ARQUITECTURA §5.

### f) ✅ Los descuentos llegan hasta el orden 3, y no hay más

Verificado contra `t214_mm_cotizacion_dscto` (2026-08-27):

```
Orden 1 → 11.321      Orden 2 → 233      Orden 3 → 53
```

**No existe orden 4 ni superior.** Los tres LEFT JOIN de la consulta cubren todo,
y el `.max(3)` del validador es correcto. Riesgo cerrado.

Si algún día aparece un orden 4 en SIESA, se rompen dos cosas a la vez: el costo
neto sale **más alto** de lo real (el tope calcula mal) y ese descuento **se
pierde** al re-emitir. Por eso conviene volver a correr esta verificación si
cambian las condiciones comerciales:

```sql
SELECT f214_orden AS Orden, COUNT(*) AS Cantidad
FROM dbo.t214_mm_cotizacion_dscto GROUP BY f214_orden
```

<details>
<summary>Lo que se temía (histórico)</summary>

### ⚠️ Ya se usa el orden 3 de descuento — ¿existirá un orden 4?

Distribución real de descuentos por renglón:

| Descuentos | Renglones |
|---|---|
| 0 | 15.985 |
| 1 | 2.805 |
| 2 | 53 |
| **3** | **23** |

Con Altipal solo se veían órdenes 1 y 2. En el catálogo completo **hay 23
renglones usando el orden 3**, o sea el techo de lo que la consulta sabe leer.

`F214_ORDEN` admite de 1 a 9. Si algún proveedor tiene un orden 4, la consulta no
lo trae, y eso cae en dos errores a la vez:

1. El costo neto sale **más alto** de lo real → el tope se calcula mal.
2. Al re-emitir, ese descuento **se pierde** — el mismo problema de §3, pero
   causado por nosotros.

**Verificar en SIESA:**

```sql
SELECT f214_orden, COUNT(*) FROM dbo.t214_mm_cotizacion_dscto GROUP BY f214_orden;
```

Si aparece algo mayor a 3, hay que agregar los LEFT JOIN que falten en la consulta
y subir el `.max(3)` del validador. Si no, quedamos como estamos.

</details>

---

## 2. La llave natural — leer esto dos veces

Los tres bloques del body comparten el mismo prefijo de campos. **Eso no es
repetición: es la llave.**

```
(F_CIA, F212_ID_TERCERO, F212_ID_SUCURSAL, F212_ID_MONEDA,
 F212_ID_ITEM, F212_FECHA_ACTIVACION, F212_ID_UM)
```

Traducido: **NIT + sucursal + moneda + ítem + fecha de activación + unidad de medida.**

Dos consecuencias que cambian el diseño:

### 2.1 La unidad de medida es parte de la llave

Un ítem **no tiene un precio**. Tiene un precio **por unidad de medida**. La misma
pasta de dientes vale distinto en `UND` que en `CAJA`.

El proveedor entonces no edita "el precio del ítem 12345": edita "el precio del
ítem 12345 **en UND**". La fila de la tabla del portal es el par ítem+U.M., no el
ítem. Es el mismo problema multi-UM de Traslados.

Si el modelo guardara solo `item_codigo`, dos renglones del mismo ítem en
unidades distintas colisionarían y uno pisaría al otro. **La tabla de solicitudes
lleva `unidad_medida` en su índice único.**

### 2.2 La fecha de activación también es parte de la llave

Esto es una **buena noticia** y elimina un componente entero del sistema.

SIESA soporta precios futuros de forma nativa: un registro con fecha `20260901`
no reemplaza al vigente, convive con él y entra en vigor ese día. Es el ERP el
que activa, no nosotros.

**Por lo tanto: el empuje a SIESA ocurre al APROBAR, no en la fecha de
activación. No hace falta cron.**

Un cron que corre el día D es un punto de falla que se cobra caro: si ese día
Vercel tiene un incidente, o la variable de entorno está mal, o el conector está
caído, el precio no entra y nadie se entera hasta que llega una factura con el
precio viejo. Mandarlo al aprobar convierte ese riesgo en un error visible
**mientras el admin está mirando la pantalla**.

¿Y si el admin se arrepiente después de aprobar? Es reversible: se reenvía la
misma llave con `F_ACTUALIZA_REG=1` y el precio anterior. La llave es estable, por
eso se puede deshacer.

### 2.3 Corolario: un ítem+U.M. puede traer VARIAS filas

Si los precios futuros conviven con el vigente, la consulta puede devolver más de
una fila para el mismo ítem+U.M., una por fecha de activación. Mostrar la primera
que aparezca es una lotería: el portal podría enseñar un precio de 2023 teniendo
uno de 2025 cargado.

**Vigente = la de mayor `FechaActivacion` que no sea futura.** El resto son
*programadas* y se muestran aparte, para que el proveedor sepa que ya hay un
cambio en camino y no proponga encima sin darse cuenta.

Resuelto en `separarVigentes()` de `normalizarCotizacion.js`. Como las fechas
quedan en `AAAA-MM-DD`, el orden alfabético **es** el cronológico: se comparan
como strings, sin construir un solo `Date`.

---

## 3. ⚠️ El riesgo de los impuestos y descuentos huérfanos

**Esto es lo que puede costar plata. Hay que probarlo en QA antes de nada.**

La fecha está en la llave. Los impuestos (bloque 0213) y los descuentos (bloque
0214) se atan a **esa misma llave, fecha incluida**.

Entonces, si un proveedor sube el precio de 25.000 a 26.000 con activación el
1-sep y **solo mandamos el encabezado de cotización**:

```
Cotización vigente (fecha 20260115)     Cotización nueva (fecha 20260901)
  precio     25.000                       precio     26.000
  ICO         1.200                       ICO        ¿?
  IBUA          800                       IBUA       ¿?
  descuento     5%                        descuento  ¿?
```

Los impuestos y descuentos viejos siguen colgados de la fecha vieja. La cotización
del 1-sep podría nacer **sin ICO, sin IBUA y sin descuentos**.

Un ítem que pierde su 5% de descuento es un 5% que Merkahorro deja de ganar en
cada compra, en silencio, hasta que alguien lo note meses después.

### La regla que se deriva

> Al empujar un cambio de precio, se **re-emiten también** los bloques de
> impuestos y descuentos vigentes del ítem+U.M., con la **fecha nueva**.

Por eso la consulta de cotizaciones tiene que traer impuestos y descuentos, y por
eso hay que guardarlos en la solicitud (snapshot), no solo el precio.

### ✅ CONFIRMADO con datos de producción (2026-08-27)

No hizo falta la prueba en QA: el historial del propio SIESA ya la contesta. La
consulta trae **todas** las fechas de cada ítem, así que se puede mirar qué pasó
cada vez que se creó una cotización nueva.

```
FOUR LOKO PONCHE FRUTAS X 473 ML
  2026-01-14  →  ICO $5.102
  2026-03-04  →  sin impuestos
```

Un ICO de $5.102 que desaparece. **Eso no es una decisión comercial**: el impuesto
al consumo sobre una bebida alcohólica no se negocia, lo fija la ley. Es una
cotización nueva a la que nadie le volvió a cargar el impuesto.

Y no es un caso aislado:

| Qué se perdió al cambiar de fecha | Cuántos ítems |
|---|---|
| El impuesto | 8 |
| El descuento | **469 de 1.237 (38%)** |

Los descuentos podrían explicarse por negociación —se acordó quitarlos—, pero el
38% es muchísimo, y el ICO del Four Loko no admite esa explicación.

**La re-emisión de los tres bloques es OBLIGATORIA.** Está implementada en
`armarPayload()` y tiene test. No quitarla.

---

## 4. `F_ACTUALIZA_REG` — no vale lo mismo en los tres bloques

| Bloque | Tipo | `F_ACTUALIZA_REG` |
|---|---|---|
| Encabezado cotizaciones | 0212 v04 | **1** (reemplaza) |
| Impuestos en valor | 0213 v02 | **1** (reemplaza) |
| Descuentos | 0214 v03 | **0** (NO reemplaza) |

Ese `0` en descuentos importa para los reintentos:

- Encabezado e impuestos son **idempotentes por diseño**: reenviar el mismo lote
  pisa el registro con los mismos valores. Inofensivo.
- Descuentos, con `0`, al reenviarse **no reemplaza**. Puede ser un no-op benigno
  o un error del conector. **Hay que probarlo en QA con un reenvío del mismo
  lote**, porque de eso depende si un reintento es seguro.

En cualquier caso, el ancla de idempotencia en la base (`siesa_aplicado_at`) sigue
siendo obligatoria. No se delega la idempotencia al ERP.

---

## 5. Campos fijos vs. variables

La documentación tiene dos columnas al final: **Campo variable** y **Campo fijo**.
El conector ya tiene la plantilla cargada con los fijos; nosotros mandamos en el
JSON **solo los variables**.

Fijos (no van en el body):

| Campo | Valor |
|---|---|
| `F_TIPO_REG` | `0212` / `0213` / `0214` |
| `F_SUBTIPO_REG` | `00` |
| `F_VERSION_REG` | `04` / `02` / `03` |
| `F_CIA` | `001` |
| `F_ACTUALIZA_REG` | `1` / `1` / `0` |
| `F212_ID_MONEDA` | `COP` |
| `F212_TIEMPO_ENTREGA` | `2` |
| `F214_CANTIDAD_HASTA` | `999999999.0000` |
| `F212_TASA_DSCTO_CONDICIONADO` | `000.0000` |

`F_NUMERO_REG` es un consecutivo que se genera **por registro dentro del lote**.

Variables (el body que mandamos):

```jsonc
{
  "Encabezado Cotizaciones": [
    { "NIT_PROVEEDOR": "", "SUCURSAL": "", "ITEM": "",
      "FECHA_ACTIVACION": "", "U.M": "", "PRECIO": "", "NOTAS": "" }
  ],
  "Impuestos en Valor": [
    { "NIT_PROVEEDOR": "", "SUCURSAL": "", "ITEM": "",
      "FECHA_ACTIVACIÓN": "", "U.M": "",
      "LLAVE_IMPUESTO": "", "VALOR_IMPUESTO": "" }
  ],
  "Descuentos": [
    { "NIT_PROVEEDOR": "", "SUCURSAL": "", "ITEM": "",
      "FECHA_ACTIVACIÓN": "", "U.M": "",
      "NRO_ORDEN": "", "%_DESCUENTO": "", "VALOR_DESCUENTO": "" }
  ]
}
```

> **Trampa de tipeo:** el encabezado usa `FECHA_ACTIVACION` **sin tilde**; los
> otros dos bloques usan `FECHA_ACTIVACIÓN` **con tilde** (`Ó`). No es un
> error del ejemplo — está así en la documentación de cada bloque. Las claves van
> en constantes, nunca escritas a mano en cada uso.

---

## 6. Formatos — módulo puro con tests

Un precio mal formateado es plata mal cargada. Estos formateadores viven en
`src/services/formatoSiesa.js`, son funciones puras y **van con tests**.

| Campo | Formato | Largo | Ejemplo |
|---|---|---|---|
| `PRECIO` | 15 enteros + `.` + 4 decimales | 20 | `000000000026000.0000` |
| `VALOR_IMPUESTO` | igual que precio | 20 | `000000000001200.0000` |
| `VALOR_DESCUENTO` | igual que precio | 20 | `000000000000000.0000` |
| `%_DESCUENTO` | 3 enteros + `.` + 4 decimales | 8 | `005.0000` |
| `FECHA_ACTIVACION` | `AAAAMMDD` | 8 | `20260901` |
| `NIT_PROVEEDOR` | alfanumérico | ≤15 | |
| `SUCURSAL` | alfanumérico | ≤3 | |
| `ITEM` | entero | ≤7 | |
| `U.M` | alfanumérico | ≤4 | `UND` |
| `LLAVE_IMPUESTO` | alfanumérico | ≤4 | `ICO`, `IBUA` |
| `NRO_ORDEN` | entero 1–9 | 1 | `1` |
| `NOTAS` | alfanumérico | ≤255 | |

Reglas del formateador:

- Rellena con ceros a la izquierda hasta el largo exacto. Un campo corto se
  rechaza en SIESA.
- **Redondea a 4 decimales explícitamente.** Nada de `toFixed` sobre un float sin
  pensar el redondeo.
- Un valor que **no entra** en el campo (precio de 16 cifras, notas de 300
  caracteres) **lanza error**. Nunca truncar en silencio: un precio truncado es un
  precio distinto.
- `%_DESCUENTO` y `VALOR_DESCUENTO` son mutuamente dependientes: uno es
  obligatorio si el otro es 0. Se valida antes de armar el lote.

### La fecha, con cuidado

`FECHA_ACTIVACION` es `AAAAMMDD` en hora **de Colombia**. Formatearla desde un
`Date` de JS en un servidor Vercel en UTC corre el riesgo de restar un día: el
1-sep a las 00:00 COL es el 1-sep a las 05:00 UTC, pero el 31-ago 20:00 COL ya es
1-sep UTC. Se formatea desde el `DATE` de Postgres como texto, sin pasar por
`Date`.

---

## 5 bis. Cómo se arma cada bloque

Implementado en `services/siesaCotizacion.js` (`armarPayload`).

| Bloque | De dónde salen los datos |
|---|---|
| Encabezado | Identidad de la cotización **vigente** + precio, notas y fecha de la **propuesta** |
| Impuestos | **Re-emitidos tal cual de la vigente**, con la fecha nueva |
| Descuentos | De la **propuesta** — el proveedor sí los edita |

Los tres bloques van siempre presentes, aunque queden vacíos: es la forma
documentada del conector. Si QA rechaza un array vacío, se filtra en `armarPayload`
y en ningún otro lado.

### Por qué los impuestos no los edita el proveedor

ICO e IBUA los fija la ley, no la negociación. Se copian de la vigente. Su único
motivo de existir en el payload es **no perderlos** al crear el registro con fecha
nueva (§3).

### Un descuento quitado se representa por AUSENCIA

Si el proveedor borra el descuento del orden 1, **no se manda una fila con 0%**:
no se manda la fila. Como la fecha es parte de la llave, no emitir un orden
significa que ese orden no existe en la fecha nueva — que es exactamente lo que
se quiso decir.

Además esquiva una ambigüedad del conector: `%_DESCUENTO` es obligatorio "si el
valor es 0" y `VALOR_DESCUENTO` es obligatorio "si el porcentaje es 0". Con los
dos en cero, la documentación no define cuál gana. No mandamos ese caso.

Trabajamos **solo con descuentos porcentuales**: `%_DESCUENTO` lleva el valor y
`VALOR_DESCUENTO` va en cero. El par cumple la regla sin ambigüedad.

### Guardas antes de mandar

| Guarda | Por qué |
|---|---|
| Fecha retroactiva bloqueada (`permitirRetroactiva`) | Una fecha pasada re-precia mercadería **ya recibida**: las órdenes que entraron desde esa fecha quedan valoradas con el precio nuevo. Es legítimo, pero jamás automático |
| La propuesta debe coincidir con el renglón vigente | Escribir el precio del ítem equivocado es el peor bug del módulo **y es silencioso**: SIESA acepta el registro sin chistar |
| Formatos validados al armar | Un precio inválido revienta acá, con un mensaje que dice qué campo, en vez de volver como un rechazo genérico del ERP |

---

## 5 ter. Variables de entorno

```
SIESA_COTIZACION_URL              default: QA (serviciosqa.siesacloud.com/...)
SIESA_ID_COMPANIA                 default: 7375
SIESA_IMPORTAR_ID_SISTEMA         default: 1
SIESA_COTIZACION_ID_DOCUMENTO     default: 253851
SIESA_COTIZACION_NOMBRE_DOCUMENTO default: Cotizaciones_Compras
CONNI_KEY / CONNI_TOKEN           sin default — sin estas, ConfigSiesaError
PROVEEDORES_SANDBOX               "true" corta el POST y solo arma el payload
```

**Pasar a producción es cambiar `SIESA_COTIZACION_URL` y nada más.**

`PROVEEDORES_SANDBOX` corta **justo antes** del POST y **después** de armar el
payload: el armado —que es donde viven los bugs de formato, llave y re-emisión—
se ejercita igual contra datos reales y queda en el log para revisarlo. Mismo
truco que `TRASLADOS_SANDBOX`.

---

## 6 bis. El huso horario, dos veces

Este backend corre en Vercel, en **UTC**. Colombia es UTC−5. Esas cinco horas
rompen dos cosas distintas si no se las trata:

| Dónde | Qué pasaría | Cómo se evita |
|---|---|---|
| Formatear `FECHA_ACTIVACION` | `new Date("2026-09-01")` es el 31-ago 19:00 en Colombia → sale `20260831` y el precio arranca **un día antes de lo firmado** | `fecha()` recorta los primeros 10 caracteres del string. Nunca pasa por `Date` |
| Decidir qué precio rige hoy | Después de las 19:00 COL, `new Date()` ya está en el día siguiente → una cotización de mañana se da por vigente **5 horas antes** | `hoyEnColombia()` usa `Intl` con `timeZone: "America/Bogota"` |

Las dos tienen test propio. No "simplificar" ninguna de las dos a un `Date`.

---

## 7. Consulta de terceros

**Pendiente — Johan la va a pasar.**

Bloquea: maestro de proveedores, y el endpoint público `NIT → sucursales` del
login. **No bloquea** el panel de cotizaciones ni el motor del conector, que se
pueden construir con la consulta de cotizaciones.

---

## 8. Etiqueta en la interfaz

El campo de precio unitario de la consulta se muestra en el portal como
**"Precio antes de impuestos"**. Siempre. Es literal: la consulta trae los
impuestos (ICO, IBUA) por separado, así que el precio unitario efectivamente no
los incluye. El nombre no es cosmética — evita que un proveedor cotice creyendo
que ese número es el precio final.
