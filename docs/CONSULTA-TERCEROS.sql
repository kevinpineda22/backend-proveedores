/* =============================================================================
   merkahorro_terceros_dev_cotiz — el MAESTRO de proveedores

   Esta es la copia de lo que está cargado en Connekta. El original vive allá y
   no se versiona solo: si alguien lo edita, esta copia queda vieja. Cuando toques
   la consulta, tocá este archivo.

   QUÉ RESUELVE
   Sin ella, el maestro se derivaba de las cotizaciones y **solo veía proveedores
   CON precios cargados** — 337. Con ella son **3.535**. Un proveedor dado de alta
   en SIESA al que todavía no se le cargó ningún precio ahora aparece en el portal
   y se le puede habilitar el acceso.

   Verificada el 2026-09-01: 3.910 filas · 40 páginas · 3.535 proveedores ·
   3.676 cuentas, y trae los 337 NIT de `NITS-PROVEEDORES-CONTROL.txt`.

   Cómo se carga (consola: integrador.siesacloud.com):

     1. Menú izquierdo → "Generador de consultas"
     2. Descripcion:  merkahorro_terceros_dev_cotiz
     3. Query:        todo lo que está debajo de esta cabecera
     4. Módulo conectividad y versión 3.0
     5. Guardar y dejar el "Estado" encendido
     6. Probar:  node scripts/diagnostico-terceros.js --control
     7. En Vercel:  SIESA_CONSULTA_TERCEROS=merkahorro_terceros_dev_cotiz

   ── LAS CUATRO COSAS QUE LA ROMPIERON, Y POR QUÉ ────────────────────────────

   El generador envuelve lo que pegás en un `SELECT * FROM ( ... )` y pagina por
   afuera. Adentro de ese envoltorio no todo es válido, y no todo hace lo que
   parece:

     1. EL `;` FINAL — rompe la sentencia envolvente.
        `HTTP 500 · Incorrect syntax near ';'`. Fue el primer fallo (2026-09-01).

     2. EL `ORDER BY` — SQL Server lo prohíbe en una subconsulta sin `TOP` u
        `OFFSET`. No se pierde nada: el backend ordena por su cuenta.

     3. EL `TOP(100)` — este es el traicionero, porque NO da error. Recorta el
        universo a 100 filas ANTES de que Connekta pagine: una sola página, y un
        maestro con el 3 % del catálogo. Sin error, sin aviso, sin nada raro en
        los logs. Y sin `ORDER BY`, `TOP` en SQL Server es no determinista: serían
        100 filas distintas en cada corrida.

     4. LA FALTA DE `WHERE` — el generador avisa al guardar: *"Las consultas que
        no tienen una clausula where, devolveran por defecto los primeros 100
        datos."* De ahí venía el `TOP(100)`: hacía explícito un techo que
        Connekta iba a imponer igual. Sacar el `TOP` sin agregar `WHERE` deja el
        mismo problema, solo que escondido.

   ── POR QUÉ EL `WHERE` ES ESTE Y NO OTRO ────────────────────────────────────

   `derivarMaestro()` descarta las filas sin NIT o sin sucursal. El `WHERE` hace
   explícito lo que el backend ya hace: no pierde una sola fila útil y satisface
   el requisito del generador.

   Se intentó antes `WHERE t200.f200_id_cia = 7375` y devolvió CERO filas. El
   7375 es el `idCompania` de **Connekta** —la conexión— no el `id_cia` de las
   tablas. Por eso `CONSULTA-COTIZACIONES.sql` tampoco lo fija nunca a un
   literal: solo encadena `id_cia` entre joins, que es lo que hace este también.

   ── POR QUÉ EL FILTRO ES UN JOIN Y NO UN WHERE SOBRE EL NIT ─────────────────

   `t200_mm_terceros` trae TODO: clientes, empleados, bancos y la propia
   compañía. El filtro correcto es **estar registrado como proveedor**, y eso es
   el `INNER JOIN` contra `t202_mm_proveedores`.

   El filtro que parece razonable a primera vista —"sacar las personas, que son
   empleados"— se lleva **57 de los 337** proveedores con acuerdos vigentes, que
   son personas naturales con NIT de cédula. Ejemplos reales que esta consulta SÍ
   trae, verificados el 2026-09-01:

       1041233833  HOYOS GIRALDO WILMER ADRIAN
       1020414979  SOLARTE PINEDA ANNY JULIETH

   Nadie se entera de esa pérdida hasta que uno llama preguntando por qué no
   puede entrar. **El criterio es el TIPO de tercero, nunca la forma del NIT.**

   ── LO QUE ENTRA Y QUIZÁ NO QUERÉS ──────────────────────────────────────────

   `SUPERMERCADOS MERKAHORRO SAS` (901150440) está en `t202_mm_proveedores`, así
   que el join lo trae. No es un error y no rompe nada —el maestro no invita a
   nadie solo— pero es un tercero al que no le vas a habilitar acceso al portal.

   Pendiente de SIESA, no bloqueante: el CORREO del proveedor y su ESTADO
   activo/inactivo. Hoy el correo se carga a mano, uno por uno.
   ============================================================================= */

SELECT
    t200.f200_id                    AS IdTercero,
    t200.f200_nit                   AS NitTercero,
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
