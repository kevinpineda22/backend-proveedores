import test from "node:test";
import assert from "node:assert/strict";
import { revalidarTope } from "./revalidarTope.js";

/** Solicitud congelada: propuso $100 cuando el vigente era $99. +1%, tope 2%. */
const SOLICITUD = {
  precio_actual: 99,
  precio_propuesto: 100,
  descuentos_propuestos: [],
  variacion_pct: 1.0101,
  porcentaje_max_vigente: 2,
};

const vigente = (precio) => ({ precio, descuentos: [] });

test("sin cambios en SIESA, la marca de la bandeja sigue siendo válida", () => {
  const r = revalidarTope(SOLICITUD, vigente(99));
  assert.equal(r.desactualizado, false);
  assert.equal(r.excedeAntes, false);
  assert.equal(r.excedeHoy, false);
  assert.equal(r.empeora, false);
});

test("EL CASO CARO: el precio de SIESA bajó y la propuesta pasó a superar el tope", () => {
  // Es el escenario que justifica todo este módulo. Congelado dice +1% (dentro
  // del tope del 2%); contra el precio de hoy son +11%. La bandeja mostraría la
  // marca en verde y el admin aprobaría un aumento cinco veces mayor al tope.
  const r = revalidarTope(SOLICITUD, vigente(90));

  assert.equal(r.desactualizado, true);
  assert.equal(r.precioAntes, 99);
  assert.equal(r.precioHoy, 90);
  assert.equal(r.excedeAntes, false, "al proponer NO superaba el tope");
  assert.equal(r.excedeHoy, true, "hoy sí lo supera");
  assert.equal(r.empeora, true, "esto es lo que tiene que frenar al admin");
  assert.ok(r.variacionHoy > 11 && r.variacionHoy < 11.2, `variación hoy: ${r.variacionHoy}`);
});

test("si el precio SUBIÓ, la propuesta mejora y no se frena a nadie", () => {
  // Un aumento del proveedor que quedó por DEBAJO del nuevo precio de SIESA no
  // es un riesgo. `desactualizado` avisa igual, pero `empeora` es false: frenar
  // acá sería ruido, y el ruido enseña a ignorar los avisos.
  const r = revalidarTope(SOLICITUD, vigente(105));
  assert.equal(r.desactualizado, true);
  assert.equal(r.empeora, false);
  assert.ok(r.variacionHoy < 0, "propone menos que el vigente de hoy");
});

test("una que YA superaba el tope no cuenta como que 'empeoró'", () => {
  // El admin ya está viendo la marca roja: no hay nada nuevo que avisarle. Si
  // `empeora` fuera true acá, el aviso saldría siempre y dejaría de significar.
  const excedida = { ...SOLICITUD, precio_propuesto: 130, variacion_pct: 31.31 };
  const r = revalidarTope(excedida, vigente(90));
  assert.equal(r.excedeAntes, true);
  assert.equal(r.excedeHoy, true);
  assert.equal(r.empeora, false);
});

test("un ítem que ya no está en el catálogo es su propio caso, no 'sin cambios'", () => {
  const r = revalidarTope(SOLICITUD, null);
  assert.equal(r.itemSinPrecio, true);
  assert.equal(r.precioHoy, null);
  assert.equal(r.variacionHoy, null);
  assert.equal(r.excedeHoy, null);
  // Nunca se lo hace pasar por "todo bien": el admin tiene que enterarse.
  assert.equal(r.desactualizado, false);
});

test("sin tope configurado, nada excede y nada empeora", () => {
  // `porcentaje_max = NULL` es "sin tope", no "0%". Ver ARQUITECTURA §6.
  const sinTope = { ...SOLICITUD, porcentaje_max_vigente: null };
  const r = revalidarTope(sinTope, vigente(50));
  assert.equal(r.excedeAntes, false);
  assert.equal(r.excedeHoy, false);
  assert.equal(r.empeora, false);
  assert.equal(r.desactualizado, true, "el precio igual cambió y hay que decirlo");
});

test("una diferencia de centavos no se reporta como cambio de precio", () => {
  const r = revalidarTope(SOLICITUD, vigente(99.005));
  assert.equal(r.desactualizado, false);
});
