import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { aprobar, rechazar } from "../services/solicitud.service.js";

/** Maestro de proveedores: NIT, sucursales, correo asociado, tope. */
export async function maestro(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("pp_proveedores")
      .select("nit, id_tercero, razon_social, porcentaje_max, bloqueado, pp_cuentas(id, sucursal, nombre_sucursal, correo_notificacion, estado)")
      .order("razon_social");

    if (error) throw new Error(error.message);
    res.json({ proveedores: data ?? [] });
  } catch (e) {
    next(e);
  }
}

/** El tope y el bloqueo del proveedor. Es la palanca del admin. */
export async function configurarProveedor(req, res, next) {
  try {
    const cambios = {};
    // `undefined` = no lo mandaron, se deja como está.
    // `null` en porcentajeMax = SIN TOPE, y es una decisión explícita del admin.
    if ("porcentajeMax" in req.body) cambios.porcentaje_max = req.body.porcentajeMax;
    if ("bloqueado" in req.body) cambios.bloqueado = req.body.bloqueado;

    if (!Object.keys(cambios).length) {
      throw createError(422, "No se envió ningún cambio");
    }

    const { data: antes } = await supabase
      .from("pp_proveedores")
      .select("porcentaje_max, bloqueado")
      .eq("nit", req.params.nit)
      .maybeSingle();

    if (!antes) throw createError(404, "El proveedor no existe");

    const { error } = await supabase.from("pp_proveedores").update(cambios).eq("nit", req.params.nit);
    if (error) throw new Error(error.message);

    // El tope decide cuánta plata entra de más: cada cambio queda registrado con
    // el valor anterior, no solo el nuevo.
    await supabase.from("pp_auditoria").insert({
      entidad: "pp_proveedores",
      entidad_id: req.params.nit,
      accion: "configurar",
      actor_user_id: req.admin.userId,
      actor_rol: "pp_admin",
      detalle: { antes, despues: cambios },
      ip: req.ip,
    });

    res.json({ ok: true, nit: req.params.nit, ...cambios });
  } catch (e) {
    next(e);
  }
}

/** Bandeja de novedades: lo que espera respuesta primero. */
export async function bandeja(req, res, next) {
  try {
    const estado = req.query.estado || "pendiente";
    const { data, error } = await supabase
      .from("pp_solicitudes_precio")
      .select(
        "id, cuenta_id, clave_item, item, descripcion_item, unidad_medida, " +
          "precio_actual, precio_propuesto, descuentos_actuales, descuentos_propuestos, " +
          "costo_neto_actual, costo_neto_propuesto, variacion_pct, porcentaje_max_vigente, " +
          "fecha_activacion, notas, estado, motivo_rechazo, firma_id, creado_at, resuelto_at, " +
          "pp_cuentas(nit, sucursal, nombre_sucursal, pp_proveedores(razon_social))",
      )
      .eq("estado", estado)
      .order("creado_at", { ascending: true })
      .limit(500);

    if (error) throw new Error(error.message);
    res.json({ solicitudes: data ?? [] });
  } catch (e) {
    next(e);
  }
}

/** La firma de una solicitud: trazo, hash, hora, IP. La prueba, completa. */
export async function verFirma(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("pp_firmas")
      .select("id, cuenta_id, payload_hash, trazo, ip, user_agent, firmado_at")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw createError(404, "La firma no existe");
    res.json(data);
  } catch (e) {
    next(e);
  }
}

export async function aprobarSolicitud(req, res, next) {
  try {
    res.json(await aprobar({ solicitudId: req.params.id, admin: req.admin, ip: req.ip }));
  } catch (e) {
    next(e);
  }
}

export async function rechazarSolicitud(req, res, next) {
  try {
    res.json(
      await rechazar({
        solicitudId: req.params.id,
        motivo: req.body.motivo,
        admin: req.admin,
        ip: req.ip,
      }),
    );
  } catch (e) {
    next(e);
  }
}
