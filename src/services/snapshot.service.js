/* =============================================================================
   Snapshot de cotizaciones: SIESA → pp_cotizaciones

   La consulta no acepta paginación y trae el catálogo entero de todos los
   proveedores. No se puede llamar en un request de usuario, y la respuesta cruda
   no puede acercarse al frontend. Un cron la vuelca acá y el portal lee de la
   tabla, filtrada por cuenta.
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { consultarCotizaciones } from "../config/connekta.js";
import { agruparCotizaciones, estadoCreible } from "./normalizarCotizacion.js";
import { sincronizarMaestro } from "./maestro.service.js";
import { auditar } from "./auditoria.js";
import { leerCotizacionesActuales, registrarCambios, destinoDe } from "./seguimientoSiesa.js";
import { urlLectura } from "./verificarCotizacion.js";

/** Supabase no traga un upsert de 60.000 filas de una. */
const LOTE = 1000;

/**
 * Cuánto puede encoger el catálogo de una corrida a la otra antes de sospechar.
 *
 * 0.5 = si el snapshot nuevo trae menos de la mitad de lo que había, NO se barre
 * lo viejo. Ver `debeBarrer`.
 */
const RETENCION_MINIMA = Number(process.env.SNAPSHOT_RETENCION_MINIMA) || 0.5;

/**
 * ¿Es seguro borrar las filas que esta corrida no trajo?
 *
 * El barrido existe para que una cotización que desapareció de SIESA desaparezca
 * del portal. Pero borrar es destructivo, y una consulta que devuelve de menos —
 * porque SIESA está a medio responder, porque un filtro cambió, porque hubo un
 * timeout parcial— borraría medio catálogo y dejaría a los proveedores sin poder
 * cotizar productos que sí existen.
 *
 * Entonces el barrido se hace solo si el resultado es CREÍBLE:
 *   - nunca con cero filas (eso es un fallo, no un catálogo vacío);
 *   - nunca si encogió más de lo tolerado.
 *
 * Si no se barre, el snapshot queda con filas viejas de más. Eso es un problema
 * menor y visible; borrar de más es un problema grave y silencioso.
 *
 * @returns {{barrer: boolean, motivo: string|null}}
 */
export function debeBarrer(nuevas, existentes, retencion = RETENCION_MINIMA) {
  if (nuevas === 0) {
    return { barrer: false, motivo: "la consulta no devolvió ninguna fila" };
  }
  if (existentes > 0 && nuevas < existentes * retencion) {
    return {
      barrer: false,
      motivo:
        `el catálogo encogió de ${existentes} a ${nuevas} filas ` +
        `(menos del ${Math.round(retencion * 100)}% de lo anterior)`,
    };
  }
  return { barrer: true, motivo: null };
}

/**
 * Convierte cotizaciones normalizadas en filas de `pp_cotizaciones`.
 * Función pura: el mapeo se prueba sin tocar la base.
 */
export function filasParaUpsert(cotizaciones, sincronizadoAt) {
  return cotizaciones.map((c) => ({
    clave: c.clave,
    clave_item: c.claveItem,
    id_tercero: c.idTercero,
    nit: c.nit,
    sucursal: c.sucursal,
    item: c.item,
    descripcion_item: c.descripcionItem,
    unidad_medida: c.unidadMedida,
    moneda: c.moneda,
    fecha_activacion: c.fechaActivacion,
    precio: c.precio,
    impuestos: c.impuestos,
    descuentos: c.descuentos,
    // null = no se sabe (la consulta no trajo el estado): NO bloquea. Ver estadoItem.
    item_activo: c.activo ?? null,
    sincronizado_at: sincronizadoAt,
  }));
}

/** Parte un arreglo en lotes de `tam`. */
export function enLotes(arr, tam = LOTE) {
  const lotes = [];
  for (let i = 0; i < arr.length; i += tam) lotes.push(arr.slice(i, i + tam));
  return lotes;
}

/**
 * Corre el snapshot completo.
 *
 * @returns {Promise<{
 *   filasCrudas: number, cotizaciones: number, descartadas: number,
 *   barrido: {ejecutado: boolean, motivo: string|null, borradas: number},
 *   duracionMs: number
 * }>}
 */
export async function sincronizar() {
  const inicio = Date.now();
  const sincronizadoAt = new Date().toISOString();

  const crudas = await consultarCotizaciones();
  const agrupadas = agruparCotizaciones(crudas);
  const { descartadas } = agrupadas;
  const { cotizaciones, descartado: estadoDescartado } = estadoCreible(agrupadas.cotizaciones);
  if (estadoDescartado) console.error(`[snapshot] 🔴 ${estadoDescartado}`);

  // Los descartes se reportan SIEMPRE, aunque el snapshot salga bien. Una fila que
  // SIESA manda y nosotros no podemos leer es un producto que el proveedor no ve
  // en el portal — y sin este log, nadie sabría por qué falta.
  if (descartadas.length) {
    const porMotivo = descartadas.reduce((acc, d) => {
      acc[d.motivo] = (acc[d.motivo] || 0) + 1;
      return acc;
    }, {});
    console.warn(`[snapshot] ${descartadas.length} fila(s) descartada(s):`, porMotivo);
  }

  /*
   * ÓRDENES DE DESCUENTO QUE NO SABEMOS LEER.
   *
   * `ORDENES_DESCUENTO` está fijo en [1,2,3] —verificado el 2026-08-27 contra
   * SIESA—. Si aparece un orden 4, el normalizador NI LO MIRA, y eso no se ve:
   * la fila entra igual, con un descuento de menos. El costo neto sale más alto
   * de lo real, el tope se calcula sobre ese número inflado, y el descuento se
   * pierde al re-emitir.
   *
   * Antes esto era una nota en la documentación que decía "revisar si cambian
   * las condiciones". Una nota no revisa nada: el cron sí. Ver PENDIENTES §5.5.
   */
  const conOrdenExtra = cotizaciones.filter((c) => c.ordenesDesconocidos?.length);
  if (conOrdenExtra.length) {
    const ordenes = [...new Set(conOrdenExtra.flatMap((c) => c.ordenesDesconocidos))].sort();
    console.error(
      `[snapshot] 🔴 ${conOrdenExtra.length} cotización(es) traen órdenes de descuento ` +
        `NO soportados (${ordenes.join(", ")}). Se están DESCARTANDO: el costo neto de ` +
        `esos ítems sale más alto de lo real y el tope calcula mal. ` +
        `Ejemplos: ${conOrdenExtra.slice(0, 5).map((c) => c.item).join(", ")}. ` +
        `Hay que decidir si el orden nuevo va en cascada y tocar también el gemelo ` +
        `del front (utils/costoNeto.js). Ver PENDIENTES §5.5.`,
    );
  }

  const { count: existentes } = await supabase
    .from("pp_cotizaciones")
    .select("id", { count: "exact", head: true });

  const filas = filasParaUpsert(cotizaciones, sincronizadoAt);

  // Seguimiento (sql/013): la foto de lo que había, ANTES de pisarla con el
  // upsert. Si no se puede leer, el snapshot sigue igual: comparar es un
  // agregado, refrescar el catálogo es el trabajo.
  let previas = null;
  try {
    previas = await leerCotizacionesActuales();
  } catch (e) {
    console.error(`[snapshot] sin diff de cambios esta corrida: ${e.message}`);
  }

  for (const lote of enLotes(filas)) {
    const { error } = await supabase
      .from("pp_cotizaciones")
      .upsert(lote, { onConflict: "clave" });
    if (error) throw new Error(`Snapshot: falló el upsert — ${error.message}`);
  }

  const { barrer, motivo } = debeBarrer(filas.length, existentes ?? 0);
  let borradas = 0;

  if (barrer) {
    // Todo lo que esta corrida NO tocó ya no está en SIESA.
    const { count, error } = await supabase
      .from("pp_cotizaciones")
      .delete({ count: "exact" })
      .lt("sincronizado_at", sincronizadoAt);
    if (error) throw new Error(`Snapshot: falló el barrido — ${error.message}`);
    borradas = count ?? 0;
  } else {
    console.warn(`[snapshot] ⚠️  Barrido OMITIDO: ${motivo}. Quedan filas viejas en la tabla.`);
  }

  // El maestro se deriva de estas MISMAS cotizaciones, no de la tabla: acá están
  // `nombreSucursal` y `razonSocial`, que el snapshot no persiste porque se
  // repetirían en las 18.000 filas. Fuente provisional hasta que llegue la
  // consulta de terceros — ver maestro.service.js.
  const maestro = await sincronizarMaestro(cotizaciones);

  // Las bajas solo cuentan si se barrió: si no, la corrida no es creíble.
  const cambiosSiesa = previas
    ? await registrarCambios({
        existentes: previas,
        nuevas: filas,
        barrido: barrer,
        detectadoAt: sincronizadoAt,
        destinoLectura: destinoDe(urlLectura()),
      })
    : { registrados: 0, omitido: "no se pudo leer la tabla antes del upsert" };

  const resultado = {
    filasCrudas: crudas.length,
    cotizaciones: filas.length,
    descartadas: descartadas.length,
    // Viaja en el resultado —y por lo tanto queda en `registrar()`— para que el
    // día que pase se pueda ver en el histórico de corridas, no solo en un log
    // de Vercel que rota.
    conOrdenDescuentoNoSoportado: conOrdenExtra.length,
    barrido: { ejecutado: barrer, motivo, borradas },
    maestro,
    cambiosSiesa,
    duracionMs: Date.now() - inicio,
  };

  await registrar(resultado);
  return resultado;
}

/* =============================================================================
   Refresco de UN proveedor — al ingresar al portal, o cuando el admin abre su
   perfil (pedido de compras, 2026-11-13: "si mueven algo en SIESA, no podemos
   esperar hasta mañana para verlo").

   LA RESTRICCIÓN QUE MANDA EL DISEÑO: las consultas personalizadas de Connekta
   NO aceptan parámetros. Verificado contra producción el 2026-11-13:
   `parametros=IdTercero=…` → HTTP 400 "el query a ejecutar no maneja
   parametros". No hay forma de pedirle a SIESA "solo Quala".

   Entonces: se LEE el catálogo entero (~20 páginas, ~20 s) y se ESCRIBE solo lo
   del proveedor. Lo caro es la lectura, así que se protege por dos lados:

     · `REFRESCO_PROVEEDOR_MIN` (10 min por defecto): si las filas de ese NIT se
       sincronizaron hace menos, no se vuelve a leer. Vive en la BASE, no en
       memoria, para que valga entre instancias de Vercel.
     · Una lectura en curso se COMPARTE dentro de la instancia, y su resultado se
       reutiliza `LECTURA_CACHE_SEG`: diez proveedores que entran juntos son una
       lectura al ERP, no diez.

   El cron diario sigue siendo el que barre el catálogo COMPLETO y arma el
   maestro. Esto solo adelanta lo de un proveedor.
   ============================================================================= */

const VIGENCIA_PROVEEDOR_MS =
  (Number(process.env.REFRESCO_PROVEEDOR_MIN) || 10) * 60_000;
const LECTURA_CACHE_MS = (Number(process.env.LECTURA_CACHE_SEG) || 90) * 1000;

/** @type {{promesa: Promise<{filasCrudas:number, cotizaciones:object[]}>, at:number}|null} */
let lecturaCompartida = null;

/** La lectura completa de SIESA, compartida entre pedidos de la misma instancia. */
function leerCatalogoSiesa() {
  if (lecturaCompartida && Date.now() - lecturaCompartida.at < LECTURA_CACHE_MS) {
    return lecturaCompartida.promesa;
  }
  const promesa = consultarCotizaciones().then((crudas) => {
    const { cotizaciones, descartado } = estadoCreible(agruparCotizaciones(crudas).cotizaciones);
    if (descartado) console.error(`[refresco] 🔴 ${descartado}`);
    return { filasCrudas: crudas.length, cotizaciones };
  });
  lecturaCompartida = { promesa, at: Date.now() };
  // Un fallo no se cachea: el próximo pedido vuelve a intentar.
  promesa.catch(() => {
    if (lecturaCompartida?.promesa === promesa) lecturaCompartida = null;
  });
  return promesa;
}

/** Solo para los tests: olvidar la lectura compartida. */
export function _olvidarLectura() {
  lecturaCompartida = null;
}

/**
 * ¿Hace falta volver a leer SIESA para este proveedor?
 * Función pura: el umbral se prueba sin base.
 */
export function refrescoVigente(ultimaSincronizacion, ahora = Date.now(), vigenciaMs = VIGENCIA_PROVEEDOR_MS) {
  if (!ultimaSincronizacion) return false;
  const t = new Date(ultimaSincronizacion).getTime();
  return Number.isFinite(t) && ahora - t < vigenciaMs;
}

/**
 * ¿Se pueden borrar las filas del proveedor que esta lectura no trajo?
 *
 * Mismo criterio que `debeBarrer`, con una guarda más: si el proveedor tenía
 * filas y la lectura no trajo NINGUNA, no se borra. Puede ser real (le sacaron
 * todo el catálogo), pero también un recorrido incompleto — y dejar a un
 * proveedor con la tabla vacía es el error grave. El cron de la noche, que mira
 * el catálogo entero, decide.
 */
export function debeBarrerProveedor({ propias, previasProveedor, total, existentesTotal }) {
  const global = debeBarrer(total, existentesTotal);
  if (!global.barrer) return global;
  if (propias === 0 && previasProveedor > 0) {
    return { barrer: false, motivo: "la lectura no trajo ninguna fila de este proveedor" };
  }
  return { barrer: true, motivo: null };
}

/** Las filas actuales de un NIT, paginadas (Supabase corta en 1.000). */
async function leerDeNit(nit) {
  const filas = [];
  for (let desde = 0; ; desde += LOTE) {
    const { data, error } = await supabase
      .from("pp_cotizaciones")
      .select(
        "id, clave, clave_item, id_tercero, nit, sucursal, item, descripcion_item, " +
          "unidad_medida, fecha_activacion, precio, impuestos, descuentos, sincronizado_at",
      )
      .eq("nit", nit)
      .order("id")
      .range(desde, desde + LOTE - 1);
    if (error) throw new Error(`no se pudo leer pp_cotizaciones del NIT ${nit}: ${error.message}`);
    filas.push(...(data ?? []));
    if (!data || data.length < LOTE) break;
  }
  return filas;
}

/**
 * Refresca las cotizaciones de UN proveedor (todas sus sucursales) desde SIESA.
 *
 * @param {string} nit
 * @param {object} [opciones]
 * @param {boolean} [opciones.forzar]  Saltar la ventana de `REFRESCO_PROVEEDOR_MIN`.
 * @param {string} [opciones.actorRol] Para la auditoría: `pp_proveedor` o `pp_admin`.
 * @param {string} [opciones.actorUserId]
 * @returns {Promise<{actualizado: boolean, motivo: string|null, sincronizadoAt: string|null,
 *                    cotizaciones?: number, borradas?: number, duracionMs?: number}>}
 */
export async function sincronizarProveedor(nit, { forzar = false, actorRol, actorUserId } = {}) {
  const inicio = Date.now();
  const n = String(nit ?? "").trim();
  if (!n) throw new Error("sincronizarProveedor: falta el NIT");

  const previas = await leerDeNit(n);
  const ultima = corridaMasNueva(previas);

  if (!forzar && refrescoVigente(ultima)) {
    return { actualizado: false, motivo: "reciente", sincronizadoAt: ultima };
  }

  const sincronizadoAt = new Date().toISOString();
  const { cotizaciones } = await leerCatalogoSiesa();
  const filas = filasParaUpsert(
    cotizaciones.filter((c) => String(c.nit).trim() === n),
    sincronizadoAt,
  );

  for (const lote of enLotes(filas)) {
    const { error } = await supabase.from("pp_cotizaciones").upsert(lote, { onConflict: "clave" });
    if (error) throw new Error(`Refresco ${n}: falló el upsert — ${error.message}`);
  }

  const { count: existentesTotal } = await supabase
    .from("pp_cotizaciones")
    .select("id", { count: "exact", head: true });

  const { barrer, motivo } = debeBarrerProveedor({
    propias: filas.length,
    previasProveedor: previas.length,
    total: cotizaciones.length,
    existentesTotal: existentesTotal ?? 0,
  });

  let borradas = 0;
  if (barrer) {
    const { count, error } = await supabase
      .from("pp_cotizaciones")
      .delete({ count: "exact" })
      .eq("nit", n)
      .lt("sincronizado_at", sincronizadoAt);
    if (error) throw new Error(`Refresco ${n}: falló el barrido — ${error.message}`);
    borradas = count ?? 0;
  } else if (motivo) {
    console.warn(`[refresco ${n}] barrido OMITIDO: ${motivo}`);
  }

  /* El seguimiento de cambios (sql/013) se registra ACÁ también. Si no, un
     cambio que este refresco ya trajo no aparecería nunca: a la noche, el cron
     compararía contra filas que ya están al día y no vería diferencia. */
  const cambiosSiesa = await registrarCambios({
    existentes: previas,
    nuevas: filas,
    barrido: barrer,
    detectadoAt: sincronizadoAt,
    destinoLectura: destinoDe(urlLectura()),
  });

  const resultado = {
    actualizado: true,
    motivo: null,
    sincronizadoAt,
    cotizaciones: filas.length,
    borradas,
    duracionMs: Date.now() - inicio,
  };

  await auditar({
    entidad: "pp_cotizaciones",
    entidadId: n,
    accion: "refresco_proveedor",
    actorRol,
    actorUserId,
    detalle: { ...resultado, barrido: { ejecutado: barrer, motivo }, cambiosSiesa },
  });

  return resultado;
}

/** La marca de sincronización más nueva de un conjunto de filas. */
const corridaMasNueva = (filas) =>
  filas.reduce((max, f) => (f.sincronizado_at && f.sincronizado_at > max ? f.sincronizado_at : max), "") ||
  null;

/** Deja constancia de la corrida. Nunca lanza: el snapshot ya salió bien. */
async function registrar(resultado) {
  await auditar({
    entidad: "pp_cotizaciones",
    accion: "snapshot",
    actorRol: "cron",
    detalle: resultado,
  });
}
