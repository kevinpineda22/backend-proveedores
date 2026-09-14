import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  CAUSACIONES,
  ajusteNeto,
  calcularFila,
  diaSiguiente,
  normalizarRango,
  restarMeses,
  tipoDeAjuste,
  aFila,
} from "./diferenciasCosto.js";

/* Todos los casos son REALES: salen de merkahorro_siesa.compras y del Excel de
   noviembre que esta pantalla reemplaza. El número del Excel se deja anotado al
   lado para que se vea qué se está corrigiendo. */

describe("el ajuste se REPARTE entre las entradas de la misma factura", () => {
  // CFP-00260995 · ítem 185904 · CAS-00004122 por $94.276, repartida en dos CEA.
  const factura = { unidadesPagadasFactura: 162, totalCas: 94276, totalCae: 0 };

  test("la entrada chica recibe su parte, no el ajuste entero (el Excel daba −$43.175)", () => {
    const r = calcularFila({ ...factura, bruto: 8248, descuentos: 322, unidades: 2, unidadesPagadas: 2 });
    assert.equal(r.costoEntrada, 3963);
    assert.equal(r.costoReal, 3381.05);
    assert.equal(r.ajusteAsignado, -1163.9);
    assert.equal(r.repartidaEnVariasEntradas, true);
    assert.ok(r.costoReal > 0, "un costo unitario negativo no existe");
  });

  test("la entrada grande da el mismo costo unitario que la chica", () => {
    const r = calcularFila({ ...factura, bruto: 659840, descuentos: 25734, unidades: 160, unidadesPagadas: 160 });
    assert.equal(r.costoReal, 3381.21);
  });

  test("dos entradas iguales dan lo mismo, y no el ajuste duplicado (el Excel daba $9.546,83)", () => {
    // CFP-00261764 · ítem 1777 · 12 + 12 unidades, CAS $9.962.
    const r = calcularFila({
      bruto: 124524, descuentos: 0, unidades: 12, unidadesPagadas: 12,
      unidadesPagadasFactura: 24, totalCas: 9962, totalCae: 0,
    });
    assert.equal(r.costoReal, 9961.92);
    assert.equal(r.ajusteAsignado, -4981);
  });

  test("lo repartido suma exactamente el ajuste de la factura", () => {
    const base = { unidadesPagadasFactura: 262, totalCas: 49894, totalCae: 0, descuentos: 0 };
    const a = calcularFila({ ...base, bruto: 28400, unidades: 10, unidadesPagadas: 10 });
    const b = calcularFila({ ...base, bruto: 710000, unidades: 252, unidadesPagadas: 252 });
    assert.ok(Math.abs(a.ajusteAsignado + b.ajusteAsignado + 49894) < 0.02);
  });
});

describe("las unidades bonificadas NO diluyen el costo", () => {
  // CFP-00261034 · ítem 7793: 96 pagadas en una CEA, 8 regaladas en otra. CAE $9.355.
  const factura = { unidadesPagadasFactura: 96, totalCas: 0, totalCae: 9355 };

  test("la entrada bonificada no tiene costo ni recibe ajuste (el Excel le ponía $1.169)", () => {
    const r = calcularFila({ ...factura, bruto: 0, descuentos: 0, unidades: 8, unidadesPagadas: 0 });
    assert.equal(r.bonificada, true);
    assert.equal(r.costoReal, null);
    assert.equal(r.costoEntrada, null);
    assert.equal(r.ajusteAsignado, 0);
    assert.equal(r.unidadesBonificadas, 8);
  });

  test("la entrada pagada se lleva el ajuste entero, dividido solo por lo pagado", () => {
    const r = calcularFila({ ...factura, bruto: 222270, descuentos: 0, unidades: 96, unidadesPagadas: 96 });
    assert.equal(r.costoReal, 2412.76);
    assert.equal(r.repartidaEnVariasEntradas, false);
  });

  test("bonificadas DENTRO de la misma entrada tampoco diluyen", () => {
    const r = calcularFila({
      bruto: 1000, descuentos: 0, unidades: 12, unidadesPagadas: 10,
      unidadesPagadasFactura: 10, totalCas: 100, totalCae: 0,
    });
    assert.equal(r.costoReal, 90); // (1000 − 100) / 10, no / 12
    assert.equal(r.unidadesBonificadas, 2);
  });
});

describe("un ajuste que no cuadra con la entrada se marca, no se esconde", () => {
  test("CAS mayor que el valor de la entrada → revisar (caso real CFP-00307879 · 2017)", () => {
    const r = calcularFila({
      bruto: 143000, descuentos: 0, unidades: 80, unidadesPagadas: 80,
      unidadesPagadasFactura: 80, totalCas: 809461, totalCae: 0,
    });
    assert.equal(r.revisar, true);
    assert.ok(r.costoReal < 0, "el número se conserva: el dato es de SIESA");
  });

  test("un ajuste normal no se marca", () => {
    const r = calcularFila({
      bruto: 8248, descuentos: 322, unidades: 2, unidadesPagadas: 2,
      unidadesPagadasFactura: 162, totalCas: 94276, totalCae: 0,
    });
    assert.equal(r.revisar, false);
  });

  test("una entrada bonificada no se marca: no tiene costo, no un costo malo", () => {
    const r = calcularFila({ bruto: 0, unidades: 8, unidadesPagadas: 0, unidadesPagadasFactura: 96, totalCae: 9355 });
    assert.equal(r.revisar, false);
  });
});

describe("el signo del ajuste lo da el TIPO, no el número", () => {
  test("un CAS resta aunque SIESA lo guarde en positivo", () => {
    assert.equal(ajusteNeto({ totalCas: 94276, totalCae: 0 }), -94276);
  });

  test("un CAE suma", () => {
    assert.equal(ajusteNeto({ totalCas: 0, totalCae: 1508 }), 1508);
  });

  test("con los dos, se netean", () => {
    assert.equal(ajusteNeto({ totalCas: "300", totalCae: "1000" }), 700);
    assert.equal(tipoDeAjuste({ totalCas: 300, totalCae: 1000 }), "mixto");
  });

  test("tipo: CAE es mayor costo, CAS es menor costo", () => {
    assert.equal(tipoDeAjuste({ totalCas: 0, totalCae: 5 }), "mayor");
    assert.equal(tipoDeAjuste({ totalCas: 5, totalCae: null }), "menor");
  });
});

describe("impuestos y descuentos", () => {
  test("el costo es ANTES de impuestos: el ICO se informa aparte, por unidad física", () => {
    const r = calcularFila({
      bruto: 42866, descuentos: 0, unidades: 12, unidadesPagadas: 10,
      unidadesPagadasFactura: 10, totalCas: 0, totalCae: 0.01, ico: 18645, ibua: 0,
    });
    assert.equal(r.costoEntrada, 4286.6, "el ICO no entra en el costo");
    assert.equal(r.icoUnitario, 1553.75, "18.645 / 12 unidades que entraron");
    assert.equal(r.ibuaUnitario, 0);
  });

  test("precio de lista y % de descuento", () => {
    const r = calcularFila({
      bruto: 611200, descuentos: 91680, unidades: 80, unidadesPagadas: 80,
      unidadesPagadasFactura: 80, totalCas: 800, totalCae: 0,
    });
    assert.equal(r.precioLista, 7640);
    assert.equal(r.porcentajeDescuento, 15);
    assert.equal(r.costoEntrada, 6494);
  });

  test("los numéricos de Postgres llegan como texto y se calculan igual", () => {
    const r = calcularFila({
      bruto: "8248.0000", descuentos: "322.0000", unidades: "2.0000", unidadesPagadas: "2.0000",
      unidadesPagadasFactura: "162.0000", totalCas: "94276.0000", totalCae: null,
    });
    assert.equal(r.costoReal, 3381.05);
  });
});

describe("solo facturas CFP y CFM", () => {
  test("CNJ, CDN, CND y CDM quedan afuera", () => {
    assert.deepEqual([...CAUSACIONES], ["CFP", "CFM"]);
    for (const otra of ["CNJ", "CDN", "CND", "CDM"]) assert.ok(!CAUSACIONES.includes(otra), otra);
  });
});

describe("la ventana de 3 meses", () => {
  const HOY = "2026-09-14";

  test("sin fechas, devuelve la ventana entera", () => {
    assert.deepEqual(normalizarRango({}, HOY), {
      ok: true, desde: "2026-06-14", hasta: "2026-09-14", minimo: "2026-06-14", maximo: "2026-09-14",
    });
  });

  test("un rango adentro de la ventana pasa tal cual", () => {
    const r = normalizarRango({ desde: "2026-08-01", hasta: "2026-08-31" }, HOY);
    assert.equal(r.ok, true);
    assert.equal(r.desde, "2026-08-01");
    assert.equal(r.hasta, "2026-08-31");
  });

  test("fuera de la ventana se RECHAZA diciendo el límite, no se recorta en silencio", () => {
    const r = normalizarRango({ desde: "2026-05-01" }, HOY);
    assert.equal(r.ok, false);
    assert.match(r.mensaje, /2026-06-14/);
  });

  test("una fecha futura se rechaza", () => {
    assert.equal(normalizarRango({ hasta: "2026-09-15" }, HOY).ok, false);
  });

  test("desde posterior a hasta se rechaza", () => {
    assert.equal(normalizarRango({ desde: "2026-09-01", hasta: "2026-08-01" }, HOY).ok, false);
  });

  test("formato inválido se rechaza", () => {
    assert.equal(normalizarRango({ desde: "01/08/2026" }, HOY).ok, false);
  });

  test("restar meses respeta el fin de mes y el cambio de año", () => {
    assert.equal(restarMeses("2026-05-31", 3), "2026-02-28");
    assert.equal(restarMeses("2028-05-31", 3), "2028-02-29");
    assert.equal(restarMeses("2026-02-10", 3), "2025-11-10");
  });

  test("día siguiente cruza meses y años", () => {
    assert.equal(diaSiguiente("2026-08-31"), "2026-09-01");
    assert.equal(diaSiguiente("2026-12-31"), "2027-01-01");
  });
});

test("aFila arma la llave y no pierde la fecha como texto", () => {
  const f = aFila({
    documento: "CEA-00293184", docto_causacion: "CFP-00260995", item: 185904, fecha: "2025-11-20",
    descripcion: "X", nit: "800007955", sucursal: "001", razon_social: "R", nombre_sucursal: "S",
    bodega: "00201", nombre_bodega: "B", docto_orden: "COC-1", presentacion: "UND", unidad: "UND",
    unidades: "2", unidades_pagadas: "2", bruto: "8248", descuentos: "322", ico: "0", ibua: "0",
    iva_pct: "19", unidades_pagadas_factura: "162", total_cas: "94276", total_cae: null,
    documentos_ajuste: ["CAS-00004122"], fecha_ajuste: "2025-11-24",
    carga_ajuste: "2025-11-24 19:26:59",
  });
  assert.equal(f.cargaAjuste, "2025-11-24 19:26:59", "la carga viaja: decide si el aviso de Inicio es nuevo");
  assert.equal(f.clave, "CFP-00260995|185904|CEA-00293184");
  assert.equal(f.fecha, "2025-11-20");
  assert.equal(f.costoReal, 3381.05);
  assert.equal(f.ivaPct, 19);
  assert.equal(f.tipoAjuste, "menor");
});
