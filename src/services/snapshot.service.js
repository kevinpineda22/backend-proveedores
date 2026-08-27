/* =============================================================================
   Snapshot de cotizaciones: SIESA → pp_cotizaciones

   La consulta no acepta paginación y trae el catálogo entero de todos los
   proveedores. No se puede llamar en un request de usuario, y la respuesta cruda
   no puede acercarse al frontend. Un cron la vuelca acá y el portal lee de la
   tabla, filtrada por cuenta.
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { consultarCotizaciones } from "../config/connekta.js";
import { agruparCotizaciones } from "./normalizarCotizacion.js";
import { sincronizarMaestro } from "./maestro.service.js";

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
  const { cotizaciones, descartadas } = agruparCotizaciones(crudas);

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

  const { count: existentes } = await supabase
    .from("pp_cotizaciones")
    .select("id", { count: "exact", head: true });

  const filas = filasParaUpsert(cotizaciones, sincronizadoAt);

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

  const resultado = {
    filasCrudas: crudas.length,
    cotizaciones: filas.length,
    descartadas: descartadas.length,
    barrido: { ejecutado: barrer, motivo, borradas },
    maestro,
    duracionMs: Date.now() - inicio,
  };

  await registrar(resultado);
  return resultado;
}

/** Deja constancia de la corrida. Nunca lanza: el snapshot ya salió bien. */
async function registrar(resultado) {
  try {
    await supabase.from("pp_auditoria").insert({
      entidad: "pp_cotizaciones",
      accion: "snapshot",
      actor_rol: "cron",
      detalle: resultado,
    });
  } catch (e) {
    console.error("[snapshot] no se pudo registrar la corrida:", e?.message);
  }
}
