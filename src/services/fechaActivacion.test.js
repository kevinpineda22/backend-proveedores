import test from "node:test";
import assert from "node:assert/strict";
import { fechaVencida, mensajeVencidas } from "./fechaActivacion.js";
import { armarPayload } from "./siesaCotizacion.js";

const HOY = "2026-09-22";
const linea = (id, fecha, desc = `Producto ${id}`) => ({ id, fecha_activacion: fecha, descripcion_item: desc, item: id });

test("vencida es estrictamente antes de hoy: hoy todavía entra", () => {
  assert.equal(fechaVencida(linea(1, "2026-09-17"), HOY), true);
  assert.equal(fechaVencida(linea(1, "2026-09-21"), HOY), true);
  assert.equal(fechaVencida(linea(1, HOY), HOY), false);
  assert.equal(fechaVencida(linea(1, "2026-09-23"), HOY), false);
  assert.equal(fechaVencida({}, HOY), false);
});

test("el corte es el MISMO que el de armarPayload", () => {
  // Si divergen, vuelve el callejón: el 409 deja pasar algo que el armado frena.
  const vigente = { claveItem: "COP|900|001|1|UND", idTercero: "900", sucursal: "001", item: 1, unidadMedida: "UND", impuestos: [] };
  const propuesta = (fechaActivacion) => ({ claveItem: vigente.claveItem, precio: 1000, descuentos: [], impuestos: [], fechaActivacion, notas: "" });

  assert.throws(() => armarPayload({ vigente, propuesta: propuesta("2026-09-21"), hoy: HOY }), /retroactiva/);
  assert.equal(fechaVencida(linea(1, "2026-09-21"), HOY), true);

  assert.doesNotThrow(() => armarPayload({ vigente, propuesta: propuesta(HOY), hoy: HOY }));
  assert.equal(fechaVencida(linea(1, HOY), HOY), false);
});

test("sin vencidas no hay mensaje", () => {
  assert.equal(mensajeVencidas([linea(1, "2026-10-01")], HOY), null);
});

test("el mensaje nombra el producto, la fecha y qué hacer", () => {
  const r = mensajeVencidas([linea(7, "2026-09-17", "ATÚN 160G")], HOY);
  assert.deepEqual(r.ids, [7]);
  assert.match(r.mensaje, /"ATÚN 160G" \(17\/09\/2026\)/);
  assert.match(r.mensaje, /Rechace esa línea/);
  assert.doesNotMatch(r.mensaje, /permitirRetroactiva/);
});

test("en un lote mixto pide aprobar el resto por separado", () => {
  const r = mensajeVencidas([linea(1, "2026-09-17"), linea(2, "2026-10-01")], HOY);
  assert.deepEqual(r.ids, [1]);
  assert.match(r.mensaje, /apruebe el resto por separado/);
});

test("con muchas vencidas nombra cinco y cuenta el resto", () => {
  const lineas = Array.from({ length: 8 }, (_, i) => linea(i + 1, "2026-09-17"));
  const r = mensajeVencidas(lineas, HOY);
  assert.equal(r.ids.length, 8);
  assert.match(r.mensaje, /y 3 más/);
  assert.match(r.mensaje, /Rechace esas líneas/);
});
