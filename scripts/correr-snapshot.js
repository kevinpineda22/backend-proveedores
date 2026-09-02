/* =============================================================================
   Dispara el snapshot a mano y muestra lo que hay que mirar

   POR QUÉ EXISTE
   El `curl` de la documentación no corre en PowerShell: ahí `curl` es un alias
   de `Invoke-WebRequest`, que no acepta `-H "clave: valor"`. Y `$CRON_SECRET`
   tampoco existe en esa consola — vive en el `.env`.

   Este script lee el secreto del `.env`, hace el POST, y resalta los dos
   números que deciden si la corrida salió bien. El secreto nunca se escribe en
   la línea de comandos, así que no queda en el historial de la terminal.

   USO
     node scripts/correr-snapshot.js            # contra producción
     node scripts/correr-snapshot.js --local    # contra localhost:3000
     node scripts/correr-snapshot.js <url-base>

   Tarda varios minutos: son ~190 páginas de cotizaciones más ~40 de terceros.
   ============================================================================= */

import "dotenv/config";
import axios from "axios";

const args = process.argv.slice(2);
const base = args.includes("--local")
  ? "http://localhost:3000"
  : args.find((a) => a.startsWith("http")) || "https://backend-proveedores.vercel.app";

const secreto = process.env.CRON_SECRET;
if (!secreto) {
  console.error(
    "\n❌ Falta CRON_SECRET en el .env.\n" +
      "   Es el mismo valor que está en las variables de entorno de Vercel.\n",
  );
  process.exit(1);
}

console.log(`\nPOST ${base}/api/cron/snapshot`);
console.log("Esto tarda varios minutos. No lo cortes.\n");

const t0 = Date.now();
try {
  const { data } = await axios.post(
    `${base}/api/cron/snapshot`,
    {},
    { headers: { "x-cron-secret": secreto }, timeout: 15 * 60_000 },
  );

  const min = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(`✅ Terminó en ${min} min\n`);
  console.dir(data, { depth: null });

  const m = data?.maestro ?? {};

  console.log("\n═══ Lo que hay que mirar ═══\n");

  // 1. ¿De dónde salió el maestro?
  const derivado = /pp_cotizaciones/.test(String(m.fuente ?? ""));
  console.log(`Fuente: ${m.fuente ?? "(no vino)"}`);
  if (derivado) {
    console.log(
      "  🔴 Sigue derivando de las cotizaciones. `SIESA_CONSULTA_TERCEROS` no\n" +
        "     llegó a ESTE deployment: ponela en Vercel y REDESPLEGÁ — una\n" +
        "     variable nueva no se aplica al deployment que ya está corriendo.",
    );
  } else {
    console.log("  ✅ Está leyendo el maestro de verdad.");
  }

  // 2. ¿Perdimos a alguien?
  const perdidos = m.proveedoresNoTraidos;
  console.log(`\nproveedoresNoTraidos: ${perdidos ?? "(no vino)"}`);
  if (perdidos > 0) {
    console.log(
      `  🔴 ${perdidos} proveedor(es) que YA estaban en el maestro no vinieron en\n` +
        "     esta corrida. El filtro de la consulta se llevó gente. Nadie se\n" +
        "     borra —el upsert no borra— pero la lista quedó incompleta.\n" +
        "     Correr: node scripts/diagnostico-terceros.js --control",
    );
  } else if (perdidos === 0) {
    console.log("  ✅ Ninguno. El maestro solo creció.");
  }

  console.log(`\nMaestro: ${m.proveedores ?? "?"} proveedores · ${m.cuentas ?? "?"} cuentas`);
  if (!derivado && perdidos === 0) {
    console.log("\n✅ Corrida limpia. El bloqueante de la consulta de terceros queda cerrado.\n");
  } else {
    process.exitCode = 1;
  }
} catch (e) {
  const status = e?.response?.status;
  const cuerpo = e?.response?.data;
  console.error(`\n❌ HTTP ${status ?? "-"}:`, cuerpo?.error || cuerpo?.message || e.message);
  if (status === 401 || status === 403) {
    console.error(
      "\n👉 El CRON_SECRET del .env no coincide con el de Vercel.\n" +
        "   Copialo de las variables de entorno del proyecto.\n",
    );
  }
  if (status === 503) {
    console.error("\n👉 CRON_SECRET no está configurado del lado del servidor.\n");
  }
  if (e.code === "ECONNABORTED") {
    console.error(
      "\n👉 Se acabó el tiempo del lado nuestro. La corrida puede haber seguido\n" +
        "   en el servidor: revisá los logs de Vercel antes de volver a dispararla.\n",
    );
  }
  process.exitCode = 1;
}
