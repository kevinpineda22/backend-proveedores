import test from "node:test";
import assert from "node:assert/strict";
import { notificarResolucion, ESTADOS_NOTIFICABLES } from "./notificacion.service.js";

const SOLICITUD = {
  id: 9,
  item: "179313",
  descripcion_item: "VINO SAZON BLANCO",
  unidad_medida: "UND",
  precio_propuesto: 13920,
  fecha_activacion: "2026-09-20",
  motivo_rechazo: "El aumento no está acordado.",
};

/* Los tests corren con PROVEEDORES_MAIL_PRUEBA=true para no mandar correos: en
   ese modo `enviar()` escribe en el log y devuelve `{enviado:false}`. Lo que se
   prueba acá es la DECISIÓN de notificar, no el transporte. */
test.before(() => {
  process.env.PROVEEDORES_MAIL_PRUEBA = "true";
});

/* ── Qué se avisa y qué no ────────────────────────────────────────────────── */

test("un estado INCIERTO no se avisa: no se afirma lo que no se comprobó", async () => {
  // `incierto` = SIESA aceptó el envío y la relectura no lo confirmó. Decirle al
  // proveedor "su precio quedó aplicado" sería la misma afirmación sin verificar
  // que este proyecto viene sacando. Espera a que un humano lo resuelva.
  const r = await notificarResolucion({
    solicitud: SOLICITUD,
    correo: "proveedor@ejemplo.com",
    estado: "incierto",
  });
  assert.equal(r.enviado, false);
  assert.match(r.motivo, /no se notifica/);
  assert.equal(ESTADOS_NOTIFICABLES.has("incierto"), false);
});

test("tampoco se avisa una fallida ni una que sigue pendiente", async () => {
  for (const estado of ["fallida", "pendiente", "aprobada"]) {
    const r = await notificarResolucion({
      solicitud: SOLICITUD,
      correo: "proveedor@ejemplo.com",
      estado,
    });
    assert.equal(r.enviado, false, `"${estado}" no debería notificarse`);
  }
});

test("los dos desenlaces que SÍ se avisan son aplicada y rechazada", () => {
  assert.deepEqual([...ESTADOS_NOTIFICABLES].sort(), ["aplicada", "rechazada"]);
});

/* ── Nunca rompe ──────────────────────────────────────────────────────────── */

test("una cuenta sin correo no es un error, es que no hay a dónde escribir", async () => {
  const r = await notificarResolucion({
    solicitud: SOLICITUD,
    correo: null,
    estado: "aplicada",
  });
  assert.equal(r.enviado, false);
  assert.match(r.motivo, /no tiene correo/);
});

test("NO LANZA aunque le entre basura: el aviso corre después de resolver", async () => {
  // Regla 1 del módulo: cuando esto se ejecuta, la solicitud ya se aprobó y el
  // precio pudo haberse escrito en SIESA. Una excepción acá convertiría "el
  // correo no salió" en "la operación falló", y el admin reintentaría algo hecho.
  await assert.doesNotReject(() =>
    notificarResolucion({ solicitud: null, correo: "x@y.com", estado: "aplicada" }),
  );
  await assert.doesNotReject(() => notificarResolucion({}));

  const r = await notificarResolucion({ solicitud: null, correo: "x@y.com", estado: "aplicada" });
  assert.equal(r.enviado, false);
});
