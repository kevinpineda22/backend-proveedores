/* =============================================================================
   ¿La marca de "supera el tope" sigue diciendo la verdad?

   POR QUÉ EXISTE
   El tope se evalúa UNA sola vez: al crear la solicitud, contra el precio que
   regía ese día (`crearSolicitud`). Después queda congelado en la fila
   (`precio_actual`, `variacion_pct`) y NUNCA se recalcula.

   Eso era inofensivo cuando el tope FRENABA. Desde que el tope solo AVISA
   (2026-08-27), la marca en la bandeja es la única defensa automática que
   queda — y una marca calculada contra un precio viejo puede decir "dentro del
   tope" cuando ya no lo está.

   El caso concreto: el proveedor propone $100 cuando el vigente es $99 (+1%,
   dentro de un tope del 2%). El cron refresca el snapshot y el precio real de
   SIESA baja a $90. Esa propuesta ahora es +11%, pero la bandeja sigue
   mostrando +1% porque es lo que se guardó. El admin aprueba tranquilo.

   Este módulo no decide nada: recalcula con el precio de HOY y devuelve las dos
   lecturas para que el admin vea la diferencia. Rechazar automáticamente sigue
   siendo una decisión de negocio abierta (PENDIENTES §2.3).
   ============================================================================= */

import { evaluarPropuesta, excedeTope } from "./costoNeto.js";
import { porcentajesDescuento } from "./normalizarCotizacion.js";

/** Los precios vienen con decimales; comparar `!==` marcaría ruido como cambio. */
const distintos = (a, b, tolerancia = 0.01) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) > tolerancia;
};

/**
 * Recalcula la propuesta contra el precio vigente HOY.
 *
 * @param {object} solicitud  Fila de `pp_solicitudes_precio` (la congelada).
 * @param {object|null} vigenteHoy  Salida de `vigenteDe()`, o `null` si el ítem
 *   ya no está en el catálogo.
 * @returns {{
 *   desactualizado: boolean,     el precio base cambió desde que se propuso
 *   itemSinPrecio: boolean,      el ítem ya no tiene cotización vigente
 *   precioAntes: number,         el que se congeló al proponer
 *   precioHoy: number|null,
 *   variacionAntes: number,
 *   variacionHoy: number|null,
 *   excedeAntes: boolean,
 *   excedeHoy: boolean|null,
 *   empeora: boolean             hoy supera el tope y al proponer NO lo superaba
 * }}
 */
export function revalidarTope(solicitud, vigenteHoy) {
  const topePct = solicitud.porcentaje_max_vigente ?? null;
  const variacionAntes = Number(solicitud.variacion_pct);
  // Con la MISMA función que usa la bandeja para pintar la marca. Reimplementar
  // la comparación acá sería una segunda verdad sobre "¿supera el tope?".
  const excedeAntes = excedeTope(variacionAntes, topePct);

  // Un ítem que desapareció del catálogo no se puede recalcular. NO se hace
  // pasar por "sin cambios": es su propio caso y el admin tiene que verlo.
  if (!vigenteHoy) {
    return {
      desactualizado: false,
      itemSinPrecio: true,
      precioAntes: Number(solicitud.precio_actual),
      precioHoy: null,
      variacionAntes,
      variacionHoy: null,
      excedeAntes,
      excedeHoy: null,
      empeora: false,
    };
  }

  const evaluacion = evaluarPropuesta({
    precioActual: vigenteHoy.precio,
    descuentosActuales: porcentajesDescuento(vigenteHoy),
    precioPropuesto: Number(solicitud.precio_propuesto),
    descuentosPropuestos: (solicitud.descuentos_propuestos ?? []).map((d) => d.porcentaje),
    topePct,
  });

  const excedeHoy = Boolean(evaluacion.excede);

  return {
    desactualizado: distintos(vigenteHoy.precio, solicitud.precio_actual),
    itemSinPrecio: false,
    precioAntes: Number(solicitud.precio_actual),
    precioHoy: Number(vigenteHoy.precio),
    variacionAntes,
    variacionHoy: Number(evaluacion.variacionPct),
    excedeAntes,
    excedeHoy,
    // Lo único que justifica frenar al admin: la marca que está mirando dice
    // "dentro del tope" y la realidad de hoy dice que no.
    empeora: excedeHoy && !excedeAntes,
  };
}
