/* =============================================================================
   Empuje de cotizaciones a SIESA — conector Cotizaciones_Compras (253851)

   Arma los tres bloques del conector a partir de la cotización VIGENTE más la
   propuesta aprobada, y los importa en una sola llamada.

   Lo que hace distinto a este servicio de un "mandá el precio nuevo":
   RE-EMITE los impuestos junto con el precio. La fecha de activación es parte de
   la llave del registro, así que la cotización con fecha nueva es un registro
   NUEVO: los impuestos de la fecha vieja no lo acompañan solos. Ver
   docs/CONTRATO-SIESA.md §3 — es el riesgo más caro del proyecto.

   Reutiliza el patrón de `backend-traslado/src/services/siesaRequisicion.service.js`:
   POST crudo sin reintento interno, `validateStatus: () => true`, y evaluación
   del CUERPO porque el conector responde 200 aunque rechace.
   ============================================================================= */

import axios from "axios";
import "dotenv/config";
import { campo } from "./formatoSiesa.js";
import { claveItem, hoyEnColombia, MONEDA } from "./normalizarCotizacion.js";

/* ── Configuración ────────────────────────────────────────────────────────── */

const cfg = {
  // Arranca apuntando a QA a propósito. Pasar a producción es cambiar ESTA
  // variable de entorno y nada más. Nunca hardcodear el host.
  url: () =>
    process.env.SIESA_COTIZACION_URL ||
    "https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar",
  idCompania: () => process.env.SIESA_ID_COMPANIA || "7375",
  idSistema: () => process.env.SIESA_IMPORTAR_ID_SISTEMA || "1",
  idDocumento: () => process.env.SIESA_COTIZACION_ID_DOCUMENTO || "253851",
  nombreDocumento: () => process.env.SIESA_COTIZACION_NOMBRE_DOCUMENTO || "Cotizaciones_Compras",
  key: () => process.env.CONNI_KEY,
  token: () => process.env.CONNI_TOKEN,
};

/** Corta el POST dejando el armado intacto. Ver `importarCotizacion`. */
export const sandboxOn = () => String(process.env.PROVEEDORES_SANDBOX || "").toLowerCase() === "true";

export class ConfigSiesaError extends Error {
  constructor(faltan) {
    super(`Falta configuración de SIESA: ${faltan.join(", ")}`);
    this.name = "ConfigSiesaError";
    this.faltan = faltan;
  }
}

export function configFaltante() {
  const faltan = [];
  if (!cfg.key()) faltan.push("CONNI_KEY");
  if (!cfg.token()) faltan.push("CONNI_TOKEN");
  if (!cfg.url()) faltan.push("SIESA_COTIZACION_URL");
  if (!cfg.idDocumento()) faltan.push("SIESA_COTIZACION_ID_DOCUMENTO");
  return faltan;
}

/* ── Armado del payload ──────────────────────────────────────────────────── */

/**
 * Los tres bloques van SIEMPRE, aunque alguno quede vacío: es la forma
 * documentada del conector. Si QA rechaza un array vacío, la corrección es
 * filtrar acá — un solo lugar.
 */
const BLOQUES = {
  encabezado: "Encabezado Cotizaciones",
  impuestos: "Impuestos en Valor",
  descuentos: "Descuentos",
};

/**
 * La llave se repite en los tres bloques y NO se escribe tres veces a mano.
 *
 * Ojo con la tilde: el bloque de encabezado usa `FECHA_ACTIVACION`, los otros dos
 * usan `FECHA_ACTIVACIÓN` con `Ó`. No es un typo de la documentación — está así en
 * cada bloque. Por eso la clave es un parámetro y no una constante suelta.
 */
function llave({ idTercero, sucursal, item, unidadMedida, fechaActivacion }, claveFecha) {
  return {
    NIT_PROVEEDOR: campo.nitProveedor(idTercero),
    SUCURSAL: campo.sucursal(sucursal),
    ITEM: campo.item(item),
    [claveFecha]: campo.fechaActivacion(fechaActivacion),
    "U.M": campo.unidadMedida(unidadMedida),
  };
}

/**
 * Arma el payload completo de un cambio de precio aprobado.
 *
 * @param {object} args
 * @param {object} args.vigente     Cotización normalizada que rige hoy. Aporta la
 *                                  identidad (tercero, sucursal, ítem, U.M.) y los
 *                                  impuestos a re-emitir.
 * @param {object} args.propuesta   `{ precio, descuentos:[{orden,porcentaje}],
 *                                  fechaActivacion, notas }`.
 * @param {boolean} [args.permitirRetroactiva=false]
 * @param {string}  [args.hoy]      `AAAA-MM-DD`; por defecto, hoy en Colombia.
 * @returns {object} Body listo para el conector.
 */
export function armarPayload({ vigente, propuesta, permitirRetroactiva = false, hoy = hoyEnColombia() }) {
  if (!vigente) throw new TypeError("armarPayload: falta la cotización vigente");
  if (!propuesta) throw new TypeError("armarPayload: falta la propuesta");

  const fechaActivacion = String(propuesta.fechaActivacion ?? "").slice(0, 10);
  if (!fechaActivacion) {
    throw new TypeError("armarPayload: la propuesta no tiene fecha de activación");
  }

  // Una fecha pasada re-precia mercadería YA RECIBIDA: las órdenes de compra que
  // entraron entre esa fecha y hoy quedan valoradas con el precio nuevo. Es una
  // operación legítima pero jamás automática, así que hay que pedirla explícita.
  if (!permitirRetroactiva && fechaActivacion < hoy) {
    throw new RangeError(
      `armarPayload: fecha de activación retroactiva (${fechaActivacion} < ${hoy}). ` +
        `Pasá permitirRetroactiva:true si es deliberado.`,
    );
  }

  // Escribir el precio del ítem equivocado es el peor bug posible de este módulo,
  // y es un bug silencioso: SIESA acepta el registro sin chistar. La propuesta y
  // la cotización vigente tienen que ser del MISMO renglón, y se verifica.
  if (propuesta.claveItem && propuesta.claveItem !== claveItem(vigente)) {
    throw new RangeError(
      `armarPayload: la propuesta (${propuesta.claveItem}) no corresponde a la cotización vigente (${claveItem(vigente)})`,
    );
  }

  // El conector escribe `F212_ID_MONEDA` como campo FIJO en COP. Con una
  // cotización en otra moneda, mandarla igual cargaría el precio en pesos: un
  // producto de USD 100 entraría como $100. Mejor no escribir nada.
  if (vigente.moneda && vigente.moneda !== MONEDA) {
    throw new RangeError(
      `armarPayload: la cotización está en ${vigente.moneda} y el conector solo escribe ${MONEDA}. ` +
        `Cargar este cambio a mano en SIESA.`,
    );
  }

  const identidad = { ...vigente, fechaActivacion };

  const encabezado = {
    ...llave(identidad, "FECHA_ACTIVACION"),
    PRECIO: campo.precio(propuesta.precio),
    NOTAS: campo.notas(propuesta.notas),
  };

  /* Impuestos: se re-emiten TAL CUAL los de la cotización vigente, con la fecha
     nueva. El proveedor no los edita — ICO e IBUA los fija la ley, no la
     negociación. Si esta lista sale vacía teniendo la vigente impuestos, el ítem
     pierde su ICO/IBUA en la fecha nueva. Ese es el bug que este bloque evita. */
  const impuestos = (vigente.impuestos ?? []).map((imp) => ({
    ...llave(identidad, "FECHA_ACTIVACIÓN"),
    LLAVE_IMPUESTO: campo.llaveImpuesto(imp.llave),
    VALOR_IMPUESTO: campo.valorImpuesto(imp.valor),
  }));

  /* Descuentos: vienen de la PROPUESTA, no de la vigente — el proveedor sí los
     edita, y por eso el tope del portal se evalúa sobre el costo neto (§6).

     Solo se emiten los mayores a 0. Un descuento que el proveedor quitó se
     representa por AUSENCIA, no por una fila en 0%: como la fecha es parte de la
     llave, no mandar el orden significa que ese orden no existe en la fecha
     nueva. Además esquiva la ambigüedad del conector, donde `%_DESCUENTO` y
     `VALOR_DESCUENTO` son obligatorios "si el otro es 0" — con los dos en cero no
     está definido qué gana. */
  const descuentos = (propuesta.descuentos ?? [])
    .filter((d) => Number(d?.porcentaje) > 0)
    .sort((a, b) => a.orden - b.orden)
    .map((d) => ({
      ...llave(identidad, "FECHA_ACTIVACIÓN"),
      NRO_ORDEN: campo.nroOrden(d.orden),
      "%_DESCUENTO": campo.porcentajeDescuento(d.porcentaje),
      // Trabajamos solo con descuentos porcentuales. El campo de valor va en cero
      // y el porcentaje es el que manda — así el par cumple la regla del conector.
      VALOR_DESCUENTO: campo.valorDescuento(0),
    }));

  return {
    [BLOQUES.encabezado]: [encabezado],
    [BLOQUES.impuestos]: impuestos,
    [BLOQUES.descuentos]: descuentos,
  };
}

/* ── Lectura de la respuesta ─────────────────────────────────────────────── */

const aTexto = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/**
 * ¿SIESA dice que salió bien?
 *
 * El conector responde **200 aunque rechace** el documento, así que el status
 * HTTP no alcanza: hay que leer el cuerpo. Tratar un 200-con-errores como éxito
 * es peor que un 500 — la solicitud quedaría marcada como aplicada sin estar en
 * el ERP, y nadie la reintentaría nunca.
 */
export function respuestaOk(data) {
  if (data == null) return false;
  if (typeof data === "object") {
    if (data.codigo != null && Number(data.codigo) !== 0) return false;
    const errores = data.Errores ?? data.errores;
    if (Array.isArray(errores) && errores.length > 0) return false;
    if (data.error) return false;
  }
  return true;
}

/** Saca de la respuesta algo que un humano pueda leer en el log. */
export function detalleError(data) {
  if (data == null) return "sin respuesta";
  if (typeof data === "string") return data.slice(0, 800);

  const errores = data.Errores ?? data.errores;
  if (Array.isArray(errores) && errores.length) return aTexto(errores).slice(0, 800);

  const d = data.detalle ?? data.mensaje ?? data.error;
  if (d != null) {
    const texto = aTexto(d);
    if (texto) return texto.slice(0, 800);
  }
  return aTexto(data).slice(0, 800);
}

/* ── POST ─────────────────────────────────────────────────────────────────── */

/**
 * POST crudo al conector. Una sola pasada, SIN reintento interno.
 *
 * El reintento vive afuera y pasa por la base de datos. Reintentar acá adentro,
 * en memoria, correría el riesgo de mandar dos veces sin registro de la primera —
 * y con un write al ERP, "no sé si llegó" es peor que "falló".
 */
async function postConector(payload) {
  return axios
    .post(cfg.url(), payload, {
      params: {
        idCompania: cfg.idCompania(),
        idSistema: cfg.idSistema(),
        idDocumento: cfg.idDocumento(),
        nombreDocumento: cfg.nombreDocumento(),
      },
      headers: {
        conniKey: cfg.key(),
        conniToken: cfg.token(),
        "Content-Type": "application/json",
      },
      timeout: 60_000,
      validateStatus: () => true,
    })
    .then(({ data, status }) => ({ data, status }));
}

/**
 * Importa a SIESA un cambio de precio ya aprobado.
 *
 * @param {object} args  Los mismos de `armarPayload`, más `solicitudId` para el log.
 * @returns {Promise<{ok: true, sandbox?: true, payload: object, respuesta: object}>}
 * @throws {ConfigSiesaError} si falta configuración
 * @throws {Error} si SIESA rechaza (con `siesaData` y `httpStatus` adjuntos)
 */
export async function importarCotizacion({ solicitudId, ...args }) {
  const faltan = configFaltante();
  if (faltan.length) throw new ConfigSiesaError(faltan);

  const payload = armarPayload(args);

  // SANDBOX — se corta JUSTO ANTES del POST y DESPUÉS de armar el payload: así el
  // armado, que es donde viven los bugs de formato, llave y re-emisión, se
  // ejercita igual contra datos reales y queda guardado para revisarlo.
  if (sandboxOn()) {
    // El payload ENTERO, no solo los conteos.
    //
    // El sandbox existe para PODER MIRAR lo que se iba a mandar antes de
    // mandarlo. Un log que dice "1 encabezado, 0 impuestos" cuenta cajas sin
    // mostrar qué hay adentro — y lo que se revisa es justamente el adentro: si
    // la fecha quedó en AAAAMMDD, si el precio tiene sus 20 caracteres, si los
    // impuestos se re-emitieron. Sin esto hay que ir a buscarlo a la base.
    console.warn(
      `[siesa] 🧪 SANDBOX — solicitud ${solicitudId ?? "?"} NO se importó. ` +
        `${payload[BLOQUES.impuestos].length} impuesto(s), ` +
        `${payload[BLOQUES.descuentos].length} descuento(s). Payload:\n` +
        JSON.stringify(payload, null, 2),
    );
    return { ok: true, sandbox: true, payload, respuesta: { sandbox: true } };
  }

  const { data, status } = await postConector(payload);

  if (status >= 400 || !respuestaOk(data)) {
    const err = new Error(
      `SIESA rechazó la cotización de la solicitud ${solicitudId ?? "?"} [HTTP ${status}]: ${detalleError(data)}`,
    );
    err.siesaData = data;
    err.httpStatus = status;
    err.payload = payload;
    throw err;
  }

  return { ok: true, payload, respuesta: data };
}

export { MONEDA, BLOQUES };
