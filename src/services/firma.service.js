/* =============================================================================
   Firma digital

   El trazo dibujado es la parte VISIBLE. No es la parte válida.

   Lo que hace que una firma signifique algo es el hash del contenido exacto que
   se firmó. Si después alguien modifica el precio, la fecha o los descuentos, el
   hash deja de coincidir y la firma queda inválida — que es exactamente lo que
   se quiere. Una firma que no se rompe al cambiar lo firmado no prueba nada: es
   un dibujito al lado de un número que puede ser cualquiera.

   La tabla es append-only por trigger (sql/001). Ver docs/ARQUITECTURA.md §8.
   ============================================================================= */

import crypto from "node:crypto";
import { supabase } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

/**
 * Serialización CANÓNICA de lo que se firma.
 *
 * Se arma a mano, campo por campo, en un orden fijo. NO con `JSON.stringify` de
 * un objeto: el orden de las claves depende de cómo se construyó el objeto, así
 * que dos llamadas con los mismos datos podrían producir strings distintos y por
 * lo tanto hashes distintos. Una verificación que falla de a ratos es peor que no
 * verificar, porque destruye la confianza en las que sí pasan.
 *
 * Los números se normalizan a 4 decimales —el alcance de SIESA— para que 4672 y
 * 4672.0 firmen igual. Los descuentos se ordenan por orden.
 */
export function serializarParaFirma({
  cuentaId,
  claveItem,
  item,
  unidadMedida,
  precioActual,
  descuentosActuales = [],
  precioPropuesto,
  descuentosPropuestos = [],
  fechaActivacion,
}) {
  const n = (v) => Number(v ?? 0).toFixed(4);
  const dtos = (lista) =>
    [...lista]
      .filter((d) => d && d.orden != null)
      .sort((a, b) => a.orden - b.orden)
      .map((d) => `${d.orden}:${n(d.porcentaje)}`)
      .join(",");

  return [
    `cuenta=${cuentaId}`,
    `claveItem=${claveItem}`,
    `item=${item}`,
    `um=${unidadMedida}`,
    `precioActual=${n(precioActual)}`,
    `dctosActuales=${dtos(descuentosActuales)}`,
    `precioPropuesto=${n(precioPropuesto)}`,
    `dctosPropuestos=${dtos(descuentosPropuestos)}`,
    `fechaActivacion=${String(fechaActivacion).slice(0, 10)}`,
  ].join("|");
}

/** SHA-256 en hexadecimal de la serialización canónica. */
export function hashPayload(datos) {
  return crypto.createHash("sha256").update(serializarParaFirma(datos), "utf8").digest("hex");
}

/**
 * ¿Esta firma corresponde a estos datos?
 *
 * Comparación en tiempo constante: comparar hashes con `===` filtra información
 * por el tiempo que tarda en encontrar la primera diferencia. Acá el riesgo es
 * remoto, pero el costo de hacerlo bien es una línea.
 */
export function firmaCoincide(hashGuardado, datos) {
  const esperado = hashPayload(datos);
  const a = Buffer.from(String(hashGuardado ?? ""), "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Un trazo vacío no es una firma: es un botón que alguien apretó sin firmar. */
const TRAZO_MINIMO = 100;
const TRAZO_MAXIMO = 512 * 1024;

export function validarTrazo(trazo) {
  if (typeof trazo !== "string" || !trazo.startsWith("data:image/")) {
    return "El trazo de la firma es inválido.";
  }
  if (trazo.length < TRAZO_MINIMO) {
    return "La firma está vacía. Dibuje su firma antes de enviar.";
  }
  if (trazo.length > TRAZO_MAXIMO) {
    return "La firma es demasiado grande.";
  }
  return null;
}

/**
 * Registra una firma y devuelve su id.
 *
 * `firmado_at` lo pone la base con `now()`: la hora del servidor, nunca la que
 * manda el cliente. El reloj del firmante no es prueba de nada.
 *
 * @returns {Promise<{id: number, payloadHash: string}>}
 */
export async function registrarFirma({ cuentaId, userId, datos, trazo, ip, userAgent }) {
  const problema = validarTrazo(trazo);
  if (problema) throw createError(422, problema);

  const payloadHash = hashPayload(datos);

  const { data, error } = await supabase
    .from("pp_firmas")
    .insert({
      cuenta_id: cuentaId,
      user_id: userId,
      payload_hash: payloadHash,
      trazo,
      ip: ip ?? null,
      user_agent: String(userAgent ?? "").slice(0, 500),
    })
    .select("id")
    .single();

  if (error) throw new Error(`No se pudo registrar la firma: ${error.message}`);

  return { id: data.id, payloadHash };
}

/**
 * Verifica que la firma de una solicitud siga correspondiendo a su contenido.
 *
 * Se llama ANTES de aprobar. Es el momento en que la firma pasa de ser un
 * registro a ser una garantía: si alguien tocó la solicitud entre que el
 * proveedor firmó y que el admin aprueba, esto lo detecta y frena el empuje.
 *
 * @returns {Promise<{valida: boolean, motivo: string|null}>}
 */
export async function verificarFirmaDeSolicitud(solicitud) {
  if (!solicitud?.firma_id) return { valida: false, motivo: "La solicitud no tiene firma asociada." };

  const { data: firma, error } = await supabase
    .from("pp_firmas")
    .select("payload_hash, cuenta_id")
    .eq("id", solicitud.firma_id)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer la firma: ${error.message}`);
  if (!firma) return { valida: false, motivo: "La firma referenciada no existe." };

  if (String(firma.cuenta_id) !== String(solicitud.cuenta_id)) {
    return { valida: false, motivo: "La firma pertenece a otra cuenta." };
  }

  const coincide = firmaCoincide(firma.payload_hash, {
    cuentaId: solicitud.cuenta_id,
    claveItem: solicitud.clave_item,
    item: solicitud.item,
    unidadMedida: solicitud.unidad_medida,
    precioActual: solicitud.precio_actual,
    descuentosActuales: solicitud.descuentos_actuales,
    precioPropuesto: solicitud.precio_propuesto,
    descuentosPropuestos: solicitud.descuentos_propuestos,
    fechaActivacion: solicitud.fecha_activacion,
  });

  return coincide
    ? { valida: true, motivo: null }
    : {
        valida: false,
        motivo:
          "El contenido de la solicitud no coincide con lo que se firmó. " +
          "Fue modificado después de la firma y no puede aprobarse.",
      };
}
