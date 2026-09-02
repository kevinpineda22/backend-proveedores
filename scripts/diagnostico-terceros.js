/* =============================================================================
   Diagnóstico de la consulta de TERCEROS

   POR QUÉ EXISTE
   Prender `SIESA_CONSULTA_TERCEROS` en Vercel y esperar al cron es la forma
   lenta de descubrir que la consulta está mal cargada. Este script pide UNA
   página, sin reintentos, y dice exactamente qué contestó SIESA.

   Los tres fallos que ya pasaron, y cómo se ven acá:

     · `Incorrect syntax near ';'`  → la consulta se cargó con un `;`. Connekta
       la envuelve para paginarla, y el `;` parte la sentencia envolvente. Lo
       mismo con `ORDER BY` y con comentarios. (Pasó el 2026-09-01.)
     · HTTP 401 *"verifique si tiene permisos"* → la consulta existe pero estas
       credenciales no la pueden ejecutar, o el nombre está mal escrito.
     · 200 con menos proveedores de los esperados → el filtro se llevó gente.
       Para eso está `--control`.

   USO
     node scripts/diagnostico-terceros.js                  # una página
     node scripts/diagnostico-terceros.js --todo           # recorre todo
     node scripts/diagnostico-terceros.js --control        # + contrasta los 337 NIT
     node scripts/diagnostico-terceros.js <nombre-consulta>

   Sin argumento de nombre usa `SIESA_CONSULTA_TERCEROS`, y si no está,
   `merkahorro_terceros_dev_cotiz`.

   NO escribe nada: ni en SIESA ni en Supabase. Nunca imprime credenciales.
   ============================================================================= */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { consultarTerceros } from "../src/config/connekta.js";
import { normalizarTercero, derivarMaestro } from "../src/services/maestro.service.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const TODO = args.includes("--todo") || args.includes("--control");
const CONTROL = args.includes("--control");
const nombre =
  args.find((a) => !a.startsWith("--")) ||
  process.env.SIESA_CONSULTA_TERCEROS ||
  "merkahorro_terceros_dev_cotiz";

const base =
  process.env.CONNEKTA_BASE_URL || "https://servicios.siesacloud.com/api/connekta/v3";

console.log(`\nConsulta:   ${nombre}`);
console.log(`idCompania: ${process.env.SIESA_ID_COMPANIA || "7375"}`);
console.log(
  `Credenciales: CONNI_KEY ${process.env.CONNI_KEY ? "✓" : "✗ FALTA"} · ` +
    `CONNI_TOKEN ${process.env.CONNI_TOKEN ? "✓" : "✗ FALTA"}`,
);

/** Una página, SIN reintentos: acá el error es la respuesta que buscamos. */
async function unaPagina() {
  const t0 = Date.now();
  const { data } = await axios.get(`${base}/ejecutarconsulta`, {
    headers: { conniKey: process.env.CONNI_KEY, conniToken: process.env.CONNI_TOKEN },
    params: {
      idCompania: process.env.SIESA_ID_COMPANIA || "7375",
      descripcion: nombre,
      paginacion: "numPag=1|tamPag=100",
    },
    timeout: 90_000,
  });
  return { data, ms: Date.now() - t0 };
}

function explicar(status, detalle) {
  const d = String(detalle || "");
  if (/incorrect syntax|error de sintaxis/i.test(d)) {
    return (
      "La consulta cargada en Connekta tiene SQL que él no puede envolver para\n" +
      "   paginar. Sacale el `;` final, el `ORDER BY` y los comentarios, y volvé\n" +
      "   a guardarla. El resto de la consulta puede estar perfecta."
    );
  }
  if (/invalid column|invalid object|nombre de objeto/i.test(d)) {
    return "Una columna o una tabla de la consulta no existe con ese nombre en SIESA.";
  }
  if (status === 401) {
    return (
      "O el nombre está mal escrito, o estas credenciales no tienen permiso\n" +
      "   sobre ESTA consulta. Cada consulta dinámica puede tener su propio par\n" +
      "   conniKey/conniToken."
    );
  }
  return null;
}

try {
  const { data, ms } = await unaPagina();
  if (data?.codigo !== 0) throw new Error(`codigo ${data?.codigo}: ${data?.mensaje}`);

  const d = data.detalle ?? {};
  const filas = d.Table ?? d.Datos ?? [];
  const totalPaginas = Number(d["total_páginas"] ?? d.total_paginas ?? 1) || 1;

  console.log(`\n✅ Responde (${ms} ms)`);
  console.log(`   ${d.total_registros ?? "?"} registros · ${totalPaginas} página(s)`);

  if (!filas.length) {
    console.log(
      "\n⚠️ Cero filas. La consulta corre pero no devuelve nada: revisá el WHERE.",
    );
    process.exit(0);
  }

  console.log(`\n   Alias: ${Object.keys(filas[0]).join(", ")}`);

  const ESPERADOS = ["IdTercero", "NitTercero", "RazonSocial", "Sucursal", "DescSucursal"];
  const faltan = ESPERADOS.filter((a) => !(a in filas[0]));
  if (faltan.length) {
    console.log(
      `\n🔴 Faltan alias que el normalizador espera: ${faltan.join(", ")}\n` +
        "   `normalizarTercero` los leería como cadena vacía y el maestro saldría mudo.",
    );
  } else {
    console.log("   ✓ Los cinco alias que espera `normalizarTercero` están.");
  }

  console.log("\n   Muestra normalizada:");
  for (const f of filas.slice(0, 3)) console.log("   ", normalizarTercero(f));

  if (!TODO) {
    console.log("\nCorrer con --todo para recorrer todas las páginas.\n");
    process.exit(0);
  }

  console.log(`\nRecorriendo las ${totalPaginas} páginas…`);
  process.env.SIESA_CONSULTA_TERCEROS = nombre;
  const crudas = await consultarTerceros();
  const { proveedores, cuentas } = derivarMaestro(crudas.map(normalizarTercero));
  console.log(
    `\n✅ ${crudas.length} filas → ${proveedores.length} proveedores · ${cuentas.length} cuentas`,
  );

  if (!CONTROL) {
    console.log("\nCorrer con --control para contrastar contra los 337 NIT de control.\n");
    process.exit(0);
  }

  /* La lista de control: los NIT que TIENEN acuerdos de precio vigentes. Si la
     consulta de terceros no trae alguno, el filtro se lo llevó. Y ojo con el
     filtro obvio: 57 de esos 337 son personas naturales con NIT de cédula. */
  const archivo = path.join(raiz, "docs/NITS-PROVEEDORES-CONTROL.txt");
  const control = fs
    .readFileSync(archivo, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim().split(/[\s,;|]+/)[0])
    .filter((n) => /^\d+$/.test(n));

  const traidos = new Set(proveedores.map((p) => p.nit));
  const perdidos = control.filter((nit) => !traidos.has(nit));

  console.log(`\n═══ Contra la lista de control (${control.length} NIT) ═══`);
  if (!perdidos.length) {
    console.log(
      "\n✅ Los trae a TODOS. El filtro está bien puesto.\n" +
        "   Ya se puede prender SIESA_CONSULTA_TERCEROS en Vercel.\n",
    );
  } else {
    const personas = perdidos.filter((n) => n.length <= 10);
    console.log(
      `\n🔴 Faltan ${perdidos.length} de ${control.length} proveedores con acuerdos vigentes.` +
        (personas.length
          ? `\n   ${personas.length} tienen NIT de persona natural: es el filtro que` +
            "\n   saca 'las personas porque son empleados'. El criterio correcto es" +
            "\n   el TIPO de tercero en SIESA, no la forma del NIT."
          : "") +
        `\n\n   Ejemplos: ${perdidos.slice(0, 12).join(", ")}\n`,
    );
    process.exitCode = 1;
  }
} catch (e) {
  const status = e?.response?.status;
  const detalle = e?.response?.data?.detalle || e?.response?.data?.mensaje || e.message;
  console.error(`\n❌ HTTP ${status ?? "-"}: ${detalle}`);
  const pista = explicar(status, detalle);
  if (pista) console.error(`\n👉 ${pista}\n`);
  process.exitCode = 1;
}
