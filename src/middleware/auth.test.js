import test from "node:test";
import assert from "node:assert/strict";
import { tokenDelHeader, detectarSuplantacion, motivoDeBloqueo, esAdminActivo } from "./auth.js";

/* ── tokenDelHeader ──────────────────────────────────────────────────────── */

test("extrae el token de un header bien formado", () => {
  assert.equal(tokenDelHeader("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(tokenDelHeader("bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(tokenDelHeader("  Bearer   abc.def.ghi  "), "abc.def.ghi");
});

test("devuelve null ante cualquier header raro, en vez de adivinar", () => {
  // Adivinar acá es abrir la puerta. Si el header no es exactamente lo esperado,
  // el request se trata como sin autenticar.
  for (const h of ["", "abc.def.ghi", "Basic abc", "Bearer", "Bearer ", null, undefined, 42, {}]) {
    assert.equal(tokenDelHeader(h), null, `debería rechazar ${JSON.stringify(h)}`);
  }
});

test("no acepta un token con espacios adentro", () => {
  assert.equal(tokenDelHeader("Bearer abc def"), null);
});

/* ── detectarSuplantacion: el corazón del aislamiento ────────────────────── */

test("no dispara cuando el request no menciona ninguna cuenta", () => {
  assert.equal(detectarSuplantacion([{ precio: 4900 }, {}, {}], 7), null);
});

test("no dispara cuando el cuenta_id coincide", () => {
  // Hay clientes que reenvían lo que recibieron. Romperlos no aporta seguridad.
  assert.equal(detectarSuplantacion([{ cuenta_id: 7 }], 7), null);
  assert.equal(detectarSuplantacion([{ cuenta_id: "7" }], 7), null); // number vs string
});

test("DISPARA cuando el request pide otra cuenta", () => {
  const r = detectarSuplantacion([{ cuenta_id: 99 }], 7);
  assert.deepEqual(r, { clave: "cuenta_id", valor: 99 });
});

test("mira body, query y params — no solo el body", () => {
  assert.deepEqual(detectarSuplantacion([{}, { cuentaId: 99 }, {}], 7), {
    clave: "cuentaId",
    valor: 99,
  });
  assert.deepEqual(detectarSuplantacion([{}, {}, { cuenta: 99 }], 7), {
    clave: "cuenta",
    valor: 99,
  });
});

test("un valor vacío no es un intento de suplantación", () => {
  assert.equal(detectarSuplantacion([{ cuenta_id: null }], 7), null);
  assert.equal(detectarSuplantacion([{ cuenta_id: "" }], 7), null);
});

test("aguanta fuentes ausentes o que no son objetos", () => {
  assert.equal(detectarSuplantacion([null, undefined, "texto", 42], 7), null);
});

test("no confunde una clave heredada del prototipo con un dato del request", () => {
  // `Object.hasOwn` en vez de `in`: sin eso, un body con __proto__ manipulado
  // podría hacer que el chequeo mire una clave que el cliente nunca mandó.
  const conProto = Object.create({ cuenta_id: 99 });
  assert.equal(detectarSuplantacion([conProto], 7), null);
});

/* ── motivoDeBloqueo ─────────────────────────────────────────────────────── */

test("solo una cuenta activa puede operar", () => {
  assert.equal(motivoDeBloqueo({ estado: "activo" }), null);
});

test("cada estado inactivo explica qué hacer, no solo que no se puede", () => {
  assert.match(motivoDeBloqueo({ estado: "suspendido" }), /compras/i);
  assert.match(motivoDeBloqueo({ estado: "invitado" }), /invitación/i);
  assert.match(motivoDeBloqueo({ estado: "sin_invitar" }), /habilitada/i);
  assert.match(motivoDeBloqueo({ estado: "vaya_a_saber" }), /no está habilitada/i);
});

test("un usuario sin cuenta de proveedor no entra", () => {
  // Caso real: un empleado de Merkahorro que abre por error la URL del portal.
  assert.match(motivoDeBloqueo(null), /no tiene una cuenta de proveedor/i);
  assert.match(motivoDeBloqueo(undefined), /no tiene una cuenta de proveedor/i);
});

test("los mensajes van en usted: el portal habla con terceros", () => {
  for (const estado of ["suspendido", "invitado", "sin_invitar"]) {
    const m = motivoDeBloqueo({ estado });
    assert.equal(/\bvos\b|\btenés\b|\bpodés\b|\busá\b/i.test(m), false, `voseo en "${m}"`);
  }
});

/* ── esAdminActivo — la autoridad del panel de compras ───────────────────── */

test("solo una fila ACTIVA de pp_admins da acceso", () => {
  // Se compara contra `activo`, no contra la existencia de la fila: un admin
  // dado de baja conserva su fila para que la auditoría de qué aprobó siga
  // apuntando a alguien.
  assert.equal(esAdminActivo({ user_id: "u1", activo: true }), true);
  assert.equal(esAdminActivo({ user_id: "u1", activo: false }), false);
});

test("sin fila en pp_admins no hay acceso", () => {
  // El caso normal: alguien de la app con sesión válida que no es de compras.
  assert.equal(esAdminActivo(null), false);
  assert.equal(esAdminActivo(undefined), false);
});

test("ser admin del portal NO depende de profiles.role", () => {
  // Es lo que permite conservar el rol que la persona ya tenía en la app. Si
  // esto mirara `role`, agregar un admin del portal le quitaría su rol anterior.
  assert.equal(esAdminActivo({ activo: true, role: "gh" }), true);
  assert.equal(esAdminActivo({ activo: false, role: "pp_admin" }), false);
});
