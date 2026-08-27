/* =============================================================================
   merkahorro_cotizaciones — PEGAR ESTO en el campo "Query" de Connekta

   Cómo se carga (consola: integrador.siesacloud.com):

     1. Menú izquierdo → "Generador de consultas"
     2. Crear una consulta NUEVA. No editar `merkahorro_cotizaciones_dev`:
        hoy es lo único que funciona, y si algo sale mal hay que poder volver.
     3. Descripcion:  merkahorro_cotizaciones
     4. Query:        todo lo que está debajo de esta cabecera
     5. Módulo conectividad y versión 3.0 → igual que la `_dev`
     6. Guardar y dejar el "Estado" encendido
     7. Probar en Postman:
        .../ejecutarconsulta?idCompania=7375&descripcion=merkahorro_cotizaciones
     8. En el .env del backend:
        SIESA_CONSULTA_COTIZACIONES=merkahorro_cotizaciones

   QUÉ CAMBIA respecto de la `_dev`:

     a) Sale el `WHERE f200_id = '800186960'`. La `_dev` estaba clavada en un solo
        proveedor: con ella, ningún otro existiría en el portal.

     b) Se corta el histórico. Solo vuelven la cotización VIGENTE y las FUTURAS.
        Medido contra la data real de Altipal (2026-08-27):

             4.888 filas  →  1.237 filas   (−75%)

        Ese 75% son precios de 2023, 2024 y 2025 que ya no rigen. El portal
        muestra lo que rige y lo que viene; el histórico de precios vive en
        SIESA, que es donde corresponde.

   ⚠️ AL PEGAR EN LA CONSOLA, QUITAR TRES COSAS

   Todo esto sale del mismo hecho: el generador envuelve lo que pegás en un
   `SELECT * FROM ( ... )`, y adentro de un envoltorio así no todo es válido.

     1. EL `ORDER BY` FINAL — es el que revienta seguro.
        SQL Server prohíbe `ORDER BY` en una subconsulta sin `TOP` u `OFFSET`:
        "The ORDER BY clause is invalid in views, inline functions, derived
        tables, subqueries, and common table expressions."
        No se pierde nada: el backend agrupa y ordena por su cuenta.

     2. EL `;` FINAL — un punto y coma en medio del envoltorio también rompe.

     3. LOS COMENTARIOS `/* */` — no rompen por sí solos, pero llevan tildes y
        guiones largos y no vale la pena pelear con el encoding de un textarea.
        La documentación vive acá, que es donde sirve.

   Por la misma razón esto usa una SUBCONSULTA en el FROM y no un `WITH`: un
   `WITH` adelante revienta dentro del envoltorio; una subconsulta lo aguanta.
   Más feo de leer y mucho menos frágil — en una caja que no controlás, esa es la
   elección correcta.
   ============================================================================= */

SELECT
    t200.f200_id                        AS IdTercero,
    t200.f200_nit                       AS NitTercero,
    t202.f202_id_sucursal               AS Sucursal,
    t202.f202_descripcion_sucursal      AS DescSucursal,
    t200.f200_razon_social              AS RazonSocial,
    v121.v121_id_item                   AS CodigoItem,
    v121.v121_descripcion               AS DescItem,
    cot.f212_id_um                      AS UM,
    cot.f212_id_moneda                  AS Moneda,
    cot.f212_precio                     AS Precio,
    cot.f212_fecha_activacion           AS FechaActivacion,
    t213.f213_id_llave_imp              AS IdLlaveImpto,
    t213.f213_valor_imp                 AS ValorImpto,
    Dscto1.f214_porcentaje_dscto        AS PorcDsctoOrden1,
    Dscto2.f214_porcentaje_dscto        AS PorcDsctoOrden2,
    Dscto3.f214_porcentaje_dscto        AS PorcDsctoOrden3

FROM (
        SELECT
            c.f212_rowid,
            c.f212_id_cia,
            c.f212_rowid_tercero,
            c.f212_id_sucursal,
            c.f212_id_moneda,
            c.f212_rowid_item_ext,
            c.f212_id_um,
            c.f212_precio,
            c.f212_fecha_activacion,

            /* La fecha que rige HOY para este renglón: la mayor que no sea
               futura. La ventana parte por la llave natural de una cotización en
               SIESA —compañía + tercero + sucursal + moneda + ítem + unidad— que
               es todo menos la fecha.

               Un ítem NO tiene un precio: tiene un precio POR UNIDAD DE MEDIDA, y
               cada unidad lleva su propia línea de tiempo. Sacar la U.M. de esta
               partición mezclaría el historial de la unidad con el de la caja. */
            MAX(CASE WHEN c.f212_fecha_activacion <= CAST(GETDATE() AS date)
                     THEN c.f212_fecha_activacion
                END)
            OVER (PARTITION BY c.f212_id_cia,
                               c.f212_rowid_tercero,
                               c.f212_id_sucursal,
                               c.f212_id_moneda,
                               c.f212_rowid_item_ext,
                               c.f212_id_um)      AS f212_fecha_vigente
        FROM dbo.t212_mm_cotizaciones AS c
     ) AS cot

INNER JOIN dbo.t200_mm_terceros AS t200
        ON cot.f212_rowid_tercero = t200.f200_rowid
       AND cot.f212_id_cia        = t200.f200_id_cia

INNER JOIN dbo.v121
        ON cot.f212_rowid_item_ext = v121.v121_rowid_item_ext
       AND t200.f200_id_cia        = v121.v121_id_cia

INNER JOIN dbo.t202_mm_proveedores AS t202
        ON cot.f212_id_sucursal = t202.f202_id_sucursal
       AND t200.f200_rowid      = t202.f202_rowid_tercero
       AND v121.v121_id_cia     = t202.f202_id_cia

/* Un ítem con ICO e IBU3 sale como DOS filas idénticas salvo el impuesto. Es
   inherente a este LEFT JOIN y está bien: el backend agrupa por la llave natural
   y acumula los impuestos en un array (normalizarCotizacion.js). NO pivotearlos
   acá — el pivote fijaría cuántos impuestos puede tener un ítem, y el día que
   aparezca una tercera llave habría que tocar la consulta otra vez. */
LEFT OUTER JOIN dbo.t213_mm_cotizacion_imptos AS t213
        ON cot.f212_rowid  = t213.f213_rowid_cotizacion
       AND cot.f212_id_cia = t213.f213_id_cia

LEFT OUTER JOIN dbo.t214_mm_cotizacion_dscto AS Dscto1
        ON cot.f212_id_cia = Dscto1.f214_id_cia
       AND cot.f212_rowid  = Dscto1.f214_rowid_cotizacion
       AND Dscto1.f214_orden = 1

LEFT OUTER JOIN dbo.t214_mm_cotizacion_dscto AS Dscto2
        ON cot.f212_id_cia = Dscto2.f214_id_cia
       AND cot.f212_rowid  = Dscto2.f214_rowid_cotizacion
       AND Dscto2.f214_orden = 2

LEFT OUTER JOIN dbo.t214_mm_cotizacion_dscto AS Dscto3
        ON cot.f212_id_cia = Dscto3.f214_id_cia
       AND cot.f212_rowid  = Dscto3.f214_rowid_cotizacion
       AND Dscto3.f214_orden = 3

/* Conserva la vigente y todo lo posterior (las programadas a futuro).

   El COALESCE cubre el ítem cuyas fechas son TODAS futuras: ahí no hay vigente,
   `f212_fecha_vigente` queda en NULL, y la condición se vuelve verdadera para
   todas sus filas. Sin ese COALESCE, un producto con precio cargado solo a futuro
   desaparecería del portal. */
WHERE cot.f212_fecha_activacion >= COALESCE(cot.f212_fecha_vigente, cot.f212_fecha_activacion)

/* Acá termina lo que se pega. SIN `ORDER BY` y SIN `;` — ver la advertencia de
   arriba. El orden lo pone el backend, que igual reagrupa las filas por su llave
   natural antes de mostrarlas. */


/* =============================================================================
   NOTAS
   =============================================================================

   1. SI ALGO FALLA AL GUARDAR

      · "Invalid column name 'f212_id_moneda'"
        Sacá esa columna de los DOS lugares donde aparece: el SELECT (`AS Moneda`)
        y el PARTITION BY. El backend asume COP cuando no viene, así que sigue
        funcionando igual. El único efecto de quitarla del PARTITION sería mezclar
        dos monedas del mismo ítem en una sola línea de tiempo — hoy no pasa,
        porque todo está en pesos.

      · Error de sintaxis cerca de `OVER`
        Sería una versión de SQL Server muy vieja (anterior a 2012) sin funciones
        de ventana. Avisame y lo reescribo con un JOIN contra un GROUP BY.

   2. CÓMO VERIFICAR QUE QUEDÓ BIEN

      Disparás el snapshot y comparás contra la corrida del 2026-08-27:

        | Métrica              | Con la `_dev` | Esperado con esta |
        |----------------------|---------------|-------------------|
        | Filas crudas         | 4.899         | ~1.240 por proveedor |
        | Proveedores (NIT)    | 1             | todos los que tengas |
        | Fechas por ítem+U.M. | hasta 7       | 1, salvo futuras     |

      Si las filas por proveedor NO bajan a la cuarta parte, la ventana no está
      filtrando y hay que mirarla. Si aparece más de un NIT, el punto (a) ya está.

   3. EL PARÁMETRO POR PROVEEDOR — pendiente, y puede no hacer falta

      La idea era pasar `parametros=IdTercero=<nit>` para traer el catálogo de a
      un proveedor. En el diálogo "Editar consulta" no hay campo para declarar
      parámetros, así que puede que estas consultas dinámicas no los soporten.

      Primero medimos SIN parámetro. Si la consulta completa vuelve en un tiempo
      razonable, no hace falta y listo. Si se cae por timeout, ahí vemos:
      `docs/CONSULTA-COTIZACIONES-PARAMETRIZADA.sql` tiene la variante lista.

      El backend ya manda el parámetro cuando se le pasa un proveedor, y no lo
      manda cuando no. Las dos formas le sirven sin tocar código.

   4. QUÉ NO SE TOCÓ, A PROPÓSITO

      · Los tres LEFT JOIN de descuentos siguen fijos en órdenes 1, 2 y 3. En la
        data real solo se usan el 1 y el 2, pero el conector admite hasta 9 y
        dejar el 3 no cuesta nada. Un cuarto orden obligaría a tocar consulta,
        normalizador y validador a la vez.

      · Los impuestos siguen sin pivotear. Ver el comentario del JOIN de t213.

      · `GETDATE()` devuelve la hora del servidor SQL, que puede no estar en hora
        Colombia. NO importa: el backend vuelve a decidir cuál es la vigente con
        `separarVigentes()`, usando la fecha de Bogotá calculada con `Intl`. Este
        filtro es una PODA DE VOLUMEN, no la fuente de verdad. Un día de más solo
        trae una fila extra que el backend descarta. Por eso tampoco conviene
        endurecerlo con `AT TIME ZONE`: agrega dependencia de versión de SQL
        Server para arreglar algo que no está roto.
   ============================================================================= */
