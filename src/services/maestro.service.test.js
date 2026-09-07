import test from "node:test";
import assert from "node:assert/strict";
import { derivarMaestro, normalizarTercero } from "./maestro.service.js";

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

/* ── Consulta de TERCEROS ─────────────────────────────────────────────────────
   El maestro derivado de cotizaciones solo ve proveedores CON precios cargados.
   La consulta de terceros lo resuelve, y su respuesta usa los MISMOS alias
   —verificado contra Connekta el 2026-08-31—. Ver PENDIENTES §1.1. */

test("normalizarTercero recorta el relleno de los CHAR de SQL Server", () => {
  // Así llega literalmente: `"1020414979      "`. Sin recortar, el NIT no
  // coincide con ninguno de los que ya están guardados.
  const fila = normalizarTercero({
    IdTercero: "901150440      ",
    NitTercero: "901150440",
    RazonSocial: "DISTRIBUIDORA EJEMPLO SAS ",
    Sucursal: "006",
    DescSucursal: " CATALOGO GENERAL ",
    IdCia: " 1 ",
  });
  assert.deepEqual(fila, {
    idTercero: "901150440",
    nit: "901150440",
    razonSocial: "DISTRIBUIDORA EJEMPLO SAS",
    sucursal: "006",
    idCia: "1",
    nombreSucursal: "CATALOGO GENERAL",
  });
});

test("conserva los ceros a la izquierda de la sucursal", () => {
  // "006" no es 6: la sucursal es parte de la llave de la cuenta y viaja como
  // texto de 3 caracteres hasta el conector.
  assert.equal(normalizarTercero({ Sucursal: "006" }).sucursal, "006");
  assert.equal(normalizarTercero({ Sucursal: " 001 " }).sucursal, "001");
});

test("una fila incompleta no revienta: queda en blanco y la descarta el maestro", () => {
  const fila = normalizarTercero({});
  assert.equal(fila.nit, "");
  assert.equal(fila.sucursal, "");
  // `derivarMaestro` salta las que no tienen nit o sucursal.
  assert.deepEqual(derivarMaestro([fila]), { proveedores: [], cuentas: [] });
});

test("la salida de normalizarTercero entra DIRECTO en derivarMaestro", () => {
  // Es el contrato entre las dos consultas: si cambia una forma, esto lo agarra.
  const crudas = [
    { IdTercero: "800186960 ", NitTercero: "800186960", RazonSocial: "ALTIPAL SAS", Sucursal: "006", DescSucursal: "CATALOGO GENERAL" },
    { IdTercero: "800186960 ", NitTercero: "800186960", RazonSocial: "ALTIPAL SAS", Sucursal: "009", DescSucursal: "BABARIA" },
    { IdTercero: "10114433", NitTercero: "10114433", RazonSocial: "GALLON MARIN CARLOS ALBERTO", Sucursal: "001", DescSucursal: "PRINCIPAL" },
  ];
  const { proveedores, cuentas } = derivarMaestro(crudas.map(normalizarTercero));

  assert.equal(proveedores.length, 2, "dos NIT distintos");
  assert.equal(cuentas.length, 3, "tres pares nit+sucursal");

  // Un proveedor con NIT de PERSONA NATURAL es un proveedor igual. De los 337
  // con acuerdos de precio, 57 son así: filtrarlos por la forma del NIT se
  // llevaría el 17 % del maestro.
  assert.ok(proveedores.some((p) => p.nit === "10114433"));
});

/* ── Duplicados de (nit, sucursal) ─────────────────────────────────────────────
   La consulta de terceros devuelve el mismo par más de una vez con nombres
   distintos: 232 pares de 3.679, medido el 2026-09-06. Y como no puede llevar
   ORDER BY, el orden de llegada no está garantizado — quedarse con el primero
   hacía que el nombre cambiara solo entre corridas del cron.
   ────────────────────────────────────────────────────────────────────────────── */

const crudaTercero = (nit, sucursal, razon, desc) => ({
  IdTercero: nit,
  NitTercero: nit,
  RazonSocial: razon,
  Sucursal: sucursal,
  DescSucursal: desc,
});

test("con (nit, sucursal) duplicado gana el nombre que NO es la razón social", () => {
  // Caso real: ZONA 2 DISTRIBUCIONES SAS, sucursal 001. Llega dos veces porque el
  // tercero está dado de alta en dos compañías. "ZONA 2 DISTRIBUCIONES SAS" es el
  // relleno genérico; "COPA ZONA 2 RAMA" es el que dice cuál sucursal es.
  const crudas = [
    crudaTercero("900256457", "001", "ZONA 2 DISTRIBUCIONES SAS", "COPA ZONA 2 RAMA"),
    crudaTercero("900256457", "001", "ZONA 2 DISTRIBUCIONES SAS", "ZONA 2 DISTRIBUCIONES SAS"),
  ];
  const { cuentas } = derivarMaestro(crudas.map(normalizarTercero));

  assert.equal(cuentas.length, 1);
  assert.equal(cuentas[0].nombre_sucursal, "COPA ZONA 2 RAMA");
});

test("y gana igual si el genérico llega PRIMERO", () => {
  // Éste es el que importa: sin ORDER BY, el orden de llegada es el que sea. Si el
  // resultado dependiera de él, la detección de sucursales hermanas (migración
  // 007) encontraría el par un día y no lo encontraría al siguiente.
  const crudas = [
    crudaTercero("900256457", "001", "ZONA 2 DISTRIBUCIONES SAS", "ZONA 2 DISTRIBUCIONES SAS"),
    crudaTercero("900256457", "001", "ZONA 2 DISTRIBUCIONES SAS", "COPA ZONA 2 RAMA"),
  ];
  const { cuentas } = derivarMaestro(crudas.map(normalizarTercero));

  assert.equal(cuentas[0].nombre_sucursal, "COPA ZONA 2 RAMA");
});

test("si ninguno es la razón social, desempata estable en los dos órdenes", () => {
  // Caso real: 1041233833 llega como "WILMER ADRIAN HOYOS GIRALDO" y como
  // "HOYOS GIRALDO WILMER ADRIAN". Ninguno es mejor que el otro; lo único que se
  // le pide al desempate es dar SIEMPRE lo mismo.
  const a = crudaTercero("1041233833", "001", "OTRA RAZON", "WILMER ADRIAN HOYOS GIRALDO");
  const b = crudaTercero("1041233833", "001", "OTRA RAZON", "HOYOS GIRALDO WILMER ADRIAN");

  const uno = derivarMaestro([a, b].map(normalizarTercero)).cuentas[0].nombre_sucursal;
  const otro = derivarMaestro([b, a].map(normalizarTercero)).cuentas[0].nombre_sucursal;

  assert.equal(uno, otro, "el orden de llegada no puede cambiar el resultado");
});

test("un duplicado no crea una cuenta de más", () => {
  // pp_cuentas tiene UNIQUE(nit, sucursal): si derivarMaestro devolviera dos, el
  // upsert con ignoreDuplicates descartaría una en silencio.
  const crudas = [
    crudaTercero("800088702", "001", "EPS SURA", "EPS SURA"),
    crudaTercero("800088702", "001", "EPS SURA", "EPS SURAMERICANA SA"),
  ];
  const { cuentas } = derivarMaestro(crudas.map(normalizarTercero));

  assert.equal(cuentas.length, 1);
  assert.equal(cuentas[0].nombre_sucursal, "EPS SURAMERICANA SA");
});

/* ── Desempate por COMPAÑÍA (2026-09-07) ──────────────────────────────────────
   La consulta ahora trae `IdCia`. Gana la fila de la compañía donde viven los
   precios: es el nombre que compras reconoce, porque es el de la operación real.
   Medido: resuelve los 138 pares ambiguos, los 138, sin perder proveedores.
   ────────────────────────────────────────────────────────────────────────────── */

const conCia = (nit, sucursal, cia, desc, razon = "ZONA 2 DISTRIBUCIONES SAS") => ({
  IdTercero: nit,
  NitTercero: nit,
  RazonSocial: razon,
  Sucursal: sucursal,
  DescSucursal: desc,
  IdCia: cia,
});

test("gana el nombre de la compañía que tiene los precios", () => {
  // Caso real: ZONA 2, sucursal 001. La cia 1 es la de la operación.
  const crudas = [
    conCia("900256457", "001", "2", "ZONA 2 DISTRIBUCIONES SAS"),
    conCia("900256457", "001", "1", "COPA ZONA 2 RAMA"),
  ];
  const { cuentas } = derivarMaestro(crudas.map(normalizarTercero), "1");

  assert.equal(cuentas.length, 1);
  assert.equal(cuentas[0].nombre_sucursal, "COPA ZONA 2 RAMA");
});

test("y gana igual si la otra compañía llega PRIMERO", () => {
  // Sin ORDER BY el orden de llegada es el que sea. Si el resultado dependiera
  // de él, el nombre cambiaría entre corridas del cron — que es el bug original.
  const a = conCia("900256457", "001", "1", "COPA ZONA 2 RAMA");
  const b = conCia("900256457", "001", "2", "ZONA 2 DISTRIBUCIONES SAS");

  for (const orden of [[a, b], [b, a]]) {
    const { cuentas } = derivarMaestro(orden.map(normalizarTercero), "1");
    assert.equal(cuentas[0].nombre_sucursal, "COPA ZONA 2 RAMA");
  }
});

test("sin IdCia cae al desempate por nombre, y no revienta", () => {
  // Si alguien saca la columna de la consulta, esto degrada — no falla.
  const crudas = [
    conCia("900256457", "001", "", "ZONA 2 DISTRIBUCIONES SAS"),
    conCia("900256457", "001", "", "COPA ZONA 2 RAMA"),
  ];
  const { cuentas } = derivarMaestro(crudas.map(normalizarTercero), null);

  assert.equal(cuentas.length, 1);
  assert.equal(cuentas[0].nombre_sucursal, "COPA ZONA 2 RAMA", "gana el que no es la razón social");
});

test("NO se pierde ningún proveedor: deduplica, no filtra", () => {
  // Filtrar por la cia con precios habría borrado 287 NIT del maestro, y el
  // maestro existe justamente para invitar a proveedores que TODAVÍA no tienen
  // precios cargados.
  const crudas = [
    conCia("900256457", "001", "1", "COPA ZONA 2 RAMA"),
    conCia("111111111", "001", "2", "SOLO EN LA OTRA CIA", "OTRO PROVEEDOR"),
  ];
  const { proveedores, cuentas } = derivarMaestro(crudas.map(normalizarTercero), "1");

  assert.equal(proveedores.length, 2, "el de la cia 2 sigue estando");
  assert.equal(cuentas.length, 2);
  assert.ok(cuentas.some((c) => c.nombre_sucursal === "SOLO EN LA OTRA CIA"));
});

test("las cuentas NO llevan la cia: no es columna de pp_cuentas", () => {
  // `_cia` es andamiaje interno. Si se colara, el upsert lo rechazaría y el
  // maestro dejaría de sincronizar entero.
  const { cuentas } = derivarMaestro([normalizarTercero(conCia("900256457", "001", "1", "X"))], "1");
  assert.deepEqual(Object.keys(cuentas[0]).sort(), ["nit", "nombre_sucursal", "sucursal"]);
});
