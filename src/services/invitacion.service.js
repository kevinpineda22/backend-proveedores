/* =============================================================================
   Invitaciones — el proveedor define su propia contraseña

   El admin asocia un correo a la cuenta y el proveedor recibe un ENLACE, no una
   clave. Ver docs/ARQUITECTURA.md §3.4.

   POR QUÉ NO SE MANDA LA CONTRASEÑA POR CORREO

   Una clave en texto plano en un buzón queda ahí para siempre: se reenvía, se
   archiva, se sincroniza a tres dispositivos. Si ese buzón se compromete el año
   que viene, el portal de precios se va con él. Un enlace que vence en 72 horas y
   se quema al primer uso, no.
   ============================================================================= */

import crypto from "node:crypto";
import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";
import { emailSintetico } from "./emailSintetico.js";
import { enviar, modoPrueba } from "./email.service.js";

const HORAS_VIGENCIA = Number(process.env.PROVEEDORES_INVITACION_HORAS) || 72;

const URL_PORTAL = () =>
  process.env.PORTAL_PROVEEDORES_URL || "http://localhost:5173/portal-proveedores";

/** El token viaja UNA vez, en el correo. En la base solo vive su hash. */
const hashear = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

/**
 * Crea (o repone) la cuenta de Auth y emite una invitación.
 *
 * @param {object} args
 * @param {number} args.cuentaId
 * @param {string} args.correo   Correo REAL del proveedor, solo para avisos.
 * @param {object} args.admin
 * @returns {Promise<{cuentaId: number, correo: string, expiraAt: string,
 *   correoEnviado: boolean, motivoCorreo?: string, enlacePrueba?: string}>}
 */
export async function invitar({ cuentaId, correo, admin, ip }) {
  const { data: cuenta, error } = await supabase
    .from("pp_cuentas")
    .select("id, nit, sucursal, nombre_sucursal, estado, user_id")
    .eq("id", cuentaId)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer la cuenta: ${error.message}`);
  if (!cuenta) throw createError(404, "La cuenta no existe");

  const identidad = emailSintetico(cuenta.nit, cuenta.sucursal);

  /* 1. El usuario de Auth.
     Se crea con una contraseña aleatoria que NADIE conoce ni va a usar: el
     proveedor define la suya al activar. Poner una clave conocida —aunque sea
     temporal— es exactamente lo que este flujo evita. */
  let userId = cuenta.user_id;

  if (!userId) {
    const { data: creado, error: errCrear } = await supabase.auth.admin.createUser({
      email: identidad,
      password: crypto.randomBytes(32).toString("hex"),
      email_confirm: true, // El email sintético no recibe correo: no hay qué confirmar.
      user_metadata: { portal: "proveedores", nit: cuenta.nit, sucursal: cuenta.sucursal },
    });

    if (errCrear) {
      // Un usuario ya existente en Auth sin `user_id` en nuestra tabla es un
      // estado inconsistente que hay que ver, no absorber en silencio.
      throw createError(
        409,
        `No se pudo crear el usuario de acceso (${identidad}): ${errCrear.message}`,
      );
    }
    userId = creado.user.id;
  }

  /* 2. El token. */
  const token = crypto.randomBytes(32).toString("hex");
  const expiraAt = new Date(Date.now() + HORAS_VIGENCIA * 3600_000).toISOString();

  // Las invitaciones anteriores sin usar se queman. Si el admin reenvía porque el
  // proveedor perdió el correo, el enlace viejo tiene que dejar de servir: si no,
  // cada reenvío deja otra puerta abierta durante 72 horas.
  await supabase
    .from("pp_invitaciones")
    .update({ usado_at: new Date().toISOString() })
    .eq("cuenta_id", cuentaId)
    .is("usado_at", null);

  const { error: errInv } = await supabase.from("pp_invitaciones").insert({
    cuenta_id: cuentaId,
    token_hash: hashear(token),
    expira_at: expiraAt,
    creado_por: admin?.userId ?? null,
  });
  if (errInv) throw new Error(`No se pudo emitir la invitación: ${errInv.message}`);

  /* 3. La cuenta queda 'invitado' — todavía NO puede operar. */
  await supabase
    .from("pp_cuentas")
    .update({ correo_notificacion: correo, user_id: userId, estado: "invitado" })
    .eq("id", cuentaId);

  /* 4. El correo. */
  const enlace = `${URL_PORTAL()}/activar?token=${token}`;
  const envio = await enviar({
    para: correo,
    asunto: "Acceso al Portal de Proveedores de Merkahorro",
    texto: textoInvitacion({ cuenta, enlace }),
    html: htmlInvitacion({ cuenta, enlace }),
  });

  await supabase.from("pp_auditoria").insert({
    entidad: "pp_cuentas",
    entidad_id: String(cuentaId),
    accion: "invitar",
    estado_anterior: cuenta.estado,
    estado_nuevo: "invitado",
    actor_user_id: admin?.userId ?? null,
    actor_rol: "pp_admin",
    // El correo del destinatario SÍ va al log (es a quién se le dio acceso);
    // el token NO — de eso solo existe el hash.
    detalle: { correo, correoEnviado: envio.enviado, motivo: envio.motivo ?? null },
    ip: ip ?? null,
  });

  return {
    cuentaId,
    correo,
    expiraAt,
    correoEnviado: envio.enviado,
    motivoCorreo: envio.motivo,
    // En modo prueba se devuelve el enlace para poder seguir el flujo sin correo.
    // Fuera de modo prueba NUNCA sale de acá: sería un token en una respuesta HTTP.
    ...(modoPrueba() ? { enlacePrueba: enlace } : {}),
  };
}

/**
 * Consume una invitación y fija la contraseña del proveedor.
 *
 * Es un endpoint PÚBLICO: lo llama alguien que todavía no tiene sesión. Por eso
 * cada rechazo devuelve el MISMO mensaje —vencido, ya usado, inexistente— y no
 * dice cuál de los tres fue. Distinguirlos convertiría esto en un oráculo para
 * probar tokens.
 */
export async function activar({ token, clave }) {
  const generico = "El enlace no es válido o ya venció. Solicite uno nuevo al área de compras.";

  if (!token || String(clave ?? "").length < 8) {
    throw createError(422, "La contraseña debe tener al menos 8 caracteres.");
  }

  const { data: inv, error } = await supabase
    .from("pp_invitaciones")
    .select("id, cuenta_id, expira_at, usado_at")
    .eq("token_hash", hashear(token))
    .maybeSingle();

  if (error) throw new Error(`No se pudo verificar la invitación: ${error.message}`);
  if (!inv || inv.usado_at || new Date(inv.expira_at) < new Date()) {
    throw createError(400, generico);
  }

  const { data: cuenta } = await supabase
    .from("pp_cuentas")
    .select("id, user_id, nit, sucursal")
    .eq("id", inv.cuenta_id)
    .maybeSingle();

  if (!cuenta?.user_id) throw createError(400, generico);

  const { error: errClave } = await supabase.auth.admin.updateUserById(cuenta.user_id, {
    password: clave,
  });
  if (errClave) throw new Error(`No se pudo fijar la contraseña: ${errClave.message}`);

  // Quemar el token ANTES de activar la cuenta. Si el orden fuera al revés y algo
  // fallara en el medio, quedaría una cuenta activa con un token todavía vivo.
  await supabase
    .from("pp_invitaciones")
    .update({ usado_at: new Date().toISOString() })
    .eq("id", inv.id);

  await supabase.from("pp_cuentas").update({ estado: "activo" }).eq("id", cuenta.id);

  await supabase.from("pp_auditoria").insert({
    entidad: "pp_cuentas",
    entidad_id: String(cuenta.id),
    accion: "activar",
    estado_anterior: "invitado",
    estado_nuevo: "activo",
    actor_user_id: cuenta.user_id,
    actor_rol: "pp_proveedor",
  });

  return { ok: true, nit: cuenta.nit, sucursal: cuenta.sucursal };
}

/* ── Cuerpo del correo ───────────────────────────────────────────────────── */

const textoInvitacion = ({ cuenta, enlace }) =>
  `Portal de Proveedores de Merkahorro

Se habilitó el acceso para ${cuenta.nombre_sucursal || "su empresa"} (NIT ${cuenta.nit}, sucursal ${cuenta.sucursal}).

Para crear su contraseña, ingrese aquí:
${enlace}

El enlace vence en ${HORAS_VIGENCIA} horas y solo puede usarse una vez.

Después podrá ingresar con su NIT, su sucursal y la contraseña que defina.

Si no esperaba este correo, ignórelo o comuníquese con el área de compras de Merkahorro.`;

const htmlInvitacion = ({ cuenta, enlace }) => `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#1f2933">
  <div style="background:#210d65;padding:24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;color:#fff;font-size:20px">Portal de Proveedores</h1>
    <p style="margin:4px 0 0;color:#cfc6ec;font-size:14px">Merkahorro</p>
  </div>
  <div style="border:1px solid #d9e2ec;border-top:none;border-radius:0 0 8px 8px;padding:24px">
    <p style="margin:0 0 16px;line-height:1.6">
      Se habilitó el acceso para <strong>${cuenta.nombre_sucursal || "su empresa"}</strong><br>
      <span style="color:#64748b;font-size:14px">NIT ${cuenta.nit} &middot; Sucursal ${cuenta.sucursal}</span>
    </p>
    <p style="margin:0 0 24px;line-height:1.6">
      Para crear su contraseña, use el siguiente enlace:
    </p>
    <p style="margin:0 0 24px">
      <a href="${enlace}" style="display:inline-block;background:#210d65;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600">
        Crear mi contraseña
      </a>
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#64748b;line-height:1.6">
      El enlace vence en ${HORAS_VIGENCIA} horas y solo puede usarse una vez.
      Después podrá ingresar con su NIT, su sucursal y la contraseña que defina.
    </p>
    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6">
      Si no esperaba este correo, ignórelo o comuníquese con el área de compras de Merkahorro.
    </p>
  </div>
</div>`;
