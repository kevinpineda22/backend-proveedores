/* =============================================================================
   Verificación post-escritura — ¿el precio quedó de verdad en SIESA?

   POR QUÉ EXISTE
   `siesaCotizacion.js` daba por escrita una cotización si la respuesta traía
   `codigo: 0`. Eso no es una prueba, es un ACUSE DE RECIBO. El 2026-08-28 la
   solicitud #5 recibió "Importacion exitosa" y nadie pudo encontrar el registro
   en el ERP durante días: el sistema afirmaba algo que no había comprobado.

   `backend-traslado` ya resolvió esta clase de problema leyendo de vuelta el
   `NroDocto` que SIESA asigna (siesaRequisicion.service.js). Una cotización no
   genera consecutivo, así que acá la prueba equivalente es RELEER la consulta y
   comparar lo que quedó contra lo que mandamos.

   ── LA ASIMETRÍA QUE HAY QUE RESPETAR ──
   Hoy se LEE de producción (`CONNEKTA_BASE_URL`) y se ESCRIBE en QA
   (`SIESA_COTIZACION_URL`). Con los entornos cruzados, releer NO puede confirmar
   nada: la cotización está en QA y la consulta mira producción.

   Ese es justamente el caso de la #5. Por eso este módulo NO inventa un
   veredicto: cuando los entornos no coinciden devuelve `no_verificable` con el
   motivo. Un "no pude comprobarlo" es información; un "confirmado" falso es el
   bug que vinimos a matar.

   Cuando el conector pase a producción (PENDIENTES §1.4), la verificación
   empieza a confirmar de verdad sin tocar una línea de acá.
   ============================================================================= */

import { consultarCotizaciones } from "../config/connekta.js";
import {
  agruparCotizaciones,
  claveCotizacion,
  MONEDA,
} from "./normalizarCotizacion.js";

/** Host de una URL, o "" si no se puede leer. Comparar hosts, no URLs completas. */
export function hostDe(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return "";
  }
}

const urlLectura = () =>
  process.env.CONNEKTA_BASE_URL || "https://servicios.siesacloud.com/api/connekta/v3";

const urlEscritura = () =>
  process.env.SIESA_COTIZACION_URL ||
  "https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar";

/**
 * ¿Leer y escribir apuntan al mismo SIESA?
 *
 * Si no, cualquier relectura es ciega y decirlo es obligatorio.
 */
export function entornosComparables(lectura = urlLectura(), escritura = urlEscritura()) {
  const a = hostDe(lectura);
  const b = hostDe(escritura);
  return Boolean(a) && Boolean(b) && a === b;
}

/** Diferencia relativa: los precios vienen con decimales y comparar `===` es frágil. */
const casiIgual = (a, b, tolerancia = 0.01) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= tolerancia;
};

/**
 * Relee la cotización recién importada y la compara con lo que se mandó.
 *
 * NO lanza: un fallo de la consulta no puede tumbar una aprobación que ya
 * escribió en el ERP. Devuelve el motivo y deja que el llamador decida.
 *
 * @returns {Promise<{estado: "confirmado"|"no_encontrado"|"discrepante"|"no_verificable",
 *                    motivo: string, esperado: object, encontrado: object|null}>}
 */
export async function verificarEnSiesa({
  idTercero,
  sucursal,
  item,
  unidadMedida,
  fechaActivacion,
  moneda = MONEDA,
  precioEsperado,
  impuestosEsperados = [],
}) {
  const esperado = {
    precio: Number(precioEsperado),
    impuestos: impuestosEsperados.map((i) => ({ llave: i.llave, valor: Number(i.valor) })),
  };

  if (!entornosComparables()) {
    return {
      estado: "no_verificable",
      motivo:
        `Se escribe en "${hostDe(urlEscritura())}" y se lee de ` +
        `"${hostDe(urlLectura())}". Con los entornos cruzados la relectura no ` +
        `prueba nada. Se confirma sola cuando el conector pase a producción.`,
      esperado,
      encontrado: null,
    };
  }

  let crudas;
  try {
    crudas = await consultarCotizaciones({ idTercero });
  } catch (e) {
    return {
      estado: "no_verificable",
      motivo: `No se pudo releer la consulta de cotizaciones: ${e.message}`,
      esperado,
      encontrado: null,
    };
  }

  // La fecha de activación es parte de la llave: la cotización nueva es un
  // REGISTRO PROPIO, no una edición del anterior. Por eso se busca por la llave
  // completa y no por ítem — buscar por ítem devolvería la vigente de hoy y
  // haría pasar por "confirmado" un precio que nunca entró.
  const buscada = claveCotizacion({
    moneda,
    idTercero,
    sucursal,
    item,
    unidadMedida,
    fechaActivacion,
  });

  const encontrada = agruparCotizaciones(crudas).find((c) => c.clave === buscada);

  if (!encontrada) {
    return {
      estado: "no_encontrado",
      motivo:
        `SIESA respondió "importación exitosa" pero la cotización no aparece al ` +
        `releer. Llave buscada: ${buscada}`,
      esperado,
      encontrado: null,
    };
  }

  const encontrado = {
    precio: encontrada.precio,
    impuestos: (encontrada.impuestos ?? []).map((i) => ({ llave: i.llave, valor: i.valor })),
  };

  const diferencias = [];

  if (!casiIgual(encontrada.precio, esperado.precio)) {
    diferencias.push(`precio: esperado ${esperado.precio}, quedó ${encontrada.precio}`);
  }

  // Los impuestos son el caso caro: un ítem ya perdió un ICO de $5.102 al
  // re-emitirse. Que el precio esté bien no alcanza.
  for (const esp of esperado.impuestos) {
    const hall = encontrado.impuestos.find((i) => i.llave === esp.llave);
    if (!hall) diferencias.push(`falta el impuesto ${esp.llave} (esperado ${esp.valor})`);
    else if (!casiIgual(hall.valor, esp.valor)) {
      diferencias.push(`impuesto ${esp.llave}: esperado ${esp.valor}, quedó ${hall.valor}`);
    }
  }

  if (diferencias.length) {
    return {
      estado: "discrepante",
      motivo: `La cotización quedó distinta a lo aprobado — ${diferencias.join("; ")}`,
      esperado,
      encontrado,
    };
  }

  return {
    estado: "confirmado",
    motivo: "Releído desde SIESA: el precio y los impuestos coinciden con lo aprobado.",
    esperado,
    encontrado,
  };
}

/** Los desenlaces que NO permiten afirmar que el precio quedó en el ERP. */
export const NO_CONFIRMA = new Set(["no_encontrado", "discrepante"]);
