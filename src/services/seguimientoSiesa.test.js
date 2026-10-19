import test from "node:test";
import assert from "node:assert/strict";
import {
  destinoDe,
  estadoDelLote,
  origenDelFallo,
  ESTADO_POR_ORIGEN,
  itemsDelLote,
  camposDistintos,
  compararCotizaciones,
  atribuir,
  cambiosCreibles,
  corridaAnteriorDe,
} from "./seguimientoSiesa.js";

/* ── Ambiente ─────────────────────────────────────────────────────────────── */

test("destinoDe distingue QA de producción por el host", () => {
  assert.equal(destinoDe("https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar"), "qa");
  assert.equal(destinoDe("https://servicios.siesacloud.com/api/connekta/v3"), "produccion");
  assert.equal(destinoDe("no es una url"), "desconocido");
  assert.equal(destinoDe("https://otro.example.com"), "desconocido");
});

/* ── Estado del lote ─────────────────────────────────────────────────────── */

test("el lote toma el PEOR estado de sus líneas", () => {
  assert.equal(estadoDelLote([{ estado: "confirmado" }, { estado: "confirmado" }]), "aplicado");
  assert.equal(estadoDelLote([{ estado: "confirmado" }, { estado: "no_verificable" }]), "no_verificable");
  assert.equal(estadoDelLote([{ estado: "confirmado" }, { estado: "discrepante" }]), "incierto");
  assert.equal(estadoDelLote([{ estado: "no_encontrado" }]), "incierto");
});

test("sin relectura no se afirma 'aplicado'", () => {
  assert.equal(estadoDelLote([]), "no_verificable");
  assert.equal(estadoDelLote([{ estado: null }]), "no_verificable");
});

test("el origen del fallo separa 'no salió' de 'rechazó' de 'no sé'", () => {
  assert.equal(ESTADO_POR_ORIGEN[origenDelFallo({ enviadoASiesa: false })], "no_enviado");
  assert.equal(ESTADO_POR_ORIGEN[origenDelFallo({ enviadoASiesa: true })], "rechazado");
  // El peligroso: un corte de red. Reintentar puede duplicar.
  assert.equal(ESTADO_POR_ORIGEN[origenDelFallo(new Error("timeout"))], "sin_respuesta");
});

test("itemsDelLote arma la clave COMPLETA, con la sucursal destino y la fecha", () => {
  const [it] = itemsDelLote(
    [
      {
        id: 7,
        solicitud_id: 3,
        clave_item: "COP|900|001|123|UND",
        item: 123,
        unidad_medida: "UND",
        fecha_activacion: "2026-10-20",
        precio_actual: "1000.0000",
        precio_propuesto: "1100.0000",
        origen: "replica",
      },
    ],
    { idTercero: "900", sucursal: "002" },
  );
  // Una réplica va a OTRA sucursal: la clave es la del destino, no la de origen.
  assert.equal(it.clave, "COP|900|002|123|UND|2026-10-20");
  assert.equal(it.precio_propuesto, 1100);
});

/* ── Comparación ─────────────────────────────────────────────────────────── */

const fila = (over = {}) => ({
  clave: "COP|900|001|123|UND|2026-10-01",
  clave_item: "COP|900|001|123|UND",
  id_tercero: "900",
  nit: "900",
  sucursal: "001",
  item: 123,
  descripcion_item: "ATUN",
  unidad_medida: "UND",
  fecha_activacion: "2026-10-01",
  precio: 1000,
  impuestos: [],
  descuentos: [],
  ...over,
});

test("el orden de impuestos y descuentos no es un cambio", () => {
  const a = {
    precio: 1000,
    impuestos: [{ llave: "IBUA", valor: 5 }, { llave: "ICO", valor: 8 }],
    descuentos: [{ orden: 2, porcentaje: 1 }, { orden: 1, porcentaje: 3 }],
  };
  const b = {
    precio: "1000.0000",
    impuestos: [{ llave: "ICO", valor: "8" }, { llave: "IBUA", valor: 5 }],
    descuentos: [{ orden: 1, porcentaje: 3 }, { orden: 2, porcentaje: 1 }],
  };
  assert.deepEqual(camposDistintos(a, b), []);
});

test("detecta qué campo cambió", () => {
  assert.deepEqual(camposDistintos({ precio: 1000 }, { precio: 1001 }), ["precio"]);
  assert.deepEqual(
    camposDistintos({ precio: 1, impuestos: [] }, { precio: 1, impuestos: [{ llave: "ICO", valor: 8 }] }),
    ["impuestos"],
  );
});

test("altas, modificadas y bajas", () => {
  const existentes = [fila(), fila({ clave: "B", precio: 50 })];
  const nuevas = [fila({ precio: 1200 }), fila({ clave: "C", precio: 70 })];
  const cambios = compararCotizaciones(existentes, nuevas, { incluirBajas: true });
  const porTipo = Object.fromEntries(cambios.map((c) => [c.tipo, c]));

  assert.equal(cambios.length, 3);
  assert.deepEqual(porTipo.modificada.campos, ["precio"]);
  assert.equal(porTipo.modificada.antes.precio, 1000);
  assert.equal(porTipo.modificada.despues.precio, 1200);
  assert.equal(porTipo.alta.clave, "C");
  assert.equal(porTipo.baja.clave, "B");
});

test("sin barrido NO hay bajas: una corrida que trajo de menos no prueba un borrado", () => {
  const cambios = compararCotizaciones([fila(), fila({ clave: "B" })], [fila()], { incluirBajas: false });
  assert.equal(cambios.length, 0);
});

/* ── Atribución ──────────────────────────────────────────────────────────── */

const envio = (over = {}) => ({
  id: 10,
  estado: "aplicado",
  destino: "produccion",
  enviado_at: "2026-10-18T15:00:00Z",
  items: [{ clave: "COP|900|001|123|UND|2026-10-01", precio_propuesto: 1200 }],
  ...over,
});

test("un cambio con el mismo precio que un envío aceptado del mismo ambiente es del portal", () => {
  const [c] = compararCotizaciones([fila()], [fila({ precio: 1200 })], { incluirBajas: true });
  const [a] = atribuir([c], [envio()], "produccion");
  assert.equal(a.origen, "portal");
  assert.equal(a.envio_id, 10);
});

test("un envío a QA no explica un cambio en producción", () => {
  const [c] = compararCotizaciones([fila()], [fila({ precio: 1200 })], { incluirBajas: true });
  const [a] = atribuir([c], [envio({ destino: "qa" })], "produccion");
  assert.equal(a.origen, "externo");
});

test("un envío rechazado no se atribuye nada, y un precio distinto tampoco", () => {
  const [c] = compararCotizaciones([fila()], [fila({ precio: 1200 })], { incluirBajas: true });
  assert.equal(atribuir([c], [envio({ estado: "rechazado" })], "produccion")[0].origen, "externo");
  assert.equal(
    atribuir([c], [envio({ items: [{ clave: c.clave, precio_propuesto: 1199 }] })], "produccion")[0].origen,
    "externo",
  );
});

test("con varios envíos coincidentes gana el más reciente", () => {
  const [c] = compararCotizaciones([fila()], [fila({ precio: 1200 })], { incluirBajas: true });
  const [a] = atribuir(
    [c],
    [envio({ id: 1, enviado_at: "2026-10-01T00:00:00Z" }), envio({ id: 2, enviado_at: "2026-10-18T00:00:00Z" })],
    "produccion",
  );
  assert.equal(a.envio_id, 2);
});

test("las bajas son siempre externas", () => {
  const [c] = compararCotizaciones([fila()], [], { incluirBajas: true });
  assert.equal(atribuir([c], [envio()], "produccion")[0].origen, "externo");
});

/* ── Válvulas ────────────────────────────────────────────────────────────── */

test("una tormenta de cambios no es creíble", () => {
  assert.equal(cambiosCreibles(100, 18000).creible, true);
  assert.equal(cambiosCreibles(6000, 18000).creible, false);
  // Con catálogos chicos el piso de 500 evita frenar cambios normales.
  assert.equal(cambiosCreibles(400, 100).creible, true);
});

test("la corrida anterior es la marca más nueva", () => {
  assert.equal(
    corridaAnteriorDe([{ sincronizado_at: "2026-10-17T10:00:00+00:00" }, { sincronizado_at: "2026-10-18T10:00:00+00:00" }]),
    "2026-10-18T10:00:00+00:00",
  );
  assert.equal(corridaAnteriorDe([]), null);
});
