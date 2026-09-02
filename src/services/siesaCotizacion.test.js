import test from "node:test";
import assert from "node:assert/strict";
import { armarPayload, respuestaOk, detalleError, BLOQUES } from "./siesaCotizacion.js";
import { agruparCotizaciones } from "./normalizarCotizacion.js";

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

const vigenteDe = (crudas) => agruparCotizaciones(crudas).cotizaciones[0];

const HOY = "2026-08-26";
const PROPUESTA = {
  precio: 4900,
  descuentos: [{ orden: 1, porcentaje: 3 }],
  fechaActivacion: "2026-09-01",
  notas: "Ajuste anual",
};

const armar = (extra = {}) =>
  armarPayload({ vigente: vigenteDe([ATUN_ALAMAR]), propuesta: PROPUESTA, hoy: HOY, ...extra });

/* ── Forma del payload ───────────────────────────────────────────────────── */

test("los nombres de los bloques son exactos", () => {
  const p = armar({
    vigente: vigenteDe([{ ...ATUN_ALAMAR, IdLlaveImpto: "ICO", ValorImpto: 1200 }]),
  });
  assert.deepEqual(Object.keys(p), [
    "Encabezado Cotizaciones",
    "Impuestos en Valor",
    "Descuentos",
  ]);
});

test("una sección VACÍA se omite, no se manda en cero", () => {
  // Verificado contra QA el 2026-08-27: mandar `"Descuentos": []` devuelve
  // HTTP 400 con una advertencia por CADA variable declarada en el conector —
  // "el campo 'ITEM' no se está enviando en la sección 'Descuentos'". El
  // conector recorre las variables configuradas y no encuentra ninguna.
  const p = armar({ propuesta: { ...PROPUESTA, descuentos: [] } });
  assert.equal("Descuentos" in p, false);
  assert.equal("Impuestos en Valor" in p, false);
  // El encabezado va SIEMPRE: sin él no hay nada que importar.
  assert.equal(p["Encabezado Cotizaciones"].length, 1);
});

test("el encabezado lleva la llave formateada y el precio nuevo", () => {
  const [enc] = armar()[BLOQUES.encabezado];
  assert.deepEqual(enc, {
    NIT_PROVEEDOR: "800186960",
    SUCURSAL: "006",
    ITEM: "1032",
    FECHA_ACTIVACION: "20260901",
    "U.M": "UND",
    PRECIO: "000000000004900.0000",
    NOTAS: "Ajuste anual",
  });
});

test("la fecha del encabezado va SIN tilde y la de los otros bloques CON tilde", () => {
  const p = armar({
    vigente: vigenteDe([{ ...ATUN_ALAMAR, IdLlaveImpto: "ICO", ValorImpto: 1200 }]),
  });

  assert.equal("FECHA_ACTIVACION" in p[BLOQUES.encabezado][0], true);
  assert.equal("FECHA_ACTIVACIÓN" in p[BLOQUES.encabezado][0], false);

  assert.equal("FECHA_ACTIVACIÓN" in p[BLOQUES.impuestos][0], true);
  assert.equal("FECHA_ACTIVACION" in p[BLOQUES.impuestos][0], false);

  assert.equal("FECHA_ACTIVACIÓN" in p[BLOQUES.descuentos][0], true);
  assert.equal("FECHA_ACTIVACION" in p[BLOQUES.descuentos][0], false);
});

/* ── Re-emisión de impuestos: el riesgo caro ─────────────────────────────── */

test("RE-EMITE los impuestos vigentes con la FECHA NUEVA", () => {
  // Sin este bloque, la cotización del 1-sep nacería sin ICO ni IBUA.
  const vigente = vigenteDe([
    { ...ATUN_ALAMAR, IdLlaveImpto: "ICO ", ValorImpto: 1200 },
    { ...ATUN_ALAMAR, IdLlaveImpto: "IBUA", ValorImpto: 800 },
  ]);
  const impuestos = armar({ vigente })[BLOQUES.impuestos];

  assert.equal(impuestos.length, 2);
  assert.deepEqual(impuestos[0], {
    NIT_PROVEEDOR: "800186960",
    SUCURSAL: "006",
    ITEM: "1032",
    "FECHA_ACTIVACIÓN": "20260901", // ← la NUEVA, no la de 2023
    "U.M": "UND",
    LLAVE_IMPUESTO: "ICO",
    VALOR_IMPUESTO: "000000000001200.0000",
  });
  assert.equal(impuestos[1].LLAVE_IMPUESTO, "IBUA");
});

test("sin impuestos vigentes, el bloque NO viaja", () => {
  const p = armar();
  assert.equal(BLOQUES.impuestos in p, false);
});

/* ── Descuentos ──────────────────────────────────────────────────────────── */

test("los descuentos salen de la PROPUESTA, no de la vigente", () => {
  const p = armar({
    propuesta: { ...PROPUESTA, descuentos: [{ orden: 1, porcentaje: 7 }] },
  });
  assert.equal(p[BLOQUES.descuentos][0]["%_DESCUENTO"], "007.0000");
});

test("un descuento quitado se representa por AUSENCIA, no por una fila en 0%", () => {
  // El proveedor borra el 3%. Como la fecha es parte de la llave, no mandar el
  // orden significa que ese orden no existe en la fecha nueva.
  const p = armar({ propuesta: { ...PROPUESTA, descuentos: [{ orden: 1, porcentaje: 0 }] } });
  assert.equal(BLOQUES.descuentos in p, false);
});

test("emite un renglón por orden, ordenados", () => {
  const p = armar({
    propuesta: {
      ...PROPUESTA,
      descuentos: [
        { orden: 3, porcentaje: 1 },
        { orden: 1, porcentaje: 3 },
        { orden: 2, porcentaje: 2 },
      ],
    },
  });
  assert.deepEqual(
    p[BLOQUES.descuentos].map((d) => d.NRO_ORDEN),
    ["1", "2", "3"],
  );
});

test("el descuento va en porcentaje y el campo de valor en cero", () => {
  const [d] = armar()[BLOQUES.descuentos];
  assert.equal(d["%_DESCUENTO"], "003.0000");
  assert.equal(d.VALOR_DESCUENTO, "000000000000000.0000");
});

/* ── Guardas ─────────────────────────────────────────────────────────────── */

test("bloquea una fecha retroactiva salvo que se pida explícitamente", () => {
  const retro = { ...PROPUESTA, fechaActivacion: "2026-08-01" };
  assert.throws(() => armar({ propuesta: retro }), RangeError);

  const p = armar({ propuesta: retro, permitirRetroactiva: true });
  assert.equal(p[BLOQUES.encabezado][0].FECHA_ACTIVACION, "20260801");
});

test("una activación de HOY no es retroactiva", () => {
  const p = armar({ propuesta: { ...PROPUESTA, fechaActivacion: HOY } });
  assert.equal(p[BLOQUES.encabezado][0].FECHA_ACTIVACION, "20260826");
});

test("rechaza una propuesta que no corresponde al renglón vigente", () => {
  // Escribir el precio del ítem equivocado es un bug silencioso: SIESA lo acepta.
  assert.throws(
    () => armar({ propuesta: { ...PROPUESTA, claveItem: "COP|800186960|006|9999|UND" } }),
    RangeError,
  );
});

test("acepta la propuesta cuando la clave sí coincide", () => {
  const vigente = vigenteDe([ATUN_ALAMAR]);
  const p = armar({ propuesta: { ...PROPUESTA, claveItem: vigente.claveItem } });
  assert.equal(p[BLOQUES.encabezado][0].ITEM, "1032");
});

test("exige vigente, propuesta y fecha", () => {
  assert.throws(() => armarPayload({ propuesta: PROPUESTA }), TypeError);
  assert.throws(() => armarPayload({ vigente: vigenteDe([ATUN_ALAMAR]) }), TypeError);
  assert.throws(
    () => armar({ propuesta: { ...PROPUESTA, fechaActivacion: null } }),
    TypeError,
  );
});

test("un precio inválido revienta al armar, no en SIESA", () => {
  assert.throws(() => armar({ propuesta: { ...PROPUESTA, precio: null } }), TypeError);
  assert.throws(() => armar({ propuesta: { ...PROPUESTA, precio: -100 } }), RangeError);
});

/* ── Lectura de la respuesta ─────────────────────────────────────────────── */

test("un 200 con errores adentro NO es éxito", () => {
  // Es el modo de falla del conector: responde 200 y rechaza en el cuerpo.
  assert.equal(respuestaOk({ codigo: 0 }), true);
  assert.equal(respuestaOk({ codigo: 1 }), false);
  assert.equal(respuestaOk({ Errores: [{ msg: "Item no existe" }] }), false);
  assert.equal(respuestaOk({ errores: [] }), true);
  assert.equal(respuestaOk({ error: "algo" }), false);
  assert.equal(respuestaOk(null), false);
});

test("el detalle del error queda legible, no [object Object]", () => {
  assert.match(detalleError({ Errores: [{ msg: "Item no existe" }] }), /Item no existe/);
  assert.match(detalleError({ detalle: "llave duplicada" }), /llave duplicada/);
  assert.equal(detalleError(null), "sin respuesta");
  assert.equal(detalleError("x".repeat(2000)).length, 800);
});

/* ── Moneda ──────────────────────────────────────────────────────────────── */

test("se niega a escribir una cotización que no esté en COP", () => {
  // El conector fija F212_ID_MONEDA en COP. Mandar una cotización en dólares
  // cargaría USD 100 como $100.
  const vigente = vigenteDe([{ ...ATUN_ALAMAR, Moneda: "USD" }]);
  assert.throws(() => armar({ vigente }), RangeError);
});

test("una cotización en COP pasa, con o sin la columna", () => {
  assert.equal(armar({ vigente: vigenteDe([{ ...ATUN_ALAMAR, Moneda: "COP" }]) })[BLOQUES.encabezado].length, 1);
  assert.equal(armar()[BLOQUES.encabezado].length, 1);
});

/* ── Origen del error: ¿salió de acá o lo rechazó el ERP? ────────────────── */

test("un ítem de 8 dígitos NO llega a SIESA: lo frena la validación local", () => {
  // Descubierto el 2026-08-31: el conector limita ITEM a 7 caracteres. Ya se
  // validaba (formatoSiesa `campo.item`), pero el error salía sin decir de dónde
  // venía y terminaba reportado como "SIESA rechazó el cambio" — mandando al
  // admin a buscar en el ERP un problema que nunca llegó ahí.
  assert.throws(
    () => armar({ vigente: { ...vigenteDe([ATUN_ALAMAR]), item: "12345678" } }),
    (e) => e instanceof RangeError && /ITEM/.test(e.message),
  );
});

test("importarCotizacion marca los errores de armado como NO enviados", async () => {
  const { importarCotizacion } = await import("./siesaCotizacion.js");

  // Sin credenciales, ConfigSiesaError se lanza antes de cualquier llamada.
  const previo = { k: process.env.CONNI_KEY, t: process.env.CONNI_TOKEN };
  delete process.env.CONNI_KEY;
  delete process.env.CONNI_TOKEN;

  try {
    await importarCotizacion({ solicitudId: 1, vigente: vigenteDe([ATUN_ALAMAR]), propuesta: PROPUESTA });
    assert.fail("tenía que lanzar");
  } catch (e) {
    // `false`, no `undefined`: la diferencia entre "no salió" y "no sé si llegó"
    // es la que decide si reintentar puede duplicar un precio.
    assert.equal(e.enviadoASiesa, false, "un fallo de configuración nunca llegó al ERP");
  } finally {
    if (previo.k) process.env.CONNI_KEY = previo.k;
    if (previo.t) process.env.CONNI_TOKEN = previo.t;
  }
});

/* ── Modo SANDBOX ─────────────────────────────────────────────────────────────

   `PROVEEDORES_SANDBOX=true` es el interruptor para probar el empuje sin escribir
   en el ERP (§8 de PENDIENTES). Corta justo antes del POST y después de armar el
   payload, así el armado —donde viven los bugs de formato y re-emisión— se
   ejercita igual.

   No tenía tests, y por eso pasó esto: el log del sandbox leía
   `payload[BLOQUES.impuestos].length` sobre un payload que OMITE las secciones
   vacías. Reventaba con cualquier ítem sin impuestos ni descuentos — 892 de las
   1.237 cotizaciones de Altipal, o sea el caso más común. Y al reventar caía en
   el catch de `marcarFallida`, diciéndole al admin que la solicitud falló, en el
   modo que existe justamente para que nada falle.
   ────────────────────────────────────────────────────────────────────────────── */

const PELADO = {
  ...ATUN_ALAMAR,
  IdLlaveImpto: null,
  ValorImpto: null,
  PorcDsctoOrden1: null,
  PorcDsctoOrden2: null,
  PorcDsctoOrden3: null,
};

/** Corre `importarCotizacion` en sandbox y devuelve lo que salió, sin tocar la red. */
async function enSandbox(vigente, propuesta) {
  const antes = process.env.PROVEEDORES_SANDBOX;
  const warn = console.warn;
  process.env.PROVEEDORES_SANDBOX = "true";
  console.warn = () => {}; // el log del sandbox es ruidoso y no es lo que se prueba
  try {
    const { importarCotizacion } = await import("./siesaCotizacion.js");
    return await importarCotizacion({ solicitudId: "test", vigente, propuesta });
  } finally {
    console.warn = warn;
    if (antes === undefined) delete process.env.PROVEEDORES_SANDBOX;
    else process.env.PROVEEDORES_SANDBOX = antes;
  }
}

test("sandbox: un ítem SIN impuestos ni descuentos no revienta el log", async () => {
  // El caso que fallaba. Sin impuestos y con la propuesta sin descuentos, el
  // payload trae SOLO el encabezado: las otras dos claves no existen.
  const r = await enSandbox(vigenteDe([PELADO]), {
    precio: 4900,
    descuentos: [],
    fechaActivacion: "2099-09-01",
    notas: "sin nada",
  });

  assert.equal(r.sandbox, true);
  assert.deepEqual(Object.keys(r.payload), [BLOQUES.encabezado]);
});

test("sandbox: no sale a la red aunque los datos sean válidos", async () => {
  const r = await enSandbox(vigenteDe([ATUN_ALAMAR]), {
    ...PROPUESTA,
    fechaActivacion: "2099-09-01",
  });

  assert.equal(r.sandbox, true);
  assert.deepEqual(r.respuesta, { sandbox: true });
  // El armado se ejercitó igual: por eso el sandbox corta DESPUÉS de armar.
  assert.ok(r.payload[BLOQUES.descuentos]);
});
