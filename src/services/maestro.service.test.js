import test from "node:test";
import assert from "node:assert/strict";
import { derivarMaestro } from "./maestro.service.js";

/** Forma NORMALIZADA, la que produce agruparCotizaciones(). */
const fila = (nit, sucursal, extra = {}) => ({
  idTercero: nit,
  nit,
  sucursal,
  nombreSucursal: `SUC ${sucursal}`,
  razonSocial: `EMPRESA ${nit}`,
  ...extra,
});

test("colapsa las 18.000 cotizaciones en proveedores y sucursales únicos", () => {
  const { proveedores, cuentas } = derivarMaestro([
    fila("800186960", "006"),
    fila("800186960", "006"), // mismo renglón, otro ítem
    fila("800186960", "001"), // otra sucursal del mismo NIT
    fila("811045372", "001"),
  ]);

  assert.equal(proveedores.length, 2);
  assert.equal(cuentas.length, 3);
});

test("un NIT con varias sucursales es UN proveedor y VARIAS cuentas", () => {
  // Es la base del aislamiento: la cuenta —no el proveedor— es la unidad de
  // acceso. La sucursal 006 no puede ver lo de la 001 aunque compartan NIT.
  const { proveedores, cuentas } = derivarMaestro([
    fila("800186960", "001"),
    fila("800186960", "006"),
    fila("800186960", "012"),
  ]);

  assert.equal(proveedores.length, 1);
  assert.deepEqual(cuentas.map((c) => c.sucursal).sort(), ["001", "006", "012"]);
});

test("conserva los ceros a la izquierda de la sucursal", () => {
  // "006" y "6" son sucursales distintas para SIESA, y el email sintético que se
  // arma con ellas también.
  const { cuentas } = derivarMaestro([fila("800186960", "006"), fila("800186960", "6")]);
  assert.equal(cuentas.length, 2);
});

test("descarta filas sin NIT o sin sucursal, sin frenar el resto", () => {
  const { proveedores, cuentas } = derivarMaestro([
    fila("800186960", "006"),
    { nit: "", sucursal: "006" },
    { nit: "811045372", sucursal: "" },
    { nit: null, sucursal: null },
  ]);

  assert.equal(proveedores.length, 1);
  assert.equal(cuentas.length, 1);
});

test("recorta el relleno que pueda quedar del snapshot", () => {
  const { proveedores, cuentas } = derivarMaestro([
    { idTercero: "800186960  ", nit: " 800186960 ", sucursal: " 006 ", nombreSucursal: "SUC  ", razonSocial: " ALTIPAL " },
  ]);
  assert.equal(proveedores[0].nit, "800186960");
  assert.equal(proveedores[0].razon_social, "ALTIPAL");
  assert.equal(cuentas[0].sucursal, "006");
});

test("un nombre vacío queda en null, no en cadena vacía", () => {
  // Una cadena vacía en la tabla se ve como un nombre que existe y está en
  // blanco; un null se ve como "todavía no lo sabemos", que es la verdad.
  const { proveedores, cuentas } = derivarMaestro([
    { nit: "800186960", sucursal: "006", nombreSucursal: "   ", razonSocial: "" },
  ]);
  assert.equal(proveedores[0].razon_social, null);
  assert.equal(cuentas[0].nombre_sucursal, null);
});

test("no devuelve nada con entrada vacía", () => {
  assert.deepEqual(derivarMaestro([]), { proveedores: [], cuentas: [] });
  assert.deepEqual(derivarMaestro(), { proveedores: [], cuentas: [] });
});
