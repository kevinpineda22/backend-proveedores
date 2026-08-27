import test from "node:test";
import assert from "node:assert/strict";
import { enlaceEsLocal } from "./invitacion.service.js";

test("detecta un portal apuntando a la máquina de desarrollo", () => {
  // El caso que evita: compras invita a un proveedor real, el correo sale bien,
  // el proveedor hace clic y aterriza en su propia máquina. Nadie se entera
  // hasta que llama por teléfono.
  for (const u of [
    "http://localhost:5173/portal-proveedores",
    "http://localhost:3000",
    "https://localhost/portal-proveedores",
    "http://127.0.0.1:5173/portal-proveedores",
    "http://0.0.0.0:8080",
    "http://[::1]:5173/portal-proveedores",
    "  http://localhost:5173/portal-proveedores  ",
  ]) {
    assert.equal(enlaceEsLocal(u), true, `debería marcar ${u} como local`);
  }
});

test("un dominio real no dispara la advertencia", () => {
  for (const u of [
    "https://merkahorro.com/portal-proveedores",
    "https://portal.merkahorro.com",
    "https://backend-proveedores.vercel.app/portal-proveedores",
  ]) {
    assert.equal(enlaceEsLocal(u), false, `no debería marcar ${u}`);
  }
});

test("no confunde un dominio que solo CONTIENE la palabra", () => {
  // `localhost.merkahorro.com` y `mi-localhost.com` son dominios reales. Una
  // advertencia falsa entrena a ignorar las advertencias.
  assert.equal(enlaceEsLocal("https://localhost.merkahorro.com/portal"), false);
  assert.equal(enlaceEsLocal("https://mi-localhost.com"), false);
  assert.equal(enlaceEsLocal("https://merkahorro.com/localhost"), false);
});

test("sin argumento lee PORTAL_PROVEEDORES_URL, que es para lo que existe", () => {
  const antes = process.env.PORTAL_PROVEEDORES_URL;
  try {
    process.env.PORTAL_PROVEEDORES_URL = "https://merkahorro.com/portal-proveedores";
    assert.equal(enlaceEsLocal(), false);

    process.env.PORTAL_PROVEEDORES_URL = "http://localhost:5173/portal-proveedores";
    assert.equal(enlaceEsLocal(), true);

    // Sin la variable, el default del módulo TAMBIÉN es localhost — y eso es
    // exactamente lo que hay que detectar: olvidarse de configurarla es el caso
    // peligroso, no un caso neutro.
    delete process.env.PORTAL_PROVEEDORES_URL;
    assert.equal(enlaceEsLocal(), true);
  } finally {
    if (antes === undefined) delete process.env.PORTAL_PROVEEDORES_URL;
    else process.env.PORTAL_PROVEEDORES_URL = antes;
  }
});

test("una URL vacía o nula no es local", () => {
  assert.equal(enlaceEsLocal(""), false);
  assert.equal(enlaceEsLocal(null), false);
});
