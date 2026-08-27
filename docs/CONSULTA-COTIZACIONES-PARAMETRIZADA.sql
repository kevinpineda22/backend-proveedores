/* =============================================================================
   Variante por proveedor — SOLO si la consulta completa no aguanta

   NO empezar por acá. Primero cargar `CONSULTA-COTIZACIONES.sql` y medir. Si la
   consulta completa vuelve en un tiempo razonable, esta variante no hace falta y
   agrega una pieza más que puede fallar.

   Esto se usa cuando el catálogo de todos los proveedores es demasiado para una
   sola llamada. En vez de traerlo entero, el backend recorre el maestro de
   terceros y llama una vez por proveedor.

   Además de repartir la carga tiene una ventaja real: un proveedor que falla ya
   no tumba el snapshot de los demás.
   ============================================================================= */

/* Es EXACTAMENTE la misma consulta de CONSULTA-COTIZACIONES.sql, con una línea
   más en el WHERE:

       WHERE cot.f212_fecha_activacion >= COALESCE(cot.f212_fecha_vigente, cot.f212_fecha_activacion)
         AND (@IdTercero IS NULL OR @IdTercero = '' OR t200.f200_id = @IdTercero)
                                                                    ↑
                                                              esto es lo nuevo

   Si Connekta no admite parámetros OPCIONALES, dejarlo obligatorio y listo:

         AND t200.f200_id = @IdTercero

   Es incluso preferible. Un parámetro obligatorio hace imposible pedir el
   catálogo entero por accidente, que es justo el problema que esta variante
   viene a resolver.
   ============================================================================= */


/* ── Cómo lo llama el backend ─────────────────────────────────────────────────

   Ya está implementado en `src/config/connekta.js`:

       consultarCotizaciones({ idTercero: "800186960" })
         → ?descripcion=merkahorro_cotizaciones&parametros=IdTercero=800186960

       consultarCotizaciones()
         → ?descripcion=merkahorro_cotizaciones          (sin parámetro)

   Es el mismo formato `nombre=valor` que backend-traslado ya usa en
   siesaStock.service.js (`parametros=f120_id=<item>`).

   El snapshot todavía llama sin proveedor. Recorrer la lista de terceros necesita
   la CONSULTA DE TERCEROS, que sigue pendiente — es la misma que hace falta para
   el maestro de proveedores y para el login. Dos cosas esperando lo mismo.
   ───────────────────────────────────────────────────────────────────────────── */


/* ── Si el diálogo de Connekta no tiene dónde declarar parámetros ─────────────

   En "Editar consulta" los campos son: Descripcion, Query, Módulo conectividad,
   versión, Observaciones y componente local. Ninguno es para parámetros.

   Puede que estas consultas dinámicas simplemente no los acepten. Antes de dar
   eso por hecho, dos cosas para mirar:

     · "Generador de consultas" (menú izquierdo) — quizá el alta tenga campos que
       la edición no muestra.
     · Probar en Postman agregando `&parametros=IdTercero=800186960` a la consulta
       que ya existe. Si el parámetro se ignora, vuelven las mismas filas de
       siempre; si molesta, devuelve error. Cualquiera de las dos respuestas sirve.

   Si de verdad no se puede, el plan B es registrar la consulta filtrada por NIT
   una vez por cada grupo de proveedores. Es feo y se mantiene mal — solo si no
   queda otra.
   ───────────────────────────────────────────────────────────────────────────── */
