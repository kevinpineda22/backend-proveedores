/* =============================================================================
   Avisarle al proveedor cómo terminó su propuesta

   POR QUÉ EXISTE
   El proveedor firma una propuesta de precio y después queda en silencio: hoy se
   entera del resultado solo si se le ocurre volver a entrar al portal. Es la
   mitad que faltaba de un circuito que ya está: el correo de invitación y el de
   recuperación funcionan, y este usa las mismas piezas.

   DOS REGLAS QUE NO SE NEGOCIAN

   1. **Un fallo de correo NUNCA deshace la resolución.** Cuando esto corre, la
      solicitud ya se aprobó (y puede haberse escrito en SIESA) o ya se rechazó.
      Tirar una excepción acá convertiría "el correo no salió" en "la operación
      falló", y el admin reintentaría algo que ya está hecho. Se registra y sigue.

   2. **No se avisa de lo que no se sabe.** Un estado `incierto` significa que
      SIESA aceptó el envío y la relectura no lo confirmó
      (services/verificarCotizacion.js). Decirle al proveedor "su precio quedó
      aplicado" cuando nadie lo comprobó es exactamente la clase de afirmación
      sin verificar que este proyecto viene sacando. Espera a que un humano lo
      resuelva.
   ============================================================================= */

import { enviar } from "./email.service.js";

/* Púrpura corporativo (`--sfc-medium`). En un correo no hay tokens de CSS, así
   que el hex va literal — pero es el MISMO que usa la app. El viejo `#210d65`
   quedó fuera al adoptar el design system. */
const MORADO = "#2d1578";
const MORADO_CLARO = "#cfc6ec";
const GRIS = "#64748b";

const dinero = (v) =>
  `$${Number(v).toLocaleString("es-CO", { maximumFractionDigits: 2 })}`;

/** La fecha viaja como `AAAA-MM-DD`. No pasa por `Date`: ver formatoSiesa.js. */
const fechaLegible = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v ?? "");
};

const encabezado = `
  <div style="background:${MORADO};padding:24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;color:#fff;font-size:20px">Portal de Proveedores</h1>
    <p style="margin:4px 0 0;color:${MORADO_CLARO};font-size:14px">Merkahorro</p>
  </div>`;

const marco = (interior) => `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#1d1d1f">
  ${encabezado}
  <div style="border:1px solid #d9e2ec;border-top:none;border-radius:0 0 8px 8px;padding:24px">
    ${interior}
    <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;line-height:1.6">
      Este es un aviso automático. Para consultas, comuníquese con Merkahorro.
    </p>
  </div>
</div>`;

const identificacion = (solicitud) => `
  <p style="margin:0 0 16px;line-height:1.6">
    <strong>${solicitud.descripcion_item || solicitud.item}</strong><br>
    <span style="color:${GRIS};font-size:14px">
      Ítem ${solicitud.item} &middot; ${solicitud.unidad_medida} &middot;
      activación ${fechaLegible(solicitud.fecha_activacion)}
    </span>
  </p>`;

/* ── Aprobada ─────────────────────────────────────────────────────────────── */

const textoAprobada = (s) =>
  `Su propuesta de precio fue aprobada.

${s.descripcion_item || s.item} (ítem ${s.item}, ${s.unidad_medida})
Precio aprobado: ${dinero(s.precio_propuesto)}
Fecha de activación: ${fechaLegible(s.fecha_activacion)}

El nuevo precio rige a partir de la fecha de activación.

Este es un aviso automático. Para consultas, comuníquese con Merkahorro.`;

const htmlAprobada = (s) =>
  marco(`
    <p style="margin:0 0 16px;line-height:1.6;font-size:16px">
      <strong style="color:#166534">Su propuesta de precio fue aprobada.</strong>
    </p>
    ${identificacion(s)}
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px">
      <tr>
        <td style="padding:8px 0;color:${GRIS}">Precio aprobado</td>
        <td style="padding:8px 0;text-align:right"><strong>${dinero(s.precio_propuesto)}</strong></td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:${GRIS};border-top:1px solid #e5e7eb">Rige desde</td>
        <td style="padding:8px 0;text-align:right;border-top:1px solid #e5e7eb">
          ${fechaLegible(s.fecha_activacion)}
        </td>
      </tr>
    </table>`);

/* ── Rechazada ────────────────────────────────────────────────────────────── */

const textoRechazada = (s) =>
  `Su propuesta de precio fue rechazada.

${s.descripcion_item || s.item} (ítem ${s.item}, ${s.unidad_medida})
Precio propuesto: ${dinero(s.precio_propuesto)}

Motivo: ${s.motivo_rechazo || "(sin motivo registrado)"}

Puede enviar una nueva propuesta desde el portal.

Este es un aviso automático. Para consultas, comuníquese con Merkahorro.`;

const htmlRechazada = (s) =>
  marco(`
    <p style="margin:0 0 16px;line-height:1.6;font-size:16px">
      <strong>Su propuesta de precio fue rechazada.</strong>
    </p>
    ${identificacion(s)}
    <p style="margin:0 0 8px;color:${GRIS};font-size:14px">
      Precio propuesto: ${dinero(s.precio_propuesto)}
    </p>
    <div style="margin:16px 0;padding:12px 14px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px">
      <p style="margin:0;line-height:1.6;font-size:14px;color:#92400e">
        <strong>Motivo:</strong> ${s.motivo_rechazo || "(sin motivo registrado)"}
      </p>
    </div>
    <p style="margin:0;line-height:1.6;font-size:14px">
      Puede enviar una nueva propuesta desde el portal.
    </p>`);

/* ── Envío ────────────────────────────────────────────────────────────────── */

/** Los únicos desenlaces que se avisan. Ver la regla 2 del encabezado. */
export const ESTADOS_NOTIFICABLES = new Set(["aplicada", "rechazada"]);

/**
 * Avisa al proveedor cómo terminó su propuesta.
 *
 * NO LANZA NUNCA. Devuelve qué pasó, para que el llamador lo registre.
 *
 * @param {object} args
 * @param {object} args.solicitud  Fila de `pp_solicitudes_precio`.
 * @param {string} args.correo     `pp_cuentas.correo_notificacion`.
 * @param {string} args.estado     Estado FINAL de la solicitud.
 * @returns {Promise<{enviado: boolean, motivo?: string}>}
 */
export async function notificarResolucion({ solicitud, correo, estado }) {
  try {
    if (!ESTADOS_NOTIFICABLES.has(estado)) {
      return { enviado: false, motivo: `estado "${estado}" no se notifica` };
    }
    // Una cuenta sin correo no es un error: se invita por NIT y el correo se
    // asocia después. Simplemente no hay a dónde escribir.
    if (!correo) return { enviado: false, motivo: "la cuenta no tiene correo" };

    const aprobada = estado === "aplicada";
    return await enviar({
      para: correo,
      asunto: aprobada
        ? `Propuesta aprobada — ítem ${solicitud.item}`
        : `Propuesta rechazada — ítem ${solicitud.item}`,
      texto: aprobada ? textoAprobada(solicitud) : textoRechazada(solicitud),
      html: aprobada ? htmlAprobada(solicitud) : htmlRechazada(solicitud),
    });
  } catch (e) {
    // La regla 1: esto corre DESPUÉS de resolver la solicitud. Que el aviso
    // falle no puede convertirse en "la aprobación falló".
    console.error(`[notificacion] falló el aviso de la solicitud ${solicitud?.id}:`, e?.message);
    return { enviado: false, motivo: e?.message || "error inesperado" };
  }
}
