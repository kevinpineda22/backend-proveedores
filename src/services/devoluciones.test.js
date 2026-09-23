import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { ESTADOS_DEVOLUCION, MESES_DEVOLUCIONES, armarDevoluciones } from "./devoluciones.js";
import { normalizarRango } from "./diferenciasCosto.js";

/* Filas con la forma de SQL_DEVOLUCIONES. Los valores salen de CDP reales de la
   réplica (2026-09-23); lo que se prueba es la normalización, no SIESA. */
const fila = (extra = {}) => ({
  documento: "CDP-00080261",
  fecha: "2026-09-23",
  estado: "Contabilizado",
  nit: "43431855",
  sucursal: "001",
  razon_social: "BETANCUR RODRIGUEZ OLGA LUCIA",
  nombre_sucursal: "OLGA LUCIA BETANCUR RODRIGUEZ",
  bodega: "00301",
  nombre_bodega: "2.GIRARDOTA PARQUE",
  item: 179025,
  descripcion: "MINI CROISSANT CONDESA X 400GR",
  motivo: "01",
  desc_motivo: "Devoluciones por averias",
  notas: "DEVOLUCION POR AVERIA",
  unidades: "6.0000",
  valor: "47880.0000",
  ...extra,
});

describe("armarDevoluciones — normaliza sin perder ni duplicar", () => {
  test("dos líneas de la misma devolución comparten documento, proveedor y sede", () => {
    const r = armarDevoluciones([
      fila(),
      fila({ item: 1507, descripcion: "AREPAS LA CONDESA", unidades: "23", valor: "115805" }),
    ]);
    assert.equal(r.documentos.length, 1);
    assert.equal(r.proveedores.length, 1);
    assert.equal(r.sedes.length, 1);
    assert.equal(r.lineas.length, 2);
    assert.deepEqual(r.lineas.map((l) => l.doc), [0, 0]);
    assert.equal(r.lineas[1].valor, 115805);
    assert.equal(r.productos[1507], "AREPAS LA CONDESA");
  });

  test("el motivo queda en la LÍNEA: una devolución con dos motivos no mezcla sus valores", () => {
    const r = armarDevoluciones([
      fila({ motivo: "01", valor: "1000" }),
      fila({ item: 2, motivo: "06", desc_motivo: "Devoluciones productos faltantes", valor: "500" }),
    ]);
    assert.equal(r.documentos.length, 1);
    assert.deepEqual(
      r.lineas.map((l) => [l.motivo, l.valor]),
      [["01", 1000], ["06", 500]],
    );
    assert.deepEqual(r.motivos.map((m) => m.codigo), ["01", "06"]);
  });

  test("el mismo CDP con dos proveedores sale como dos devoluciones", () => {
    const r = armarDevoluciones([fila(), fila({ nit: "900111222", razon_social: "OTRO SAS" })]);
    assert.equal(r.documentos.length, 2);
    assert.equal(r.proveedores.length, 2);
    assert.notEqual(r.lineas[0].doc, r.lineas[1].doc);
  });

  test("los números llegan como número, no como el texto de pg", () => {
    const [l] = armarDevoluciones([fila()]).lineas;
    assert.equal(l.unidades, 6);
    assert.equal(l.valor, 47880);
    assert.equal(typeof l.item, "number");
  });

  test("sin notas ni nombre, no inventa texto vacío", () => {
    const r = armarDevoluciones([fila({ notas: null, razon_social: "  ", motivo: null, desc_motivo: null })]);
    assert.equal(r.documentos[0].notas, null);
    assert.equal(r.proveedores[0].razonSocial, "43431855");
    assert.equal(r.lineas[0].motivo, "—");
    assert.equal(r.motivos[0].descripcion, "Sin motivo");
  });

  test("sin filas, catálogos vacíos (no undefined)", () => {
    const r = armarDevoluciones([]);
    assert.deepEqual(r, { proveedores: [], sedes: [], motivos: [], productos: {}, documentos: [], lineas: [] });
  });
});

describe("la ventana de devoluciones es de 6 meses y no altera la de diferencias", () => {
  const hoy = "2026-09-23";

  test("sin fechas, devuelve los 6 meses completos", () => {
    const r = normalizarRango({}, hoy, MESES_DEVOLUCIONES);
    assert.equal(r.ok, true);
    assert.equal(r.desde, "2026-03-23");
    assert.equal(r.hasta, hoy);
  });

  test("un rango de 5 meses atrás es válido para devoluciones y no para diferencias", () => {
    assert.equal(normalizarRango({ desde: "2026-04-15", hasta: hoy }, hoy, MESES_DEVOLUCIONES).ok, true);
    assert.equal(normalizarRango({ desde: "2026-04-15", hasta: hoy }, hoy).ok, false);
  });

  test("el mensaje de rechazo dice la ventana real", () => {
    const r = normalizarRango({ desde: "2026-01-01", hasta: hoy }, hoy, MESES_DEVOLUCIONES);
    assert.equal(r.ok, false);
    assert.match(r.mensaje, /últimos 6 meses/);
  });

  test("anuladas y en elaboración no son devoluciones hechas", () => {
    assert.deepEqual([...ESTADOS_DEVOLUCION], ["Facturado", "Contabilizado"]);
  });
});
