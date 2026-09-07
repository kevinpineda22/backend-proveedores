import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { esquemas } from "./validators.js";

const LINEA = {
  claveItem: "COP|800186960|006|179313|UND",
  precioPropuesto: 13920,
  descuentosPropuestos: [],
  fechaActivacion: "2026-10-15",
  notas: "Ajuste",
};

const FIRMA = "data:image/svg+xml;base64,x";

/** Un paquete de UNA línea, con `extra` aplicado a esa línea. */
const parsear = (extra) =>
  esquemas.crearSolicitud.safeParse({ lineas: [{ ...LINEA, ...extra }], firma: FIRMA });

const parsearPaquete = (lineas, extra = {}) =>
  esquemas.crearSolicitud.safeParse({ lineas, firma: FIRMA, ...extra });

describe("crearSolicitud — el precio propuesto", () => {
  test("acepta un entero", () => {
    assert.equal(parsear({ precioPropuesto: 13920 }).success, true);
  });

  test("acepta hasta 2 decimales", () => {
    assert.equal(parsear({ precioPropuesto: 4891.28 }).success, true);
    assert.equal(parsear({ precioPropuesto: 6246.8 }).success, true);
  });

  /* El caso real, medido contra SIESA QA el 2026-09-02.

     El conector rechaza un precio con más de 2 decimales — *"no cumple con los
     decimales unitarios de la moneda"*—, y **SIESA almacena precios así**: 218
     cotizaciones del catálogo (1,2 %, 36 proveedores) tienen 3 o 4 decimales,
     todas nacidas de dividir el precio de una presentación.

     El disparador no es un proveedor escribiendo mal: es proponer un cambio de
     descuento SIN tocar el precio. El precio que viaja es el que SIESA nos dio.

     Sin esta validación, el proveedor proponía, FIRMABA, el admin aprobaba, y el
     rechazo llegaba recién ahí. El error tiene que aparecer cuando todavía se
     puede corregir. */
  test("rechaza más de 2 decimales, que es lo que rechaza el conector", () => {
    assert.equal(parsear({ precioPropuesto: 4891.275 }).success, false);
    assert.equal(parsear({ precioPropuesto: 4583.3333 }).success, false);
  });

  test("el mensaje dice qué hacer, no solo que está mal", () => {
    const r = parsear({ precioPropuesto: 4891.275 });
    const mensaje = r.error.issues[0].message;
    assert.match(mensaje, /decimales/i);
    assert.match(mensaje, /4891,27/); // el valor ya redondeado, para copiarlo
  });

  test("sigue rechazando cero y negativos", () => {
    assert.equal(parsear({ precioPropuesto: 0 }).success, false);
    assert.equal(parsear({ precioPropuesto: -100 }).success, false);
  });
});

/* ── El paquete (migración 006) ────────────────────────────────────────────── */

describe("crearSolicitud — el paquete de productos", () => {
  const otra = { ...LINEA, claveItem: "COP|800186960|006|2092|UND", precioPropuesto: 900 };

  test("acepta varias líneas con una sola firma", () => {
    assert.equal(parsearPaquete([LINEA, otra]).success, true);
  });

  test("un paquete sin líneas no es una solicitud", () => {
    const r = parsearPaquete([]);
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /ningún producto/i);
  });

  test("rechaza el mismo renglón dos veces, con un mensaje sobre ESTA solicitud", () => {
    // Sin esto choca contra `idx_pp_lineas_pendiente_unica` y el 23505 se traduce
    // a "ya tiene una solicitud pendiente" — un mensaje sobre OTRA solicitud,
    // cuando el problema está adentro de ésta.
    const r = parsearPaquete([LINEA, { ...LINEA, precioPropuesto: 999 }]);
    assert.equal(r.success, false);
    assert.match(r.error.issues[0].message, /repetido/i);
  });

  test("el mismo ítem en otra U.M. NO es un repetido", () => {
    // Un ítem no tiene un precio: tiene uno por unidad de medida, y la U.M. es
    // parte de la llave. Prohibirlo bloquearía un caso legítimo y frecuente.
    const p2 = { ...LINEA, claveItem: "COP|800186960|006|179313|P2", precioPropuesto: 27840 };
    assert.equal(parsearPaquete([LINEA, p2]).success, true);
  });

  test("corta en 100 productos", () => {
    const muchas = Array.from({ length: 101 }, (_, i) => ({
      ...LINEA,
      claveItem: `COP|800186960|006|${1000 + i}|UND`,
    }));
    assert.equal(parsearPaquete(muchas).success, false);
    assert.equal(parsearPaquete(muchas.slice(0, 100)).success, true);
  });

  test("una firma vacía no pasa: el paquete entero cuelga de ella", () => {
    assert.equal(esquemas.crearSolicitud.safeParse({ lineas: [LINEA], firma: "" }).success, false);
    assert.equal(esquemas.crearSolicitud.safeParse({ lineas: [LINEA] }).success, false);
  });
});

describe("crearSolicitud — los impuestos", () => {
  test("omitir `impuestosPropuestos` NO lo convierte en un array vacío", () => {
    // ES LA DIFERENCIA MÁS CARA DEL ESQUEMA. `undefined` significa "no los tocó,
    // re-emitilos"; `[]` significa "los quitó". Un `.default([])` acá le borraría
    // el ICO a todo producto que pase sin declararlos.
    const r = parsear({});
    assert.equal(r.success, true);
    assert.equal("impuestosPropuestos" in r.data.lineas[0], false);
  });

  test("un array vacío SÍ llega como array vacío", () => {
    const r = parsear({ impuestosPropuestos: [] });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.lineas[0].impuestosPropuestos, []);
  });

  test("acepta un impuesto en 0: está sujeto y hoy paga cero", () => {
    const r = parsear({ impuestosPropuestos: [{ llave: "ICO", valor: 0 }] });
    assert.equal(r.success, true);
  });

  test("no valida la llave contra una lista cerrada", () => {
    // Hoy son ICO e IBU3. Si la ley agrega otra, un enum acá bloquearía el
    // catálogo entero hasta que alguien despliegue.
    assert.equal(parsear({ impuestosPropuestos: [{ llave: "NUEVO", valor: 10 }] }).success, true);
  });

  test("rechaza un valor negativo y una llave vacía", () => {
    assert.equal(parsear({ impuestosPropuestos: [{ llave: "ICO", valor: -1 }] }).success, false);
    assert.equal(parsear({ impuestosPropuestos: [{ llave: "", valor: 10 }] }).success, false);
  });
});

describe("resolverLineas / rechazarLineas", () => {
  test("aprobar exige al menos una línea", () => {
    assert.equal(esquemas.resolverLineas.safeParse({ lineaIds: [] }).success, false);
    assert.equal(esquemas.resolverLineas.safeParse({ lineaIds: [1, 2, 3] }).success, true);
  });

  test("rechazar sigue exigiendo motivo", () => {
    // Un rechazo sin motivo deja al proveedor volviendo a proponer lo mismo. Lo
    // exige también la base (CHECK pp_lineas_rechazo_con_motivo).
    assert.equal(esquemas.rechazarLineas.safeParse({ lineaIds: [1], motivo: "corto" }).success, false);
    assert.equal(
      esquemas.rechazarLineas.safeParse({ lineaIds: [1], motivo: "El precio supera lo acordado" })
        .success,
      true,
    );
  });
});
