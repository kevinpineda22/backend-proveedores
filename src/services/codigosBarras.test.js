import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { normalizarCodigo, esEscaneable, conCodigos } from "./codigosBarras.service.js";

describe("normalizarCodigo", () => {
  test("saca el `+` final que SIESA agrega", () => {
    // 19.651 códigos del catálogo lo tienen y ninguna etiqueta física lo lleva.
    assert.equal(normalizarCodigo("150+"), "150");
    assert.equal(normalizarCodigo("179343+"), "179343");
  });

  test("recorta y normaliza mayúsculas", () => {
    assert.equal(normalizarCodigo("  7702044200486 "), "7702044200486");
    assert.equal(normalizarCodigo("m7702044200486"), "M7702044200486");
  });

  test("no rompe con vacío o nulo", () => {
    assert.equal(normalizarCodigo(null), "");
    assert.equal(normalizarCodigo(undefined), "");
  });
});

describe("esEscaneable — qué se le puede mostrar a un proveedor", () => {
  test("un EAN-13 sí", () => {
    assert.equal(esEscaneable("7702044200486"), true);
  });

  test("un EAN-8 sí", () => {
    assert.equal(esEscaneable("77020442"), true);
  });

  test("el código interno del ítem NO", () => {
    // `150UND` no está impreso en ninguna caja: mostrarlo como "código de
    // barras" manda al proveedor a buscar algo que no existe.
    assert.equal(esEscaneable("150UND"), false);
  });

  test("el que lleva prefijo de sistema NO", () => {
    assert.equal(esEscaneable("M7702044200486"), false);
  });

  test("el número de ítem con `+` NO: queda muy corto para ser un EAN", () => {
    assert.equal(esEscaneable("150+"), false);
    assert.equal(esEscaneable("2926+"), false);
  });
});

describe("conCodigos", () => {
  const mapa = new Map([
    [
      "150|UND",
      { codigos: ["150UND", "150", "7702044200486", "M7702044200486"], principal: "7702044200486" },
    ],
    ["150|P2", { codigos: ["7702044299999"], principal: "7702044299999" }],
  ]);

  test("engancha el código que corresponde a la U.M., no al ítem", () => {
    // El mismo ítem en otra presentación es otra caja con otra etiqueta.
    const r = conCodigos(
      [
        { item: 150, unidadMedida: "UND" },
        { item: 150, unidadMedida: "P2" },
      ],
      mapa,
    );
    assert.equal(r[0].codigoBarras, "7702044200486");
    assert.equal(r[1].codigoBarras, "7702044299999");
  });

  test("deja TODOS los códigos para que el buscador los use", () => {
    // Mostrar solo el EAN, pero encontrar por cualquiera: si alguien tiene
    // anotado el código interno, que le sirva igual.
    const [r] = conCodigos([{ item: 150, unidadMedida: "UND" }], mapa);
    assert.deepEqual(r.codigosBarras, ["150UND", "150", "7702044200486", "M7702044200486"]);
  });

  test("un ítem sin código queda en null, no en cadena vacía", () => {
    // `null` se lee como "no hay dato". Una cadena vacía se renderiza como un
    // hueco y parece un error de la pantalla.
    const [r] = conCodigos([{ item: 999, unidadMedida: "UND" }], mapa);
    assert.equal(r.codigoBarras, null);
    assert.deepEqual(r.codigosBarras, []);
  });

  test("no pierde los campos del renglón", () => {
    const [r] = conCodigos([{ item: 150, unidadMedida: "UND", precio: 4891.27 }], mapa);
    assert.equal(r.precio, 4891.27);
  });

  test("con el mapa vacío devuelve los renglones sin códigos, sin romper", () => {
    // Es lo que pasa si `siesa_codigos_barras` falla: el catálogo tiene que
    // seguir funcionando sin la columna de ayuda.
    const [r] = conCodigos([{ item: 150, unidadMedida: "UND" }], new Map());
    assert.equal(r.codigoBarras, null);
  });
});
