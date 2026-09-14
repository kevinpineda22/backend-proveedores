import test from "node:test";
import assert from "node:assert/strict";
import { combinar, llave, paraProveedor } from "./seguimientoDiferencias.js";

const FILA = { clave: "CFP-1|76|CEA-9", doctoCausacion: "CFP-1", item: 76, costoReal: 10 };

test("sin fila de seguimiento, la diferencia está PENDIENTE", () => {
  const [f] = combinar([FILA], new Map());
  assert.equal(f.seguimiento.estado, "pendiente");
  assert.equal(f.seguimiento.actualizadoPor, null);
});

test("el seguimiento es por factura+ítem: las dos entradas de una factura comparten estado", () => {
  const mapa = new Map([[llave("CFP-1", "76"), { estado: "corregido", nota: "ok", actualizado_por: "María", actualizado_at: "x" }]]);
  const filas = combinar([FILA, { ...FILA, clave: "CFP-1|76|CEA-10" }], mapa);
  assert.deepEqual(filas.map((f) => f.seguimiento.estado), ["corregido", "corregido"]);
});

test("la llave no distingue el ítem como texto o número", () => {
  assert.equal(llave("CFP-1", "76"), llave("CFP-1", 76));
});

test("el proveedor NO ve la nota interna ni quién la marcó", () => {
  const [f] = combinar([FILA], new Map([["CFP-1|76", { estado: "corregido", nota: "llamar a Juan", actualizado_por: "María", actualizado_at: "2026-09-14T15:00:00Z" }]]));
  const p = paraProveedor(f);
  assert.deepEqual(p.seguimiento, { estado: "corregido", actualizadoAt: "2026-09-14T15:00:00Z" });
  assert.ok(!JSON.stringify(p).includes("llamar a Juan"));
  assert.ok(!JSON.stringify(p).includes("María"));
  assert.equal(p.costoReal, 10, "el resto de la fila queda intacto");
});
