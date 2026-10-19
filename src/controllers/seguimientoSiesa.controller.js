/* =============================================================================
   Seguimiento SIESA — la pestaña del admin (sql/013)

   Solo lectura. Reintentar sigue viviendo en la bandeja (`/solicitudes/lineas/
   reintentar`): esta pantalla dice qué pasó, no empuja nada. Dos lugares que
   empujan terminan en dos juegos de guardas que se desincronizan.
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { infoConector } from "../services/siesaCotizacion.js";
import { entornosComparables, hostDe, urlLectura } from "../services/verificarCotizacion.js";
import { destinoDe } from "../services/seguimientoSiesa.js";

/** Lo liviano de un envío: la lista no trae payload ni respuesta. */
const COLUMNAS_LISTA =
  "id, cuenta_id, id_tercero, sucursal, solicitud_ids, linea_ids, renglones, items, conector, " +
  "destino, sandbox, estado, http_status, error, verificaciones, enviado_por, enviado_por_nombre, " +
  "enviado_at, respondido_at, duracion_ms, historico, " +
  "pp_cuentas(nit, nombre_sucursal, pp_proveedores(razon_social))";

const LIMITE_ENVIOS = 500;
const LIMITE_CAMBIOS = 3000;

/** `hasta` es inclusivo: se compara contra el día siguiente. */
const diaSiguiente = (fecha) => {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Fechas en Colombia (UTC-5): el día del admin, no el de UTC. */
const inicioDia = (fecha) => `${fecha}T00:00:00-05:00`;

/** Una fila de la lista con el proveedor aplanado. */
const aEnvio = ({ pp_cuentas: c, ...e }) => ({
  ...e,
  nit: c?.nit ?? null,
  nombre_sucursal: c?.nombre_sucursal ?? null,
  razon_social: c?.pp_proveedores?.razon_social ?? null,
});

/** GET /admin/siesa/estado — a dónde escribe y lee el portal, y la última corrida. */
export async function estado(req, res, next) {
  try {
    const c = infoConector();
    const { data: corrida } = await supabase
      .from("pp_auditoria")
      .select("creado_at, detalle")
      .eq("entidad", "pp_cotizaciones")
      .eq("accion", "snapshot")
      .order("creado_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    res.json({
      escritura: {
        destino: destinoDe(c.url),
        host: hostDe(c.url),
        conector: c.idDocumento,
        nombre: c.nombreDocumento,
        sandbox: c.sandbox,
        configurado: c.faltantes.length === 0,
        faltantes: c.faltantes,
      },
      lectura: { destino: destinoDe(urlLectura()), host: hostDe(urlLectura()) },
      // false = la relectura es ciega y los envíos quedan `no_verificable`.
      comparables: entornosComparables(),
      ultimoSnapshot: corrida
        ? {
            at: corrida.creado_at,
            cotizaciones: corrida.detalle?.cotizaciones ?? null,
            cambiosSiesa: corrida.detalle?.cambiosSiesa ?? null,
          }
        : null,
    });
  } catch (e) {
    next(e);
  }
}

/** GET /admin/siesa/envios?desde&hasta&estado */
export async function listarEnvios(req, res, next) {
  try {
    const { desde, hasta, estado: filtroEstado } = req.query;
    let q = supabase
      .from("pp_siesa_envios")
      .select(COLUMNAS_LISTA)
      .order("enviado_at", { ascending: false })
      .limit(LIMITE_ENVIOS);
    if (desde) q = q.gte("enviado_at", inicioDia(desde));
    if (hasta) q = q.lt("enviado_at", inicioDia(diaSiguiente(hasta)));
    if (filtroEstado) q = q.eq("estado", filtroEstado);

    const { data, error } = await q;
    if (error) throw new Error(`No se pudieron leer los envíos: ${error.message}`);
    const envios = (data ?? []).map(aEnvio);
    res.json({ envios, limite: LIMITE_ENVIOS, truncado: envios.length === LIMITE_ENVIOS });
  } catch (e) {
    next(e);
  }
}

/**
 * GET /admin/siesa/envios/:id — el envío completo, más lo que pasó con sus
 * líneas en `pp_auditoria` (aprobar, empuje_fallido, reintentar…): es lo que
 * cuenta por qué hay tres intentos para el mismo producto.
 */
export async function obtenerEnvio(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw createError(422, "Id de envío inválido.");

    const { data, error } = await supabase
      .from("pp_siesa_envios")
      .select(`${COLUMNAS_LISTA}, payload, respuesta`)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`No se pudo leer el envío: ${error.message}`);
    if (!data) throw createError(404, "No se encontró el envío.");

    const envio = aEnvio(data);
    const { data: eventos, error: errEv } = await supabase
      .from("pp_auditoria")
      .select("id, entidad_id, accion, estado_anterior, estado_nuevo, actor_rol, detalle, creado_at")
      .eq("entidad", "pp_solicitud_lineas")
      .in("entidad_id", envio.linea_ids.map(String))
      .order("creado_at", { ascending: true })
      .limit(200);
    if (errEv) console.error(`[seguimiento] envío ${id}: sin historial de líneas: ${errEv.message}`);

    res.json({ envio, eventos: eventos ?? [] });
  } catch (e) {
    next(e);
  }
}

/** GET /admin/siesa/cambios?desde&hasta&origen&tipo */
export async function listarCambios(req, res, next) {
  try {
    const { desde, hasta, origen, tipo } = req.query;
    let q = supabase
      .from("pp_siesa_cambios")
      .select("*")
      .order("detectado_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(LIMITE_CAMBIOS);
    if (desde) q = q.gte("detectado_at", inicioDia(desde));
    if (hasta) q = q.lt("detectado_at", inicioDia(diaSiguiente(hasta)));
    if (origen) q = q.eq("origen", origen);
    if (tipo) q = q.eq("tipo", tipo);

    const { data, error } = await q;
    if (error) throw new Error(`No se pudieron leer los cambios: ${error.message}`);

    // La razón social no vive en el cambio (no hay FK por NIT): se pega acá.
    const nits = [...new Set((data ?? []).map((c) => c.nit).filter(Boolean))];
    let nombres = new Map();
    if (nits.length) {
      const { data: provs, error: errP } = await supabase
        .from("pp_proveedores")
        .select("nit, razon_social")
        .in("nit", nits);
      if (errP) console.error(`[seguimiento] cambios sin razón social: ${errP.message}`);
      nombres = new Map((provs ?? []).map((p) => [p.nit, p.razon_social]));
    }

    const cambios = (data ?? []).map((c) => ({ ...c, razon_social: nombres.get(c.nit) ?? null }));
    res.json({ cambios, limite: LIMITE_CAMBIOS, truncado: cambios.length === LIMITE_CAMBIOS });
  } catch (e) {
    next(e);
  }
}
