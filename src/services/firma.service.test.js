import test from "node:test";
import assert from "node:assert/strict";
import { serializarParaFirma, hashPayload, firmaCoincide, validarTrazo } from "./firma.service.js";

const DATOS = {
  cuentaId: 7,
  claveItem: "COP|800186960|006|1032|UND",
  item: 1032,
  unidadMedida: "UND",
  precioActual: 4672,
  descuentosActuales: [{ orden: 1, porcentaje: 3 }],
  precioPropuesto: 4900,
  descuentosPropuestos: [{ orden: 1, porcentaje: 3 }],
  fechaActivacion: "2026-09-01",
};

/* ── Canonicalización ────────────────────────────────────────────────────── */

test("el mismo contenido produce siempre el mismo hash", () => {
  assert.equal(hashPayload(DATOS), hashPayload({ ...DATOS }));
});

test("el orden de las claves del objeto NO cambia el hash", () => {
  // Por esto la serialización se arma a mano y no con JSON.stringify: con
  // stringify, dos objetos iguales construidos distinto darían hashes distintos
  // y la verificación fallaría de a ratos.
  const alReves = {
    fechaActivacion: DATOS.fechaActivacion,
    descuentosPropuestos: DATOS.descuentosPropuestos,
    precioPropuesto: DATOS.precioPropuesto,
    descuentosActuales: DATOS.descuentosActuales,
    precioActual: DATOS.precioActual,
    unidadMedida: DATOS.unidadMedida,
    item: DATOS.item,
    claveItem: DATOS.claveItem,
    cuentaId: DATOS.cuentaId,
  };
  assert.equal(hashPayload(alReves), hashPayload(DATOS));
});

test("4672 y 4672.0 firman igual", () => {
  assert.equal(hashPayload({ ...DATOS, precioActual: 4672.0 }), hashPayload(DATOS));
  assert.equal(hashPayload({ ...DATOS, precioActual: "4672" }), hashPayload(DATOS));
});

test("el orden de los descuentos en el array no cambia el hash", () => {
  const a = { ...DATOS, descuentosPropuestos: [{ orden: 2, porcentaje: 2 }, { orden: 1, porcentaje: 3 }] };
  const b = { ...DATOS, descuentosPropuestos: [{ orden: 1, porcentaje: 3 }, { orden: 2, porcentaje: 2 }] };
  assert.equal(hashPayload(a), hashPayload(b));
});

test("una fecha ISO y una fecha corta firman igual", () => {
  assert.equal(hashPayload({ ...DATOS, fechaActivacion: "2026-09-01T00:00:00" }), hashPayload(DATOS));
});

/* ── La firma se rompe si cambia lo firmado ──────────────────────────────── */

test("CADA campo del contenido cambia el hash", () => {
  const variantes = {
    cuentaId: 8,
    claveItem: "COP|800186960|006|9999|UND",
    item: 9999,
    unidadMedida: "CAJA",
    precioActual: 4673,
    precioPropuesto: 4901,
    fechaActivacion: "2026-09-02",
    descuentosPropuestos: [{ orden: 1, porcentaje: 0 }],
    descuentosActuales: [{ orden: 1, porcentaje: 5 }],
  };
  const base = hashPayload(DATOS);

  for (const [campo, valor] of Object.entries(variantes)) {
    assert.notEqual(hashPayload({ ...DATOS, [campo]: valor }), base, `${campo} no afectó el hash`);
  }
});

test("quitar un descuento rompe la firma", () => {
  // El caso que motivó el tope sobre costo neto: si alguien borra el descuento
  // después de firmado, la firma tiene que dejar de valer.
  assert.notEqual(hashPayload({ ...DATOS, descuentosPropuestos: [] }), hashPayload(DATOS));
});

/* ── firmaCoincide ───────────────────────────────────────────────────────── */

test("valida el hash correcto y rechaza cualquier otro", () => {
  const h = hashPayload(DATOS);
  assert.equal(firmaCoincide(h, DATOS), true);
  assert.equal(firmaCoincide(h, { ...DATOS, precioPropuesto: 5000 }), false);
});

test("no revienta con un hash ausente, vacío o de otro largo", () => {
  // `timingSafeEqual` lanza si los buffers difieren en longitud: hay que
  // chequear el largo antes, o un hash corrupto tumba la aprobación con un 500.
  for (const h of [null, undefined, "", "abc", "x".repeat(63), "x".repeat(65)]) {
    assert.equal(firmaCoincide(h, DATOS), false);
  }
});

test("el hash es un SHA-256 en hexadecimal", () => {
  assert.match(hashPayload(DATOS), /^[0-9a-f]{64}$/);
});

/* ── Serialización legible ───────────────────────────────────────────────── */

test("la serialización es auditable a ojo", () => {
  // Que se pueda leer importa: cuando alguien discuta una firma, esto es lo que
  // se compara contra la solicitud.
  const s = serializarParaFirma(DATOS);
  assert.match(s, /cuenta=7/);
  assert.match(s, /precioActual=4672\.0000/);
  assert.match(s, /precioPropuesto=4900\.0000/);
  assert.match(s, /dctosPropuestos=1:3\.0000/);
  assert.match(s, /fechaActivacion=2026-09-01/);
});

/* ── validarTrazo ────────────────────────────────────────────────────────── */

const TRAZO_OK = "data:image/png;base64," + "A".repeat(200);

test("acepta un trazo real", () => {
  assert.equal(validarTrazo(TRAZO_OK), null);
});

test("un trazo vacío no es una firma, es un botón apretado", () => {
  assert.match(validarTrazo("data:image/png;base64,"), /vacía/i);
});

test("rechaza lo que no sea una imagen", () => {
  for (const t of [null, undefined, 42, "", "no soy una imagen", "http://ejemplo.com/f.png"]) {
    assert.match(validarTrazo(t), /inválido/i);
  }
});

test("rechaza un trazo desmedido", () => {
  assert.match(validarTrazo("data:image/png;base64," + "A".repeat(600_000)), /grande/i);
});

test("los mensajes van en usted", () => {
  for (const t of ["data:image/png;base64,", "no soy una imagen"]) {
    const m = validarTrazo(t);
    assert.equal(/\bvos\b|\bdibujá\b|\btenés\b/i.test(m), false, `voseo en "${m}"`);
  }
});
