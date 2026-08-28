/* =============================================================================
   Autenticación y aislamiento entre proveedores

   LA REGLA QUE NO SE NEGOCIA (docs/ARQUITECTURA.md §5):

     El `cuenta_id` de cualquier operación sale SIEMPRE del JWT.
     Nunca del body, nunca del query string, nunca de un header del cliente.

   Es la única regla que, si se rompe, convierte esto en una fuga de datos entre
   competidores. Un proveedor viendo los precios de otro no es un bug menor.

   Este archivo es la primera de tres capas. Las otras dos son RLS (sql/001) y la
   separación de routers (`/api/proveedor/*` vs `/api/admin/*`). Van tres porque
   una sola falla.
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { createError } from "./errorHandler.js";

/* ── Piezas puras (testeables sin Express ni Supabase) ───────────────────── */

/**
 * Extrae el token del header `Authorization`.
 *
 * Estricto a propósito: un header raro es un cliente mal escrito o alguien
 * probando. Devuelve `null` en vez de adivinar — adivinar acá es abrir la puerta.
 */
export function tokenDelHeader(header) {
  if (typeof header !== "string") return null;
  const m = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** Nombres con los que un cliente podría intentar imponer una cuenta. */
const CLAVES_CUENTA = ["cuenta_id", "cuentaId", "cuenta"];

/**
 * ¿El request trae un `cuenta_id` distinto del que dice el JWT?
 *
 * Si lo trae IGUAL, pasa: hay clientes que reenvían lo que recibieron y no tiene
 * sentido romperlos. Si lo trae DISTINTO, es un intento de operar sobre otra
 * cuenta, y la respuesta correcta es un 403 con registro de auditoría —
 * **no** un filtro silencioso que devuelve una lista vacía.
 *
 * La diferencia importa: filtrar en silencio hace que el intento se vea igual que
 * "no hay datos", y entonces nadie se entera de que alguien está probando.
 *
 * @returns {{clave: string, valor: unknown} | null} La clave infractora, si la hay.
 */
export function detectarSuplantacion(fuentes, cuentaId) {
  for (const fuente of fuentes) {
    if (!fuente || typeof fuente !== "object") continue;
    for (const clave of CLAVES_CUENTA) {
      if (!Object.hasOwn(fuente, clave)) continue;
      const valor = fuente[clave];
      if (valor == null || valor === "") continue;
      if (String(valor) !== String(cuentaId)) return { clave, valor };
    }
  }
  return null;
}

/** Mensaje por estado de cuenta. `null` = la cuenta puede operar. */
export function motivoDeBloqueo(cuenta) {
  if (!cuenta) return "Su usuario no tiene una cuenta de proveedor asociada.";
  switch (cuenta.estado) {
    case "activo":
      return null;
    case "suspendido":
      return "Su cuenta está suspendida. Comuníquese con Merkahorro.";
    case "invitado":
      return "Su cuenta todavía no está activada. Use el enlace de invitación que recibió por correo.";
    case "sin_invitar":
      return "Su cuenta todavía no fue habilitada.";
    default:
      return "Su cuenta no está habilitada para ingresar.";
  }
}

/* ── Registro de intentos ────────────────────────────────────────────────── */

/**
 * Deja rastro de un intento de operar sobre otra cuenta.
 *
 * Nunca lanza: si la auditoría falla, el 403 tiene que salir igual. Un error
 * escribiendo el log no puede convertirse en un 500 que deje pasar la duda de si
 * el acceso se concedió.
 */
async function registrarSuplantacion({ userId, cuentaId, intento, req }) {
  try {
    await supabase.from("pp_auditoria").insert({
      entidad: "pp_cuentas",
      entidad_id: String(cuentaId),
      accion: "suplantacion_bloqueada",
      actor_user_id: userId,
      actor_rol: "pp_proveedor",
      detalle: {
        clave: intento.clave,
        valor_recibido: String(intento.valor).slice(0, 100),
        ruta: `${req.method} ${req.originalUrl}`,
      },
      ip: req.ip,
    });
  } catch (e) {
    console.error("[auth] no se pudo registrar el intento de suplantación:", e?.message);
  }
}

/* ── Middlewares ─────────────────────────────────────────────────────────── */

/** Valida el JWT contra Supabase y deja `req.usuario`. */
async function autenticar(req) {
  const token = tokenDelHeader(req.headers?.authorization);
  if (!token) throw createError(401, "Falta el token de autenticación");

  // `getUser(token)` verifica la firma y la expiración del lado del servidor.
  // Decodificar el JWT nosotros y confiar en el payload sería confiar en un
  // string que mandó el cliente: cualquiera puede escribir un `sub` a mano.
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw createError(401, "Sesión inválida o vencida");

  return data.user;
}

/**
 * Superficie del PROVEEDOR. Deja en `req.cuenta` la cuenta derivada del JWT.
 *
 * De acá para adentro, ningún controlador vuelve a preguntarse de quién son los
 * datos: usa `req.cuenta.id` y punto.
 */
export async function requiereProveedor(req, res, next) {
  try {
    const usuario = await autenticar(req);

    const { data: cuenta, error } = await supabase
      .from("pp_cuentas")
      .select("id, nit, sucursal, nombre_sucursal, estado, pp_proveedores(id_tercero, razon_social, porcentaje_max, bloqueado)")
      .eq("user_id", usuario.id)
      .maybeSingle();

    if (error) throw createError(500, "No se pudo resolver la cuenta del proveedor");

    const motivo = motivoDeBloqueo(cuenta);
    if (motivo) throw createError(403, motivo);

    const intento = detectarSuplantacion([req.body, req.query, req.params], cuenta.id);
    if (intento) {
      await registrarSuplantacion({ userId: usuario.id, cuentaId: cuenta.id, intento, req });
      throw createError(403, "La operación no corresponde a su cuenta");
    }

    const proveedor = cuenta.pp_proveedores || {};
    req.usuario = usuario;
    req.cuenta = {
      id: cuenta.id,
      nit: cuenta.nit,
      sucursal: cuenta.sucursal,
      nombreSucursal: cuenta.nombre_sucursal,
      idTercero: proveedor.id_tercero,
      razonSocial: proveedor.razon_social,
      // El tope viaja para que el servicio lo aplique. NO se serializa al cliente
      // salvo dentro del 422 que lo choca: ahí sí, con el número exacto, porque
      // es el momento en que el proveedor necesita saber a qué atenerse.
      porcentajeMax: proveedor.porcentaje_max,
      bloqueado: Boolean(proveedor.bloqueado),
    };

    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Exige que el proveedor pueda PROPONER, no solo mirar.
 *
 * `bloqueado` no cierra la sesión: el proveedor sigue viendo su catálogo y sus
 * solicitudes anteriores. Solo se le corta proponer cambios. Un bloqueo que
 * además esconde la información deja al proveedor sin poder ni entender por qué
 * lo llamaron — y a Merkahorro sin nada que mostrarle en la llamada.
 */
export function puedeProponer(req, res, next) {
  if (req.cuenta?.bloqueado) {
    return next(
      createError(
        403,
        "Su cuenta tiene los cambios de precio bloqueados. Comuníquese con Merkahorro.",
      ),
    );
  }
  next();
}

/**
 * Superficie del ADMIN del portal. Router aparte, middleware aparte.
 *
 * LA AUTORIDAD ES `pp_admins`, NO `profiles.role`.
 *
 * `profiles.role` es una sola columna: exigir `role = 'pp_admin'` obligaría a
 * cada administrador a RENUNCIAR al rol que ya tiene en la app. La propia
 * app ya chocó con eso —de ahí `profiles.ecommerce_rol`, una segunda columna de
 * rol agregada para un módulo— y agregar una tercera no arregla el problema, lo
 * repite.
 *
 * Una tabla propia hace que ser admin del portal sea ADITIVO: se suma a lo que la
 * persona ya era, y agregar o quitar un admin no toca `profiles` ni afecta a
 * nadie más. Ver sql/003_admins.sql.
 *
 * Y hay una razón de fondo: aprobar un cambio de precio ESCRIBE EN SIESA. Ese
 * permiso merece una lista explícita de personas, no depender de un string que se
 * cambia por otros motivos.
 */
export const esAdminActivo = (fila) => Boolean(fila?.activo);

export async function requiereAdmin(req, res, next) {
  try {
    const usuario = await autenticar(req);

    const { data: admin, error } = await supabase
      .from("pp_admins")
      .select("user_id, nombre, correo, activo")
      .eq("user_id", usuario.id)
      .maybeSingle();

    if (error) throw createError(500, "No se pudo verificar los permisos");

    // Se compara contra `activo`, no contra la existencia de la fila: un admin
    // dado de baja conserva su fila para que la auditoría de qué aprobó siga
    // apuntando a alguien.
    if (!esAdminActivo(admin)) {
      throw createError(403, "No tiene permisos de administrador del Portal de Proveedores");
    }

    req.usuario = usuario;
    req.admin = {
      userId: usuario.id,
      nombre: admin.nombre || admin.correo || usuario.email,
    };
    next();
  } catch (e) {
    next(e);
  }
}
