import test from "node:test";
import assert from "node:assert/strict";
import { trim, decimal, precio, porcentaje, fecha, texto, entero, campo } from "./formatoSiesa.js";

/* ── trim: el relleno de SQL Server ──────────────────────────────────────── */

test("recorta el relleno con que Connekta devuelve los CHAR", () => {
  // Valores textuales de la respuesta real de merkahorro_cotizaciones_dev.
  assert.equal(trim("800186960      "), "800186960");
  assert.equal(trim("UND "), "UND");
  assert.equal(trim("ATUN ALAMAR ENSALADA NATURAL X160GR     "), "ATUN ALAMAR ENSALADA NATURAL X160GR");
  assert.equal(trim(null), "");
  assert.equal(trim(undefined), "");
});

/* ── decimal / precio ────────────────────────────────────────────────────── */

test("el precio va a 20 caracteres: 15 enteros + punto + 4 decimales", () => {
  assert.equal(precio(4672), "000000000004672.0000");
  assert.equal(precio(4672).length, 20);
  assert.equal(precio(0), "000000000000000.0000");
  assert.equal(precio(4531.84), "000000000004531.8400");
});

test("redondea a 4 decimales, no trunca", () => {
  assert.equal(precio(1.00005), "000000000000001.0001");
  assert.equal(precio(1.00004), "000000000000001.0000");
});

test("lanza si el valor no entra en el campo, en vez de truncarlo", () => {
  // 16 dígitos en un campo de 15. Truncar acá cargaría un precio distinto.
  assert.throws(() => precio(1234567890123456), RangeError);
  assert.throws(() => decimal(1000, 3, 4, "X"), RangeError);
});

test("rechaza negativos: el ancho fijo no reserva lugar para el signo", () => {
  assert.throws(() => precio(-1), RangeError);
});

test("rechaza valores no numéricos", () => {
  assert.throws(() => precio("cuatro mil"), TypeError);
  assert.throws(() => precio(null), TypeError);
  assert.throws(() => precio(""), TypeError);
  assert.throws(() => precio([]), TypeError);
  assert.throws(() => precio(false), TypeError);
});

/* ── porcentaje ──────────────────────────────────────────────────────────── */

test("el porcentaje va a 8 caracteres: 3 enteros + punto + 4 decimales", () => {
  assert.equal(porcentaje(3), "003.0000");
  assert.equal(porcentaje(3).length, 8);
  assert.equal(porcentaje(0), "000.0000");
  assert.equal(porcentaje(100), "100.0000");
});

test("un descuento de más del 100% se rechaza", () => {
  assert.throws(() => porcentaje(101), RangeError);
});

/* ── fecha: la trampa del huso horario ───────────────────────────────────── */

test("convierte a AAAAMMDD desde lo que manda Connekta y desde un DATE", () => {
  assert.equal(fecha("2023-09-01T00:00:00"), "20230901");
  assert.equal(fecha("2026-09-01"), "20260901");
});

test("NO corre la fecha un día por el huso horario", () => {
  // Este es el bug que el módulo evita: en un server UTC,
  // new Date("2026-09-01") formateado a hora Colombia daría 20260831.
  assert.equal(fecha("2026-09-01T00:00:00"), "20260901");
  assert.equal(fecha("2026-01-01"), "20260101");
  assert.equal(fecha("2026-12-31"), "20261231");
});

test("rechaza fechas mal formadas o inexistentes", () => {
  assert.throws(() => fecha("01/09/2026"), TypeError);
  assert.throws(() => fecha("20260901"), TypeError);
  assert.throws(() => fecha(""), TypeError);
  assert.throws(() => fecha("2026-13-01"), RangeError);
});

/* ── texto / entero ──────────────────────────────────────────────────────── */

test("el texto se recorta y se valida contra el largo del campo", () => {
  assert.equal(texto("UND ", 4, "U.M"), "UND");
  assert.throws(() => texto("x".repeat(256), 255, "NOTAS"), RangeError);
});

test("el entero rechaza decimales y negativos", () => {
  assert.equal(entero(1032, 7, "ITEM"), "1032");
  assert.throws(() => entero(10.5, 7, "ITEM"), TypeError);
  assert.throws(() => entero(-3, 7, "ITEM"), TypeError);
  assert.throws(() => entero(12345678, 7, "ITEM"), RangeError);
});

/* ── campo: una fila real de Altipal, de punta a punta ───────────────────── */

test("formatea el ATÚN ALAMAR tal como llega de Connekta", () => {
  const fila = {
    IdTercero: "800186960      ",
    Sucursal: "006",
    CodigoItem: 1032,
    UM: "UND ",
    Precio: 4672.0,
    FechaActivacion: "2023-09-01T00:00:00",
    PorcDsctoOrden1: 3.0,
  };

  assert.equal(campo.nitProveedor(fila.IdTercero), "800186960");
  assert.equal(campo.sucursal(fila.Sucursal), "006");
  assert.equal(campo.item(fila.CodigoItem), "1032");
  assert.equal(campo.unidadMedida(fila.UM), "UND");
  assert.equal(campo.precio(fila.Precio), "000000000004672.0000");
  assert.equal(campo.fechaActivacion(fila.FechaActivacion), "20230901");
  assert.equal(campo.porcentajeDescuento(fila.PorcDsctoOrden1), "003.0000");
});

test("el orden del descuento va de 1 a 9, nunca 0", () => {
  assert.equal(campo.nroOrden(1), "1");
  assert.equal(campo.nroOrden(9), "9");
  assert.throws(() => campo.nroOrden(0), RangeError);
  assert.throws(() => campo.nroOrden(10), RangeError);
});

test("las notas vacías son válidas, las de 300 caracteres no", () => {
  assert.equal(campo.notas(null), "");
  assert.equal(campo.notas("Ajuste anual"), "Ajuste anual");
  assert.throws(() => campo.notas("x".repeat(300)), RangeError);
});
