import test from "node:test";
import assert from "node:assert/strict";
import { problemaDeLinea } from "./solicitud.service.js";

const HOY = "2026-11-13";
const VIGENTE = { claveItem: "k", descripcionItem: "CUATES PICANTE", precio: 1200, activo: true };
const LINEA = { claveItem: "k", fechaActivacion: "2026-11-20" };

test("una línea sana no tiene problema", () => {
  assert.equal(problemaDeLinea({ vigente: VIGENTE, linea: LINEA, hoy: HOY }), null);
});

test("un ítem INACTIVO en SIESA no se cotiza (compras, 2026-11-13)", () => {
  const p = problemaDeLinea({ vigente: { ...VIGENTE, activo: false }, linea: LINEA, hoy: HOY });
  assert.equal(p.status, 409);
  assert.match(p.motivo, /inactivo en SIESA/);
  assert.match(p.mensaje, /CUATES PICANTE/);
});

test("sin dato de estado (null) NO bloquea: ante la duda no se frena", () => {
  assert.equal(problemaDeLinea({ vigente: { ...VIGENTE, activo: null }, linea: LINEA, hoy: HOY }), null);
});

test("fuera del catálogo, sin precio o con fecha no futura: cada uno con su motivo", () => {
  assert.equal(problemaDeLinea({ vigente: null, linea: LINEA, hoy: HOY }).status, 404);
  assert.match(problemaDeLinea({ vigente: { ...VIGENTE, precio: 0 }, linea: LINEA, hoy: HOY }).motivo, /precio/);
  assert.match(
    problemaDeLinea({ vigente: VIGENTE, linea: { ...LINEA, fechaActivacion: HOY }, hoy: HOY }).motivo,
    /futura/,
  );
});

test("al validar el carrito, una línea SIN fecha todavía no es un problema", () => {
  // La fecha se elige en la pantalla de firma, después de esta revisión.
  assert.equal(problemaDeLinea({ vigente: VIGENTE, linea: { claveItem: "k" }, hoy: HOY }), null);
});
