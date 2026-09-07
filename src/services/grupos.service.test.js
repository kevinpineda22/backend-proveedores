import test from "node:test";
import assert from "node:assert/strict";
import { planificarReplicas } from "./grupos.service.js";

const cuenta = (id, sucursal, nombre) => ({ id, nit: "900256457", sucursal, nombreSucursal: nombre });

const vigente = (precio, descuentos = [], impuestos = []) => ({
  claveItem: `COP|900256457|002|179378|UND`,
  item: 179378,
  unidadMedida: "UND",
  precio,
  descuentos,
  impuestos,
  fechaActivacion: "2025-12-17",
});

const PROPUESTA = {
  precio: 18000,
  descuentos: [],
  impuestos: [],
  fechaActivacion: "2026-12-01",
};

/* ── Lo que se replica ────────────────────────────────────────────────────── */

test("replica a la hermana que sí tiene el producto", () => {
  const { replicas, omitidas } = planificarReplicas({
    propuesta: PROPUESTA,
    hermanas: [{ cuenta: cuenta(2, "001", "COPA ZONA 2 NIVEA"), vigente: vigente(17260) }],
  });

  assert.equal(replicas.length, 1);
  assert.equal(omitidas.length, 0);
  assert.equal(replicas[0].cuenta.sucursal, "001");
  assert.equal(replicas[0].propuesta.precio, 18000, "el precio propuesto es el mismo");
});

test("la variación se calcula contra el precio DE LA HERMANA, no el del que propuso", () => {
  // Es el caso real de ZONA 2 NIVEA: la sucursal 001 tiene 17.260 y la 002 tiene
  // 17.290. Copiar la variación del origen mentiría en la bandeja del admin justo
  // en los 16 renglones donde las hermanas ya difieren.
  const { replicas } = planificarReplicas({
    propuesta: { ...PROPUESTA, precio: 17290 },
    hermanas: [{ cuenta: cuenta(2, "001", "COPA ZONA 2 NIVEA"), vigente: vigente(17260) }],
  });

  // 17260 → 17290 es +0,1738 %, no 0 %.
  assert.ok(replicas[0].evaluacion.variacionPct > 0);
  assert.equal(replicas[0].evaluacion.costoActual, 17260);
});

test("cada hermana se evalúa contra SU tope, y puede excederlo aunque el origen no", () => {
  // La hermana está más barata, así que el mismo precio propuesto es una subida
  // mayor para ella. Si se copiara la marca del origen, esta pasaría sin aviso.
  const { replicas } = planificarReplicas({
    propuesta: { ...PROPUESTA, precio: 11000 },
    hermanas: [{ cuenta: cuenta(2, "001", "COPA"), vigente: vigente(10000) }],
    topePct: 5,
  });

  assert.equal(replicas[0].evaluacion.variacionPct, 10);
  assert.equal(replicas[0].evaluacion.excede, true);
});

test("los descuentos y los impuestos propuestos viajan igual a la hermana", () => {
  // Es el mismo acuerdo comercial: lo que cambia es la base contra la que se
  // compara, no lo que se negoció.
  const propuesta = {
    ...PROPUESTA,
    descuentos: [{ orden: 1, porcentaje: 5 }],
    impuestos: [{ llave: "ICO", valor: 900 }],
  };
  const { replicas } = planificarReplicas({
    propuesta,
    hermanas: [{ cuenta: cuenta(2, "001", "COPA"), vigente: vigente(10000) }],
  });

  assert.deepEqual(replicas[0].propuesta.descuentos, [{ orden: 1, porcentaje: 5 }]);
  assert.deepEqual(replicas[0].propuesta.impuestos, [{ llave: "ICO", valor: 900 }]);
});

test("los descuentos propuestos entran en el costo neto de la hermana", () => {
  const { replicas } = planificarReplicas({
    propuesta: { ...PROPUESTA, precio: 10000, descuentos: [{ orden: 1, porcentaje: 10 }] },
    hermanas: [{ cuenta: cuenta(2, "001", "COPA"), vigente: vigente(10000) }],
  });

  assert.equal(replicas[0].evaluacion.costoPropuesto, 9000);
});

/* ── Lo que NO se replica ─────────────────────────────────────────────────── */

test("no inventa el renglón que no existe en la hermana", () => {
  // 56 de 521 renglones existen en una sola sucursal. Sin cotización vigente no
  // hay identidad ni impuestos que re-emitir: replicar sería dar de alta un
  // precio en una sucursal donde compras nunca lo negoció.
  const { replicas, omitidas } = planificarReplicas({
    propuesta: PROPUESTA,
    hermanas: [{ cuenta: cuenta(2, "001", "COPA ZONA 2 NIVEA"), vigente: null }],
  });

  assert.equal(replicas.length, 0);
  assert.equal(omitidas.length, 1);
  assert.equal(omitidas[0].motivo, "sin_cotizacion_vigente");
  assert.equal(omitidas[0].nombreSucursal, "COPA ZONA 2 NIVEA", "el admin tiene que saber CUÁL");
});

test("un precio vigente en 0 se omite en vez de reventar", () => {
  // costoNeto lanza con precio 0 —un Infinity comparado contra el tope dejaría
  // pasar hasta una baja—. Acá se corta antes: una hermana rara no puede tumbar
  // la solicitud entera del proveedor.
  const { replicas, omitidas } = planificarReplicas({
    propuesta: PROPUESTA,
    hermanas: [{ cuenta: cuenta(2, "001", "COPA"), vigente: vigente(0) }],
  });

  assert.equal(replicas.length, 0);
  assert.equal(omitidas[0].motivo, "sin_precio_vigente");
});

test("mezcla: replica lo que puede y omite lo que no, en la misma pasada", () => {
  const { replicas, omitidas } = planificarReplicas({
    propuesta: PROPUESTA,
    hermanas: [
      { cuenta: cuenta(2, "001", "COPA A"), vigente: vigente(17260) },
      { cuenta: cuenta(3, "003", "COPA B"), vigente: null },
      { cuenta: cuenta(4, "004", "COPA C"), vigente: vigente(17000) },
    ],
  });

  assert.equal(replicas.length, 2);
  assert.equal(omitidas.length, 1);
  assert.equal(omitidas[0].sucursal, "003");
});

test("sin hermanas no replica nada y no falla", () => {
  // Es el caso NORMAL: hoy hay 30 grupos sugeridos y 0 activos.
  const { replicas, omitidas } = planificarReplicas({ propuesta: PROPUESTA });

  assert.deepEqual(replicas, []);
  assert.deepEqual(omitidas, []);
});
