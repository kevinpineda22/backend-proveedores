-- ---------------------------------------------------------------------------
-- 009 — El tope de aumento puede ser por SUCURSAL, no solo por NIT
-- ---------------------------------------------------------------------------
--
-- Decidido por compras el 2026-09-07 (§2.2): **el tope es por sucursal.**
--
-- QUÉ RESUELVE
-- `pp_proveedores.porcentaje_max` es UNO POR NIT, y la unidad real de acuerdo es
-- la sucursal. El caso está en los datos: `ZONA 2 DISTRIBUCIONES SAS` (900256457)
-- tiene DIEZ sucursales — cinco marcas (RAMA, EL REY, NIVEA, TROLLI, LAVA) por dos
-- zonas de entrega. Hoy las diez comparten el mismo máximo, así que un acuerdo
-- distinto por marca no se puede reflejar: o se afloja el tope para todas, o se
-- aprieta a todas.
--
-- POR QUÉ UNA COLUMNA NUEVA Y NO MUDAR LA VIEJA
-- El tope del NIT sigue existiendo como valor POR DEFECTO. Mudarlo obligaría a
-- configurar 3.680 cuentas una por una antes de que el sistema volviera a
-- proteger algo — y mientras tanto todas quedarían sin tope, que es justo lo
-- contrario de lo que se quiere.
--
--     pp_cuentas.porcentaje_max      → manda si NO es NULL
--     pp_proveedores.porcentaje_max  → el que rige si la cuenta no tiene el suyo
--
-- 🔴 ACLARACIÓN POSTERIOR (2026-09-08) — LEER ANTES QUE EL RESTO
-- El texto de abajo dice que un NULL en `pp_cuentas` "hereda el del NIT", a
-- secas. Merkahorro precisó la regla después de correr esta migración: el tope
-- del NIT es el default **de todas las sucursales o de ninguna**.
--
--     ninguna sucursal del NIT con tope propio → las vacías HEREDAN el del NIT
--     alguna  sucursal del NIT con tope propio → las vacías quedan SIN TOPE
--
-- El esquema NO cambia —sigue siendo esta misma columna nullable—, cambia quién
-- resuelve: `topeDe()` en `services/costoNeto.js`, que ahora recibe si alguna
-- hermana tiene el suyo. Por eso no hay una migración 010.
--
-- Consecuencia que hay que tener presente al cargar topes: **el primer tope de
-- sucursal que se guarda le saca el tope a todas las hermanas vacías.**
--
-- ⚠️ NULL NO ES CERO, y acá vale doble.
-- En `pp_cuentas`, NULL significa **"heredá el del NIT"**, no "sin tope". Es una
-- tercera cosa, distinta de las dos que ya convivían en `pp_proveedores` (NULL =
-- sin tope, 0 = ninguna subida). Confundirlas deja a un proveedor sin ninguna
-- guarda o congelado, y en los dos casos nadie se entera hasta que alguien
-- reclama.
--
-- Por eso la resolución vive en UN solo lugar del código —`topeDe()` en
-- `src/services/costoNeto.js`— y no repartida en cada consulta.
-- ---------------------------------------------------------------------------

ALTER TABLE pp_cuentas
  ADD COLUMN IF NOT EXISTS porcentaje_max NUMERIC(5,2);

ALTER TABLE pp_cuentas
  DROP CONSTRAINT IF EXISTS pp_cuentas_pct_valido;

ALTER TABLE pp_cuentas
  ADD CONSTRAINT pp_cuentas_pct_valido
  CHECK (porcentaje_max IS NULL OR porcentaje_max >= 0);

COMMENT ON COLUMN pp_cuentas.porcentaje_max IS
  'Tope de subida del COSTO CON DESCUENTO para ESTA sucursal, en puntos '
  'porcentuales (5.00 = 5%). '
  'NULL = hereda el de pp_proveedores (NO significa "sin tope"). '
  '0 = ninguna subida permitida. Los tres casos son distintos.';

-- El maestro NO la toca. `sincronizarMaestro` usa `ignoreDuplicates`, así que una
-- corrida del cron no puede pisar lo que Merkahorro configuró a mano — la misma
-- garantía que ya protege al correo, al user_id y al estado de la cuenta.
--
-- Nada que migrar: todas las cuentas nacen en NULL y siguen rigiéndose por el
-- tope del NIT, exactamente como hasta hoy. Esta migración no cambia el
-- comportamiento de nadie hasta que alguien fije un tope de sucursal.

-- ---------------------------------------------------------------------------
-- Para ver dónde el tope por sucursal cambiaría algo
-- ---------------------------------------------------------------------------
--   SELECT p.nit, p.razon_social, p.porcentaje_max AS tope_del_nit,
--          count(*) AS sucursales
--     FROM pp_proveedores p
--     JOIN pp_cuentas c ON c.nit = p.nit
--    GROUP BY p.nit, p.razon_social, p.porcentaje_max
--   HAVING count(*) > 1
--    ORDER BY count(*) DESC;
