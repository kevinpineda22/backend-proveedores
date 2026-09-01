import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { enlaceEsLocal, solicitarRecuperacion } from "./invitacion.service.js";

const CUENTA_ACTIVA = {
  id: 17,
  nit: "800186960",
  sucursal: "006",
  nombre_sucursal: "ALTIPAL CATALOGO GENERAL",
  estado: "activo",
  correo_notificacion: "proveedor@example.com",
  user_id: "auth-17",
};

function clienteRecuperacion({
  cuenta = CUENTA_ACTIVA,
  errorCuenta = null,
  errorInvalidacion = null,
  errorInsercion = null,
  errorAuditoria = null,
  // Freno por cuenta: qué devuelve la consulta de "¿ya se emitió uno recién?".
  // Por defecto, nada — o sea, sin envío reciente.
  emisionReciente = [],
  errorReciente = null,
} = {}) {
  const llamadas = {
    consultas: [],
    frenos: [],
    invalidaciones: [],
    invitaciones: [],
    auditorias: [],
  };

  const cliente = {
    from(tabla) {
      if (tabla === "pp_cuentas") {
        const filtros = [];
        const consulta = {
          select() {
            return consulta;
          },
          eq(campo, valor) {
            filtros.push([campo, valor]);
            return consulta;
          },
          async maybeSingle() {
            llamadas.consultas.push(filtros);
            return { data: cuenta, error: errorCuenta };
          },
        };
        return consulta;
      }

      if (tabla === "pp_invitaciones") {
        return {
          // El freno por cuenta: select().eq().gt().limit(). Devuelve filas si
          // hubo una emisión dentro del cooldown.
          select() {
            const filtros = [];
            const consulta = {
              eq(campo, valor) {
                filtros.push([campo, valor]);
                return consulta;
              },
              gt(campo, valor) {
                filtros.push([campo, valor]);
                return consulta;
              },
              async limit() {
                llamadas.frenos.push(filtros);
                return { data: emisionReciente, error: errorReciente };
              },
            };
            return consulta;
          },
          update(cambios) {
            const filtros = [];
            return {
              eq(campo, valor) {
                filtros.push([campo, valor]);
                return this;
              },
              async is(campo, valor) {
                filtros.push([campo, valor]);
                llamadas.invalidaciones.push({ cambios, filtros });
                return { error: errorInvalidacion };
              },
            };
          },
          async insert(fila) {
            llamadas.invitaciones.push(fila);
            return { error: errorInsercion };
          },
        };
      }

      if (tabla === "pp_auditoria") {
        return {
          async insert(fila) {
            llamadas.auditorias.push(fila);
            return { error: errorAuditoria };
          },
        };
      }

      throw new Error(`Tabla inesperada en prueba: ${tabla}`);
    },
  };

  return { cliente, llamadas };
}

const dependencias = (cliente, extras = {}) => ({
  cliente,
  enviarCorreo: async () => ({ enviado: true }),
  esModoPrueba: () => false,
  generarToken: () => "a".repeat(64),
  ahora: () => new Date("2026-08-28T12:00:00.000Z"),
  ...extras,
});

test("detecta un portal apuntando a la máquina de desarrollo", () => {
  // El caso que evita: Merkahorro invita a un proveedor real, el correo sale bien,
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

test("recuperación no enumera cuentas inexistentes, inactivas o incompletas", async (t) => {
  t.mock.method(console, "warn", () => {});

  for (const cuenta of [
    null,
    { ...CUENTA_ACTIVA, estado: "invitado" },
    { ...CUENTA_ACTIVA, estado: "suspendido" },
    { ...CUENTA_ACTIVA, correo_notificacion: null },
    { ...CUENTA_ACTIVA, user_id: null },
  ]) {
    const { cliente, llamadas } = clienteRecuperacion({ cuenta });
    let envioIntentado = false;

    const resultado = await solicitarRecuperacion(
      { nit: " 800.186.960-6 ", sucursal: "006", ip: "192.0.2.10" },
      dependencias(cliente, {
        enviarCorreo: async () => {
          envioIntentado = true;
          return { enviado: true };
        },
      }),
    );

    assert.deepEqual(resultado, { ok: true });
    assert.equal(envioIntentado, false);
    assert.equal(llamadas.invitaciones.length, 0);
    assert.equal(llamadas.auditorias.length, 0);
    assert.deepEqual(llamadas.consultas[0], [
      ["nit", "800186960"],
      ["sucursal", "006"],
    ]);
  }
});

test("recuperación activa invalida anteriores, guarda solo el hash y audita", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { cliente, llamadas } = clienteRecuperacion();
  const correos = [];
  const token = "token-secreto-que-solo-viaja-en-el-enlace";

  const resultado = await solicitarRecuperacion(
    { nit: CUENTA_ACTIVA.nit, sucursal: CUENTA_ACTIVA.sucursal, ip: "192.0.2.10" },
    dependencias(cliente, {
      generarToken: () => token,
      enviarCorreo: async (correo) => {
        correos.push(correo);
        return { enviado: true };
      },
    }),
  );

  assert.deepEqual(resultado, { ok: true });
  assert.deepEqual(llamadas.invalidaciones, [
    {
      cambios: { usado_at: "2026-08-28T12:00:00.000Z" },
      filtros: [
        ["cuenta_id", 17],
        ["usado_at", null],
      ],
    },
  ]);
  assert.deepEqual(llamadas.invitaciones, [
    {
      cuenta_id: 17,
      token_hash: crypto.createHash("sha256").update(token, "utf8").digest("hex"),
      expira_at: "2026-08-31T12:00:00.000Z",
      creado_por: null,
    },
  ]);
  assert.equal(JSON.stringify(llamadas.invitaciones).includes(token), false);
  assert.equal(correos.length, 1);
  assert.equal(correos[0].para, CUENTA_ACTIVA.correo_notificacion);
  assert.match(correos[0].texto, new RegExp(`activar\\?token=${token}`));
  assert.deepEqual(llamadas.auditorias, [
    {
      entidad: "pp_cuentas",
      entidad_id: "17",
      accion: "recuperar_clave",
      actor_rol: "pp_proveedor",
      detalle: { correoEnviado: true, motivo: null },
      ip: "192.0.2.10",
    },
  ]);
  assert.equal("correo" in llamadas.auditorias[0].detalle, false);
});

test("modo prueba devuelve el enlace sin cambiar la respuesta normal", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { cliente } = clienteRecuperacion();
  const token = "b".repeat(64);

  const resultado = await solicitarRecuperacion(
    { nit: CUENTA_ACTIVA.nit, sucursal: CUENTA_ACTIVA.sucursal },
    dependencias(cliente, {
      generarToken: () => token,
      esModoPrueba: () => true,
    }),
  );

  assert.deepEqual(resultado, {
    ok: true,
    enlacePrueba: `http://localhost:5173/portal-proveedores/activar?token=${token}`,
  });
});

test("un error al consultar Supabase no se disfraza de cuenta inexistente", async () => {
  const { cliente, llamadas } = clienteRecuperacion({
    cuenta: null,
    errorCuenta: { message: "base no disponible" },
  });

  await assert.rejects(
    solicitarRecuperacion(
      { nit: CUENTA_ACTIVA.nit, sucursal: CUENTA_ACTIVA.sucursal },
      dependencias(cliente),
    ),
    /No se pudo verificar la cuenta: base no disponible/,
  );
  assert.equal(llamadas.invitaciones.length, 0);
});

test("si no puede invalidar enlaces anteriores NO crea otro token", async () => {
  const { cliente, llamadas } = clienteRecuperacion({
    errorInvalidacion: { message: "falló update" },
  });
  let envioIntentado = false;

  await assert.rejects(
    solicitarRecuperacion(
      { nit: CUENTA_ACTIVA.nit, sucursal: CUENTA_ACTIVA.sucursal },
      dependencias(cliente, {
        enviarCorreo: async () => {
          envioIntentado = true;
          return { enviado: true };
        },
      }),
    ),
    /No se pudieron invalidar los enlaces anteriores: falló update/,
  );
  assert.equal(llamadas.invitaciones.length, 0);
  assert.equal(llamadas.auditorias.length, 0);
  assert.equal(envioIntentado, false);
});

test("si falla la inserción del token no envía correo ni audita", async () => {
  const { cliente, llamadas } = clienteRecuperacion({
    errorInsercion: { message: "falló insert" },
  });
  let envioIntentado = false;

  await assert.rejects(
    solicitarRecuperacion(
      { nit: CUENTA_ACTIVA.nit, sucursal: CUENTA_ACTIVA.sucursal },
      dependencias(cliente, {
        enviarCorreo: async () => {
          envioIntentado = true;
          return { enviado: true };
        },
      }),
    ),
    /No se pudo emitir el enlace: falló insert/,
  );
  assert.equal(llamadas.auditorias.length, 0);
  assert.equal(envioIntentado, false);
});

test("un correo fallido queda auditado sin revelar la cuenta en la respuesta", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { cliente, llamadas } = clienteRecuperacion();

  const resultado = await solicitarRecuperacion(
    { nit: CUENTA_ACTIVA.nit, sucursal: CUENTA_ACTIVA.sucursal },
    dependencias(cliente, {
      enviarCorreo: async () => ({ enviado: false, motivo: "SMTP no disponible" }),
    }),
  );

  assert.deepEqual(resultado, { ok: true });
  assert.deepEqual(llamadas.auditorias[0].detalle, {
    correoEnviado: false,
    motivo: "SMTP no disponible",
  });
});

test("un fallo de auditoría se reporta sin provocar un segundo correo", async (t) => {
  t.mock.method(console, "warn", () => {});
  const errores = [];
  t.mock.method(console, "error", (mensaje) => errores.push(mensaje));
  const { cliente } = clienteRecuperacion({
    errorAuditoria: { message: "tabla bloqueada" },
  });

  const resultado = await solicitarRecuperacion(
    { nit: CUENTA_ACTIVA.nit, sucursal: CUENTA_ACTIVA.sucursal },
    dependencias(cliente),
  );

  assert.deepEqual(resultado, { ok: true });
  assert.equal(errores.length, 1);
  assert.match(errores[0], /cuenta 17: tabla bloqueada/);
});

/* ── Freno por cuenta ─────────────────────────────────────────────────────────
   El límite por IP cuenta en memoria de cada instancia serverless: en Vercel se
   multiplica por N y rotar IPs lo esquiva. Contra este endpoint eso importa
   porque no filtra datos — MANDA UN CORREO A UN TERCERO. La defensa que sirve
   mira la cuenta y vive en la base, que todas las instancias comparten. */

test("un segundo pedido dentro del minuto NO manda otro correo", async () => {
  const { cliente, llamadas } = clienteRecuperacion({
    emisionReciente: [{ id: 1 }], // ya se emitió uno hace poco
  });
  let envioIntentado = false;

  const resultado = await solicitarRecuperacion(
    { nit: "800186960", sucursal: "006", ip: "192.0.2.10" },
    dependencias(cliente, {
      enviarCorreo: async () => {
        envioIntentado = true;
        return { enviado: true };
      },
    }),
  );

  assert.equal(envioIntentado, false, "no se le manda un segundo correo al proveedor");
  assert.equal(llamadas.invitaciones.length, 0, "ni se emite otro token");
  assert.equal(llamadas.invalidaciones.length, 0, "ni se queman los anteriores");
});

test("el freno responde IGUAL que el camino feliz: no es un oráculo", async () => {
  // Decir "espere un minuto" confirmaría que ese NIT+sucursal existe y está
  // activo — justo lo que las respuestas iguales evitan.
  const conFreno = await solicitarRecuperacion(
    { nit: "800186960", sucursal: "006", ip: "192.0.2.10" },
    dependencias(clienteRecuperacion({ emisionReciente: [{ id: 1 }] }).cliente),
  );
  const sinCuenta = await solicitarRecuperacion(
    { nit: "999999999", sucursal: "001", ip: "192.0.2.10" },
    dependencias(clienteRecuperacion({ cuenta: null }).cliente),
  );

  assert.deepEqual(conFreno, { ok: true });
  assert.deepEqual(conFreno, sinCuenta);
});

test("el freno mira la CUENTA y una ventana de tiempo, no la IP", async () => {
  const { cliente, llamadas } = clienteRecuperacion();
  await solicitarRecuperacion(
    { nit: "800186960", sucursal: "006", ip: "192.0.2.10" },
    dependencias(cliente),
  );

  const filtros = llamadas.frenos[0] ?? [];
  const campos = filtros.map(([campo]) => campo);
  assert.ok(campos.includes("cuenta_id"), "filtra por cuenta");
  assert.ok(campos.includes("created_at"), "y por ventana de tiempo");
  // Si alguna vez alguien lo cambia por IP, este test lo agarra: la IP no es lo
  // que hay que proteger — la bandeja del proveedor sí.
  assert.equal(campos.includes("ip"), false);
});

test("si NO se puede comprobar el freno, no se manda nada", async () => {
  // Un correo de más a un tercero no se deshace. Sin poder verificar, el camino
  // seguro es no enviar — y decirlo, no absorberlo en un 200 silencioso.
  const { cliente, llamadas } = clienteRecuperacion({ errorReciente: { message: "falló select" } });
  let envioIntentado = false;

  await assert.rejects(
    () =>
      solicitarRecuperacion(
        { nit: "800186960", sucursal: "006", ip: "192.0.2.10" },
        dependencias(cliente, {
          enviarCorreo: async () => {
            envioIntentado = true;
            return { enviado: true };
          },
        }),
      ),
    /No se pudo verificar el último envío/,
  );

  assert.equal(envioIntentado, false);
  assert.equal(llamadas.invitaciones.length, 0);
});
