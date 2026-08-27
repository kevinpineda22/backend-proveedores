import { catalogoDe, crearSolicitud } from "../services/solicitud.service.js";
import { supabase } from "../config/supabase.js";

/** Quién soy. El frontend arma el encabezado con esto, sin pedir el maestro. */
export function miCuenta(req, res) {
  const { id, nit, sucursal, nombreSucursal, razonSocial, bloqueado } = req.cuenta;
  // `porcentajeMax` NO se serializa: es configuración interna. El proveedor lo
  // conoce cuando lo choca, en el detalle del 422. Ver ARQUITECTURA §5.
  res.json({ id, nit, sucursal, nombreSucursal, razonSocial, bloqueado });
}

export async function catalogo(req, res, next) {
  try {
    res.json({ items: await catalogoDe(req.cuenta) });
  } catch (e) {
    next(e);
  }
}

export async function crear(req, res, next) {
  try {
    const r = await crearSolicitud({
      cuenta: req.cuenta,
      usuario: req.usuario,
      datos: req.body,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json(r);
  } catch (e) {
    next(e);
  }
}

export async function misSolicitudes(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("pp_solicitudes_precio")
      .select(
        "id, clave_item, item, descripcion_item, unidad_medida, precio_actual, precio_propuesto, " +
          "descuentos_actuales, descuentos_propuestos, costo_neto_actual, costo_neto_propuesto, " +
          "variacion_pct, fecha_activacion, estado, motivo_rechazo, creado_at, resuelto_at",
      )
      .eq("cuenta_id", req.cuenta.id)
      .order("creado_at", { ascending: false })
      .limit(200);

    if (error) throw new Error(error.message);
    res.json({ solicitudes: data ?? [] });
  } catch (e) {
    next(e);
  }
}
