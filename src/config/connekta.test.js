import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { esReintentable, esperaAntesDeReintentar } from "./connekta.js";

/** Arma un error de axios con el status y el detalle que devuelve Connekta. */
const errorCon = (status, detalle) => ({
  response: { status, data: { detalle }, headers: {} },
});

describe("esReintentable — qué vale la pena volver a intentar", () => {
  test("un corte de red se reintenta", () => {
    // Sin `response` no hubo respuesta: timeout, socket cortado, DNS.
    assert.equal(esReintentable({ code: "ECONNRESET" }), true);
  });

  test("un 429 se reintenta", () => {
    assert.equal(esReintentable(errorCon(429, "rate limit")), true);
  });

  test("un 500 por deadlock se reintenta", () => {
    // Connekta corre sobre SQL Server y bajo carga deadlockea. El propio motor
    // dice qué hacer: volver a intentar.
    assert.equal(
      esReintentable(errorCon(500, "Transaction was deadlocked on lock resources")),
      true,
    );
  });

  test("un 500 por SINTAXIS de la consulta NO se reintenta", () => {
    // El caso real del 2026-09-01: `merkahorro_terceros_dev_cotiz` se cargó con
    // un `;`. El error salía a los 250 ms y el bucle esperaba 60,5 s tres veces
    // — tres minutos por página, por algo que no puede cambiar entre intentos.
    assert.equal(
      esReintentable(
        errorCon(
          500,
          "Error de SQL Server: Hay un error de sintaxis: probablemente falte una coma, " +
            "palabra clave o hay algo mal escrito., Error orginal: Incorrect syntax near ';'.",
        ),
      ),
      false,
    );
  });

  test("un 500 por columna u objeto inexistente tampoco se reintenta", () => {
    assert.equal(esReintentable(errorCon(500, "Invalid column name 'NitTerceroo'")), false);
    assert.equal(esReintentable(errorCon(500, "Invalid object name 't200_mm_tercero'")), false);
  });

  test("un 401 no se reintenta", () => {
    // Credenciales o permisos de la consulta dinámica. Reintentar no los arregla.
    assert.equal(esReintentable(errorCon(401, "No autorizado")), false);
  });

  test("un 400 no se reintenta", () => {
    assert.equal(esReintentable(errorCon(400, "parámetro inválido")), false);
  });
});

describe("esperaAntesDeReintentar", () => {
  test("le hace caso a Connekta cuando dice cuándo se libera el rate limit", () => {
    const error = {
      response: { status: 429, headers: { "connekta-rate-limit-reset": "01:00" } },
    };
    assert.equal(esperaAntesDeReintentar(error, 1), 60_500);
  });

  test("sin header, backoff exponencial con jitter", () => {
    const espera = esperaAntesDeReintentar(errorCon(500, "deadlock"), 2);
    // base = 800 * 2^1 = 1600, más un jitter de hasta otro tanto.
    assert.ok(espera >= 1600 && espera < 3200, `espera fuera de rango: ${espera}`);
  });
});
