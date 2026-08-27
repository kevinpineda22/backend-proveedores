/* =============================================================================
   Envío de correo

   Acepta las variables con prefijo SMTP_* y con prefijo EMAIL_*. Las dos formas
   conviven en los backends de Merkahorro (backend-traslado usa EMAIL_HOST) y no
   vale la pena obligar a renombrar un .env que ya funciona.
   ============================================================================= */

import nodemailer from "nodemailer";
import "dotenv/config";

const cfg = {
  host: () => process.env.SMTP_HOST || process.env.EMAIL_HOST || "smtp.office365.com",
  port: () => Number(process.env.SMTP_PORT || process.env.EMAIL_PORT) || 587,
  secure: () =>
    String(process.env.SMTP_SECURE || process.env.EMAIL_SECURE || "").toLowerCase() === "true",
  user: () => process.env.EMAIL_USER || process.env.SMTP_USER,
  pass: () => process.env.EMAIL_PASS || process.env.SMTP_PASS,
  remitente: () => process.env.EMAIL_REMITENTE || process.env.EMAIL_USER,
};

/**
 * Modo de prueba: en vez de mandar, escribe el correo en el log.
 *
 * Sirve para probar el flujo completo de invitación sin llenarle la casilla a un
 * proveedor real con correos de prueba. Con `PROVEEDORES_MAIL_PRUEBA=true`, el
 * enlace de activación queda en la consola y se puede pegar en el navegador.
 */
export const modoPrueba = () =>
  String(process.env.PROVEEDORES_MAIL_PRUEBA || "").toLowerCase() === "true";

export const configurado = () => Boolean(cfg.user() && cfg.pass());

let transporte = null;
const obtenerTransporte = () => {
  if (!transporte) {
    transporte = nodemailer.createTransport({
      host: cfg.host(),
      port: cfg.port(),
      secure: cfg.secure(), // false para 587 (STARTTLS)
      auth: { user: cfg.user(), pass: cfg.pass() },
    });
  }
  return transporte;
};

/**
 * Manda un correo.
 *
 * @returns {Promise<{enviado: boolean, motivo?: string}>}
 *
 * NO LANZA si el correo falla, y eso es deliberado. En el flujo de invitación, la
 * cuenta y el token YA se crearon cuando se llega acá. Si un fallo de SMTP tirara
 * una excepción, el endpoint devolvería 500 y el admin creería que no pasó nada —
 * cuando en realidad la invitación existe y el token está quemándose solo. Es
 * mejor responder "cuenta creada, el correo no salió" y ofrecer reenviar.
 */
export async function enviar({ para, asunto, html, texto }) {
  if (modoPrueba()) {
    console.warn(
      `[email] 🧪 MODO PRUEBA — no se envió a ${para}\n` +
        `        Asunto: ${asunto}\n` +
        `        ${texto || html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500)}`,
    );
    return { enviado: false, motivo: "modo prueba" };
  }

  if (!configurado()) {
    console.warn("[email] faltan EMAIL_USER / EMAIL_PASS — el correo no se envió.");
    return { enviado: false, motivo: "SMTP sin configurar" };
  }

  try {
    await obtenerTransporte().sendMail({
      from: `"Portal de Proveedores Merkahorro" <${cfg.remitente()}>`,
      to: para,
      subject: asunto,
      html,
      text: texto,
    });
    return { enviado: true };
  } catch (e) {
    console.error(`[email] falló el envío a ${para}:`, e?.message);
    return { enviado: false, motivo: e?.message || "error de envío" };
  }
}
