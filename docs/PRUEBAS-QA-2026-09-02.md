# Qué revisar en SIESA QA — pruebas de descuentos y unidades de medida

Escritas el **2026-09-02**, a pedido de QA tras confirmar la solicitud #5.

**Todo está en el mismo lugar:**

> Proveedor **800186960** (ALTIPAL SAS) · sucursal **006** · **fecha de
> activación 15/10/2026**

Esa fecha es futura a propósito: **no busques por "precio vigente"**, porque
todavía no rige. Es lo mismo que pasó con la #5.

---

## Los 6 registros a verificar

| # | Ítem | U.M. | Precio | Descuentos | Impuestos |
|---|---|---|---|---|---|
| 1 | **9659** ATUN ISABEL ACEITE GIRASOL X160G | UND | 6.246,80 | orden 1 = **1 %** | — |
| 2 | **9659** (el mismo, otra presentación) | **P3** | 18.741,00 | **ninguno** | — |
| 3 | **1032** ATUN ALAMAR ENSALADA NATURAL | UND | 4.891,27 | orden 1 = **4 %**, orden 2 = **15 %** | — |
| 4 | **1032** (el mismo, otra presentación) | **P2** | 10.271,68 | ninguno | — |
| 5 | **2092** VINO CARIÑOSO MANZANA X 750 ML | UND | 12.871,73 | ninguno | **ICO 4.313** |
| 6 | **10765** BOCADOS ALAMAR EN ACEITE X 140 GR | UND | 4.887,17 | ninguno | — |

---

## Las 4 preguntas que estas pruebas vienen a contestar

### 1. ¿Se escriben bien los descuentos? (registros 1 y 3)

El **1** tiene un descuento del 1 %. El **3** tiene dos en cascada, 4 % y 15 %.

En el 3, confirmar además **cómo los aplica SIESA**: el portal calcula 4 % y
después 15 % sobre el resultado (encadenados), no 19 % de una. Si SIESA los suma
en vez de encadenarlos, el costo que ve Merkahorro no es el que muestra el
portal.

### 2. ¿Quitar un descuento se representa como ausencia? (registro 2)

El ítem 9659 en P3 **hoy tiene un 3 % de descuento**. Esta prueba lo quita.

Lo correcto es que en la fecha 15/10/2026 **no exista ninguna línea de
descuento** para ese renglón. **No** una línea en 0 %. Si aparece una línea en
0 %, hay que revisar cómo interpreta el conector la ausencia.

### 3. ¿Las presentaciones se pisan entre sí? (registros 3 y 4, y 1 y 2)

El ítem **1032** tiene que quedar con **DOS filas** en el 15/10/2026: una en UND
(4.891,27) y otra en P2 (10.271,68). Lo mismo el **9659**, en UND y P3.

Si aparece una sola, la unidad de medida no está entrando en la llave y un cambio
de precio pisa al de la otra presentación.

### 4. ¿El impuesto sobrevive al cambio de precio? (registro 5)

El VINO CARIÑOSO tiene **ICO de 4.313**. Al subirle el precio, ese ICO **tiene
que aparecer también en la fecha nueva**.

Si el precio nuevo queda sin ICO, el producto perdió su impuesto a partir del
15/10. Ya pasó una vez: le costó un ICO de $5.102 al FOUR LOKO.

---

## ⚠️ Dos aclaraciones para no reportar falsos problemas

**a) El ítem 1032 en UND se escribió DOS VECES.** Primero con 4.989,10 y después
con 4.891,27 más los dos descuentos. La segunda sobrescribió a la primera, que es
el comportamiento esperado —misma llave, misma fecha—. **El valor que vale es
4.891,27**, el de la tabla.

**b) Un rechazo que buscamos a propósito.** Se intentó escribir el ítem 1032 en
UND con su precio actual exacto, `4891.275`, y SIESA lo rechazó:

```
"el precio no cumple con los decimales unitarios de la moneda"
```

**Ese precio salió de SIESA**, no lo inventamos. Es una consulta que devuelve
`4891.275` para un producto cuyo precio no puede volver a escribirse con esos
tres decimales.

No es un problema del portal —ya lo validamos antes de enviar, así que el
proveedor recibe un aviso claro en vez de un error del ERP— pero **vale que lo
sepan del lado de SIESA**: hay **218 acuerdos de precio (36 proveedores)** en esa
situación, todos con precios nacidos de dividir el de una presentación.

---

## Si todo está bien

Con el visto bueno, el portal pasa a escribir en producción: es cambiar una
variable de entorno, sin desplegar código nuevo.
