import { catalogoDe, crearSolicitud, anular, marcarVistas } from "../services/solicitud.service.js";
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

/**
 * Las solicitudes del proveedor, agrupadas en paquetes.
 *
 * Filtra `origen = 'proveedor'`: las líneas replicadas a sucursales hermanas las
 * generó el sistema y el proveedor no sabe que existen. La política de RLS ya lo
 * impide del lado de la base, pero acá se lee con la service key —que pasa por
 * encima de RLS—, así que el filtro tiene que estar escrito igual. Las dos capas
 * dicen lo mismo a propósito: ARQUITECTURA §5.
 */
export async function misSolicitudes(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("pp_solicitud_lineas")
      .select(
        "id, solicitud_id, clave_item, item, descripcion_item, unidad_medida, precio_actual, " +
          "precio_propuesto, descuentos_actuales, descuentos_propuestos, impuestos_vigentes, " +
          "impuestos_propuestos, costo_neto_actual, costo_neto_propuesto, variacion_pct, " +
          // `visto_at` (migración 010) decide si el inicio destaca esta línea.
          // Sin traerlo, el proveedor apagaría un aviso y le volvería a aparecer
          // en la siguiente carga: la marca estaría guardada y nadie la leería.
          "fecha_activacion, estado, motivo_rechazo, creado_at, resuelto_at, visto_at, " +
          "pp_solicitudes!inner(id, cuenta_id, creado_at)",
      )
      .eq("cuenta_destino_id", req.cuenta.id)
      .eq("origen", "proveedor")
      .order("creado_at", { ascending: false })
      .limit(500);

    if (error) throw new Error(error.message);

    /* Se devuelven agrupadas por paquete, no sueltas: el proveedor firmó un
       paquete y lo tiene que ver como lo firmó. Devolver 40 filas planas lo
       obligaría a reconstruir a ojo qué mandó junto. */
    const paquetes = new Map();
    for (const l of data ?? []) {
      const id = l.solicitud_id;
      if (!paquetes.has(id)) {
        paquetes.set(id, { id, creadoAt: l.pp_solicitudes?.creado_at ?? l.creado_at, lineas: [] });
      }
      const { pp_solicitudes, ...linea } = l;
      paquetes.get(id).lineas.push(linea);
    }

    res.json({ solicitudes: [...paquetes.values()] });
  } catch (e) {
    next(e);
  }
}

/** POST /api/proveedor/solicitudes/:id/anular — el proveedor retira su propuesta */
export async function anularSolicitud(req, res, next) {
  try {
    res.json(
      await anular({
        solicitudId: req.params.id,
        // La cuenta sale del JWT (req.cuenta), nunca del body. Es la regla que
        // aísla a un proveedor de otro — ver ARQUITECTURA §5.
        cuenta: req.cuenta,
        userId: req.usuario?.id,
        ip: req.ip,
      }),
    );
  } catch (e) {
    next(e);
  }
}

/**
 * El proveedor apaga avisos de su pantalla de inicio (migración 010).
 *
 * Devuelve cuántos se apagaron, no cuáles fallaron. Un id que no era suyo
 * simplemente no entra en la cuenta: responder "esa línea no es tuya" confirmaría
 * que existe, y eso es exactamente lo que ARQUITECTURA §5 no quiere que se pueda
 * averiguar probando números.
 */
export async function marcarVistasDeLineas(req, res, next) {
  try {
    res.json(await marcarVistas({ lineaIds: req.body.lineaIds, cuenta: req.cuenta }));
  } catch (e) {
    next(e);
  }
}
