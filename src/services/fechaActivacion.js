/* =============================================================================
   Fecha de activación vencida — la regla que destraba la aprobación

   Al CREAR, la fecha tiene que ser futura (solicitud.service, regla de compras).
   Pero una línea puede quedar esperando aprobación hasta que esa fecha pase, y
   al aprobarla `armarPayload` la frena por retroactiva —con razón: re-preciaría
   mercadería ya recibida—.

   Antes de esto, el frenazo pasaba DESPUÉS del candado: la línea quedaba
   `fallida` con un error técnico ("Pasá permitirRetroactiva:true…"), "Reintentar"
   la devolvía a pendiente, y volver a aprobar fallaba otra vez. Para siempre: la
   fecha no se corrige sola. 10 líneas quedaron así (17/09 aprobadas el 22/09).

   Ahora se frena ANTES, con un 409 que dice qué hacer, y la línea sigue
   `pendiente` para que el admin la rechace. El rechazo es manual a propósito
   (Johan, 2026-10-19): rechazar avisa al proveedor, y eso lo decide compras.

   El corte es el MISMO que el de `armarPayload` (fecha < hoy): hoy todavía
   entra. Si el corte cambia allá, cambia acá. Gemelo del front: `esPasada()` en
   utils/fechas.js.
   ============================================================================= */

import { hoyEnColombia } from "./normalizarCotizacion.js";

/** ¿La fecha de activación de esta línea ya pasó? Comparación de strings ISO. */
export const fechaVencida = (linea, hoy = hoyEnColombia()) =>
  Boolean(linea?.fecha_activacion) && String(linea.fecha_activacion).slice(0, 10) < hoy;

/** `2026-09-17` → `17/09/2026`. */
const dma = (iso) => String(iso).slice(0, 10).split("-").reverse().join("/");

/**
 * El mensaje del 409, o `null` si ninguna línea venció.
 *
 * Nombra los productos: el admin puede estar aprobando un paquete de veinte y
 * tiene que saber cuáles sacar.
 */
export function mensajeVencidas(lineas, hoy = hoyEnColombia()) {
  const vencidas = lineas.filter((l) => fechaVencida(l, hoy));
  if (!vencidas.length) return null;

  const nombres = vencidas
    .slice(0, 5)
    .map((l) => `"${l.descripcion_item ?? `ítem ${l.item}`}" (${dma(l.fecha_activacion)})`)
    .join(", ");
  const resto = vencidas.length > 5 ? ` y ${vencidas.length - 5} más` : "";
  const una = vencidas.length === 1;

  return {
    ids: vencidas.map((l) => l.id),
    mensaje:
      `${una ? "La fecha de activación ya pasó" : "Las fechas de activación ya pasaron"}: ` +
      `${nombres}${resto}. SIESA no acepta precios con fecha pasada. ` +
      `${una ? "Rechace esa línea" : "Rechace esas líneas"} para que el proveedor proponga ` +
      `otra fecha${vencidas.length < lineas.length ? ", y apruebe el resto por separado" : ""}.`,
  };
}
