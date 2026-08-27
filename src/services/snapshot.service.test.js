import test from "node:test";
import assert from "node:assert/strict";
import { debeBarrer, filasParaUpsert, enLotes } from "./snapshot.service.js";
import { agruparCotizaciones } from "./normalizarCotizacion.js";

/* ── debeBarrer: la válvula de seguridad ─────────────────────────────────── */

test("barre cuando el catálogo se mantiene o crece", () => {
  assert.deepEqual(debeBarrer(1000, 1000), { barrer: true, motivo: null });
  assert.deepEqual(debeBarrer(1200, 1000), { barrer: true, motivo: null });
});

test("NO barre con cero filas: eso es un fallo, no un catálogo vacío", () => {
  const r = debeBarrer(0, 1000);
  assert.equal(r.barrer, false);
  assert.match(r.motivo, /ninguna fila/i);
});

test("NO barre si el catálogo encogió más de lo tolerado", () => {
  // Una consulta que devuelve de menos borraría medio catálogo y dejaría a los
  // proveedores sin poder cotizar productos que sí existen.
  const r = debeBarrer(400, 1000);
  assert.equal(r.barrer, false);
  assert.match(r.motivo, /encogió de 1000 a 400/);
});

test("una merma tolerable sí barre", () => {
  assert.equal(debeBarrer(600, 1000).barrer, true);
});

test("la primera corrida barre: no hay nada anterior con qué comparar", () => {
  assert.equal(debeBarrer(5000, 0).barrer, true);
});

test("el umbral es configurable", () => {
  assert.equal(debeBarrer(800, 1000, 0.9).barrer, false);
  assert.equal(debeBarrer(800, 1000, 0.5).barrer, true);
});

/* ── filasParaUpsert ─────────────────────────────────────────────────────── */

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
  IdLlaveImpto: "ICO",
  ValorImpto: 1200,
  PorcDsctoOrden1: 3.0,
  PorcDsctoOrden2: null,
  PorcDsctoOrden3: null,
};

test("mapea una cotización normalizada a columnas de pp_cotizaciones", () => {
  const { cotizaciones } = agruparCotizaciones([ATUN_ALAMAR]);
  const [fila] = filasParaUpsert(cotizaciones, "2026-08-26T10:00:00.000Z");

  assert.deepEqual(fila, {
    clave: "COP|800186960|006|1032|UND|2023-09-01",
    clave_item: "COP|800186960|006|1032|UND",
    id_tercero: "800186960",
    nit: "800186960",
    sucursal: "006",
    item: 1032,
    descripcion_item: "ATUN ALAMAR ENSALADA NATURAL X160GR",
    unidad_medida: "UND",
    moneda: "COP",
    fecha_activacion: "2023-09-01",
    precio: 4672,
    impuestos: [{ llave: "ICO", valor: 1200 }],
    descuentos: [{ orden: 1, porcentaje: 3 }],
    sincronizado_at: "2026-08-26T10:00:00.000Z",
  });
});

test("todas las filas de una corrida llevan el MISMO sincronizado_at", () => {
  // De eso depende el barrido: se borra lo que quedó con marca anterior. Si cada
  // fila tuviera su propio timestamp, el barrido se comería filas recién escritas.
  const { cotizaciones } = agruparCotizaciones([
    ATUN_ALAMAR,
    { ...ATUN_ALAMAR, CodigoItem: 11041 },
    { ...ATUN_ALAMAR, UM: "CAJA" },
  ]);
  const filas = filasParaUpsert(cotizaciones, "2026-08-26T10:00:00.000Z");

  assert.equal(filas.length, 3);
  assert.equal(new Set(filas.map((f) => f.sincronizado_at)).size, 1);
});

test("la clave del upsert es única por cotización", () => {
  const { cotizaciones } = agruparCotizaciones([
    ATUN_ALAMAR,
    { ...ATUN_ALAMAR, UM: "CAJA" },
    { ...ATUN_ALAMAR, FechaActivacion: "2025-03-01" },
  ]);
  const claves = filasParaUpsert(cotizaciones, "x").map((f) => f.clave);
  assert.equal(new Set(claves).size, claves.length);
});

/* ── enLotes ─────────────────────────────────────────────────────────────── */

test("parte en lotes sin perder ni duplicar filas", () => {
  const arr = Array.from({ length: 2500 }, (_, i) => i);
  const lotes = enLotes(arr, 1000);

  assert.deepEqual(lotes.map((l) => l.length), [1000, 1000, 500]);
  assert.deepEqual(lotes.flat(), arr);
});

test("un arreglo vacío no genera lotes vacíos", () => {
  assert.deepEqual(enLotes([], 1000), []);
});

test("menos filas que el tamaño de lote da un solo lote", () => {
  assert.equal(enLotes([1, 2, 3], 1000).length, 1);
});
