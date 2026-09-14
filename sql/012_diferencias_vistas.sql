-- ---------------------------------------------------------------------------
-- 012 — El proveedor oculta el aviso de diferencias de costo, hasta que haya nuevas
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Johan, 2026-09-14: en Inicio va "un aviso importante" de las diferencias de
-- costo, "pero que sea quitable, no invasivo permanente".
--
-- Quitable y no permanente son las dos mitades:
--   · Quitable: el proveedor lo cierra y deja de verlo.
--   · No permanente: si después llegan diferencias NUEVAS, el aviso vuelve.
--     Un aviso que se cierra para siempre esconde justo lo siguiente que hay
--     que mirar.
--
-- POR QUÉ EN LA BASE Y NO EN EL NAVEGADOR
-- Es la lección de la migración 010: en `localStorage`, "oculto" quiere decir
-- "oculto en esta máquina". El proveedor lo cierra en la oficina y le reaparece
-- desde la casa.
--
-- POR QUÉ UN TEXTO Y NO UN TIMESTAMPTZ
-- Guarda el valor `actualizado` de la réplica de SIESA en el momento de cerrar
-- (`max(fecha_carga)`, formato `AAAA-MM-DD HH24:MI:SS`). El aviso muestra las
-- diferencias cuyo ajuste se cargó DESPUÉS de ese valor.
--
-- Las dos marcas —la de cierre y la de cada ajuste— salen del MISMO reloj, el de
-- la réplica, que es `timestamp without time zone`. Guardarlo como `timestamptz`
-- con el `now()` de Supabase compararía dos relojes distintos con husos
-- distintos, y el aviso aparecería o desaparecería cinco horas corrido. En texto
-- ISO el orden alfabético es el cronológico, y la comparación es exacta.
--
-- QUÉ NO ES
-- No toca el seguimiento de compras (`pp_diferencias_seguimiento`) ni la pestaña
-- "Diferencias de costo", que muestra todo siempre. Solo decide si Inicio
-- destaca algo. Por eso tampoco se audita: ver el comentario de la 010.
-- ---------------------------------------------------------------------------

ALTER TABLE pp_cuentas
  ADD COLUMN IF NOT EXISTS diferencias_vistas_hasta TEXT;

ALTER TABLE pp_cuentas
  DROP CONSTRAINT IF EXISTS pp_cuentas_diferencias_vistas_formato;

ALTER TABLE pp_cuentas
  ADD CONSTRAINT pp_cuentas_diferencias_vistas_formato
  CHECK (
    diferencias_vistas_hasta IS NULL
    OR diferencias_vistas_hasta ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
  );

COMMENT ON COLUMN pp_cuentas.diferencias_vistas_hasta IS
  'Hasta qué carga de la réplica de SIESA el proveedor ya vio el aviso de '
  'diferencias de costo en Inicio. NULL = nunca lo ocultó. Formato '
  'AAAA-MM-DD HH24:MI:SS, del reloj de la réplica (ver la cabecera de sql/012). '
  'Lo escribe únicamente el dueño de la cuenta (POST /api/proveedor/diferencias-costo/visto).';

-- ---------------------------------------------------------------------------
-- Nada que migrar: todas las cuentas nacen en NULL, o sea "nunca lo ocultó", y
-- el aviso les aparece. Es lo correcto: nadie vio todavía estas diferencias.
--
-- Verificar después de correrla:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'pp_cuentas' AND column_name = 'diferencias_vistas_hasta';
--   NOTIFY pgrst, 'reload schema';
-- ---------------------------------------------------------------------------
