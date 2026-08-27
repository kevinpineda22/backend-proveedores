-- =============================================================================
-- Migration 003: administradores del Portal de Proveedores
--
-- POR QUÉ UNA TABLA Y NO UN ROL EN `profiles`
--
-- `profiles.role` es UNA columna: poner `pp_admin` ahí le quita al usuario el rol
-- que ya tenía. Y la app ya chocó con esto antes — por eso existe
-- `profiles.ecommerce_rol`, una segunda columna de rol agregada para un módulo.
-- Seguir por ese camino da una columna por módulo y ninguna regla clara.
--
-- Además, aprobar un cambio de precio ESCRIBE EN SIESA. Ese permiso merece una
-- lista explícita de personas, no "quien tenga cierto string en una columna que
-- se cambia por otros motivos".
--
-- Con esta tabla, alguien puede ser admin del portal Y seguir siendo lo que ya
-- era. Agregar o quitar un admin no toca `profiles` ni afecta a nadie más.
-- =============================================================================

CREATE TABLE IF NOT EXISTS pp_admins (
  user_id     UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  correo      TEXT,
  nombre      TEXT,
  activo      BOOLEAN      NOT NULL DEFAULT true,
  creado_por  UUID,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE pp_admins IS
  'Quién puede aprobar cambios de precio del Portal de Proveedores. '
  'Independiente de profiles.role: un admin del portal conserva su rol de la app.';

COMMENT ON COLUMN pp_admins.activo IS
  'Se DESACTIVA, no se borra. Un admin borrado deja sus filas de pp_auditoria '
  'apuntando a un usuario que ya no existe, y la auditoría de quién aprobó qué '
  'es justamente lo que no puede perderse.';

CREATE INDEX IF NOT EXISTS idx_pp_admins_activo ON pp_admins(activo);

-- RLS: nadie lee esta tabla desde el cliente. Solo el backend, con service key.
-- Sin políticas, RLS niega todo — que es exactamente lo que se quiere: la lista
-- de quién puede aprobar precios no tiene por qué ser consultable.
ALTER TABLE pp_admins ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- ALTA DEL PRIMER ADMIN
--
-- Reemplazá el correo por el tuyo y ejecutá. Es la única alta manual: desde el
-- panel se pueden agregar los demás.
-- ---------------------------------------------------------------------------
INSERT INTO pp_admins (user_id, correo, nombre)
SELECT id, email, COALESCE(raw_user_meta_data->>'nombre', email)
  FROM auth.users
 WHERE email = 'johanmerkahorro777@gmail.com'
ON CONFLICT (user_id) DO UPDATE SET activo = true;
