/* =============================================================================
   Costo neto y variación — LA REGLA QUE DECIDE SI ENTRA PLATA DE MÁS

   Este módulo es la autoridad del tope porcentual. El frontend tiene un gemelo
   (`src/pages/PortalProveedores/utils/costoNeto.js`) que sirve SOLO para mostrar
   el número mientras el proveedor escribe. Si los dos divergen, el peor caso es
   una vista previa confusa — nunca un precio mal aprobado, porque la decisión la
   toma esta copia, en el servidor.

   POR QUÉ EL TOPE NO SE APLICA AL PRECIO

   La intuición dice "si el proveedor sube el precio más del 5%, bloquealo". Esa
   regla tiene un agujero por el que se cuela cualquiera, y con datos reales se ve
   en dos líneas. ATÚN ALAMAR de Altipal, tal como viene hoy de SIESA:

       Precio 4.672   ·   PorcDsctoOrden1 = 3%
       Costo real     = 4.672 × 0,97 = 4.531,84

   El proveedor deja el precio intacto —subida 0%, pasa cualquier tope— y baja el
   descuento de 3% a 0%. Lo que Merkahorro paga sube a 4.672: un +3,09% real que
   el tope nunca vio, porque estaba mirando la columna equivocada.

   Combinado es peor: +4,9% de precio (justo debajo de un tope del 5%) más el
   descuento a cero da un +8,14% efectivo.

   Por eso el tope se evalúa sobre el COSTO NETO — precio menos descuentos — que
   es el número que realmente sale de la caja.
   ============================================================================= */

/**
 * Modo de composición de los descuentos por orden.
 *
 * `cascada`: cada descuento se aplica sobre el saldo del anterior.
 *   4.672 con 3% y 2% → 4.672 × 0,97 × 0,98 = 4.441,20
 *
 * `aditivo`: los porcentajes se suman y se aplican una vez.
 *   4.672 con 3% y 2% → 4.672 × 0,95 = 4.438,40
 *
 * ✅ CONFIRMADO POR COMPRAS (2026-08-27): es CASCADA. Se preguntó con el ejemplo
 * de arriba —$4.672 con 3% y 2%— y la respuesta fue $4.441,20, o sea el segundo
 * descuento aplicado sobre el saldo del primero.
 *
 * Coincide con lo que ya se asumía, así que no hubo que cambiar el cálculo. Pero
 * la confirmación importa igual: se buscaron por fuerza bruta las combinaciones
 * donde el modo VOLTEA la decisión del tope y aparecieron 4.862. Ejemplo: con
 * descuentos de 20% y 20%, bajando el segundo a 16% sin tocar el precio, cascada
 * da +5,00% y aditivo +6,67%. Contra un tope del 5%, uno pasa y el otro no.
 *
 * Si algún día compras cambia de criterio, se cambia esta constante Y su gemelo
 * del frontend (`utils/costoNeto.js`). Los dos, o divergen.
 */
export const MODO_DESCUENTO = "cascada";

/** Un `null` de SIESA en `PorcDsctoOrdenN` significa "sin descuento", o sea 0%. */
const pct = (v) => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new TypeError(`Porcentaje de descuento inválido: ${JSON.stringify(v)}`);
  }
  if (n < 0 || n > 100) {
    throw new RangeError(`Porcentaje de descuento fuera de rango (0–100): ${n}`);
  }
  return n;
};

/**
 * Redondeo a 4 decimales — el mismo alcance que maneja SIESA en sus campos
 * decimales. Se hace en cada paso y no solo al final: dejar correr el error de
 * punto flotante a través de tres multiplicaciones encadenadas produce colas del
 * tipo 4441.199999999999, y esa cola después se compara contra un tope. Un
 * bloqueo que se activa o no según el bit 52 de un double no es una regla de
 * negocio, es una lotería.
 */
const r4 = (n) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

/**
 * Costo neto: lo que Merkahorro realmente paga por una unidad.
 *
 * @param {number} precio      Precio antes de impuestos, tal como lo trae SIESA.
 * @param {Array<number|null>} descuentos  Porcentajes por orden (1, 2, 3…).
 *                                          `null` cuenta como 0%.
 * @returns {number} Costo neto redondeado a 4 decimales.
 */
export function costoNeto(precio, descuentos = []) {
  const p = Number(precio);
  if (!Number.isFinite(p)) {
    throw new TypeError(`Precio inválido: ${JSON.stringify(precio)}`);
  }
  if (p < 0) {
    throw new RangeError(`El precio no puede ser negativo: ${p}`);
  }

  const lista = (Array.isArray(descuentos) ? descuentos : [descuentos]).map(pct);

  if (MODO_DESCUENTO === "aditivo") {
    const suma = lista.reduce((a, b) => a + b, 0);
    // Descuentos aditivos que pasan de 100 darían un costo negativo. Eso no es
    // una promoción agresiva: es data corrupta, y hay que verla, no absorberla.
    if (suma > 100) {
      throw new RangeError(`Los descuentos aditivos suman ${suma}%, más de 100%`);
    }
    return r4(p * (1 - suma / 100));
  }

  return r4(lista.reduce((acc, d) => r4(acc * (1 - d / 100)), p));
}

/**
 * Variación entre dos costos netos, como fracción (0.05 = 5%).
 *
 * Positiva = a Merkahorro le sale más caro. Negativa = más barato.
 *
 * @returns {number} Fracción redondeada a 6 decimales.
 */
export function variacion(costoActual, costoPropuesto) {
  const a = Number(costoActual);
  const b = Number(costoPropuesto);

  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError("Los costos deben ser números finitos");
  }
  // Sin costo actual no hay porcentaje que calcular: dividir por cero daría
  // Infinity y un Infinity comparado contra un tope bloquea SIEMPRE, incluso una
  // baja de precio. Un ítem sin precio vigente es un caso a resolver a mano.
  if (a === 0) {
    throw new RangeError(
      "No se puede calcular la variación: el costo actual es 0 (ítem sin precio vigente en SIESA)",
    );
  }

  return Math.round(((b - a) / a + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * ¿Esta propuesta excede el tope que le puso el admin al proveedor?
 *
 * Reglas, todas deliberadas:
 *
 * - Solo bloquea SUBIDAS. Una baja de costo nos favorece y pasa siempre, por
 *   grande que sea.
 * - `topePct = null` es SIN TOPE, no 0%. Confundirlos congelaría a todos los
 *   proveedores que nadie configuró todavía, sin que nadie entienda por qué.
 * - `topePct = 0` sí significa cero: ninguna subida permitida.
 *
 * @param {object} args
 * @param {number} args.precioActual
 * @param {Array<number|null>} args.descuentosActuales
 * @param {number} args.precioPropuesto
 * @param {Array<number|null>} args.descuentosPropuestos
 * @param {number|null} args.topePct  Tope de subida en puntos porcentuales (5 = 5%).
 * @returns {{
 *   costoActual: number, costoPropuesto: number,
 *   variacion: number, variacionPct: number,
 *   topePct: number|null, excede: boolean
 * }}
 */
export function evaluarPropuesta({
  precioActual,
  descuentosActuales = [],
  precioPropuesto,
  descuentosPropuestos = [],
  topePct = null,
}) {
  const cActual = costoNeto(precioActual, descuentosActuales);
  const cPropuesto = costoNeto(precioPropuesto, descuentosPropuestos);
  const v = variacion(cActual, cPropuesto);

  const tope = topePct == null || topePct === "" ? null : Number(topePct);
  if (tope != null && (!Number.isFinite(tope) || tope < 0)) {
    throw new RangeError(`Tope porcentual inválido: ${JSON.stringify(topePct)}`);
  }

  return {
    costoActual: cActual,
    costoPropuesto: cPropuesto,
    variacion: v,
    variacionPct: Math.round((v * 100 + Number.EPSILON) * 1e4) / 1e4,
    topePct: tope,
    excede: tope != null && v > 0 && v * 100 > tope,
  };
}
