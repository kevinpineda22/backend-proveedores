-- ---------------------------------------------------------------------------
-- 014 — Quién firma: nombre y cédula en pp_firmas
-- ---------------------------------------------------------------------------
--
-- QUÉ RESUELVE
-- Compras, 2026-11-13: "el proveedor firma la solicitud, pero las firmas no
-- siempre dicen mucho; además de la firma debemos pedir nombre y cédula,
-- obligatorios". Un trazo prueba que alguien dibujó algo, no quién.
--
-- POR QUÉ SON COLUMNAS NULLABLE
-- Las firmas anteriores a esta migración no los tienen y no se pueden inventar.
-- La obligatoriedad vive en la API (validators.js → crearSolicitud.firmante) y
-- en `registrarFirma()`, que se niega a insertar sin los dos.
--
-- POR QUÉ NO HACE FALTA UN TRIGGER NUEVO
-- Nombre y cédula entran en el HASH de la firma (formato v3, firma.service.js).
-- Si alguien los cambiara en la base, `verificarFirmaDeSolicitud()` deja de
-- validar y la solicitud no se puede aprobar. Además pp_firmas ya es
-- append-only por trigger (001): un UPDATE ni siquiera llega.
--
-- ⚠️ CORRER ANTES DEL DEPLOY DEL BACKEND. Sin estas columnas el INSERT de la
-- firma falla y ningún proveedor puede enviar una solicitud.
-- ---------------------------------------------------------------------------

ALTER TABLE pp_firmas ADD COLUMN IF NOT EXISTS firmante_nombre TEXT;
ALTER TABLE pp_firmas ADD COLUMN IF NOT EXISTS firmante_cedula TEXT;

COMMENT ON COLUMN pp_firmas.firmante_nombre IS
  'Nombre completo de quien firmó, normalizado en MAYÚSCULAS y sin espacios dobles. '
  'Parte del hash desde la v3: cambiarlo invalida la firma. NULL en firmas anteriores a la 014.';

COMMENT ON COLUMN pp_firmas.firmante_cedula IS
  'Cédula de quien firmó, solo dígitos. Parte del hash desde la v3. NULL en firmas anteriores a la 014.';
