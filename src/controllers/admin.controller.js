import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import {
  aprobarLineas,
  rechazarLineas,
  reintentar,
  vigenteDe,
  cambianImpuestos,
} from "../services/solicitud.service.js";
import { excedeTope } from "../services/costoNeto.js";
import { revalidarTope } from "../services/revalidarTope.js";

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

/**
 * Bandeja de novedades: lo que espera respuesta primero.
 *
 * Devuelve LÍNEAS agrupadas por paquete. El admin resuelve por línea —aprobar
 * tres y rechazar una es normal— pero tiene que ver de qué paquete salen: el
 * proveedor las mandó juntas y las firmó juntas.
 *
 * ⚠️ ACÁ SÍ SE VEN LAS RÉPLICAS. El proveedor no sabe que su propuesta también
 * va a la sucursal hermana —es un reparto interno de Merkahorro—, pero compras
 * tiene que verlo: es su decisión y su plata. Medido el 2026-09-06, de 521
 * renglones comparados entre hermanas, 16 ya tienen precio distinto hoy. Una
 * réplica que nadie mira pisa esas diferencias en silencio.
 */
export async function bandeja(req, res, next) {
  try {
    const estado = req.query.estado || "pendiente";
    const { data, error } = await supabase
      .from("pp_solicitud_lineas")
      .select(
        "id, solicitud_id, cuenta_destino_id, origen, replica_de_id, clave_item, item, " +
          "descripcion_item, unidad_medida, precio_actual, precio_propuesto, " +
          "descuentos_actuales, descuentos_propuestos, impuestos_vigentes, impuestos_propuestos, " +
          "costo_neto_actual, costo_neto_propuesto, variacion_pct, porcentaje_max_vigente, " +
          "fecha_activacion, notas, estado, motivo_rechazo, creado_at, resuelto_at, " +
          "pp_solicitudes!inner(id, cuenta_id, firma_id, creado_at), " +
          "pp_cuentas!pp_solicitud_lineas_cuenta_destino_id_fkey(nit, sucursal, nombre_sucursal, pp_proveedores(razon_social))",
      )
      .eq("estado", estado)
      .order("creado_at", { ascending: true })
      .limit(1000);

    if (error) throw new Error(error.message);

    // El tope ya no frena al proveedor: marca la fila para el admin. Se deriva
    // acá, con la MISMA función que usó la creación, en vez de guardarse en una
    // columna — así no hay dos verdades sobre la misma fila ni migración que
    // correr, y `porcentaje_max_vigente` ya viaja congelado en cada solicitud.
    //
    // Y se REVALIDA contra el precio de hoy: `variacion_pct` se congeló el día
    // de la propuesta, así que la marca puede estar diciendo "dentro del tope"
    // sobre una base que SIESA ya movió. Ver services/revalidarTope.js.
    //
    // Solo para las PENDIENTES: son las que el admin puede aprobar, y son pocas.
    // Revalidar el histórico sería releer el catálogo para nada.
    const filas = data ?? [];
    const revalidar = estado === "pendiente";

    const lineas = await Promise.all(
      filas.map(async (s) => {
        const base = {
          ...s,
          excede_tope: excedeTope(s.variacion_pct, s.porcentaje_max_vigente),
          /* Un cambio de impuestos NO pasa por el tope: un ICO lo fija la ley, no
             la negociación, y meterlo en el porcentaje lo aflojaría. El único
             control que queda es que una persona lo mire, así que la fila tiene
             que decirlo sola. */
          cambia_impuestos: cambianImpuestos(s.impuestos_vigentes, s.impuestos_propuestos),
        };
        if (!revalidar) return base;

        const cuenta = s.pp_cuentas;
        if (!cuenta?.nit || !cuenta?.sucursal) return base;

        try {
          const hoy = await vigenteDe(cuenta, s.clave_item);
          return { ...base, revalidacion: revalidarTope(s, hoy) };
        } catch (e) {
          // Un fallo al releer NO puede tumbar la bandeja: sin ella el admin no
          // puede operar nada. Se degrada a la marca congelada y se deja rastro.
          console.warn(`[bandeja] no se pudo revalidar la línea ${s.id}: ${e.message}`);
          return base;
        }
      }),
    );

    /* Agrupadas por paquete. El resumen de arriba es para PRIORIZAR —cuántas
       líneas, cuántas se pasan del tope, cuántas tocan impuestos—; lo que se
       aprueba sigue siendo la línea. */
    const paquetes = new Map();
    for (const l of lineas) {
      const id = l.solicitud_id;
      if (!paquetes.has(id)) {
        paquetes.set(id, {
          id,
          cuentaId: l.pp_solicitudes?.cuenta_id,
          firmaId: l.pp_solicitudes?.firma_id,
          creadoAt: l.pp_solicitudes?.creado_at ?? l.creado_at,
          proveedor: l.pp_cuentas?.pp_proveedores?.razon_social ?? null,
          lineas: [],
        });
      }
      paquetes.get(id).lineas.push(l);
    }

    const solicitudes = [...paquetes.values()].map((p) => ({
      ...p,
      resumen: {
        lineas: p.lineas.length,
        replicadas: p.lineas.filter((l) => l.origen === "replica").length,
        excedenTope: p.lineas.filter((l) => l.excede_tope).length,
        cambianImpuestos: p.lineas.filter((l) => l.cambia_impuestos).length,
      },
    }));

    res.json({ solicitudes });
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

/**
 * POST /api/admin/solicitudes/lineas/aprobar
 *
 * Recibe `lineaIds`, no un id de solicitud. Aprobar "todo el paquete" es mandar
 * todas sus líneas; aprobar una es mandar una. Que la API no distinga los dos
 * casos es lo que hace que la pantalla pueda ser flexible sin lógica de más.
 */
export async function aprobarSolicitud(req, res, next) {
  try {
    res.json(
      await aprobarLineas({
        lineaIds: req.body.lineaIds,
        admin: req.admin,
        ip: req.ip,
        // El admin ya vio el aviso de precio desactualizado y decidió seguir.
        // Viaja en el body y no en la query: es una decisión, no un filtro.
        confirmaDesactualizado: req.body?.confirmaDesactualizado === true,
      }),
    );
  } catch (e) {
    next(e);
  }
}

export async function rechazarSolicitud(req, res, next) {
  try {
    res.json(
      await rechazarLineas({
        lineaIds: req.body.lineaIds,
        motivo: req.body.motivo,
        admin: req.admin,
        ip: req.ip,
      }),
    );
  } catch (e) {
    next(e);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   ADMINISTRADORES DEL PORTAL — `pp_admins`

   Hasta hoy esta tabla se manejaba con SQL a mano: para que Merkahorro sumara a
   alguien había que pasar por desarrollo. Estos tres endpoints cierran eso.

   TRES REGLAS QUE NO SE NEGOCIAN

   1. NUNCA SE BORRA. Solo se desactiva. `pp_auditoria` guarda quién aprobó cada
      cambio de precio apuntando a estas filas: borrar una deja la auditoría
      señalando a un usuario que no existe, y esa auditoría es justamente lo que
      no puede perderse. Por eso no hay DELETE acá, y no es un olvido.

   2. NUNCA CERO ADMINS ACTIVOS. Si el último admin se desactiva, nadie puede
      aprobar precios NI volver a agregar un admin — se sale de eso con SQL a
      mano contra producción. Se valida antes de escribir.

   3. EL ADMIN TIENE QUE SER UN EMPLEADO. Se resuelve el correo contra
      `profiles`, no contra `auth.users`: un proveedor también vive en
      `auth.users` (con su email sintético), y darle permiso de aprobar precios
      a un proveedor sería catastrófico. `profiles` solo tiene gente de
      Merkahorro, así que la tabla misma es la validación.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ¿Este cambio dejaría el portal sin ningún administrador activo?
 *
 * Función pura y exportada para poder probarla: es la guarda que evita el único
 * error irreversible desde la pantalla. Sin admins activos nadie puede aprobar
 * precios NI volver a agregar un admin — se sale de eso con SQL a mano contra
 * producción, de noche, con alguien esperando.
 *
 * Mira el CONTEO, no "¿es usted mismo?": con dos admins, que uno se desactive
 * está perfecto. Con uno solo, da igual quién sea.
 *
 * @param {boolean} activoNuevo     El estado al que se quiere pasar.
 * @param {number}  activosActuales Cuántos hay activos ahora.
 */
export const dejariaSinAdmins = (activoNuevo, activosActuales) =>
  activoNuevo === false && Number(activosActuales) <= 1;

/** Cuántos admins activos quedan. Se usa para no dejar la puerta sin llave. */
async function contarActivos() {
  const { count, error } = await supabase
    .from("pp_admins")
    .select("user_id", { count: "exact", head: true })
    .eq("activo", true);

  if (error) throw new Error(`No se pudo contar los administradores: ${error.message}`);
  return count ?? 0;
}

/** GET /api/admin/admins — activos e inactivos, para poder reactivar. */
export async function listarAdmins(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("pp_admins")
      .select("user_id, nombre, correo, activo, creado_por, created_at")
      .order("activo", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);

    // Se devuelven también los inactivos: la pantalla tiene que poder
    // reactivar a alguien que volvió, y esconder la fila haría pensar que no
    // existe — y el intento de agregarlo de nuevo chocaría contra la PK.
    res.json({
      admins: (data ?? []).map((a) => ({ ...a, esUsted: a.user_id === req.admin.userId })),
      activos: (data ?? []).filter((a) => a.activo).length,
    });
  } catch (e) {
    next(e);
  }
}

/** POST /api/admin/admins — alta o reactivación, por correo. */
export async function agregarAdmin(req, res, next) {
  try {
    const correo = req.body.correo.trim().toLowerCase();

    // La persona tiene que existir en `profiles`: es lo que separa a un empleado
    // de Merkahorro de un proveedor externo. Ver la regla 3 de arriba.
    const { data: perfil, error: errPerfil } = await supabase
      .from("profiles")
      .select("user_id, nombre, correo")
      .ilike("correo", correo)
      .maybeSingle();

    if (errPerfil) throw new Error(`No se pudo buscar el usuario: ${errPerfil.message}`);

    if (!perfil) {
      throw createError(
        404,
        `No hay ningún usuario de Merkahorro con el correo ${correo}. ` +
          `La persona tiene que tener cuenta en la aplicación antes de ser administrador del portal.`,
      );
    }

    const { data: previo } = await supabase
      .from("pp_admins")
      .select("activo")
      .eq("user_id", perfil.user_id)
      .maybeSingle();

    if (previo?.activo) {
      throw createError(409, `${perfil.nombre || correo} ya es administrador del portal.`);
    }

    // `upsert` y no `insert`: si la fila existe desactivada, esto la reactiva.
    // Es el mismo acto desde la pantalla —"agregar a esta persona"— y pedirle al
    // admin que distinga entre alta y reactivación sería un detalle nuestro.
    const { error } = await supabase.from("pp_admins").upsert(
      {
        user_id: perfil.user_id,
        correo: perfil.correo ?? correo,
        nombre: perfil.nombre ?? correo,
        activo: true,
        creado_por: req.admin.userId,
      },
      { onConflict: "user_id" },
    );

    if (error) throw new Error(error.message);

    await supabase.from("pp_auditoria").insert({
      entidad: "pp_admins",
      entidad_id: perfil.user_id,
      accion: previo ? "reactivar" : "agregar",
      estado_anterior: previo ? "inactivo" : null,
      estado_nuevo: "activo",
      actor_user_id: req.admin.userId,
      actor_rol: "pp_admin",
      detalle: { correo: perfil.correo ?? correo, nombre: perfil.nombre },
      ip: req.ip,
    });

    res.status(previo ? 200 : 201).json({
      ok: true,
      userId: perfil.user_id,
      nombre: perfil.nombre,
      correo: perfil.correo ?? correo,
      reactivado: Boolean(previo),
    });
  } catch (e) {
    next(e);
  }
}

/** PATCH /api/admin/admins/:userId — activar o desactivar. Nunca borrar. */
export async function cambiarEstadoAdmin(req, res, next) {
  try {
    const { activo } = req.body;
    const userId = req.params.userId;

    const { data: fila, error: errLeer } = await supabase
      .from("pp_admins")
      .select("user_id, nombre, correo, activo")
      .eq("user_id", userId)
      .maybeSingle();

    if (errLeer) throw new Error(errLeer.message);
    if (!fila) throw createError(404, "Ese administrador no existe");

    if (fila.activo === activo) {
      return res.json({ ok: true, userId, activo, sinCambios: true });
    }

    // La guarda que evita quedarse afuera del propio portal. Ver dejariaSinAdmins().
    if (dejariaSinAdmins(activo, await contarActivos())) {
      throw createError(
        409,
        "No se puede desactivar al único administrador activo. " +
          "Agregue otro administrador antes de desactivar este.",
      );
    }

    const { error } = await supabase.from("pp_admins").update({ activo }).eq("user_id", userId);
    if (error) throw new Error(error.message);

    await supabase.from("pp_auditoria").insert({
      entidad: "pp_admins",
      entidad_id: userId,
      accion: activo ? "reactivar" : "desactivar",
      estado_anterior: fila.activo ? "activo" : "inactivo",
      estado_nuevo: activo ? "activo" : "inactivo",
      actor_user_id: req.admin.userId,
      actor_rol: "pp_admin",
      detalle: { nombre: fila.nombre, correo: fila.correo, seDesactivoASiMismo: userId === req.admin.userId },
      ip: req.ip,
    });

    res.json({ ok: true, userId, activo, nombre: fila.nombre });
  } catch (e) {
    next(e);
  }
}

/** Devuelve una solicitud con problema a la cola de pendientes. */
export async function reintentarSolicitud(req, res, next) {
  try {
    res.json(await reintentar({ lineaIds: req.body.lineaIds, admin: req.admin, ip: req.ip }));
  } catch (e) {
    next(e);
  }
}
