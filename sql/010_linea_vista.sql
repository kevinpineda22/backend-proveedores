-- ---------------------------------------------------------------------------
-- 010 — El proveedor puede dar por visto un aviso, y que quede así PARA SIEMPRE
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- El inicio del proveedor tiene un bloque "Requieren su atención" con lo que le
-- rechazaron. Nada lo apagaba nunca: una rechazada de enero seguía ocupando la
-- pantalla en septiembre. Johan, 2026-09-08: *"es bastante intrusivo, en toda la
-- pantalla de inicio, cómo podemos omitir esto luego de verlo, permanentemente"*.
--
-- POR QUÉ UNA COLUMNA Y NO EL NAVEGADOR
-- La primera versión lo guardaba en `localStorage`. Anda, pero "permanente" ahí
-- significa "permanente en ESTA máquina": el proveedor lo cierra en la oficina y
-- le vuelve a aparecer desde la casa, o cuando limpia el navegador. Para algo que
-- se apaga UNA vez y no se vuelve a mirar, ese olvido es justamente el defecto.
--
-- QUÉ NO ES
-- Esto NO borra nada. La línea, su estado y su motivo de rechazo siguen enteros y
-- se siguen viendo en "Solicitudes": lo único que cambia es que el inicio deja de
-- destacarla. Un proveedor que apaga el aviso no pierde la explicación de por qué
-- le dijeron que no — que es lo que necesita si quiere volver a proponer.
--
-- POR QUÉ NO SE AUDITA
-- `pp_auditoria` guarda lo que mueve plata o permisos. Que alguien haya cerrado
-- un aviso en su propia pantalla no es ninguna de las dos cosas, y meterlo ahí
-- llenaría de ruido la tabla donde después hay que buscar quién cambió un precio.
-- ---------------------------------------------------------------------------

ALTER TABLE pp_solicitud_lineas
  ADD COLUMN IF NOT EXISTS visto_at TIMESTAMPTZ;

COMMENT ON COLUMN pp_solicitud_lineas.visto_at IS
  'Cuándo el PROVEEDOR dio por visto el aviso de esta línea en su pantalla de '
  'inicio. NULL = todavía se le destaca. No afecta el estado ni la validez de la '
  'solicitud: es solo presentación. Lo escribe únicamente el dueño de la línea '
  '(POST /api/proveedor/solicitudes/lineas/vistas).';

-- El índice sirve a la única consulta que la usa: "las mías que todavía no vi".
-- Parcial, porque las ya vistas no se buscan nunca — y en régimen van a ser la
-- mayoría de las filas.
CREATE INDEX IF NOT EXISTS idx_pp_lineas_sin_ver
  ON pp_solicitud_lineas (cuenta_destino_id)
  WHERE visto_at IS NULL;

-- ---------------------------------------------------------------------------
-- Nada que migrar: todas las líneas existentes nacen en NULL, o sea "sin ver".
-- Es lo correcto — nadie las dio por vistas todavía, y darlas por vistas de
-- entrada le escondería al proveedor un rechazo que nunca leyó.
-- ---------------------------------------------------------------------------
