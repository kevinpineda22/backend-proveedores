# Qué tiene que mirar QA — solicitud #5

Pedido el **2026-08-28**. Es el último bloqueante del Portal de Proveedores
(§1.2 de `PENDIENTES.md`), y bloquea §1.4.

**La pregunta, en una línea:** ¿quedó escrito en SIESA **QA** el acuerdo de
precio que el portal importó el 27/08/2026, o el conector respondió "éxito" sin
persistir nada?

---

## El registro a buscar

| Campo | Valor |
|---|---|
| Compañía | **7375** |
| Proveedor (NIT) | **800186960** — ALTIPAL SAS |
| Sucursal | **006** — ALTIPAL CATALOGO GENERAL |
| Ítem | **179313** — VINO SAZON BLANCO X 750 ML |
| Unidad de medida | **UND** |
| Moneda | COP |
| **Fecha de activación** | **20/09/2026** |
| Precio | **13.920,00** |
| Impuesto | **ICO** — valor **4.974,00** |
| Descuentos | ninguno |
| Notas | "Aumento de costo de importacion" |

**Importado el 27/08/2026 a las 17:22:48 (hora Colombia)** mediante el conector
`Cotizaciones_Compras` (idDocumento **253851**, idSistema **1**). Reenviado el
28/08/2026 para tener una escritura con hora conocida — misma respuesta.

Respuesta del conector, las dos veces:

```json
{ "codigo": 0, "mensaje": "Transacción Exitosa", "detalle": "Importacion exitosa" }
```

---

## 🔴 Lo que hace que no aparezca a simple vista

**Hay que buscarlo por FECHA DE ACTIVACIÓN, no por precio vigente.**

La cotización activa el **20/09/2026**, o sea a futuro. En la pantalla del precio
que rige HOY no tiene por qué aparecer: todavía no rige. Buscar "el precio actual
del ítem 179313" va a devolver el anterior (**13.132,33**) y eso NO significa que
la importación haya fallado.

El precio anterior sigue ahí a propósito: SIESA guarda un historial por fecha, no
un precio único que se pisa.

---

## Cómo confirmarlo

### Opción A — por consulta a la base de QA (la que no deja dudas)

```sql
SELECT
    t200.f200_nit                   AS Nit,
    t202.f202_id_sucursal           AS Sucursal,
    v121.v121_id_item               AS Item,
    cot.f212_id_um                  AS UM,
    cot.f212_id_moneda              AS Moneda,
    cot.f212_precio                 AS Precio,
    cot.f212_fecha_activacion       AS FechaActivacion,
    t213.f213_id_llave_imp          AS LlaveImpuesto,
    t213.f213_valor_imp             AS ValorImpuesto
FROM dbo.t212_mm_cotizaciones AS cot
INNER JOIN dbo.t200_mm_terceros AS t200
        ON cot.f212_rowid_tercero = t200.f200_rowid
       AND cot.f212_id_cia        = t200.f200_id_cia
INNER JOIN dbo.v121
        ON cot.f212_rowid_item_ext = v121.v121_rowid_item_ext
       AND cot.f212_id_cia         = v121.v121_id_cia
INNER JOIN dbo.t202_mm_proveedores AS t202
        ON cot.f212_id_sucursal = t202.f202_id_sucursal
       AND t200.f200_rowid      = t202.f202_rowid_tercero
       AND cot.f212_id_cia      = t202.f202_id_cia
LEFT OUTER JOIN dbo.t213_mm_cotizacion_imptos AS t213
        ON cot.f212_rowid  = t213.f213_rowid_cotizacion
       AND cot.f212_id_cia = t213.f213_id_cia
WHERE t200.f200_nit          = '800186960'
  AND t202.f202_id_sucursal  = '006'
  AND v121.v121_id_item      = 179313
  AND cot.f212_id_um         = 'UND'
ORDER BY cot.f212_fecha_activacion DESC
```

**Sin filtrar por fecha a propósito:** así se ve el historial completo del ítem y
queda claro si la fila del 20/09/2026 está o no está, en vez de recibir un
resultado vacío que no distingue "no se escribió" de "filtré mal".

### Opción B — por pantalla

Cotizaciones / acuerdos de precio de compra → filtrar por tercero **800186960**,
sucursal **006**, ítem **179313** — y **quitar cualquier filtro de vigencia o de
"precio actual"**, que es lo que la esconde.

---

## Las tres respuestas posibles

| Si… | Qué significa |
|---|---|
| **Aparece la fila del 20/09/2026 con 13.920 e ICO 4.974** | ✅ El conector escribe bien. El portal queda liberado para pasar a producción. |
| **Aparece pero con otros valores** | El conector transforma algo en el camino. Necesitamos ver qué quedó exactamente. |
| **No aparece** | El conector confirma éxito y no persiste. Eso ya no es una pregunta nuestra: se escala a SIESA con la evidencia de abajo. |

---

## Por qué estamos seguros de que el problema no es del payload

Se probó el conector a propósito con datos malos (`scripts/diagnostico-siesa.js`)
y rechaza todo lo que puede rechazar:

| Prueba | Respuesta del conector |
|---|---|
| `ITEM: "999999999"` (9 caracteres) | 400 · *"El campo ITEM supera el tamaño permitido (7)"* |
| `ITEM: "9999999"` (7 caracteres, inexistente) | 400 · *"el item no existe por código, extensiones, referencia, ni codigo de barras"* + *"la unidad de medida no es valida para el item"* |
| `NIT_PROVEEDOR: "999999999"` con ítem real | 400 · *"el tercero-Sucursal no existe"* |
| **Solicitud #5 — todos los datos reales** | **200 · `codigo: 0` · "Importacion exitosa"** |

Valida el tamaño de cada campo, la existencia del ítem, que la U.M. sea válida
para ese ítem, y que el par tercero-sucursal exista. **No regala aprobaciones.**
La #5 pasó las cuatro validaciones con datos reales.

También quedaron descartados `idCompania 7375`, `idSistema 1` e
`idDocumento 253851`: si estuvieran mal apuntados, el conector no habría podido
resolver nada de lo anterior.

---

## Contexto, para que se entienda por qué importa

Hasta que esto se confirme, el portal **no puede escribir en producción**. Hoy
escribe en QA a propósito, y toda verificación posterior a la escritura sale
`no_verificable`: se lee de producción y se escribe en QA, así que releer para
comparar es ciego. Confirmado esto, se cambia una variable y el circuito queda
cerrado de punta a punta.
