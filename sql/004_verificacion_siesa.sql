-- ---------------------------------------------------------------------------
-- 004 — Verificar la escritura en SIESA, y el estado "incierto"
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- El sistema daba una cotización por escrita si SIESA respondía `codigo: 0`.
-- Eso es un acuse de recibo, no una prueba. El 2026-08-28 la solicitud #5
-- recibió "Importacion exitosa" y durante días nadie pudo encontrar el registro
-- en el ERP: la base afirmaba `aplicada` sin haber comprobado nada.
--
-- Ahora, después de importar, se RELEE la cotización y se compara precio e
-- impuestos contra lo aprobado. El resultado se guarda en `siesa_verificacion`.
--
-- POR QUÉ HACE FALTA UN ESTADO NUEVO
-- La relectura tiene cuatro desenlaces y los estados que había solo cubrían dos:
--
--   confirmado      → el precio está en SIESA          → 'aplicada'
--   no_verificable  → no se pudo comprobar             → 'aplicada' + motivo
--   no_encontrado   → SIESA dijo OK y no está          → ¿?
--   discrepante     → está, pero con otros valores     → ¿?
--
-- Los dos últimos no son 'fallida': 'fallida' significa "SIESA lo rechazó" y
-- habilita reintentar. Acá SIESA lo ACEPTÓ; no sabemos qué quedó. Marcarlo
-- 'aplicada' es la mentira que veníamos a matar, y marcarlo 'fallida' invita a
-- reenviar un precio que puede estar adentro — o sea, a duplicarlo.
--
-- 'incierto' separa "falló" de "no sé". Es el mismo patrón que
-- backend-traslado adoptó en su migración 033 por la misma razón.
--
-- EL COSTO, DICHO EXPLÍCITAMENTE
-- Una solicitud 'incierta' necesita que una persona mire el ERP y decida. Se
-- elige a propósito: destrabarla cuesta un minuto, y un precio duplicado en el
-- ERP hay que ir a pedir que lo borren.
--
-- 'no_verificable' NO cae acá. Mientras se lea de producción y se escriba en QA
-- (ver docs/PENDIENTES.md §1.4), TODA aprobación sería incierta y el estado
-- perdería el sentido: si todo es sospechoso, nada lo es. Queda 'aplicada' con
-- el motivo guardado, que es la verdad: se mandó, se aceptó, no se pudo releer.
-- ---------------------------------------------------------------------------

ALTER TABLE pp_solicitudes_precio
  ADD COLUMN IF NOT EXISTS siesa_verificacion JSONB;

COMMENT ON COLUMN pp_solicitudes_precio.siesa_verificacion IS
  'Resultado de releer la cotización después de importarla: '
  '{estado, motivo, esperado, encontrado, verificado_at}. '
  'estado ∈ confirmado | no_encontrado | discrepante | no_verificable. '
  'NULL en las solicitudes anteriores a la migración 004 y en las de sandbox.';

ALTER TABLE pp_solicitudes_precio
  DROP CONSTRAINT IF EXISTS pp_solicitudes_estado_valido;

ALTER TABLE pp_solicitudes_precio
  ADD CONSTRAINT pp_solicitudes_estado_valido
  CHECK (estado IN ('pendiente','aprobada','rechazada','aplicada','fallida','incierto'));

-- 'incierto' llegó por el mismo camino que 'aplicada' —se tomó la solicitud y se
-- empujó—, así que lleva la misma marca de empuje. Sin esto, una incierta podría
-- volver a la cola sin registro de cuándo se mandó, que es el agujero por donde
-- se cuelan los duplicados.
ALTER TABLE pp_solicitudes_precio
  DROP CONSTRAINT IF EXISTS pp_solicitudes_incierta_con_marca;

ALTER TABLE pp_solicitudes_precio
  ADD CONSTRAINT pp_solicitudes_incierta_con_marca
  CHECK (estado <> 'incierto' OR siesa_aplicado_at IS NOT NULL);

-- La bandeja filtra por estado y las inciertas son las que hay que mirar primero.
CREATE INDEX IF NOT EXISTS idx_pp_solicitudes_incierta
  ON pp_solicitudes_precio(id)
  WHERE estado = 'incierto';
