-- ---------------------------------------------------------------------------
-- 005 — Estado "anulada": el proveedor retira su propia propuesta
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Un proveedor que se equivoca al escribir el precio no tiene salida. El índice
-- `idx_pp_solicitudes_pendiente_unica` permite UNA sola propuesta viva por
-- renglón, así que tampoco puede mandar la correcta: queda esperando a que
-- alguien le rechace la equivocada para recién entonces proponer bien.
--
-- POR QUÉ UN ESTADO NUEVO Y NO 'rechazada'
-- 'rechazada' significa "Merkahorro la revisó y dijo que no", y arrastra un
-- motivo escrito por un admin. Meter ahí un retiro del proveedor ensucia dos
-- cosas: el historial que el proveedor lee —vería un rechazo que nadie hizo— y
-- las métricas de la bandeja, que cuentan rechazos para saber cómo viene la
-- negociación. Son hechos distintos y merecen nombres distintos.
--
-- QUÉ NO CAMBIA
-- La firma NO se borra. `pp_firmas` es append-only por trigger y la propuesta
-- existió: que se haya retirado no la desfirma. El histórico tiene que poder
-- mostrar qué se propuso y qué pasó con eso.
--
-- Y solo se puede anular en 'pendiente'. Una vez que un admin la tomó, el
-- proveedor ya no manda: el precio pudo haber salido hacia SIESA.
-- ---------------------------------------------------------------------------

ALTER TABLE pp_solicitudes_precio
  DROP CONSTRAINT IF EXISTS pp_solicitudes_estado_valido;

ALTER TABLE pp_solicitudes_precio
  ADD CONSTRAINT pp_solicitudes_estado_valido
  CHECK (estado IN (
    'pendiente','aprobada','rechazada','aplicada','fallida','incierto','anulada'
  ));

-- Una anulada NUNCA tuvo empuje a SIESA: se retira antes de que un admin la
-- tome. Si algún día una anulada aparece con la marca puesta, algo dejó pasar
-- una solicitud ya empujada a un estado que dice que nunca salió.
ALTER TABLE pp_solicitudes_precio
  DROP CONSTRAINT IF EXISTS pp_solicitudes_anulada_sin_empuje;

ALTER TABLE pp_solicitudes_precio
  ADD CONSTRAINT pp_solicitudes_anulada_sin_empuje
  CHECK (estado <> 'anulada' OR siesa_aplicado_at IS NULL);
