import test from "node:test";
import assert from "node:assert/strict";
import { limitePorIp, _reiniciar } from "./rateLimit.js";

/** Simula el trío (req, res, next) de Express y devuelve el error, si hubo. */
function pedir(middleware, ip) {
  let error = null;
  const cabeceras = {};
  middleware(
    { ip },
    { setHeader: (k, v) => (cabeceras[k] = v) },
    (e) => {
      error = e ?? null;
    },
  );
  return { error, cabeceras };
}

test.beforeEach(() => _reiniciar());

test("deja pasar hasta el máximo y corta con 429 en el siguiente", () => {
  const limite = limitePorIp({ maximo: 3, ventanaMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    assert.equal(pedir(limite, "1.1.1.1").error, null, `el pedido ${i + 1} tenía que pasar`);
  }
  const cuarto = pedir(limite, "1.1.1.1");
  assert.equal(cuarto.error?.status ?? cuarto.error?.statusCode, 429);
});

test("el 429 dice CUÁNDO reintentar, no solo que no", () => {
  const limite = limitePorIp({ maximo: 1, ventanaMs: 60_000 });
  pedir(limite, "2.2.2.2");
  const { cabeceras } = pedir(limite, "2.2.2.2");
  assert.ok(Number(cabeceras["Retry-After"]) > 0);
});

test("cada IP tiene su propio contador", () => {
  const limite = limitePorIp({ maximo: 1, ventanaMs: 60_000 });
  pedir(limite, "3.3.3.3");
  assert.equal(pedir(limite, "4.4.4.4").error, null, "otra IP no hereda el bloqueo");
});

test("llenar el Map NO le devuelve el turno a quien está bloqueado", () => {
  /*
   * EL BUG QUE ESTO CUBRE. Cuando el Map llegaba al techo se hacía `.clear()`,
   * y eso convertía la protección de memoria en un botón de reinicio: rotar
   * 10.000 IPs borraba el contador de todos —el del atacante incluido— y el
   * límite volvía a cero. El techo pensado para cuidar la RAM era la forma más
   * barata de saltarse el límite.
   *
   * Ahora el desalojo tira primero las VENCIDAS y, si no alcanza, la mitad más
   * vieja. Quien está golpeando ahora tiene la entrada más nueva: se conserva.
   */
  const limite = limitePorIp({ maximo: 1, ventanaMs: 60_000 });

  // El atacante agota su cuota.
  pedir(limite, "9.9.9.9");
  assert.ok(pedir(limite, "9.9.9.9").error, "queda bloqueado");

  // Y ahora intenta limpiar el Map rotando IPs.
  for (let i = 0; i < 12_000; i++) pedir(limite, `10.0.${(i / 256) | 0}.${i % 256}`);

  assert.ok(
    pedir(limite, "9.9.9.9").error,
    "después de la rotación TIENE que seguir bloqueado",
  );
});

test("una ventana vencida arranca de cero", () => {
  const limite = limitePorIp({ maximo: 1, ventanaMs: 1 });
  pedir(limite, "5.5.5.5");
  const finDeEspera = Date.now() + 5;
  while (Date.now() < finDeEspera) {
    /* espera activa: son milisegundos y evita un timer en el test */
  }
  assert.equal(pedir(limite, "5.5.5.5").error, null);
});
