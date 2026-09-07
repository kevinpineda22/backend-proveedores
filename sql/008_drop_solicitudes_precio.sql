-- ---------------------------------------------------------------------------
-- 008 — Borrar `pp_solicitudes_precio`, la tabla previa a la 006
-- ---------------------------------------------------------------------------
--
-- La 006 la copió a `pp_solicitudes` + `pp_solicitud_lineas` y la dejó en pie a
-- propósito, para poder verificar el backfill contra producción antes de borrar
-- nada. Ya se verificó (2026-09-07): 1 línea migrada, cero diferencias de estado
-- o de marca de empuje, y la tabla vieja hoy está en **0 filas** — su única
-- solicitud se borró con la limpieza de datos de prueba. El backend hace rato que
-- no la escribe.
--
-- ⚠️ CORRER LA VERIFICACIÓN DE ABAJO ANTES DEL DROP. No es una formalidad: si el
-- backfill quedara corto, esto borra solicitudes firmadas que nadie puede
-- reconstruir — `pp_firmas` guarda el hash de lo firmado, no el contenido.
--
-- El bloque hace el DROP **solo si las cuentas cierran**. Si no cierran, no borra
-- y lanza con el detalle. Un script destructivo que se ejecuta a ciegas es la
-- forma más cara de confiar en una nota que alguien escribió otro día.
-- ---------------------------------------------------------------------------

-- ═══ Verificación a mano, para mirar con los ojos antes de correr el DO ═══════
--
--   SELECT count(*) FROM pp_solicitudes_precio;
--   SELECT count(*) FROM pp_solicitud_lineas WHERE migrada_de_id IS NOT NULL;
--
--   -- tiene que dar CERO filas:
--   SELECT p.id, p.estado AS viejo, l.estado AS nuevo
--     FROM pp_solicitudes_precio p
--     LEFT JOIN pp_solicitud_lineas l ON l.migrada_de_id = p.id
--    WHERE l.id IS NULL
--       OR p.estado <> l.estado
--       OR p.siesa_aplicado_at IS DISTINCT FROM l.siesa_aplicado_at;

DO $borrar$
DECLARE
  viejas    INTEGER;
  migradas  INTEGER;
  desviadas INTEGER;
BEGIN
  /* Idempotente: si la tabla ya no está, esta migración ya corrió y no hay nada
     que hacer. Sin esto, la segunda corrida revienta con
     `42P01 relation "pp_solicitudes_precio" does not exist` — porque el cuerpo se
     compila recién al ejecutarse— y el error se lee como una falla cuando en
     realidad es el final feliz. Una migración que no se puede correr dos veces es
     una migración que nadie se anima a correr una. */
  IF to_regclass('public.pp_solicitudes_precio') IS NULL THEN
    RAISE NOTICE 'pp_solicitudes_precio ya no existe: la 008 ya se corrió. Nada que hacer.';
    RETURN;
  END IF;

  SELECT count(*) INTO viejas FROM pp_solicitudes_precio;
  SELECT count(*) INTO migradas FROM pp_solicitud_lineas WHERE migrada_de_id IS NOT NULL;

  /* Que los números coincidan no alcanza: podrían coincidir con las filas
     equivocadas. Se compara fila por fila el ESTADO y la MARCA DE EMPUJE, que son
     los dos datos que no se pueden perder — un estado mal migrado devuelve a la
     cola una solicitud ya empujada, y eso duplica un precio en el ERP. */
  SELECT count(*) INTO desviadas
    FROM pp_solicitudes_precio p
    LEFT JOIN pp_solicitud_lineas l ON l.migrada_de_id = p.id
   WHERE l.id IS NULL
      OR p.estado <> l.estado
      OR p.siesa_aplicado_at IS DISTINCT FROM l.siesa_aplicado_at;

  /* ⚠️ NO comparar `viejas = migradas`. Son dos cosas distintas: `viejas` es lo
     que QUEDA en la tabla vieja hoy, `migradas` es lo que ALGUNA VEZ se copió.
     En cuanto alguien borra una fila de la tabla vieja —la limpieza de datos de
     prueba, por ejemplo— los números se separan para siempre y el guard bloquea
     un DROP que es perfectamente seguro. Medido el 2026-09-07: 0 viejas contra 1
     migrada, y con la igualdad esto lanzaba excepción sin que faltara nada.

     La propiedad que de verdad protege es `desviadas = 0`: toda fila que TODAVÍA
     está en la vieja tiene su línea nueva, con el mismo estado y la misma marca
     de empuje. Si la vieja está vacía, no hay nada que perder. */
  IF desviadas > 0 THEN
    RAISE EXCEPTION
      'NO se borró nada. Backfill incompleto: % solicitudes viejas, % líneas migradas, % SIN línea nueva o con estado/marca distintos. Revisar la migración 006.',
      viejas, migradas, desviadas;
  END IF;

  RAISE NOTICE 'Backfill verificado: % solicitudes copiadas sin diferencias. Borrando la tabla vieja.', viejas;

  /* CASCADE por las políticas de RLS y el trigger de updated_at que cuelgan de
     ella. No hay foreign keys apuntando acá: `pp_solicitud_lineas.migrada_de_id`
     es un BIGINT suelto a propósito, justamente para que este DROP no arrastre
     nada. */
  DROP TABLE pp_solicitudes_precio CASCADE;
END $borrar$;

-- ---------------------------------------------------------------------------
-- Qué queda después
-- ---------------------------------------------------------------------------
-- `pp_solicitud_lineas.migrada_de_id` se conserva: es el único rastro de qué
-- línea vino de la tabla vieja, y no molesta a nadie. Sin ella, el histórico
-- pierde la trazabilidad de la migración.
--
-- `pp_firmas` y `pp_auditoria` no se tocan: son append-only por trigger, y las
-- entradas que apuntan a ids de la tabla borrada siguen siendo ciertas — el hecho
-- ocurrió.
