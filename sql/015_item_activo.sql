-- ---------------------------------------------------------------------------
-- 015 — Estado del ítem en SIESA (activo / inactivo) en pp_cotizaciones
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Compras, 2026-11-13: un proveedor puede cargar en su solicitud productos que
-- están INACTIVOS en SIESA, y el portal los trataba como normales — la consulta
-- de cotizaciones no traía el estado. Ahora trae `EstadoItem` y el snapshot lo
-- guarda acá.
--
-- TRES VALORES, A PROPÓSITO
--   true  → activo
--   false → inactivo: no se puede cotizar (problemaDeLinea, solicitud.service.js)
--   NULL  → no se sabe (la consulta todavía no trae la columna, o el dato no es
--           creíble — ver estadoCreible()). NO bloquea: ante la duda, no frenar.
--
-- ⚠️ CORRER ANTES DEL DEPLOY DEL BACKEND. El snapshot hace upsert con esta
-- columna: sin ella, el cron de las 5:00 y el refresco al ingresar FALLAN.
-- ---------------------------------------------------------------------------

ALTER TABLE pp_cotizaciones ADD COLUMN IF NOT EXISTS item_activo BOOLEAN;

COMMENT ON COLUMN pp_cotizaciones.item_activo IS
  'Estado del ítem en SIESA según la columna EstadoItem de la consulta. '
  'true = activo, false = inactivo (no se cotiza), NULL = no se sabe (no bloquea).';
