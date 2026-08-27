/* =============================================================================
   Normalizador de la consulta `merkahorro_cotizaciones_dev`

   Convierte lo que devuelve Connekta —con relleno de CHAR, descuentos pivoteados
   en columnas y una sola columna de impuesto— en cotizaciones limpias, agrupadas
   por su llave natural.

   Es el ÚNICO lugar del backend que toca la forma cruda de SIESA. De acá para
   adentro se trabaja con objetos normalizados; nadie más lee `PorcDsctoOrden2`
   ni se acuerda de trimear.
   ============================================================================= */

import { trim } from "./formatoSiesa.js";

/**
 * Moneda por defecto.
 *
 * La consulta `_dev` no trae la columna; la propuesta en docs/CONSULTA-COTIZACIONES.sql
 * sí. Cuando no viene, se asume COP — que es lo que hay hoy en toda la data y lo
 * que el conector escribe como campo fijo (`F212_ID_MONEDA`).
 *
 * Se lee del dato en vez de darla por sentada para que el día que aparezca un
 * proveedor en USD el problema SE VEA, en lugar de que un precio en dólares entre
 * al ERP como si fueran pesos. `armarPayload()` corta ahí mismo.
 */
export const MONEDA = "COP";

/** Órdenes de descuento que la consulta expone. El conector admite hasta 9. */
export const ORDENES_DESCUENTO = [1, 2, 3];

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Recorta un ISO o un DATE a `AAAA-MM-DD`. Sin `Date`, sin husos. Ver formatoSiesa. */
const soloFecha = (v) => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(trim(v));
  return m ? m[1] : null;
};

/**
 * Hoy en Colombia, como `AAAA-MM-DD`.
 *
 * El servidor corre en UTC: a partir de las 19:00 de Colombia, `new Date()` ya
 * está en el día siguiente. Una cotización con activación mañana se daría por
 * vigente cinco horas antes de tiempo. `Intl` con `timeZone` resuelve esto sin
 * traer una librería, y `en-CA` produce justo el formato ISO que necesitamos.
 */
export function hoyEnColombia(ahora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ahora);
}

/**
 * Llave natural de una cotización en SIESA. Es lo que identifica un registro
 * único del lado del ERP — ver docs/CONTRATO-SIESA.md §2.
 */
export function claveCotizacion({ moneda, idTercero, sucursal, item, unidadMedida, fechaActivacion }) {
  return [moneda || MONEDA, idTercero, sucursal, item, unidadMedida, fechaActivacion].join("|");
}

/**
 * Llave del renglón editable del portal: la misma, SIN la fecha.
 *
 * Es el par ítem+U.M. de un proveedor: la fila que el proveedor ve y sobre la que
 * propone. Un ítem no tiene un precio, tiene un precio por unidad de medida.
 */
export function claveItem({ moneda, idTercero, sucursal, item, unidadMedida }) {
  return [moneda || MONEDA, idTercero, sucursal, item, unidadMedida].join("|");
}

/**
 * Normaliza UNA fila cruda.
 *
 * @returns {{ok: true, fila: object} | {ok: false, motivo: string, cruda: object}}
 */
export function normalizarFila(cruda) {
  const idTercero = trim(cruda?.IdTercero);
  const nit = trim(cruda?.NitTercero) || idTercero;
  const sucursal = trim(cruda?.Sucursal);
  const unidadMedida = trim(cruda?.UM);
  const fechaActivacion = soloFecha(cruda?.FechaActivacion);
  const item = num(cruda?.CodigoItem);

  // Un descarte NUNCA es silencioso: sale con motivo y con la fila cruda adjunta,
  // para que el snapshot pueda reportarlo. Una fila que desaparece sin dejar
  // rastro es un producto que el proveedor no puede cotizar y nadie sabe por qué.
  if (!idTercero) return { ok: false, motivo: "sin IdTercero", cruda };
  if (!sucursal) return { ok: false, motivo: "sin Sucursal", cruda };
  if (item == null || !Number.isInteger(item) || item <= 0) {
    return { ok: false, motivo: `CodigoItem inválido (${JSON.stringify(cruda?.CodigoItem)})`, cruda };
  }
  if (!unidadMedida) return { ok: false, motivo: "sin UM", cruda };
  if (!fechaActivacion) {
    return { ok: false, motivo: `FechaActivacion inválida (${JSON.stringify(cruda?.FechaActivacion)})`, cruda };
  }

  const llaveImpuesto = trim(cruda?.IdLlaveImpto);
  const valorImpuesto = num(cruda?.ValorImpto);

  return {
    ok: true,
    fila: {
      idTercero, // ← va al conector como NIT_PROVEEDOR
      nit, // ← lo que el proveedor teclea en el login
      razonSocial: trim(cruda?.RazonSocial),
      sucursal,
      nombreSucursal: trim(cruda?.DescSucursal),
      // La consulta vieja no trae la columna; sin dato se asume COP y la llave
      // queda idéntica a la que ya está guardada. Ver el comentario de MONEDA.
      moneda: trim(cruda?.Moneda) || MONEDA,
      item,
      descripcionItem: trim(cruda?.DescItem),
      unidadMedida,
      fechaActivacion,
      precio: num(cruda?.Precio),
      // Un impuesto sin llave o sin valor no es un impuesto de cero: es una fila
      // sin impuesto. Se omite en vez de inventar un 0 que después se re-emitiría.
      impuesto: llaveImpuesto && valorImpuesto != null ? { llave: llaveImpuesto, valor: valorImpuesto } : null,
      descuentos: ORDENES_DESCUENTO.map((orden) => ({
        orden,
        porcentaje: num(cruda?.[`PorcDsctoOrden${orden}`]),
      })).filter((d) => d.porcentaje != null),
    },
  };
}

/**
 * Agrupa filas crudas en cotizaciones únicas por llave natural.
 *
 * POR QUÉ SE AGRUPA SI CADA FILA YA PARECE UNA COTIZACIÓN
 *
 * Porque `IdLlaveImpto` es UNA sola columna y las llaves de impuesto son al menos
 * DOS (ICO, IBUA). Un ítem que tenga los dos no entra en una fila: o la consulta
 * repite el renglón —una vez por impuesto— o pierde uno. En toda la muestra
 * vienen en `null`, así que todavía no se sabe cuál de las dos cosas hace.
 *
 * Agrupar por la llave y acumular los impuestos en un array funciona bien en los
 * dos escenarios: si la consulta duplica, los renglones se colapsan en uno con
 * dos impuestos; si no duplica, queda uno con un impuesto o ninguno. Escribirlo
 * tolerante ahora cuesta diez líneas; descubrirlo en producción cuesta el ICO de
 * un catálogo entero.
 *
 * @returns {{cotizaciones: object[], descartadas: Array<{motivo: string, cruda: object}>}}
 */
export function agruparCotizaciones(crudas = []) {
  const porClave = new Map();
  const descartadas = [];

  for (const cruda of crudas) {
    const r = normalizarFila(cruda);
    if (!r.ok) {
      descartadas.push({ motivo: r.motivo, cruda: r.cruda });
      continue;
    }

    const { impuesto, ...resto } = r.fila;
    const clave = claveCotizacion(resto);
    const previa = porClave.get(clave);

    if (!previa) {
      porClave.set(clave, { ...resto, clave, claveItem: claveItem(resto), impuestos: impuesto ? [impuesto] : [] });
      continue;
    }

    // Mismo registro repetido. Los descuentos ya vinieron completos en la primera
    // fila (son columnas, no filas): solo hay que sumar el impuesto nuevo.
    if (impuesto && !previa.impuestos.some((i) => i.llave === impuesto.llave)) {
      previa.impuestos.push(impuesto);
    }
  }

  return { cotizaciones: [...porClave.values()], descartadas };
}

/**
 * De todas las cotizaciones de un ítem+U.M., cuál es la VIGENTE hoy.
 *
 * SIESA guarda precios futuros como registros propios —la fecha es parte de la
 * llave—, así que un mismo ítem+U.M. puede traer varias filas: la que rige y las
 * que van a regir. Mostrar la primera que aparezca es una lotería.
 *
 * Vigente = la de mayor `fechaActivacion` que no sea futura. Las fechas están en
 * `AAAA-MM-DD`, formato en que el orden alfabético ES el orden cronológico: se
 * comparan como strings, sin construir un solo `Date`.
 *
 * @param {object[]} cotizaciones
 * @param {string} hoy `AAAA-MM-DD`. Por defecto, hoy en Colombia.
 * @returns {{vigentes: object[], programadas: object[]}}
 */
export function separarVigentes(cotizaciones = [], hoy = hoyEnColombia()) {
  const porItem = new Map();
  const programadas = [];

  for (const c of cotizaciones) {
    if (c.fechaActivacion > hoy) {
      programadas.push(c);
      continue;
    }
    const previa = porItem.get(c.claveItem);
    if (!previa || c.fechaActivacion > previa.fechaActivacion) {
      porItem.set(c.claveItem, c);
    }
  }

  return { vigentes: [...porItem.values()], programadas };
}

/** Porcentajes de descuento listos para `costoNeto()`. */
export const porcentajesDescuento = (cotizacion) =>
  (cotizacion?.descuentos ?? []).map((d) => d.porcentaje);
