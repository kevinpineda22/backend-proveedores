import test from "node:test";
import assert from "node:assert/strict";
import {
  hostDe,
  entornosComparables,
  verificarEnSiesa,
  NO_CONFIRMA,
} from "./verificarCotizacion.js";

/* ── hostDe ───────────────────────────────────────────────────────────────── */

test("hostDe compara hosts, no URLs: distinta ruta es el mismo SIESA", () => {
  assert.equal(
    hostDe("https://servicios.siesacloud.com/api/connekta/v3"),
    hostDe("https://servicios.siesacloud.com/api/siesa/v3.1/conectoresimportar"),
  );
});

test("hostDe no explota con basura; devuelve cadena vacía", () => {
  assert.equal(hostDe("no soy una url"), "");
  assert.equal(hostDe(undefined), "");
  assert.equal(hostDe(null), "");
});

/* ── entornosComparables ──────────────────────────────────────────────────── */

test("leer de producción y escribir en QA NO es comparable", () => {
  // Es la configuración real de hoy, y la razón por la que la solicitud #5 no
  // se pudo confirmar durante días.
  assert.equal(
    entornosComparables(
      "https://servicios.siesacloud.com/api/connekta/v3",
      "https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar",
    ),
    false,
  );
});

test("mismo host es comparable aunque cambie la ruta", () => {
  assert.equal(
    entornosComparables(
      "https://servicios.siesacloud.com/api/connekta/v3",
      "https://servicios.siesacloud.com/api/siesa/v3.1/conectoresimportar",
    ),
    true,
  );
});

test("una URL ilegible no se hace pasar por comparable", () => {
  // Ante la duda, NO verificable. Un `true` acá inventaría confirmaciones.
  assert.equal(entornosComparables("", "https://servicios.siesacloud.com"), false);
  assert.equal(entornosComparables("basura", "tambien basura"), false);
});

/* ── verificarEnSiesa ─────────────────────────────────────────────────────── */

/**
 * Con los entornos cruzados —la configuración de hoy— la verificación tiene que
 * decir "no pude", nunca "confirmado". Este test es la red que impide que
 * alguien "arregle" el caso cruzado devolviendo un OK optimista.
 */
test("entornos cruzados devuelven no_verificable, jamás confirmado", async () => {
  const previo = {
    lectura: process.env.CONNEKTA_BASE_URL,
    escritura: process.env.SIESA_COTIZACION_URL,
  };
  process.env.CONNEKTA_BASE_URL = "https://servicios.siesacloud.com/api/connekta/v3";
  process.env.SIESA_COTIZACION_URL =
    "https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar";

  try {
    const r = await verificarEnSiesa({
      idTercero: "1234",
      sucursal: "006",
      item: "179313",
      unidadMedida: "UND",
      fechaActivacion: "2026-09-20",
      precioEsperado: 13920,
      impuestosEsperados: [{ llave: "ICO", valor: 4974 }],
    });

    assert.equal(r.estado, "no_verificable");
    assert.match(r.motivo, /serviciosqa\.siesacloud\.com/);
    assert.match(r.motivo, /servicios\.siesacloud\.com/);
    assert.equal(r.encontrado, null);
    // El esperado viaja igual: sirve para que la bandeja muestre qué se mandó.
    assert.equal(r.esperado.precio, 13920);
  } finally {
    process.env.CONNEKTA_BASE_URL = previo.lectura;
    process.env.SIESA_COTIZACION_URL = previo.escritura;
  }
});

test("no_verificable NO manda la solicitud a revisión humana", () => {
  // "No pude comprobarlo" no es "salió mal". Si `no_verificable` entrara acá,
  // con los entornos cruzados TODA aprobación quedaría incierta y el estado
  // perdería el sentido.
  assert.equal(NO_CONFIRMA.has("no_verificable"), false);
  assert.equal(NO_CONFIRMA.has("confirmado"), false);
});

test("los desenlaces que contradicen el éxito sí van a revisión", () => {
  assert.equal(NO_CONFIRMA.has("no_encontrado"), true);
  assert.equal(NO_CONFIRMA.has("discrepante"), true);
});
