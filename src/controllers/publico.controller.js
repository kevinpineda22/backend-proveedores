import { supabase } from "../config/supabase.js";

/**
 * Sucursales de un NIT, para el segundo paso del login.
 *
 * ESTA RESPUESTA ES PÚBLICA. Cada campo que se agregue acá se publica en
 * internet. Hoy salen dos: `sucursal` y `nombre`. Nada más.
 *
 * Lo que NO sale, y por qué:
 *   - el correo de notificación → es dato de un tercero;
 *   - el estado de la cuenta    → decir "invitado" vs "activo" revela quién ya
 *                                 tiene portal y quién no, que es media hoja de
 *                                 ruta para un phishing dirigido;
 *   - la razón social            → no hace falta para elegir sucursal.
 *
 * Un NIT que no existe devuelve una lista vacía, igual que un NIT sin sucursales
 * habilitadas. No se distinguen a propósito: un 404 acá sería un oráculo que
 * confirma qué NITs están en el sistema.
 */
export async function sucursalesPorNit(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("pp_cuentas")
      .select("sucursal, nombre_sucursal")
      .eq("nit", req.query.nit)
      .in("estado", ["invitado", "activo"])
      .order("sucursal");

    if (error) throw new Error(error.message);

    res.json({
      sucursales: (data ?? []).map((c) => ({
        sucursal: c.sucursal,
        nombre: c.nombre_sucursal,
      })),
    });
  } catch (e) {
    next(e);
  }
}
