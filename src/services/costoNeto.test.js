import test from "node:test";
import assert from "node:assert/strict";
import { costoNeto, variacion, evaluarPropuesta } from "./costoNeto.js";

/* ── costoNeto ────────────────────────────────────────────────────────────── */

test("sin descuentos, el costo neto es el precio", () => {
  assert.equal(costoNeto(4672), 4672);
  assert.equal(costoNeto(4672, []), 4672);
});

test("un null de SIESA en PorcDsctoOrdenN cuenta como 0%, no rompe", () => {
  // Así viene literalmente la respuesta de Connekta para el ATÚN ALAMAR.
  assert.equal(costoNeto(4672, [3, null, null]), 4531.84);
});

test("descuentos en cascada, no sumados", () => {
  // 4672 × 0,97 × 0,98 = 4441.2032 en cascada.
  // Si fueran aditivos (5%) daría 4438.40 — la diferencia son 2,80 por unidad.
  assert.equal(costoNeto(4672, [3, 2]), 4441.2032);
});

test("un descuento del 100% deja el costo en cero", () => {
  assert.equal(costoNeto(4672, [100]), 0);
});

test("rechaza precios y descuentos inválidos en vez de absorberlos", () => {
  assert.throws(() => costoNeto("abc"), TypeError);
  assert.throws(() => costoNeto(-1), RangeError);
  assert.throws(() => costoNeto(100, [101]), RangeError);
  assert.throws(() => costoNeto(100, [-5]), RangeError);
});

test("no arrastra colas de punto flotante", () => {
  // Sin el redondeo por paso esto daría 0.30000000000000004 y similares.
  const c = costoNeto(0.1, [10, 10, 10]);
  assert.equal(c, 0.0729);
  assert.equal(String(c).length <= 6, true);
});

/* ── variacion ────────────────────────────────────────────────────────────── */

test("la variación es una fracción con signo", () => {
  assert.equal(variacion(100, 105), 0.05);
  assert.equal(variacion(100, 95), -0.05);
  assert.equal(variacion(100, 100), 0);
});

test("un costo actual de 0 lanza en vez de devolver Infinity", () => {
  // Infinity comparado contra un tope bloquearía incluso una BAJA de precio.
  assert.throws(() => variacion(0, 100), RangeError);
});

/* ── evaluarPropuesta — el agujero que motivó todo el módulo ──────────────── */

test("AGUJERO: bajar el descuento sin tocar el precio SÍ es una subida", () => {
  // Caso real: ATÚN ALAMAR de Altipal. El proveedor deja el precio idéntico
  // (subida 0% sobre el precio) pero borra el 3% de descuento.
  const r = evaluarPropuesta({
    precioActual: 4672,
    descuentosActuales: [3],
    precioPropuesto: 4672,
    descuentosPropuestos: [0],
    topePct: 5,
  });

  assert.equal(r.costoActual, 4531.84);
  assert.equal(r.costoPropuesto, 4672);
  assert.equal(r.variacionPct, 3.0928); // +3,09% real, con el precio quieto
  assert.equal(r.excede, false); // no supera el 5%, pero el número ya no miente
});

test("AGUJERO: precio justo bajo el tope + descuento a cero lo supera de largo", () => {
  const r = evaluarPropuesta({
    precioActual: 4672,
    descuentosActuales: [3],
    precioPropuesto: 4900.93, // +4,9% de precio: pasaría un tope del 5% mirando precio
    descuentosPropuestos: [0],
    topePct: 5,
  });

  assert.equal(r.variacionPct > 8, true); // +8,14% efectivo
  assert.equal(r.excede, true); // y acá SÍ se bloquea
});

/* ── evaluarPropuesta — reglas del tope ──────────────────────────────────── */

test("solo bloquea subidas: una baja de costo pasa siempre", () => {
  const r = evaluarPropuesta({
    precioActual: 4672,
    descuentosActuales: [3],
    precioPropuesto: 2000,
    descuentosPropuestos: [0],
    topePct: 5,
  });
  assert.equal(r.variacion < 0, true);
  assert.equal(r.excede, false);
});

test("tope null es SIN TOPE, no 0%", () => {
  const r = evaluarPropuesta({
    precioActual: 100,
    precioPropuesto: 400,
    topePct: null,
  });
  assert.equal(r.variacionPct, 300);
  assert.equal(r.excede, false);
});

test("tope 0 sí bloquea cualquier subida", () => {
  const r = evaluarPropuesta({
    precioActual: 100,
    precioPropuesto: 100.01,
    topePct: 0,
  });
  assert.equal(r.excede, true);
});

test("el tope es exclusivo: exactamente 5% con tope 5 pasa", () => {
  const r = evaluarPropuesta({
    precioActual: 100,
    precioPropuesto: 105,
    topePct: 5,
  });
  assert.equal(r.variacionPct, 5);
  assert.equal(r.excede, false);
});

test("un pelo por encima del tope no pasa", () => {
  const r = evaluarPropuesta({
    precioActual: 100,
    precioPropuesto: 105.01,
    topePct: 5,
  });
  assert.equal(r.excede, true);
});

test("rechaza un tope negativo", () => {
  assert.throws(
    () => evaluarPropuesta({ precioActual: 100, precioPropuesto: 101, topePct: -3 }),
    RangeError,
  );
});
