/* =============================================================================
   La auditoría: un solo lugar donde se escribe, un solo lugar donde puede fallar

   POR QUÉ EXISTE ESTE ARCHIVO
   El insert a `pp_auditoria` estaba copiado en OCHO lugares, y con él estaba
   copiado el mismo error en todos: **`supabase-js` no lanza cuando la base
   rechaza el insert — devuelve `{ error }`.**

   Eso hacía que varios de esos ocho fueran así:

       try {
         await supabase.from("pp_auditoria").insert({ … });   // devuelve {error}
       } catch (e) {
         console.error("no se pudo registrar:", e?.message);  // nunca entra acá
       }

   El `catch` cubre errores LANZADOS (la red se cayó, el cliente explotó). Un
   rechazo de Postgres no lanza: se devuelve, y si nadie lo desestructura,
   desaparece. El comentario decía "nunca lanza" y era cierto; lo que no decía es
   que tampoco avisaba.

   NO ES TEÓRICO. El 2026-09-07, verificando el tope por sucursal, un insert
   falló con `22P02 invalid input syntax for type inet` —`pp_auditoria.ip` es de
   tipo `inet` y le llegaba un texto que no era una IP— mientras la operación
   auditada se completaba con toda normalidad. La tabla parecía completa. Una
   auditoría incompleta que se ve completa es peor que no tener auditoría: la
   primera pregunta después de un cambio de precio raro es "¿quién lo hizo?", y la
   respuesta habría sido un silencio que nadie sabía interpretar.

   LAS DOS REGLAS
     1. **Nunca lanza.** Un log que falla no puede tumbar la operación que estaba
        registrando: el 403 tiene que salir, el tope ya se guardó, el correo ya
        se mandó. Devolver 500 acá invitaría a reintentar algo ya hecho.
     2. **Nunca calla.** Si no pudo escribir, sale por `console.error` diciendo
        QUÉ no se auditó —entidad, id y acción—, no solo que algo falló. Un log
        que dice "error" sin decir de qué obliga a adivinar.
   ============================================================================= */

import { supabase } from "../config/supabase.js";

/**
 * Registra un hecho en `pp_auditoria`.
 *
 * @param {object} evento
 * @param {string} evento.entidad        Tabla o concepto: `pp_cuentas`, `pp_cotizaciones`…
 * @param {string|number} [evento.entidadId]  Id de la fila. Opcional: el snapshot no tiene una.
 * @param {string} evento.accion         Qué pasó, en pasado: `invitar`, `aprobar`…
 * @param {string} [evento.estadoAnterior]
 * @param {string} [evento.estadoNuevo]
 * @param {string} [evento.actorUserId]
 * @param {string} [evento.actorRol]     `pp_admin`, `pp_proveedor`, `cron`…
 * @param {object} [evento.detalle]      Contexto. Nunca tokens ni contraseñas.
 * @param {string} [evento.ip]           Tiene que ser una IP: la columna es `inet`.
 * @param {object} [cliente]             Otro cliente de Supabase (invitación usa el suyo).
 * @returns {Promise<boolean>} `true` si quedó registrado. Nadie está obligado a
 *          mirarlo, pero permite que un llamador decida avisar de otra forma.
 */
export async function auditar(
  {
    entidad,
    entidadId,
    accion,
    estadoAnterior,
    estadoNuevo,
    actorUserId,
    actorRol,
    detalle,
    ip,
  },
  cliente = supabase,
) {
  const quien = `${entidad}${entidadId != null ? `/${entidadId}` : ""} · ${accion}`;

  try {
    const { error } = await cliente.from("pp_auditoria").insert({
      entidad,
      // `null` y no `"null"`: `String(undefined)` deja la cadena "undefined" en la
      // columna, y después nadie entiende a qué fila apuntaba ese registro.
      entidad_id: entidadId == null ? null : String(entidadId),
      accion,
      estado_anterior: estadoAnterior ?? null,
      estado_nuevo: estadoNuevo ?? null,
      actor_user_id: actorUserId ?? null,
      actor_rol: actorRol ?? null,
      detalle: detalle ?? null,
      ip: ip ?? null,
    });

    // ESTE es el chequeo que faltaba en siete de los ocho llamadores.
    if (error) {
      console.error(`[auditoria] no se registró "${quien}": ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    // Y esto sigue cubriendo lo otro: que el cliente explote o se caiga la red.
    console.error(`[auditoria] no se registró "${quien}": ${e?.message}`);
    return false;
  }
}

export default auditar;
