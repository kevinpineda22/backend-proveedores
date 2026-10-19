/* =============================================================================
   Seguimiento SIESA — qué mandó el portal, y qué cambió afuera (sql/013)

   Dos preguntas, dos tablas:

     pp_siesa_envios   "¿qué le mandamos a SIESA, cuándo, y qué contestó?"
                       Una fila por INTENTO. La abre `empujarLote()` con el
                       payload ANTES del POST y la cierra con la respuesta. Es el
                       patrón del panel SIESA de Carnes.

     pp_siesa_cambios  "¿qué cambió en las cotizaciones de SIESA, y fuimos
                       nosotros?" La escribe el snapshot diario comparando la
                       corrida nueva contra `pp_cotizaciones` ANTES de pisarla.

   LAS DOS REGLAS DE `auditoria.js` VALEN ACÁ
     1. Nunca lanza. Registrar un envío no puede tumbar el envío: si SIESA ya
        aceptó un precio, un 500 nuestro invitaría a reaprobarlo — a duplicarlo.
     2. Nunca calla. Si no pudo escribir, sale por console.error diciendo QUÉ.

   LO QUE `pp_siesa_cambios` NO SABE, y la pantalla tiene que decirlo:
     · cuándo exacto (el snapshot es diario: se sabe la ventana, no la hora);
     · quién (la consulta de Connekta no trae usuario de modificación).
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { hostDe } from "./verificarCotizacion.js";
import { claveCotizacion, MONEDA } from "./normalizarCotizacion.js";

/* ── Ambiente ─────────────────────────────────────────────────────────────── */

/**
 * `qa` | `produccion` | `desconocido` a partir de la URL de SIESA Cloud.
 *
 * Importa porque hoy el conector escribe en QA y el snapshot lee de producción:
 * una fila "aplicado" sin esta marca se leería como un precio vigente en PROD.
 */
export function destinoDe(url) {
  const host = hostDe(url);
  if (!host) return "desconocido";
  if (/(^|[.-])qa([.-]|$)|serviciosqa/.test(host)) return "qa";
  if (host.endsWith("siesacloud.com")) return "produccion";
  return "desconocido";
}

/* ── Estados de un envío ──────────────────────────────────────────────────── */

/** Estados en los que SIESA ACEPTÓ el documento. Solo estos pueden atribuirse un cambio. */
export const ACEPTADOS = new Set(["aceptado", "aplicado", "no_verificable", "incierto"]);

/**
 * El mismo criterio que `marcarLoteFallido`, en un solo lugar:
 *   enviadoASiesa false     → no salió de acá
 *   enviadoASiesa true      → el ERP lo rechazó
 *   enviadoASiesa undefined → se cortó: NO sabemos si llegó
 */
export function origenDelFallo(e) {
  if (e?.enviadoASiesa === false) return "local";
  if (e?.enviadoASiesa === true) return "rechazo_erp";
  return "sin_respuesta";
}

export const ESTADO_POR_ORIGEN = {
  local: "no_enviado",
  rechazo_erp: "rechazado",
  sin_respuesta: "sin_respuesta",
};

/**
 * El estado del LOTE a partir de la relectura de cada línea.
 *
 * Gana el peor: un lote de veinte con una línea incierta es un lote que alguien
 * tiene que mirar. `null` = sandbox o sin relectura.
 */
export function estadoDelLote(verificaciones = []) {
  const estados = verificaciones.map((v) => v?.estado).filter(Boolean);
  if (!estados.length) return "no_verificable";
  if (estados.some((s) => s === "no_encontrado" || s === "discrepante")) return "incierto";
  if (estados.some((s) => s !== "confirmado")) return "no_verificable";
  return "aplicado";
}

/**
 * La foto de cada línea al momento del envío. La línea puede reintentarse y
 * cambiar después; el envío tiene que seguir diciendo qué se mandó ESA vez.
 */
export function itemsDelLote(lote, { idTercero, sucursal }) {
  return lote.map((l) => ({
    linea_id: l.id,
    solicitud_id: l.solicitud_id,
    clave: claveCotizacion({
      moneda: String(l.clave_item ?? "").split("|")[0] || MONEDA,
      idTercero,
      sucursal,
      item: l.item,
      unidadMedida: l.unidad_medida,
      fechaActivacion: l.fecha_activacion,
    }),
    item: l.item,
    descripcion_item: l.descripcion_item,
    unidad_medida: l.unidad_medida,
    fecha_activacion: l.fecha_activacion,
    precio_actual: l.precio_actual == null ? null : Number(l.precio_actual),
    precio_propuesto: l.precio_propuesto == null ? null : Number(l.precio_propuesto),
    origen: l.origen,
  }));
}

/* ── Escritura de envíos ─────────────────────────────────────────────────── */

/**
 * Abre el registro de un intento. Devuelve el id, o `null` si no pudo.
 * Nunca lanza: ver la regla 1 de la cabecera.
 */
export async function abrirEnvio({ cuentaId, idTercero, sucursal, lote, admin, conector, payload, sandbox }) {
  const fila = {
    cuenta_id: cuentaId ?? null,
    id_tercero: idTercero ?? null,
    sucursal: sucursal ?? null,
    solicitud_ids: [...new Set(lote.map((l) => l.solicitud_id))],
    linea_ids: lote.map((l) => l.id),
    renglones: lote.length,
    items: itemsDelLote(lote, { idTercero, sucursal }),
    conector: conector?.idDocumento ?? null,
    destino: conector ? destinoDe(conector.url) : "desconocido",
    sandbox: Boolean(sandbox),
    estado: "enviando",
    payload: payload ?? null,
    enviado_por: admin?.userId ?? null,
    enviado_por_nombre: admin?.nombre ?? null,
  };
  try {
    const { data, error } = await supabase.from("pp_siesa_envios").insert(fila).select("id").single();
    if (error) {
      console.error(`[seguimiento] no se registró el envío de las líneas ${fila.linea_ids}: ${error.message}`);
      return null;
    }
    return data.id;
  } catch (e) {
    console.error(`[seguimiento] no se registró el envío de las líneas ${fila.linea_ids}: ${e?.message}`);
    return null;
  }
}

/**
 * Actualiza el MISMO intento con lo que pasó. `id` null = no se pudo abrir; no
 * hay nada que cerrar y ya se avisó al abrir. Nunca lanza.
 */
export async function cerrarEnvio(id, cambios, inicio) {
  if (id == null) return false;
  const fila = { ...cambios };
  if (fila.error != null) fila.error = String(fila.error).slice(0, 2000);
  // `inicio` solo en el cierre que trae la respuesta de SIESA: la relectura
  // posterior actualiza el estado sin mover cuándo respondió el ERP.
  if (inicio != null) {
    fila.duracion_ms = Date.now() - inicio;
    fila.respondido_at = new Date().toISOString();
  }
  try {
    const { error } = await supabase.from("pp_siesa_envios").update(fila).eq("id", id);
    if (error) {
      console.error(`[seguimiento] envío ${id}: no se guardó "${fila.estado}": ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[seguimiento] envío ${id}: no se guardó "${fila.estado}": ${e?.message}`);
    return false;
  }
}

/* ── Comparación de snapshots ────────────────────────────────────────────── */

const num = (v) => (v == null || v === "" ? null : Number(v));

/** Impuestos y descuentos en forma canónica: mismo contenido = mismo texto. */
const canonImpuestos = (arr) =>
  JSON.stringify(
    (arr ?? [])
      .map((i) => ({ llave: String(i?.llave ?? ""), valor: num(i?.valor) }))
      .sort((a, b) => a.llave.localeCompare(b.llave) || (a.valor ?? 0) - (b.valor ?? 0)),
  );
const canonDescuentos = (arr) =>
  JSON.stringify(
    (arr ?? [])
      .map((d) => ({ orden: num(d?.orden), porcentaje: num(d?.porcentaje) }))
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0)),
  );

/** Precios iguales al centavo de 4 decimales que guarda la columna. */
const mismoPrecio = (a, b) => {
  const x = num(a);
  const y = num(b);
  if (x == null || y == null) return x === y;
  return Math.abs(x - y) < 0.00005;
};

/** `{precio, impuestos, descuentos}` de una fila de pp_cotizaciones. */
const valores = (f) => ({
  precio: num(f.precio),
  impuestos: f.impuestos ?? [],
  descuentos: f.descuentos ?? [],
});

/** Qué campos difieren entre dos filas con la misma clave. */
export function camposDistintos(antes, despues) {
  const campos = [];
  if (!mismoPrecio(antes.precio, despues.precio)) campos.push("precio");
  if (canonImpuestos(antes.impuestos) !== canonImpuestos(despues.impuestos)) campos.push("impuestos");
  if (canonDescuentos(antes.descuentos) !== canonDescuentos(despues.descuentos)) campos.push("descuentos");
  return campos;
}

const identidad = (f) => ({
  clave: f.clave,
  clave_item: f.clave_item,
  id_tercero: f.id_tercero,
  nit: f.nit ?? null,
  sucursal: f.sucursal,
  item: f.item,
  descripcion_item: f.descripcion_item ?? null,
  unidad_medida: f.unidad_medida,
  fecha_activacion: f.fecha_activacion,
});

/**
 * Las diferencias entre lo que había y lo que trae la corrida nueva.
 *
 * Función pura. `existentes` y `nuevas` son filas con la forma de pp_cotizaciones.
 *
 * `incluirBajas`: solo si el snapshot BARRIÓ. Si el barrido se omitió es porque
 * la corrida trajo de menos y no es creíble; anotar esas ausencias como "bajas"
 * sería afirmar que SIESA borró media lista porque una consulta se cortó.
 */
export function compararCotizaciones(existentes, nuevas, { incluirBajas }) {
  const previas = new Map(existentes.map((f) => [f.clave, f]));
  const cambios = [];

  for (const n of nuevas) {
    const p = previas.get(n.clave);
    if (!p) {
      cambios.push({ ...identidad(n), tipo: "alta", campos: [], antes: null, despues: valores(n) });
      continue;
    }
    previas.delete(n.clave);
    const campos = camposDistintos(valores(p), valores(n));
    if (campos.length) {
      cambios.push({ ...identidad(n), tipo: "modificada", campos, antes: valores(p), despues: valores(n) });
    }
  }

  if (incluirBajas) {
    for (const p of previas.values()) {
      cambios.push({ ...identidad(p), tipo: "baja", campos: [], antes: valores(p), despues: null });
    }
  }
  return cambios;
}

/**
 * ¿Lo mandó el portal? Un cambio es nuestro si hay un envío ACEPTADO, del mismo
 * ambiente que se está leyendo, con la misma clave (fecha incluida) y el mismo
 * precio. Si hay varios, el más reciente.
 *
 * El ambiente no es un detalle: hoy el portal escribe en QA y el snapshot lee
 * PROD. Un envío a QA que casualmente coincide con un cambio de PROD no lo hizo
 * el portal.
 *
 * Las bajas son siempre externas: el portal nunca borra una cotización.
 */
export function atribuir(cambios, envios, destinoLectura) {
  const porClave = new Map();
  const ordenados = [...envios]
    .filter((e) => ACEPTADOS.has(e.estado) && e.destino === destinoLectura)
    .sort((a, b) => new Date(b.enviado_at) - new Date(a.enviado_at));
  for (const e of ordenados) {
    for (const it of e.items ?? []) {
      if (!porClave.has(it.clave)) porClave.set(it.clave, []);
      porClave.get(it.clave).push({ envioId: e.id, precio: it.precio_propuesto });
    }
  }

  return cambios.map((c) => {
    if (c.tipo === "baja") return { ...c, origen: "externo", envio_id: null };
    const candidato = (porClave.get(c.clave) ?? []).find((x) => mismoPrecio(x.precio, c.despues?.precio));
    return candidato
      ? { ...c, origen: "portal", envio_id: candidato.envioId }
      : { ...c, origen: "externo", envio_id: null };
  });
}

/**
 * ¿Es creíble esta cantidad de cambios?
 *
 * La misma idea que `debeBarrer`: si de una corrida a otra "cambia" más de la
 * fracción tolerada del catálogo, lo más probable es que haya cambiado la
 * CONSULTA o el normalizador, no los precios. Anotar 18.000 cambios falsos
 * entierra los reales. Se registra el motivo y no se anota fila por fila.
 */
const FRACCION_MAXIMA = Number(process.env.SEGUIMIENTO_CAMBIOS_MAX_FRACCION) || 0.3;

export function cambiosCreibles(cantidad, catalogo, fraccion = FRACCION_MAXIMA) {
  const tope = Math.max(500, Math.floor(catalogo * fraccion));
  if (cantidad > tope) {
    return {
      creible: false,
      motivo:
        `${cantidad} cambios en un catálogo de ${catalogo} (tope ${tope}). Suele ser un ` +
        `cambio de la consulta o del normalizador, no de los precios.`,
    };
  }
  return { creible: true, motivo: null };
}

/* ── Lectura de lo que hay, para el snapshot ─────────────────────────────── */

const PAGINA = 1000;

/**
 * Toda `pp_cotizaciones`, paginada. Supabase corta en 1.000 filas por pedido:
 * sin paginar, el diff vería un catálogo de 1.000 y anotaría el resto como altas.
 */
export async function leerCotizacionesActuales() {
  const filas = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from("pp_cotizaciones")
      .select(
        "id, clave, clave_item, id_tercero, nit, sucursal, item, descripcion_item, " +
          "unidad_medida, fecha_activacion, precio, impuestos, descuentos, sincronizado_at",
      )
      .order("id")
      .range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`no se pudo leer pp_cotizaciones: ${error.message}`);
    filas.push(...(data ?? []));
    if (!data || data.length < PAGINA) break;
  }
  return filas;
}

/** La corrida anterior = la marca más nueva de lo que había. */
export const corridaAnteriorDe = (existentes) =>
  existentes.reduce((max, f) => (f.sincronizado_at && f.sincronizado_at > max ? f.sincronizado_at : max), "") ||
  null;

/**
 * Compara, atribuye y guarda. Nunca lanza: el snapshot ya salió bien y esto es
 * su contabilidad. Devuelve un resumen para la auditoría de la corrida.
 */
export async function registrarCambios({ existentes, nuevas, barrido, detectadoAt, destinoLectura }) {
  try {
    if (!existentes.length) {
      // Sin nada contra qué comparar, todo sería "alta". Es la línea base.
      return { registrados: 0, omitido: "sin corrida anterior: esta queda como línea base" };
    }

    const crudos = compararCotizaciones(existentes, nuevas, { incluirBajas: barrido });
    const { creible, motivo } = cambiosCreibles(crudos.length, existentes.length);
    if (!creible) {
      console.error(`[seguimiento] 🔴 diff del snapshot OMITIDO: ${motivo}`);
      return { registrados: 0, detectados: crudos.length, omitido: motivo };
    }
    if (!crudos.length) return { registrados: 0, porTipo: {}, porOrigen: {} };

    const corridaAnterior = corridaAnteriorDe(existentes);
    // Un día de margen hacia atrás: un envío aceptado justo antes de la corrida
    // anterior pudo no haber llegado a esa lectura.
    const desde = new Date(
      new Date(corridaAnterior ?? Date.now() - 30 * 864e5).getTime() - 864e5,
    ).toISOString();
    const { data: envios, error: errEnvios } = await supabase
      .from("pp_siesa_envios")
      .select("id, estado, destino, enviado_at, items")
      .gte("enviado_at", desde)
      .in("estado", [...ACEPTADOS]);
    if (errEnvios) {
      // Sin envíos todo sale "externo": peor que no anotar, porque acusa.
      console.error(`[seguimiento] no se leyeron los envíos para atribuir: ${errEnvios.message}`);
      return { registrados: 0, detectados: crudos.length, omitido: "no se pudo atribuir el origen" };
    }

    const cambios = atribuir(crudos, envios ?? [], destinoLectura).map((c) => ({
      ...c,
      detectado_at: detectadoAt,
      corrida_anterior_at: corridaAnterior,
    }));

    let registrados = 0;
    for (let i = 0; i < cambios.length; i += PAGINA) {
      const lote = cambios.slice(i, i + PAGINA);
      const { error } = await supabase.from("pp_siesa_cambios").insert(lote);
      if (error) {
        console.error(
          `[seguimiento] no se guardaron ${lote.length} cambio(s) del snapshot: ${error.message}`,
        );
        continue;
      }
      registrados += lote.length;
    }

    const contar = (k) =>
      cambios.reduce((acc, c) => ({ ...acc, [c[k]]: (acc[c[k]] || 0) + 1 }), {});
    return { registrados, detectados: cambios.length, porTipo: contar("tipo"), porOrigen: contar("origen") };
  } catch (e) {
    console.error(`[seguimiento] falló el diff del snapshot: ${e?.message}`);
    return { registrados: 0, omitido: `error: ${e?.message}` };
  }
}
