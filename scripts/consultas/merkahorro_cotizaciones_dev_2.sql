SELECT
    t200.f200_id                        AS IdTercero,
    t200.f200_nit                       AS NitTercero,
    cot.f212_id_cia                     AS IdCia,
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
    Dscto3.f214_porcentaje_dscto        AS PorcDsctoOrden3,
    Dscto4.f214_porcentaje_dscto        AS PorcDsctoOrden4

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

LEFT OUTER JOIN dbo.t214_mm_cotizacion_dscto AS Dscto4
        ON cot.f212_id_cia = Dscto4.f214_id_cia
       AND cot.f212_rowid  = Dscto4.f214_rowid_cotizacion
       AND Dscto4.f214_orden = 4

WHERE cot.f212_fecha_activacion >= COALESCE(cot.f212_fecha_vigente, cot.f212_fecha_activacion)
