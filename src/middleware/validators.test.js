import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { esquemas } from "./validators.js";

const BASE = {
  claveItem: "COP|800186960|006|179313|UND",
  precioPropuesto: 13920,
  descuentosPropuestos: [],
  fechaActivacion: "2026-10-15",
  notas: "Ajuste",
  firma: "data:image/svg+xml;base64,x",
};

const parsear = (extra) => esquemas.crearSolicitud.safeParse({ ...BASE, ...extra });

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
