/* =============================================================================
   Diferencias de costo: lo que se facturó distinto de lo que entró

   QUÉ RESPONDE
   Cuando llega mercancía, SIESA registra una ENTRADA (CEA) al costo de la orden
   de compra. Si después la factura del proveedor viene por otro valor, compras
   registra un AJUSTE contra esa factura:

     CAS  ajuste por salida   → llegó por MENOR costo
     CAE  ajuste por entrada  → llegó MÁS COSTOSO

   Esta pantalla muestra, por cada entrada con ajuste, el costo unitario REAL
   antes de impuestos. Y lleva el seguimiento de si compras ya corrigió la
   cotización, para que la próxima orden salga con el precio bueno.

   REEMPLAZA a un Excel ("Novedades al 30 de noviembre") que calculaba mal. Medido
   contra la base el 2026-09-14: de 229 filas con costo, 221 dan igual con esta
   regla y las 8 restantes eran errores del Excel. Ver docs/PENDIENTES.md §9.

   LAS REGLAS — confirmadas por María José (compras), 2026-09-14
   1. La llave es FACTURA + ÍTEM (`docto_causacion`, `item`). Una misma factura
      puede llegar partida en varias entradas: 24 unidades facturadas, 12 en una
      CEA y 12 en otra.
   2. Solo facturas CFP y CFM. Las CNJ, CDN, CND, CDM y las entradas sin factura
      no se tocan.
   3. Sin CAS ni CAE no hay diferencia: "llegó bien" y no se muestra.
   4. El ajuste de una factura repartida SE REPARTE por cantidad entre sus
      entradas. El Excel lo sumaba ENTERO a cada una, y dividía por la cantidad
      parcial: una entrada de 2 unidades daba −$43.175 por unidad.
   5. Las unidades BONIFICADAS (valor bruto 0) NO DILUYEN el costo. Ni reciben
      ajuste ni entran en la división.
   6. Las devoluciones (CDP) no entran en el costo. Van a servir aparte, para
      analítica por motivo.
   7. Antes de impuestos = bruto − descuentos. IVA, ICO, IBUA e IPCU quedan AFUERA.
      Verificado en las 3.986 filas del Excel: `neto = bruto − dscto + impuestos`
      sin una sola excepción.

   DOS TRAMPAS DE LOS DATOS
   - **SIESA guarda los CAS en POSITIVO.** El signo lo pone el tipo de documento
     (`ajusteNeto`), no el número. Sumar el valor tal cual convierte un
     "llegó más barato" en "llegó más caro".
   - **El NIT viene con relleno** (`"800007955      "`). Se recorta en la
     consulta; sin eso ningún proveedor encuentra sus filas.
   ============================================================================= */

import { hoyEnColombia } from "./normalizarCotizacion.js";

/** Facturas cuyas entradas se evalúan. CNJ y el resto quedan afuera por omisión. */
export const CAUSACIONES = Object.freeze(["CFP", "CFM"]);

/** Cuántos meses hacia atrás se puede consultar. Johan, 2026-09-14. */
export const MESES_VENTANA = 3;

const redondear = (n, dec = 2) =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dec) / 10 ** dec;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ── Fechas: texto AAAA-MM-DD, nunca `Date` local ─────────────────────────── */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * La misma fecha, N meses antes. Si el día no existe en ese mes, el último.
 * 31 de mayo − 3 meses = 28 de febrero, no 3 de marzo.
 */
export function restarMeses(fecha, meses) {
  const [a, m, d] = fecha.split("-").map(Number);
  const indice = a * 12 + (m - 1) - meses;
  const anio = Math.floor(indice / 12);
  const mes = indice - anio * 12; // 0-11
  const ultimoDia = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  const dia = Math.min(d, ultimoDia);
  return `${anio}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** Día siguiente, sobre el texto. Para el `<` exclusivo de la consulta. */
export function diaSiguiente(fecha) {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Valida el rango pedido contra la ventana de 3 meses.
 *
 * Sin `desde`/`hasta` devuelve la ventana entera. Un rango que se sale de la
 * ventana NO se recorta en silencio: se rechaza diciendo cuál es el límite. Un
 * recorte callado haría creer que no hubo diferencias en fechas que en realidad
 * nunca se consultaron.
 *
 * @returns {{ok: true, desde, hasta, minimo, maximo} | {ok: false, mensaje}}
 */
export function normalizarRango({ desde, hasta } = {}, hoy = hoyEnColombia()) {
  const maximo = hoy;
  const minimo = restarMeses(hoy, MESES_VENTANA);
  const d = desde || minimo;
  const h = hasta || maximo;

  if (!ISO.test(d) || !ISO.test(h)) {
    return { ok: false, mensaje: "Las fechas deben tener el formato AAAA-MM-DD." };
  }
  if (d > h) {
    return { ok: false, mensaje: "La fecha inicial no puede ser posterior a la final." };
  }
  if (d < minimo || h > maximo) {
    return {
      ok: false,
      mensaje: `Solo se pueden consultar los últimos ${MESES_VENTANA} meses: del ${minimo} al ${maximo}.`,
    };
  }
  return { ok: true, desde: d, hasta: h, minimo, maximo };
}

/* ── El cálculo ────────────────────────────────────────────────────────────── */

/**
 * El ajuste con su signo. SIESA guarda CAS y CAE en positivo.
 * @returns {number} negativo = llegó más barato
 */
export const ajusteNeto = ({ totalCae, totalCas }) => num(totalCae) - num(totalCas);

/**
 * Costo unitario real de UNA entrada.
 *
 * @param {object} f  Fila agregada por (entrada, factura, ítem). Ver `SQL_DIFERENCIAS`.
 * @param {number} f.bruto              valor bruto de esta entrada
 * @param {number} f.descuentos
 * @param {number} f.unidades           todas las unidades de la entrada
 * @param {number} f.unidadesPagadas    las de valor bruto > 0
 * @param {number} f.unidadesPagadasFactura  las pagadas de TODAS las entradas de la factura
 * @param {number} f.totalCas  f.totalCae  suma de ajustes de la factura+ítem, en positivo
 * @param {number} f.ico  f.ibua        impuestos de esta entrada, en pesos
 */
export function calcularFila(f) {
  const bruto = num(f.bruto);
  const descuentos = num(f.descuentos);
  const unidades = num(f.unidades);
  const pagadas = num(f.unidadesPagadas);
  const pagadasFactura = num(f.unidadesPagadasFactura);
  const ajusteFactura = ajusteNeto(f);
  const base = bruto - descuentos;

  /* Una entrada toda bonificada no tiene costo unitario: dividir por cero, o
     peor, repartirle ajuste, es exactamente la dilución que compras descartó.
     El Excel le ponía $1.169 por unidad a 8 unidades regaladas. */
  const bonificada = pagadas <= 0;

  const ajusteAsignado =
    bonificada || pagadasFactura <= 0 ? 0 : (ajusteFactura * pagadas) / pagadasFactura;

  const costoEntrada = bonificada ? null : base / pagadas;
  const costoReal = bonificada ? null : (base + ajusteAsignado) / pagadas;

  return {
    unidades: redondear(unidades, 4),
    unidadesPagadas: redondear(pagadas, 4),
    unidadesBonificadas: redondear(unidades - pagadas, 4),
    bonificada,
    // Ayuda a leer por qué el ajuste de la fila no es el de la factura.
    repartidaEnVariasEntradas: !bonificada && Math.abs(pagadasFactura - pagadas) > 1e-9,
    precioLista: bonificada ? null : redondear(bruto / pagadas),
    porcentajeDescuento: bruto > 0 ? redondear((descuentos * 100) / bruto) : null,
    costoEntrada: redondear(costoEntrada),
    tipoAjuste: tipoDeAjuste(f),
    ajusteFactura: redondear(ajusteFactura),
    ajusteAsignado: redondear(ajusteAsignado),
    ajusteUnitario: bonificada ? null : redondear(ajusteAsignado / pagadas),
    costoReal: redondear(costoReal),
    /* Un costo real en cero o negativo no es un costo: es un ajuste que no cuadra
       con la entrada. Caso real: CFP-00307879, ítem 2017, entrada de $143.000 y
       un CAS por $809.461. No se esconde ni se corrige acá —el dato es de SIESA—,
       se marca para que alguien lo mire antes de corregir una cotización con él. */
    revisar: costoReal != null && costoReal <= 0,
    /* Los impuestos por unidad FÍSICA, bonificadas incluidas: el ICO se cobra por
       unidad que entra, se haya pagado o no. Mismo criterio que el Excel. */
    icoUnitario: unidades > 0 ? redondear(num(f.ico) / unidades) : null,
    ibuaUnitario: unidades > 0 ? redondear(num(f.ibua) / unidades) : null,
  };
}

/** `mayor` (CAE), `menor` (CAS) o `mixto` si la factura tiene los dos. */
export function tipoDeAjuste({ totalCae, totalCas }) {
  const cae = num(totalCae) > 0;
  const cas = num(totalCas) > 0;
  if (cae && cas) return "mixto";
  return cae ? "mayor" : "menor";
}

/* ── La consulta ───────────────────────────────────────────────────────────── */

/**
 * $1 desde (AAAA-MM-DD) · $2 hasta EXCLUSIVO · $3 causaciones · $4 NIT o null
 * · $5 sucursal o null
 *
 * ⚠️ EL REPARTO MIRA TODAS LAS ENTRADAS DE LA FACTURA, NO SOLO LAS DEL RANGO.
 * `entradas` NO filtra por fecha: si una factura tiene una entrada el 31 y otra
 * el 1, y el rango arranca el 1, las unidades del 31 igual cuentan para repartir
 * el ajuste. Filtrar antes de sumar le cargaría el ajuste entero a la entrada
 * que quedó adentro — el mismo error del Excel, pero en el borde del rango.
 * La fecha se aplica al FINAL, sobre las filas ya calculadas.
 *
 * El `fecha >= $1` de `ajustes` es solo para no barrer 1,3 M de filas: un ajuste
 * nunca es anterior a su entrada (medido: 0 de 6.399) y la entrada es ≥ $1.
 */
const SQL_POR_ENTRADA = `
WITH ajustes AS MATERIALIZED (
  SELECT docto_causacion, item,
         sum(valor_bruto_local - valor_dsctos_local) FILTER (WHERE left(documento,3) = 'CAS') AS total_cas,
         sum(valor_bruto_local - valor_dsctos_local) FILTER (WHERE left(documento,3) = 'CAE') AS total_cae,
         array_agg(DISTINCT documento ORDER BY documento) AS documentos_ajuste,
         to_char(min(fecha), 'YYYY-MM-DD') AS fecha_ajuste,
         -- Cuándo LLEGÓ el ajuste a la réplica (no la fecha del documento). Es lo
         -- que decide si el aviso de Inicio es nuevo para el proveedor.
         to_char(max(fecha_carga), 'YYYY-MM-DD HH24:MI:SS') AS carga_ajuste
  FROM merkahorro_siesa.compras
  WHERE left(documento,3) IN ('CAS','CAE')
    AND estado = 'Facturado'
    AND left(docto_causacion,3) = ANY($3::text[])
    AND fecha >= $1::date
  GROUP BY docto_causacion, item
),
entradas AS MATERIALIZED (
  SELECT c.*, a.total_cas, a.total_cae, a.documentos_ajuste, a.fecha_ajuste, a.carga_ajuste
  FROM merkahorro_siesa.compras c
  JOIN ajustes a USING (docto_causacion, item)
  WHERE left(c.documento,3) = 'CEA'
    AND c.estado = 'Facturado'
    AND ($4::text IS NULL OR btrim(c.proveedor) = $4)
    AND ($5::text IS NULL OR btrim(c.sucursal) = $5)
),
por_entrada AS MATERIALIZED (
  SELECT documento, docto_causacion, item,
         min(fecha)::date AS dia,
         max(total_cas) AS total_cas,
         max(total_cae) AS total_cae,
         (array_agg(documentos_ajuste))[1] AS documentos_ajuste,
         max(fecha_ajuste) AS fecha_ajuste,
         max(carga_ajuste) AS carga_ajuste,
         btrim(max(desc_item)) AS descripcion,
         max(btrim(proveedor)) AS nit,
         max(btrim(sucursal)) AS sucursal,
         max(razon_social_proveedor) AS razon_social,
         max(desc_sucursal) AS nombre_sucursal,
         string_agg(DISTINCT btrim(bodega), ', ') AS bodega,
         string_agg(DISTINCT desc_bodega, ', ') AS nombre_bodega,
         string_agg(DISTINCT docto_orden, ', ') AS docto_orden,
         max(btrim(um)) AS presentacion,
         max(btrim(um_inv)) AS unidad,
         sum(cantidad) AS unidades,
         sum(cantidad) FILTER (WHERE valor_bruto_local > 0) AS unidades_pagadas,
         sum(valor_bruto_local) AS bruto,
         sum(valor_dsctos_local) AS descuentos,
         sum(vlr_imp_ico) AS ico,
         sum(vlr_imp_ibuaa) AS ibua,
         max(iva) AS iva_pct
  FROM entradas
  GROUP BY documento, docto_causacion, item
)
/* Columnas explícitas y NO \`e.*\`: \`dia\` es un DATE, y el driver lo convierte en
   un \`Date\` de JavaScript en la hora local del servidor (UTC en Vercel). La
   fecha viaja como texto; el \`Date\` no sale de la base.

   ⚠️ RENDIMIENTO — el total de la factura sale de una VENTANA, no de un JOIN.
   La primera versión agregaba \`entradas\` dos veces (por entrada y por factura)
   y las cruzaba. Como \`left(documento,3)\` no tiene estadística, el planificador
   estimaba 1 fila por CTE, elegía un nested loop y re-agregaba 2.587 veces:
   31,7 s para tres meses, 268 s para noviembre. Leer los datos tardaba menos de
   un segundo. \`sum() OVER (PARTITION BY …)\` hace el mismo cálculo en una pasada. */
SELECT e.documento, e.docto_causacion, e.item,
       to_char(e.dia, 'YYYY-MM-DD') AS fecha,
       e.descripcion, e.nit, e.sucursal, e.razon_social, e.nombre_sucursal,
       e.bodega, e.nombre_bodega, e.docto_orden, e.presentacion, e.unidad,
       e.unidades, e.unidades_pagadas, e.bruto, e.descuentos, e.ico, e.ibua, e.iva_pct,
       sum(e.unidades_pagadas) OVER (PARTITION BY e.docto_causacion, e.item) AS unidades_pagadas_factura,
       e.total_cas, e.total_cae, e.documentos_ajuste, e.fecha_ajuste, e.carga_ajuste,
       e.dia
FROM por_entrada e
`;

/* La fecha se filtra DESPUÉS de la ventana, en una capa de afuera: si el WHERE
   estuviera en el mismo SELECT, se aplicaría ANTES del \`OVER\` y la suma de la
   factura perdería las entradas de fuera del rango. Ver la advertencia de arriba. */
export const SQL_DIFERENCIAS = `
SELECT documento, docto_causacion, item, fecha, descripcion, nit, sucursal, razon_social,
       nombre_sucursal, bodega, nombre_bodega, docto_orden, presentacion, unidad, unidades,
       unidades_pagadas, bruto, descuentos, ico, ibua, iva_pct, unidades_pagadas_factura,
       total_cas, total_cae, documentos_ajuste, fecha_ajuste, carga_ajuste
FROM (${SQL_POR_ENTRADA}) t
WHERE t.dia >= $1::date AND t.dia < $2::date
ORDER BY t.dia DESC, t.razon_social, t.docto_causacion, t.item, t.documento
`;

/** Hasta cuándo cargó la réplica. El ETL no es nuestro: se muestra, no se arregla.
 *
 * Con SEGUNDOS y en el mismo formato que `carga_ajuste`: el proveedor oculta el
 * aviso de Inicio "hasta" este valor, y se compara como texto contra la carga de
 * cada ajuste. Los dos salen del reloj de la réplica, así que no hay husos de
 * por medio — mezclarlo con el `now()` de Supabase sí los tendría. */
export const SQL_ACTUALIZADO = `SELECT to_char(max(fecha_carga), 'YYYY-MM-DD HH24:MI:SS') AS actualizado FROM merkahorro_siesa.compras`;

/** Fila cruda de la consulta → lo que viaja a la pantalla. */
export function aFila(r) {
  const calculo = calcularFila({
    bruto: r.bruto,
    descuentos: r.descuentos,
    unidades: r.unidades,
    unidadesPagadas: r.unidades_pagadas,
    unidadesPagadasFactura: r.unidades_pagadas_factura,
    totalCas: r.total_cas,
    totalCae: r.total_cae,
    ico: r.ico,
    ibua: r.ibua,
  });

  return {
    clave: `${r.docto_causacion}|${r.item}|${r.documento}`,
    documento: r.documento,
    doctoCausacion: r.docto_causacion,
    item: Number(r.item),
    descripcion: r.descripcion,
    nit: r.nit,
    sucursal: r.sucursal,
    razonSocial: r.razon_social,
    nombreSucursal: r.nombre_sucursal,
    bodega: r.bodega,
    nombreBodega: r.nombre_bodega,
    doctoOrden: r.docto_orden,
    fecha: r.fecha,
    presentacion: r.presentacion,
    unidad: r.unidad,
    documentosAjuste: r.documentos_ajuste ?? [],
    fechaAjuste: r.fecha_ajuste,
    cargaAjuste: r.carga_ajuste ?? null,
    ivaPct: r.iva_pct == null ? null : Number(r.iva_pct),
    ...calculo,
  };
}
