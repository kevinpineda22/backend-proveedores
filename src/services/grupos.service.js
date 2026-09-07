/* =============================================================================
   Sucursales hermanas — replicar una propuesta a las otras sucursales del NIT

   POR QUÉ EXISTE
   Un mismo proveedor entrega en Copacabana y en el resto, y SIESA lo guarda como
   dos sucursales del mismo NIT: "COPA ZONA 2 RAMA" (suc 001) y "ZONA 2 RAMA"
   (suc 002). Es el mismo acuerdo comercial partido por zona de entrega. El
   proveedor propone una vez y el precio tiene que llegar a las dos.

   EN SILENCIO, Y ESO ES DELIBERADO
   El reparto por sede es interno de Merkahorro; al proveedor no le sirve y no lo
   maneja. No ve la sucursal hermana, ni la línea replicada, ni sabe que existe.
   Quien SÍ la ve es compras: es su decisión y su plata.

   El silencio del lado del proveedor NO lo hace este módulo — lo hace la política
   de RLS de `pp_solicitud_lineas` (migración 006), que exige `origen='proveedor'`.
   Que dependa de la base y no de acordarse de filtrar en cada consulta es lo que
   lo vuelve confiable.

   LAS DOS COSAS QUE ESTE MÓDULO NO PUEDE HACER, MEDIDAS SOBRE DATOS REALES
   (cruce del 2026-09-06, 521 renglones comparados entre 11 pares de hermanas)

   1. **No inventa renglones.** 56 de esos 521 existen en UNA sola sucursal. Ahí
      no hay cotización vigente del otro lado, y sin vigente no hay identidad ni
      impuestos que re-emitir: replicar sería DAR DE ALTA un precio en una
      sucursal donde compras nunca lo negoció. Se omite y se informa.

   2. **No asume que las hermanas valen lo mismo.** 16 de esos 521 ya tienen
      precio distinto hoy (ZONA 2 NIVEA: $17.260 contra $17.290). Por eso cada
      réplica se evalúa contra el precio de SU sucursal: la variación —y el
      tope— se calculan sobre la base de la hermana, no sobre la del que propuso.
      Copiar la variación del origen mentiría en la bandeja del admin.

   Y por eso los grupos nacen APAGADOS (migración 007): hasta que una persona de
   compras confirma que esas dos sucursales comparten precio, acá no pasa nada.
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { evaluarPropuesta } from "./costoNeto.js";
import { porcentajesDescuento, separarVigentes } from "./normalizarCotizacion.js";

/**
 * Las OTRAS sucursales del grupo ACTIVO al que pertenece esta cuenta.
 *
 * Devuelve `[]` cuando la cuenta no está en ningún grupo, o cuando el grupo está
 * apagado. Las dos son el caso normal: hoy 30 grupos sugeridos y 0 activos.
 *
 * @returns {Promise<Array<{id:number, nit:string, sucursal:string, nombreSucursal:string}>>}
 */
export async function hermanasDe(cuenta) {
  const { data: pertenencia, error } = await supabase
    .from("pp_grupo_sucursales")
    .select("grupo_id, pp_grupos_sucursal!inner(id, activo)")
    .eq("nit", cuenta.nit)
    .eq("sucursal", cuenta.sucursal)
    .eq("pp_grupos_sucursal.activo", true)
    .maybeSingle();

  if (error) throw new Error(`No se pudieron leer las sucursales hermanas: ${error.message}`);
  if (!pertenencia) return [];

  const { data: miembros, error: e2 } = await supabase
    .from("pp_grupo_sucursales")
    .select("nit, sucursal")
    .eq("grupo_id", pertenencia.grupo_id);

  if (e2) throw new Error(`No se pudieron leer los miembros del grupo: ${e2.message}`);

  const otras = (miembros ?? []).filter((m) => m.sucursal !== cuenta.sucursal);
  if (!otras.length) return [];

  /* La cuenta destino tiene que EXISTIR en pp_cuentas: la línea replicada apunta
     a `cuenta_destino_id`. La FK de la migración 007 ya garantiza que el miembro
     del grupo es una cuenta real, pero se necesita el id. */
  const { data: cuentas, error: e3 } = await supabase
    .from("pp_cuentas")
    .select("id, nit, sucursal, nombre_sucursal")
    .eq("nit", cuenta.nit)
    .in("sucursal", otras.map((o) => o.sucursal));

  if (e3) throw new Error(`No se pudieron leer las cuentas hermanas: ${e3.message}`);

  return (cuentas ?? []).map((c) => ({
    id: c.id,
    nit: c.nit,
    sucursal: c.sucursal,
    nombreSucursal: c.nombre_sucursal,
  }));
}

/** Cómo se indexa un renglón dentro de una sucursal. La clave completa NO sirve. */
export const claveEnSucursal = (item, unidadMedida) => `${item}|${unidadMedida}`;

/**
 * Las cotizaciones vigentes de una sucursal para un conjunto de ítems.
 *
 * Busca por `item` + `unidad_medida`, NO por `clave_item`: la clave lleva la
 * sucursal adentro (`COP|tercero|sucursal|item|um`), así que la de la hermana es
 * otra. Buscar por la clave del que propuso no encontraría NUNCA nada — y el
 * síntoma sería "no existe del otro lado" en el 100 % de los renglones, que se
 * parece demasiado a un resultado legítimo como para notarlo.
 *
 * Una consulta por hermana, no una por (línea × hermana): un paquete de 40
 * productos son 40 consultas de más por cada sucursal del grupo.
 *
 * @returns {Promise<Map<string, object>>} `item|um` → cotización vigente
 */
export async function vigentesEnSucursal({ nit, sucursal }, items, aCotizacion) {
  if (!items.length) return new Map();

  const { data, error } = await supabase
    .from("pp_cotizaciones")
    .select(
      "clave, clave_item, id_tercero, nit, sucursal, moneda, item, descripcion_item, " +
        "unidad_medida, fecha_activacion, precio, impuestos, descuentos",
    )
    .eq("nit", nit)
    .eq("sucursal", sucursal)
    .in("item", [...new Set(items)]);

  if (error) throw new Error(`No se pudieron leer las cotizaciones hermanas: ${error.message}`);

  // `separarVigentes` sobre TODO el lote: un ítem+U.M. puede tener varias fechas
  // y la que importa es la que rige hoy (CONTRATO-SIESA §2.3).
  const { vigentes } = separarVigentes((data ?? []).map(aCotizacion));
  return new Map(vigentes.map((v) => [claveEnSucursal(v.item, v.unidadMedida), v]));
}

/**
 * Arma las líneas replicadas de UNA línea propia.
 *
 * Función pura: recibe la vigente de cada hermana ya leída. Así la decisión —qué
 * se replica, qué se omite y con qué números— se prueba sin base de datos.
 *
 * @param {object} args
 * @param {object} args.propuesta   `{precio, descuentos, impuestos, fechaActivacion, notas}`
 * @param {Array} args.hermanas     `[{cuenta, vigente|null}]`
 * @param {number|null} args.topePct
 * @returns {{replicas: object[], omitidas: object[]}}
 */
export function planificarReplicas({ propuesta, hermanas = [], topePct = null }) {
  const replicas = [];
  const omitidas = [];

  for (const { cuenta, vigente } of hermanas) {
    if (!vigente) {
      omitidas.push({
        cuentaId: cuenta.id,
        sucursal: cuenta.sucursal,
        nombreSucursal: cuenta.nombreSucursal,
        motivo: "sin_cotizacion_vigente",
      });
      continue;
    }
    if (!(vigente.precio > 0)) {
      // Un precio en 0 no es una base contra la que calcular una variación: daría
      // Infinity y el tope compararía contra un número sin sentido. `costoNeto`
      // lanza en ese caso a propósito; acá se corta antes.
      omitidas.push({
        cuentaId: cuenta.id,
        sucursal: cuenta.sucursal,
        nombreSucursal: cuenta.nombreSucursal,
        motivo: "sin_precio_vigente",
      });
      continue;
    }

    /* La variación se calcula contra el precio de SU sucursal.
       Copiar la del origen sería mentirle al admin justo en los renglones donde
       las hermanas ya difieren — que hoy son 16 de 521. */
    const evaluacion = evaluarPropuesta({
      precioActual: vigente.precio,
      descuentosActuales: porcentajesDescuento(vigente),
      precioPropuesto: propuesta.precio,
      descuentosPropuestos: (propuesta.descuentos ?? []).map((d) => d.porcentaje),
      topePct,
    });

    replicas.push({
      cuenta,
      vigente,
      evaluacion,
      // El precio, los descuentos y los impuestos son los MISMOS: es el mismo
      // acuerdo comercial. Lo que cambia es contra qué se compara.
      propuesta,
    });
  }

  return { replicas, omitidas };
}
