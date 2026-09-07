SELECT
    t200.f200_id                    AS IdTercero,
    t200.f200_nit                   AS NitTercero,
    t200.f200_id_cia                AS IdCia,
    t200.f200_razon_social          AS RazonSocial,
    'PROVEEDOR'                     AS TipoTercero,
    t202.f202_id_sucursal           AS Sucursal,
    t202.f202_descripcion_sucursal  AS DescSucursal
FROM dbo.t200_mm_terceros AS t200
INNER JOIN dbo.t202_mm_proveedores AS t202
    ON t202.f202_rowid_tercero = t200.f200_rowid
   AND t202.f202_id_cia        = t200.f200_id_cia
WHERE t200.f200_nit IS NOT NULL
  AND t202.f202_id_sucursal IS NOT NULL
