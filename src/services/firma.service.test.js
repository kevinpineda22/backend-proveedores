import test from "node:test";
import assert from "node:assert/strict";
import {
  serializarParaFirma,
  serializarLinea,
  hashPayload,
  hashPayloadV1,
  firmaCoincide,
  validarTrazo,
  lineaParaFirma,
} from "./firma.service.js";

/** Una línea del paquete. */
const LINEA = {
  claveItem: "COP|800186960|006|1032|UND",
  item: 1032,
  unidadMedida: "UND",
  precioActual: 4672,
  descuentosActuales: [{ orden: 1, porcentaje: 3 }],
  impuestosVigentes: [],
  precioPropuesto: 4900,
  descuentosPropuestos: [{ orden: 1, porcentaje: 3 }],
  impuestosPropuestos: [],
  fechaActivacion: "2026-09-01",
};

const OTRA = {
  ...LINEA,
  claveItem: "COP|800186960|006|2092|UND",
  item: 2092,
  precioActual: 12496.83,
  precioPropuesto: 12900,
  descuentosActuales: [],
  descuentosPropuestos: [],
  impuestosVigentes: [{ llave: "ICO", valor: 4313 }],
  impuestosPropuestos: [{ llave: "ICO", valor: 4313 }],
};

const paquete = (...lineas) => ({ cuentaId: 7, lineas });
const DATOS = paquete(LINEA);

/* ── Canonicalización ────────────────────────────────────────────────────── */

test("el mismo contenido produce siempre el mismo hash", () => {
  assert.equal(hashPayload(DATOS), hashPayload(paquete({ ...LINEA })));
});

test("el orden de las claves del objeto NO cambia el hash", () => {
  // Por esto la serialización se arma a mano y no con JSON.stringify: con
  // stringify, dos objetos iguales construidos distinto darían hashes distintos
  // y la verificación fallaría de a ratos.
  const alReves = {
    fechaActivacion: LINEA.fechaActivacion,
    impuestosPropuestos: LINEA.impuestosPropuestos,
    descuentosPropuestos: LINEA.descuentosPropuestos,
    precioPropuesto: LINEA.precioPropuesto,
    impuestosVigentes: LINEA.impuestosVigentes,
    descuentosActuales: LINEA.descuentosActuales,
    precioActual: LINEA.precioActual,
    unidadMedida: LINEA.unidadMedida,
    item: LINEA.item,
    claveItem: LINEA.claveItem,
  };
  assert.equal(hashPayload(paquete(alReves)), hashPayload(DATOS));
});

test("4672 y 4672.0 firman igual", () => {
  assert.equal(hashPayload(paquete({ ...LINEA, precioActual: 4672.0 })), hashPayload(DATOS));
  assert.equal(hashPayload(paquete({ ...LINEA, precioActual: "4672" })), hashPayload(DATOS));
});

test("el orden de los descuentos en el array no cambia el hash", () => {
  const a = paquete({ ...LINEA, descuentosPropuestos: [{ orden: 2, porcentaje: 2 }, { orden: 1, porcentaje: 3 }] });
  const b = paquete({ ...LINEA, descuentosPropuestos: [{ orden: 1, porcentaje: 3 }, { orden: 2, porcentaje: 2 }] });
  assert.equal(hashPayload(a), hashPayload(b));
});

test("el orden de los IMPUESTOS en el array tampoco", () => {
  // Un ítem puede traer ICO e IBU3, y el orden en que la consulta los devuelve no
  // está garantizado (la consulta duplica el renglón por impuesto y el agrupador
  // los acumula en un array). Sin ordenar, la misma solicitud firmaría distinto
  // según cómo vino de SIESA.
  const dos = [{ llave: "ICO", valor: 100 }, { llave: "IBU3", valor: 50 }];
  const a = paquete({ ...LINEA, impuestosPropuestos: dos });
  const b = paquete({ ...LINEA, impuestosPropuestos: [...dos].reverse() });
  assert.equal(hashPayload(a), hashPayload(b));
});

test("el orden de las LÍNEAS no cambia el hash", () => {
  // El proveedor arma su paquete en la pantalla y los productos pueden salir en
  // cualquier orden. El mismo paquete tiene que firmar siempre igual.
  assert.equal(hashPayload(paquete(LINEA, OTRA)), hashPayload(paquete(OTRA, LINEA)));
});

test("una fecha ISO y una fecha corta firman igual", () => {
  assert.equal(
    hashPayload(paquete({ ...LINEA, fechaActivacion: "2026-09-01T00:00:00" })),
    hashPayload(DATOS),
  );
});

/* ── La firma se rompe si cambia lo firmado ──────────────────────────────── */

test("CADA campo de la línea cambia el hash", () => {
  const variantes = {
    claveItem: "COP|800186960|006|9999|UND",
    item: 9999,
    unidadMedida: "CAJA",
    precioActual: 4673,
    precioPropuesto: 4901,
    fechaActivacion: "2026-09-02",
    descuentosPropuestos: [{ orden: 1, porcentaje: 0 }],
    descuentosActuales: [{ orden: 1, porcentaje: 5 }],
    impuestosPropuestos: [{ llave: "ICO", valor: 1 }],
    impuestosVigentes: [{ llave: "ICO", valor: 1 }],
  };
  const base = hashPayload(DATOS);

  for (const [campo, valor] of Object.entries(variantes)) {
    assert.notEqual(
      hashPayload(paquete({ ...LINEA, [campo]: valor })),
      base,
      `${campo} no afectó el hash`,
    );
  }
});

test("la cuenta cambia el hash", () => {
  assert.notEqual(hashPayload({ cuentaId: 8, lineas: [LINEA] }), hashPayload(DATOS));
});

test("quitar un descuento rompe la firma", () => {
  // El caso que motivó el tope sobre costo neto: si alguien borra el descuento
  // después de firmado, la firma tiene que dejar de valer.
  assert.notEqual(hashPayload(paquete({ ...LINEA, descuentosPropuestos: [] })), hashPayload(DATOS));
});

test("quitar un IMPUESTO rompe la firma", () => {
  // Desde el 2026-09-06 el proveedor puede quitar un ICO. La única prueba de que
  // lo pidió él es que ese hecho esté ADENTRO de lo firmado.
  const con = paquete({ ...OTRA });
  const sin = paquete({ ...OTRA, impuestosPropuestos: [] });
  assert.notEqual(hashPayload(sin), hashPayload(con));
});

test("un impuesto en 0 y un impuesto AUSENTE firman distinto", () => {
  // No significan lo mismo: cero es "está sujeto y paga cero"; ausente es "no
  // existe en esta fecha". Si firmaran igual, la firma no podría distinguir
  // cuál de las dos aceptó el proveedor.
  const cero = paquete({ ...OTRA, impuestosPropuestos: [{ llave: "ICO", valor: 0 }] });
  const ausente = paquete({ ...OTRA, impuestosPropuestos: [] });
  assert.notEqual(hashPayload(cero), hashPayload(ausente));
});

test("AGREGARLE una línea al paquete rompe la firma", () => {
  // Ésta es LA razón de que el hash cubra todas las líneas. Si cubriera solo la
  // primera, colar un producto en una solicitud ya firmada no rompería nada.
  assert.notEqual(hashPayload(paquete(LINEA, OTRA)), hashPayload(paquete(LINEA)));
});

test("SACARLE una línea al paquete rompe la firma", () => {
  assert.notEqual(hashPayload(paquete(LINEA)), hashPayload(paquete(LINEA, OTRA)));
});

test("un paquete vacío no hashea igual que uno con líneas", () => {
  // Guarda contra el error tonto de pasarle la forma vieja (objeto plano, sin
  // `lineas`): daría `lineas=0` y TODOS los hashes saldrían iguales — los tests
  // pasarían sin probar nada.
  assert.notEqual(hashPayload({ cuentaId: 7, lineas: [] }), hashPayload(DATOS));
  assert.notEqual(hashPayload({ cuentaId: 7 }), hashPayload(DATOS));
});

/* ── firmaCoincide ───────────────────────────────────────────────────────── */

test("valida el hash correcto y rechaza cualquier otro", () => {
  const h = hashPayload(DATOS);
  assert.equal(firmaCoincide(h, DATOS), true);
  assert.equal(firmaCoincide(h, paquete({ ...LINEA, precioPropuesto: 5000 })), false);
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

/* ── Compatibilidad con las firmas anteriores a la 006 ────────────────────── */

test("una firma v1 sigue siendo válida en un paquete de UNA línea", () => {
  // Sin esto, la solicitud que ya estaba `pendiente` al migrar diría "fue
  // modificada después de la firma" — una acusación falsa, y nadie la modificó.
  const viejo = hashPayloadV1({ cuentaId: 7, linea: LINEA });

  assert.notEqual(viejo, hashPayload(DATOS), "los formatos son distintos");
  assert.equal(firmaCoincide(viejo, DATOS), true, "pero la firma vieja se acepta igual");
});

test("una firma v1 NO vale para un paquete de varias líneas", () => {
  // v1 solo pudo firmar una línea. Aceptarla sobre un paquete de dos sería
  // aceptar una firma que nunca vio la segunda.
  const viejo = hashPayloadV1({ cuentaId: 7, linea: LINEA });
  assert.equal(firmaCoincide(viejo, paquete(LINEA, OTRA)), false);
});

test("una firma v1 NO vale si la línea cambia impuestos", () => {
  // v1 no firmaba impuestos: no puede dar fe de que el proveedor aceptó quitar
  // un ICO. Si valiera, quitarle el impuesto a una solicitud vieja pasaría la
  // verificación sin que nadie lo haya firmado.
  const linea = { ...OTRA, impuestosPropuestos: [] };
  const viejo = hashPayloadV1({ cuentaId: 7, linea });
  assert.equal(firmaCoincide(viejo, paquete(linea)), false);
});

test("v1 y v2 no colisionan aunque el contenido sea el mismo", () => {
  assert.notEqual(hashPayloadV1({ cuentaId: 7, linea: LINEA }), hashPayload(DATOS));
});

/* ── Serialización legible ───────────────────────────────────────────────── */

test("la serialización es auditable a ojo", () => {
  // Que se pueda leer importa: cuando alguien discuta una firma, esto es lo que
  // se compara contra la solicitud.
  const s = serializarParaFirma(paquete(LINEA, OTRA));
  assert.match(s, /^v2/, "la versión va adentro de lo firmado");
  assert.match(s, /cuenta=7/);
  assert.match(s, /lineas=2/);
  assert.match(s, /precioActual=4672\.0000/);
  assert.match(s, /precioPropuesto=4900\.0000/);
  assert.match(s, /dctosPropuestos=1:3\.0000/);
  assert.match(s, /imptosPropuestos=ICO:4313\.0000/);
  assert.match(s, /fechaActivacion=2026-09-01/);
});

test("las líneas van separadas por un carácter que no aparece adentro", () => {
  // Si el separador de líneas pudiera aparecer dentro de una, dos paquetes
  // distintos podrían producir la misma cadena partiéndola en otro lado.
  const s = serializarLinea(LINEA);
  assert.equal(s.includes("\n"), false);
  assert.equal(serializarParaFirma(paquete(LINEA, OTRA)).split("\n").length, 5); // v2 + cuenta + lineas + 2
});

/* ── lineaParaFirma ──────────────────────────────────────────────────────── */

test("lineaParaFirma traduce una fila de la base sin perder nada", () => {
  // Es el contrato entre la tabla y la firma: si se agrega una columna firmable
  // y no se mapea acá, la firma deja de cubrirla en silencio.
  const fila = {
    clave_item: LINEA.claveItem,
    item: LINEA.item,
    unidad_medida: LINEA.unidadMedida,
    precio_actual: LINEA.precioActual,
    descuentos_actuales: LINEA.descuentosActuales,
    impuestos_vigentes: [{ llave: "ICO", valor: 10 }],
    precio_propuesto: LINEA.precioPropuesto,
    descuentos_propuestos: LINEA.descuentosPropuestos,
    impuestos_propuestos: [{ llave: "ICO", valor: 20 }],
    fecha_activacion: LINEA.fechaActivacion,
  };

  assert.equal(
    hashPayload({ cuentaId: 7, lineas: [lineaParaFirma(fila)] }),
    hashPayload(paquete({
      ...LINEA,
      impuestosVigentes: [{ llave: "ICO", valor: 10 }],
      impuestosPropuestos: [{ llave: "ICO", valor: 20 }],
    })),
  );
});

test("lineaParaFirma no rompe con los JSONB en null", () => {
  // `descuentos_actuales` tiene DEFAULT '[]' pero `maybeSingle` sobre una fila
  // parcial puede traer undefined. Un crash acá tumbaría la aprobación.
  const l = lineaParaFirma({ clave_item: "x", item: 1, unidad_medida: "UND", fecha_activacion: "2026-01-01" });
  assert.deepEqual(l.descuentosActuales, []);
  assert.deepEqual(l.impuestosPropuestos, []);
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
