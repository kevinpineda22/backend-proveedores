-- =============================================================================
-- Migration 002: moneda en el snapshot de cotizaciones
--
-- La consulta nueva (docs/CONSULTA-COTIZACIONES.sql) devuelve `Moneda`. La vieja
-- no. El default COP cubre las dos: las filas ya cargadas quedan bien, porque
-- toda la data existente está en pesos.
--
-- Traerla importa por una sola razón: el conector escribe F212_ID_MONEDA como
-- campo FIJO en COP. Si mañana entra un proveedor en USD y no lo notamos, un
-- producto de USD 100 se cargaría como $100. Con la columna guardada,
-- `armarPayload()` corta antes de escribir.
-- =============================================================================

ALTER TABLE pp_cotizaciones
  ADD COLUMN IF NOT EXISTS moneda VARCHAR(3) NOT NULL DEFAULT 'COP';

COMMENT ON COLUMN pp_cotizaciones.moneda IS
  'Parte de la llave natural en SIESA. El conector solo sabe escribir COP: una '
  'cotización en otra moneda se rechaza al armar el payload, no se convierte.';


