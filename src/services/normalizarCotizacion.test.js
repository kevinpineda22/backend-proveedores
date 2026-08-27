import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizarFila,
  agruparCotizaciones,
  separarVigentes,
  hoyEnColombia,
  claveItem,
  porcentajesDescuento,
} from "./normalizarCotizacion.js";
import { costoNeto } from "./costoNeto.js";

/** Fila textual de la respuesta real de merkahorro_cotizaciones_dev. */
const ATUN_ALAMAR = {
  IdTercero: "800186960      ",
  NitTercero: "800186960",
  Sucursal: "006",
  DescSucursal: "ALTIPAL CATALOGO GENERAL",
  RazonSocial: "ALTIPAL SAS",
  CodigoItem: 1032,
  DescItem: "ATUN ALAMAR ENSALADA NATURAL X160GR     ",
  UM: "UND ",
  Precio: 4672.0,
  FechaActivacion: "2023-09-01T00:00:00",
  IdLlaveImpto: null,
  ValorImpto: null,
  PorcDsctoOrden1: 3.0,
  PorcDsctoOrden2: null,
  PorcDsctoOrden3: null,
};

/* ── normalizarFila ──────────────────────────────────────────────────────── */

test("limpia el relleno de CHAR de todos los campos de texto", () => {
  const { ok, fila } = normalizarFila(ATUN_ALAMAR);
  assert.equal(ok, true);
  assert.equal(fila.idTercero, "800186960");
  assert.equal(fila.unidadMedida, "UND");
  assert.equal(fila.descripcionItem, "ATUN ALAMAR ENSALADA NATURAL X160GR");
  assert.equal(fila.nombreSucursal, "ALTIPAL CATALOGO GENERAL");
});

test("guarda IdTercero y NitTercero por separado: no son intercambiables", () => {
  const { fila } = normalizarFila({ ...ATUN_ALAMAR, NitTercero: "900999999" });
  assert.equal(fila.idTercero, "800186960"); // → NIT_PROVEEDOR del conector
  assert.equal(fila.nit, "900999999"); // → lo que se teclea en el login
});

test("recorta la fecha al día, sin construir un Date", () => {
  const { fila } = normalizarFila(ATUN_ALAMAR);
  assert.equal(fila.fechaActivacion, "2023-09-01");
});

test("un null en PorcDsctoOrdenN es ausencia de descuento, no un 0% cargado", () => {
  const { fila } = normalizarFila(ATUN_ALAMAR);
  assert.deepEqual(fila.descuentos, [{ orden: 1, porcentaje: 3 }]);
});

test("lee los tres órdenes de descuento cuando vienen", () => {
  const { fila } = normalizarFila({
    ...ATUN_ALAMAR,
    PorcDsctoOrden2: 2.0,
    PorcDsctoOrden3: 1.5,
  });
  assert.deepEqual(fila.descuentos, [
    { orden: 1, porcentaje: 3 },
    { orden: 2, porcentaje: 2 },
    { orden: 3, porcentaje: 1.5 },
  ]);
});

test("un impuesto sin llave o sin valor se omite, no se inventa un cero", () => {
  assert.equal(normalizarFila(ATUN_ALAMAR).fila.impuesto, null);
  assert.equal(normalizarFila({ ...ATUN_ALAMAR, IdLlaveImpto: "ICO" }).fila.impuesto, null);
  assert.deepEqual(
    normalizarFila({ ...ATUN_ALAMAR, IdLlaveImpto: "ICO ", ValorImpto: 1200 }).fila.impuesto,
    { llave: "ICO", valor: 1200 },
  );
});

test("descarta con motivo en vez de dejar pasar filas rotas", () => {
  const casos = [
    [{ ...ATUN_ALAMAR, IdTercero: "   " }, /IdTercero/],
    [{ ...ATUN_ALAMAR, Sucursal: null }, /Sucursal/],
    [{ ...ATUN_ALAMAR, CodigoItem: 0 }, /CodigoItem/],
    [{ ...ATUN_ALAMAR, CodigoItem: "abc" }, /CodigoItem/],
    [{ ...ATUN_ALAMAR, UM: "  " }, /UM/],
    [{ ...ATUN_ALAMAR, FechaActivacion: "01/09/2023" }, /FechaActivacion/],
  ];
  for (const [cruda, motivo] of casos) {
    const r = normalizarFila(cruda);
    assert.equal(r.ok, false);
    assert.match(r.motivo, motivo);
    assert.equal(r.cruda, cruda); // la fila cruda viaja con el descarte
  }
});

/* ── agruparCotizaciones: la ambigüedad ICO / IBUA ───────────────────────── */

test("si la consulta repite el renglón por impuesto, se colapsa en uno solo", () => {
  // Escenario A: SIESA duplica la fila, una por llave de impuesto.
  const { cotizaciones, descartadas } = agruparCotizaciones([
    { ...ATUN_ALAMAR, IdLlaveImpto: "ICO ", ValorImpto: 1200 },
    { ...ATUN_ALAMAR, IdLlaveImpto: "IBUA", ValorImpto: 800 },
  ]);

  assert.equal(descartadas.length, 0);
  assert.equal(cotizaciones.length, 1); // un ítem+U.M.+fecha = una cotización
  assert.deepEqual(cotizaciones[0].impuestos, [
    { llave: "ICO", valor: 1200 },
    { llave: "IBUA", valor: 800 },
  ]);
  // Y los descuentos NO se duplican: vienen en columnas, no en filas.
  assert.deepEqual(cotizaciones[0].descuentos, [{ orden: 1, porcentaje: 3 }]);
});

test("si la consulta no repite, el resultado es igual de correcto", () => {
  // Escenario B: una sola fila, sin impuestos. Es lo que muestra la data real.
  const { cotizaciones } = agruparCotizaciones([ATUN_ALAMAR]);
  assert.equal(cotizaciones.length, 1);
  assert.deepEqual(cotizaciones[0].impuestos, []);
});

test("no repite el mismo impuesto dos veces", () => {
  const fila = { ...ATUN_ALAMAR, IdLlaveImpto: "ICO", ValorImpto: 1200 };
  const { cotizaciones } = agruparCotizaciones([fila, fila]);
  assert.deepEqual(cotizaciones[0].impuestos, [{ llave: "ICO", valor: 1200 }]);
});

test("el mismo ítem en dos unidades son dos cotizaciones, no una", () => {
  const { cotizaciones } = agruparCotizaciones([
    ATUN_ALAMAR,
    { ...ATUN_ALAMAR, UM: "CAJA", Precio: 112128 },
  ]);
  assert.equal(cotizaciones.length, 2);
  assert.notEqual(cotizaciones[0].claveItem, cotizaciones[1].claveItem);
});

test("junta los descartes sin frenar el lote", () => {
  const { cotizaciones, descartadas } = agruparCotizaciones([
    ATUN_ALAMAR,
    { ...ATUN_ALAMAR, UM: null },
    { ...ATUN_ALAMAR, CodigoItem: 11041, DescItem: "ATUN ALAMAR RALLADO" },
  ]);
  assert.equal(cotizaciones.length, 2);
  assert.equal(descartadas.length, 1);
  assert.match(descartadas[0].motivo, /UM/);
});

/* ── separarVigentes ─────────────────────────────────────────────────────── */

const conFecha = (fecha, extra = {}) => ({ ...ATUN_ALAMAR, FechaActivacion: fecha, ...extra });

test("de dos fechas pasadas, vigente es la más reciente", () => {
  const { cotizaciones } = agruparCotizaciones([
    conFecha("2023-09-01", { Precio: 4672 }),
    conFecha("2025-03-01", { Precio: 5100 }),
  ]);
  const { vigentes, programadas } = separarVigentes(cotizaciones, "2026-08-26");

  assert.equal(vigentes.length, 1);
  assert.equal(vigentes[0].precio, 5100);
  assert.equal(programadas.length, 0);
});

test("una fecha futura es programada, no vigente", () => {
  const { cotizaciones } = agruparCotizaciones([
    conFecha("2025-03-01", { Precio: 5100 }),
    conFecha("2026-09-01", { Precio: 5400 }),
  ]);
  const { vigentes, programadas } = separarVigentes(cotizaciones, "2026-08-26");

  assert.equal(vigentes[0].precio, 5100); // el que rige hoy
  assert.equal(programadas[0].precio, 5400); // el que ya está cargado a futuro
});

test("una activación de HOY ya es vigente", () => {
  const { cotizaciones } = agruparCotizaciones([conFecha("2026-08-26")]);
  const { vigentes, programadas } = separarVigentes(cotizaciones, "2026-08-26");
  assert.equal(vigentes.length, 1);
  assert.equal(programadas.length, 0);
});

test("separa por ítem+U.M., no mezcla unidades", () => {
  const { cotizaciones } = agruparCotizaciones([
    conFecha("2025-03-01", { UM: "UND ", Precio: 5100 }),
    conFecha("2024-01-01", { UM: "CAJA", Precio: 120000 }),
  ]);
  const { vigentes } = separarVigentes(cotizaciones, "2026-08-26");
  assert.equal(vigentes.length, 2);
});

/* ── hoyEnColombia: la trampa del huso ───────────────────────────────────── */

test("a las 21:00 de Colombia sigue siendo hoy, no mañana", () => {
  // 2026-08-27T02:00:00Z = 2026-08-26 21:00 en Bogotá (UTC−5).
  // Un `new Date().toISOString().slice(0,10)` daría 2026-08-27 y adelantaría la
  // vigencia de una cotización cinco horas.
  assert.equal(hoyEnColombia(new Date("2026-08-27T02:00:00Z")), "2026-08-26");
});

test("a las 00:30 de Colombia ya es el día nuevo", () => {
  assert.equal(hoyEnColombia(new Date("2026-08-27T05:30:00Z")), "2026-08-27");
});

test("devuelve AAAA-MM-DD, el formato que consume el resto del módulo", () => {
  assert.match(hoyEnColombia(), /^\d{4}-\d{2}-\d{2}$/);
});

/* ── integración con la regla del tope ───────────────────────────────────── */

test("una cotización normalizada alimenta costoNeto sin traducción extra", () => {
  const { cotizaciones } = agruparCotizaciones([ATUN_ALAMAR]);
  const c = cotizaciones[0];

  assert.equal(costoNeto(c.precio, porcentajesDescuento(c)), 4531.84);
});

test("claveItem ignora la fecha: es el renglón editable del portal", () => {
  const base = { idTercero: "800186960", sucursal: "006", item: 1032, unidadMedida: "UND" };
  assert.equal(claveItem(base), claveItem({ ...base }));
  assert.equal(claveItem(base).includes("2023"), false);
});

/* ── Moneda ──────────────────────────────────────────────────────────────── */

test("sin columna Moneda asume COP y la llave no cambia", () => {
  // La consulta vieja no la trae. Las llaves ya guardadas tienen que seguir
  // valiendo, o las solicitudes existentes dejarían de encontrar su cotización.
  const { fila } = normalizarFila(ATUN_ALAMAR);
  assert.equal(fila.moneda, "COP");

  const { cotizaciones } = agruparCotizaciones([ATUN_ALAMAR]);
  assert.equal(cotizaciones[0].clave, "COP|800186960|006|1032|UND|2023-09-01");
});

test("lee la moneda cuando la consulta nueva la manda, con relleno y todo", () => {
  assert.equal(normalizarFila({ ...ATUN_ALAMAR, Moneda: "COP " }).fila.moneda, "COP");
  assert.equal(normalizarFila({ ...ATUN_ALAMAR, Moneda: "USD" }).fila.moneda, "USD");
});

test("dos monedas del mismo ítem son cotizaciones distintas", () => {
  const { cotizaciones } = agruparCotizaciones([
    { ...ATUN_ALAMAR, Moneda: "COP" },
    { ...ATUN_ALAMAR, Moneda: "USD", Precio: 1.2 },
  ]);
  assert.equal(cotizaciones.length, 2);
  assert.equal(cotizaciones[1].clave.startsWith("USD|"), true);
});
