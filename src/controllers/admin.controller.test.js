import test from "node:test";
import assert from "node:assert/strict";
import { dejariaSinAdmins } from "./admin.controller.js";

/* ── La guarda del último administrador ───────────────────────────────────────

   Es la única acción irreversible desde la pantalla. Si el portal se queda sin
   administradores activos, nadie puede aprobar precios NI volver a agregar un
   administrador: la propia pantalla de administradores queda detrás de
   `requiereAdmin`. Se sale de eso con SQL a mano contra producción.

   Por eso se prueba: un `<` en vez de un `<=` acá no rompe ningún test de
   integración, no tira ningún error, y se descubre el día que pasa.
   ────────────────────────────────────────────────────────────────────────── */

test("desactivar al ÚNICO admin activo queda bloqueado", () => {
  assert.equal(dejariaSinAdmins(false, 1), true);
});

test("desactivar cuando hay más de uno se permite", () => {
  // Con dos admins, que uno se dé de baja está perfecto: queda el otro.
  assert.equal(dejariaSinAdmins(false, 2), false);
  assert.equal(dejariaSinAdmins(false, 37), false);
});

test("ACTIVAR nunca se bloquea, ni siquiera con cero admins", () => {
  // El caso de recuperación: si alguien llegó a cero por SQL, la pantalla tiene
  // que poder volver a sumar gente. Bloquear el alta ahí sería tapiar la salida.
  assert.equal(dejariaSinAdmins(true, 0), false);
  assert.equal(dejariaSinAdmins(true, 1), false);
});

test("con cero activos, desactivar tampoco pasa", () => {
  // No debería poder llegar acá —hace falta ser admin para pedirlo— pero la
  // guarda no depende de eso: el estado inconsistente no la vuelve permisiva.
  assert.equal(dejariaSinAdmins(false, 0), true);
});

test("mira el conteo, no quién lo pide", () => {
  // La guarda NO pregunta "¿es usted mismo?". Un admin puede darse de baja si
  // queda alguien más; y no puede, aunque sea otro, si es el último que queda.
  // Atar la regla a la identidad daría el resultado equivocado en los dos casos.
  assert.equal(dejariaSinAdmins(false, 1), true);
  assert.equal(dejariaSinAdmins(false, 2), false);
});

test("un conteo que llega como texto no vuelve permisiva la guarda", () => {
  // `count` viene de la base. Si algún día llega como string, `"1" <= 1` sería
  // true por coerción, pero `"2"` también compararía raro sin el Number().
  assert.equal(dejariaSinAdmins(false, "1"), true);
  assert.equal(dejariaSinAdmins(false, "2"), false);
});

test("solo el false explícito cuenta como desactivar", () => {
  // El validador exige un booleano, así que acá no debería llegar otra cosa.
  // Pero si llegara, un `undefined` no puede leerse como "desactivar".
  assert.equal(dejariaSinAdmins(undefined, 1), false);
  assert.equal(dejariaSinAdmins(null, 1), false);
});
