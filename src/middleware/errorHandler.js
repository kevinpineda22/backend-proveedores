/* =============================================================================
   Errores de la API
   ============================================================================= */

export class ApiError extends Error {
  constructor(status, mensaje, detalle) {
    super(mensaje);
    this.name = "ApiError";
    this.status = status;
    this.detalle = detalle;
  }
}

export const createError = (status, mensaje, detalle) => new ApiError(status, mensaje, detalle);

/**
 * Manejador final.
 *
 * Un 5xx NO devuelve el mensaje interno: los errores de Supabase y de axios
 * arrastran nombres de tabla, columnas y a veces fragmentos de la consulta. Eso
 * es un mapa del esquema servido a cualquiera que provoque una excepción. Los
 * 4xx sí llevan mensaje, porque son culpa del request y el cliente necesita
 * saber qué corregir.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    return res.status(status).json({ error: "Error interno del servidor" });
  }

  return res.status(status).json({
    error: err.message || "Solicitud inválida",
    ...(err.detalle ? { detalle: err.detalle } : {}),
  });
}
