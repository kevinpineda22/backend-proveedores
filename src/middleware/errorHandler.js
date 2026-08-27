/* =============================================================================
   Errores de la API
   ============================================================================= */

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} mensaje
   * @param {unknown} [detalle]
   * @param {boolean} [expuesto]  Ver `errorHandler`.
   */
  constructor(status, mensaje, detalle, expuesto = false) {
    super(mensaje);
    this.name = "ApiError";
    this.status = status;
    this.detalle = detalle;
    this.expuesto = expuesto;
  }
}

export const createError = (status, mensaje, detalle) => new ApiError(status, mensaje, detalle);

/**
 * Error de 5xx cuyo mensaje SÍ tiene que llegar al usuario.
 *
 * Existe por un caso concreto que se descubrió en producción: cuando SIESA
 * rechaza una cotización, la API responde 502 y el admin veía "Error interno del
 * servidor". El mensaje del ERP —"el campo X no se está enviando en la sección
 * Y"— es EXACTAMENTE lo que necesita para saber qué pasó, y era justo el que se
 * enmascaraba.
 *
 * La regla del enmascarado sigue siendo correcta por defecto: los errores de
 * Supabase y de axios arrastran nombres de tabla, columnas y fragmentos de
 * consulta. Lo que faltaba era poder decir "este mensaje lo escribí yo, es para
 * que lo lean, y no contiene nada de adentro".
 */
export const createErrorExpuesto = (status, mensaje, detalle) =>
  new ApiError(status, mensaje, detalle, true);

/**
 * Manejador final.
 *
 * Un 5xx NO devuelve el mensaje interno **salvo que esté marcado como expuesto**:
 * los errores de Supabase y de axios arrastran nombres de tabla, columnas y a
 * veces fragmentos de la consulta, y eso es un mapa del esquema servido a
 * cualquiera que provoque una excepción.
 *
 * Los 4xx sí llevan mensaje, porque son culpa del request y el cliente necesita
 * saber qué corregir.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;

  if (status >= 500) {
    // Al log va SIEMPRE el error completo, expuesto o no.
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);

    if (!err?.expuesto) {
      return res.status(status).json({ error: "Error interno del servidor" });
    }
  }

  return res.status(status).json({
    error: err.message || "Solicitud inválida",
    ...(err.detalle ? { detalle: err.detalle } : {}),
  });
}
