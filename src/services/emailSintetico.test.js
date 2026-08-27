import test from "node:test";
import assert from "node:assert/strict";
import { emailSintetico, normalizarNit } from "./emailSintetico.js";

/* Estos casos son LOS MISMOS que los del gemelo del frontend
   (`PortalProveedores/utils/emailSintetico.test.js`). Si acá se agrega uno, allá
   también: son la única garantía de que las dos copias no se separen. */

test("deja pasar un NIT ya limpio", () => {
  assert.equal(normalizarNit("800186960"), "800186960");
});

test("acepta el NIT como lo escribe una persona", () => {
  assert.equal(normalizarNit("800.186.960"), "800186960");
  assert.equal(normalizarNit("800 186 960"), "800186960");
  assert.equal(normalizarNit("  800186960  "), "800186960");
});

test("descarta el dígito de verificación", () => {
  assert.equal(normalizarNit("800186960-1"), "800186960");
  assert.equal(normalizarNit("800.186.960-1"), "800186960");
});

test("no toca un guion que no sea de DV", () => {
  assert.equal(normalizarNit("800186960-12"), "800186960-12");
  assert.equal(normalizarNit("ABC-X"), "ABC-X");
});

test("aguanta vacío y nulo", () => {
  assert.equal(normalizarNit(""), "");
  assert.equal(normalizarNit(null), "");
  assert.equal(normalizarNit(undefined), "");
});

test("arma la identidad de Supabase Auth", () => {
  assert.equal(emailSintetico("800186960", "006"), "800186960-006@proveedores.merkahorro.com");
});

test("las cuatro formas del NIT dan EXACTAMENTE el mismo email", () => {
  // Es lo que impide que el proveedor defina su clave y después no pueda entrar.
  const esperado = "800186960-006@proveedores.merkahorro.com";
  assert.equal(emailSintetico("800.186.960", "006"), esperado);
  assert.equal(emailSintetico("800186960-1", "006"), esperado);
  assert.equal(emailSintetico(" 800 186 960 ", " 006 "), esperado);
  assert.equal(emailSintetico("800186960", "006"), esperado);
});

test("siempre en minúsculas", () => {
  assert.equal(emailSintetico("800186960", "A1"), "800186960-a1@proveedores.merkahorro.com");
});

test("la sucursal conserva sus ceros a la izquierda", () => {
  // "006" y "6" son sucursales distintas para SIESA.
  assert.notEqual(emailSintetico("800186960", "006"), emailSintetico("800186960", "6"));
});

test("falla fuerte si falta un dato, en vez de armar un email a medias", () => {
  assert.throws(() => emailSintetico("", "006"), /NIT/);
  assert.throws(() => emailSintetico("800186960", ""), /sucursal/);
  assert.throws(() => emailSintetico(null, null));
});
