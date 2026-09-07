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

/* Los números se normalizan a 4 decimales —el alcance de SIESA— para que 4672 y
   4672.0 firmen igual. */
const n = (v) => Number(v ?? 0).toFixed(4);

const dtos = (lista = []) =>
  [...lista]
    .filter((d) => d && d.orden != null)
    .sort((a, b) => a.orden - b.orden)
    .map((d) => `${d.orden}:${n(d.porcentaje)}`)
    .join(",");

/* Los impuestos se ordenan POR LLAVE, no por orden de llegada: un ítem puede
   traer ICO e IBU3 y el orden en que la consulta los devuelve no está
   garantizado. Sin esto, el mismo contenido podría firmar distinto según cómo
   vino de SIESA — y una verificación que falla de a ratos es peor que no
   verificar, porque destruye la confianza en las que sí pasan. */
const imptos = (lista = []) =>
  [...lista]
    .filter((i) => i && i.llave != null)
    .sort((a, b) => String(a.llave).localeCompare(String(b.llave)))
    .map((i) => `${i.llave}:${n(i.valor)}`)
    .join(",");

/**
 * Serialización CANÓNICA de UNA línea.
 *
 * Se arma a mano, campo por campo, en un orden fijo. NO con `JSON.stringify` de
 * un objeto: el orden de las claves depende de cómo se construyó el objeto, así
 * que dos llamadas con los mismos datos podrían producir strings distintos.
 *
 * Los IMPUESTOS entran acá desde el 2026-09-06, cuando el proveedor pasó a poder
 * editarlos. Antes se re-emitían fijos y no había nada que firmar. Ahora sí: si
 * un proveedor quita un ICO, la única prueba de que lo pidió él es que ese hecho
 * esté ADENTRO de lo firmado.
 */
export function serializarLinea({
  claveItem,
  item,
  unidadMedida,
  precioActual,
  descuentosActuales = [],
  impuestosVigentes = [],
  precioPropuesto,
  descuentosPropuestos = [],
  impuestosPropuestos = [],
  fechaActivacion,
}) {
  return [
    `claveItem=${claveItem}`,
    `item=${item}`,
    `um=${unidadMedida}`,
    `precioActual=${n(precioActual)}`,
    `dctosActuales=${dtos(descuentosActuales)}`,
    `imptosActuales=${imptos(impuestosVigentes)}`,
    `precioPropuesto=${n(precioPropuesto)}`,
    `dctosPropuestos=${dtos(descuentosPropuestos)}`,
    `imptosPropuestos=${imptos(impuestosPropuestos)}`,
    `fechaActivacion=${String(fechaActivacion).slice(0, 10)}`,
  ].join("|");
}

/* La versión va ADENTRO de lo que se hashea. Sin marca, el día que cambie el
   formato todas las firmas viejas pasarían a decir "esto fue modificado" — una
   acusación falsa, que es peor que no verificar. Con marca, se sabe con qué regla
   se firmó y se puede verificar con esa. */
const VERSION = "v2";

/**
 * Serialización CANÓNICA del PAQUETE. Una solicitud = una firma (migración 006).
 *
 * TIENE QUE CUBRIR TODAS LAS LÍNEAS. Si cubriera solo la primera, agregarle un
 * producto a una solicitud ya firmada no rompería nada y la firma dejaría de
 * probar qué fue lo que el proveedor aceptó.
 *
 * `lineas=N` va explícito y las líneas se separan con `\n` —un carácter que no
 * aparece dentro de ninguna— para que dos paquetes distintos no puedan producir
 * la misma cadena partiendo el texto en otro lado.
 *
 * Se ordenan por `claveItem`: el proveedor puede mandar los productos en
 * cualquier orden, y el mismo paquete tiene que firmar siempre igual.
 */
export function serializarParaFirma({ cuentaId, lineas = [] }) {
  const cuerpo = [...lineas]
    .sort((a, b) => String(a.claveItem).localeCompare(String(b.claveItem)))
    .map(serializarLinea);

  return [VERSION, `cuenta=${cuentaId}`, `lineas=${lineas.length}`, ...cuerpo].join("\n");
}

/**
 * Serialización v1: UNA línea, sin impuestos. Es la de antes de la migración 006.
 *
 * Se conserva SOLO para verificar firmas que ya existían. No se emite más.
 * Sacarla dejaría sin poder aprobar a las solicitudes firmadas antes del cambio:
 * el sistema le diría al admin que fueron modificadas después de firmadas, y
 * nadie las modificó.
 */
function serializarV1({ cuentaId, linea }) {
  return [
    `cuenta=${cuentaId}`,
    `claveItem=${linea.claveItem}`,
    `item=${linea.item}`,
    `um=${linea.unidadMedida}`,
    `precioActual=${n(linea.precioActual)}`,
    `dctosActuales=${dtos(linea.descuentosActuales)}`,
    `precioPropuesto=${n(linea.precioPropuesto)}`,
    `dctosPropuestos=${dtos(linea.descuentosPropuestos)}`,
    `fechaActivacion=${String(linea.fechaActivacion).slice(0, 10)}`,
  ].join("|");
}

const sha = (texto) => crypto.createHash("sha256").update(texto, "utf8").digest("hex");

/** SHA-256 en hexadecimal de la serialización canónica del paquete. */
export function hashPayload(datos) {
  return sha(serializarParaFirma(datos));
}

/** SHA-256 de la serialización v1. Solo para verificar firmas anteriores a la 006. */
export function hashPayloadV1(datos) {
  return sha(serializarV1(datos));
}

/**
 * Comparación en tiempo constante: comparar hashes con `===` filtra información
 * por el tiempo que tarda en encontrar la primera diferencia. Acá el riesgo es
 * remoto, pero el costo de hacerlo bien es una línea.
 */
function igual(hashGuardado, esperado) {
  const a = Buffer.from(String(hashGuardado ?? ""), "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * ¿Esta firma corresponde a este paquete?
 *
 * Prueba v2 y, si el paquete es de UNA sola línea, también v1 — las firmas
 * anteriores a la migración 006 se emitieron con ese formato y siguen siendo
 * válidas. Un paquete de varias líneas jamás pudo firmarse con v1, así que ahí ni
 * se intenta: probar formatos de más agranda la superficie sin ganar nada.
 */
export function firmaCoincide(hashGuardado, datos) {
  if (igual(hashGuardado, hashPayload(datos))) return true;

  const lineas = datos?.lineas ?? [];
  if (lineas.length !== 1) return false;

  // Y solo si la línea NO tiene impuestos propuestos distintos de los vigentes:
  // v1 no los firmaba, así que no puede dar fe de un cambio de impuesto.
  const [l] = lineas;
  if (imptos(l.impuestosPropuestos) !== imptos(l.impuestosVigentes)) return false;

  return igual(hashGuardado, hashPayloadV1({ cuentaId: datos.cuentaId, linea: l }));
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

/** Fila de `pp_solicitud_lineas` → la forma que consume `serializarLinea`. */
export const lineaParaFirma = (l) => ({
  claveItem: l.clave_item,
  item: l.item,
  unidadMedida: l.unidad_medida,
  precioActual: l.precio_actual,
  descuentosActuales: l.descuentos_actuales ?? [],
  impuestosVigentes: l.impuestos_vigentes ?? [],
  precioPropuesto: l.precio_propuesto,
  descuentosPropuestos: l.descuentos_propuestos ?? [],
  impuestosPropuestos: l.impuestos_propuestos ?? [],
  fechaActivacion: l.fecha_activacion,
});

/**
 * Verifica que la firma de una solicitud siga correspondiendo a su contenido.
 *
 * Se llama ANTES de aprobar. Es el momento en que la firma pasa de ser un
 * registro a ser una garantía: si alguien tocó la solicitud entre que el
 * proveedor firmó y que el admin aprueba, esto lo detecta y frena el empuje.
 *
 * ⚠️ SE VERIFICA CONTRA EL PAQUETE COMPLETO, aunque se esté aprobando UNA línea.
 * El admin aprueba línea por línea, pero lo que se firmó fue el conjunto: si
 * alguien le agregó un producto al paquete después de la firma, aprobar una
 * línea "sana" del mismo paquete tiene que frenarse igual. Verificar solo la
 * línea que se aprueba dejaría entrar exactamente eso.
 *
 * ⚠️ Y SOLO CON LAS LÍNEAS DEL PROVEEDOR. Las réplicas a sucursales hermanas las
 * genera el sistema, no el proveedor: meterlas adentro haría que la firma
 * dependiera de una configuración interna de Merkahorro que él no firmó, y
 * prender un grupo invalidaría firmas ya hechas.
 *
 * @param {object} solicitud  fila de `pp_solicitudes`
 * @param {object[]} lineas   TODAS las de esa solicitud (se filtran las réplicas acá)
 * @returns {Promise<{valida: boolean, motivo: string|null}>}
 */
export async function verificarFirmaDeSolicitud(solicitud, lineas = []) {
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

  const propias = lineas.filter((l) => l.origen !== "replica");
  if (propias.length === 0) {
    return { valida: false, motivo: "La solicitud no tiene líneas propias que verificar." };
  }

  const coincide = firmaCoincide(firma.payload_hash, {
    cuentaId: solicitud.cuenta_id,
    lineas: propias.map(lineaParaFirma),
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
