-- ---------------------------------------------------------------------------
-- 011 — Seguimiento de las diferencias de costo: ¿compras ya corrigió la cotización?
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- La pantalla "Diferencias de costo" muestra las entradas que se facturaron
-- distinto de lo que entraron (tienen un CAS o un CAE). Eso lo calcula el backend
-- en cada consulta, leyendo la réplica de SIESA — no se guarda.
--
-- Lo que SÍ hay que guardar es la decisión humana: si compras ya corrigió la
-- cotización en SIESA para que la próxima orden salga con el precio bueno. Era la
-- columna "Cotización corregida" (Corregido / Pendiente) del Excel que esta
-- pantalla reemplaza. María José, 2026-09-14: "llevar seguimiento", y "solo
-- compras lo marca".
--
-- POR QUÉ LA LLAVE ES FACTURA + ÍTEM Y NO LA ENTRADA
-- Una factura puede llegar partida en dos entradas (CEA). La corrección es UNA
-- sola —se corrige la cotización de ese producto—, así que marcar una de las dos
-- entradas y dejar la otra "pendiente" sería mentir sobre la mitad.
--
-- POR QUÉ NO HAY FILA = PENDIENTE
-- No se precargan filas: una diferencia sin seguimiento está pendiente. Así esta
-- tabla no tiene que sincronizarse con la réplica, que carga otra persona.
--
-- POR QUÉ EL PROVEEDOR NO LA LEE DIRECTO
-- RLS activo y sin políticas: solo la lee el backend con la service key. El
-- proveedor ve el estado a través de la API, que le quita la nota interna y el
-- nombre de quién la marcó.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pp_diferencias_seguimiento (
  docto_causacion   VARCHAR(20)  NOT NULL,
  item              INTEGER      NOT NULL,
  estado            VARCHAR(10)  NOT NULL DEFAULT 'pendiente',
  nota              TEXT,
  actualizado_por   TEXT,
  actualizado_user  UUID,
  actualizado_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  PRIMARY KEY (docto_causacion, item),

  CONSTRAINT pp_dif_estado_valido
    CHECK (estado IN ('pendiente', 'corregido')),

  -- Solo CFP y CFM tienen diferencias que seguir (ver services/diferenciasCosto.js).
  CONSTRAINT pp_dif_causacion_valida
    CHECK (docto_causacion ~ '^(CFP|CFM)-[0-9]+$'),

  -- "Corregido" tiene que decir QUIÉN. Si la próxima orden vuelve a salir con el
  -- precio viejo, la pregunta "¿quién dijo que esto estaba corregido?" tiene que
  -- tener respuesta.
  CONSTRAINT pp_dif_corregido_con_responsable
    CHECK (estado = 'pendiente' OR actualizado_por IS NOT NULL)
);

COMMENT ON TABLE pp_diferencias_seguimiento IS
  'Si compras ya corrigió la cotización de una factura+ítem con diferencia de costo. '
  'Sin fila = pendiente. La diferencia en sí NO se guarda: se calcula leyendo la '
  'réplica de SIESA (merkahorro_siesa.compras).';

ALTER TABLE pp_diferencias_seguimiento ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Verificar después de correrla:
--
--   SELECT to_regclass('public.pp_diferencias_seguimiento');   -- no NULL
--   NOTIFY pgrst, 'reload schema';   -- PostgREST cachea el esquema (PENDIENTES §0)
-- ---------------------------------------------------------------------------
