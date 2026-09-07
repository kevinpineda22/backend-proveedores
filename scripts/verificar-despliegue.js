/* =============================================================================
   ¿El despliegue quedó bien? — 10 segundos, sin abrir el navegador

   POR QUÉ EXISTE
   El 2026-09-07 se desplegó el backend nuevo y TODO devolvía 404, incluido
   `/api/salud`. No era el código: era `vercel.json` en formato `rewrites`, que
   hace que Express reciba `/src/server.js` en vez de la URL real (ver
   docs/ARQUITECTURA.md §11.1). Ya había pasado en `backend-traslado`.

   Ese diagnóstico son tres peticiones. Este script las hace y dice qué significa
   cada resultado, para no tener que acordarse.

   NO ESCRIBE NADA. Solo pide rutas públicas y comprueba que las privadas
   respondan 401 —o sea, que EXISTAN y estén protegidas—, nunca que funcionen.

   USO
     node scripts/verificar-despliegue.js
     node scripts/verificar-despliegue.js https://otro-deploy.vercel.app
   ============================================================================= */

import axios from "axios";
import fs from "node:fs";
import { execSync } from "node:child_process";

const BASE = (process.argv[2] || "https://backend-proveedores.vercel.app").replace(/\/+$/, "");
const API = `${BASE}/api`;

/** Lee un archivo del repo. Devuelve "" si el script se corre desde otra carpeta. */
const fsLeer = (ruta) => {
  try {
    return fs.readFileSync(ruta, "utf8");
  } catch {
    return "";
  }
};

/** La rama y el remoto que Vercel debería estar construyendo. */
const remotoActual = () => {
  try {
    const rama = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    const remoto = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
    const commit = execSync("git log --oneline -1", { encoding: "utf8" }).trim();
    return `Acá: rama "${rama}" de ${remoto}\n           último commit: ${commit}`;
  } catch {
    return "(no se pudo leer el estado de git)";
  }
};

const pedir = async (metodo, ruta) => {
  const r = await axios({
    method: metodo,
    url: `${API}${ruta}`,
    data: metodo === "post" ? {} : undefined,
    validateStatus: () => true,
    timeout: 30000,
  });
  return { status: r.status, cuerpo: JSON.stringify(r.data ?? "").slice(0, 120) };
};

let fallos = 0;
const ok = (t) => console.log(`  ✓ ${t}`);
const mal = (t) => {
  console.log(`  ✗ ${t}`);
  fallos++;
};

console.log(`\nProbando ${API}\n`);

/* ── 1. ¿Llega ALGO? ───────────────────────────────────────────────────────
   La prueba que separa "esta ruta está mal" de "ninguna ruta llega": se pide
   una salud que SIEMPRE existe y una ruta inventada. Si las dos responden lo
   mismo, el problema es el enrutamiento, no el código. */
console.log("── ¿Las peticiones llegan a Express? ──────────────────────");

const salud = await pedir("get", "/salud");
const inventada = await pedir("get", "/ruta-que-no-existe-jamas");

console.log(`  /salud                     → ${salud.status} ${salud.cuerpo}`);
console.log(`  /ruta-que-no-existe-jamas  → ${inventada.status}`);

if (salud.status === 404 && inventada.status === 404) {
  mal("TODO da 404, incluso /salud. Ninguna petición está llegando a las rutas.");

  /* El archivo local puede estar bien y el problema seguir: lo que importa no es
     lo que dice el repo, es qué build está sirviendo el dominio. Distinguir esos
     dos casos es la diferencia entre editar un archivo otra vez —inútil— y
     mirar el dashboard. */
  let config = null;
  try {
    config = JSON.parse(fsLeer("vercel.json"));
  } catch {
    /* Se corre desde otra carpeta: no se puede leer, y no es un problema. */
  }

  if (config && (config.rewrites || !config.builds)) {
    console.log(`
      CAUSA: este \`vercel.json\` usa \`rewrites\` (o le falta \`builds\`).
      \`rewrites.destination\` REESCRIBE la URL: Express recibe literalmente
      /src/server.js y no matchea nada.

      ARREGLO: formato legacy — version + builds + routes. Ver
      docs/ARQUITECTURA.md §11.1. Ya pasó en backend-traslado.`);
  } else if (config) {
    console.log(`
      OJO: el \`vercel.json\` de ESTE repo ya está bien (builds + routes).
      Entonces el archivo no es el problema — lo es QUÉ BUILD está sirviendo el
      dominio. Tres cosas para mirar en Vercel, en este orden:

        1. ¿El último build FALLÓ? Si falló, el dominio sigue sirviendo el
           deployment anterior —el que tenía \`rewrites\`— y por eso no cambió
           nada. El error del build lo dice todo.

        2. ¿El deployment más nuevo está PROMOVIDO a producción? Un build que
           salió bien pero no se promovió deja el alias en el viejo. Ya pasó en
           backend-traslado (2026-09-04).

        3. ¿Vercel está mirando esta rama y este repo?
           ${remotoActual()}

      Para separar (1) de (2): copiá la URL del deployment más reciente desde el
      dashboard y probala directo, salteando el alias:

        node scripts/verificar-despliegue.js https://<deployment>.vercel.app

      Si ESA anda y el dominio no, es (2): falta promover.
      Si ESA tampoco anda, el build no tomó el vercel.json nuevo.`);
  }
} else if (salud.status === 200) {
  ok("/salud responde 200 — el enrutamiento está bien");
} else {
  mal(`/salud respondió ${salud.status}, que no es 200 ni el 404 del enrutamiento`);
}

/* ── 2. ¿Está el código NUEVO? ─────────────────────────────────────────────
   Las rutas de la migración 006 reciben `lineaIds`. Sin token tienen que dar
   401 (existen y están protegidas). Un 404 acá, con /salud en 200, significa
   que el deploy sirvió una versión vieja. */
console.log("\n── ¿Está desplegada la migración 006? ─────────────────────");

for (const ruta of [
  "/admin/solicitudes/lineas/aprobar",
  "/admin/solicitudes/lineas/rechazar",
  "/admin/solicitudes/lineas/reintentar",
]) {
  const r = await pedir("post", ruta);
  if (r.status === 401 || r.status === 403) ok(`${ruta} → ${r.status} (existe y pide token)`);
  else if (r.status === 404) mal(`${ruta} → 404: el deploy tiene código VIEJO`);
  else mal(`${ruta} → ${r.status} ${r.cuerpo}`);
}

/* ── 3. Las públicas de siempre ────────────────────────────────────────────
   No son parte del cambio, pero si éstas se rompieron el despliegue rompió algo
   más grande que las rutas nuevas. */
console.log("\n── Las de siempre ─────────────────────────────────────────");

const suc = await pedir("get", "/publico/sucursales?nit=800186960");
suc.status === 200
  ? ok("/publico/sucursales responde 200")
  : mal(`/publico/sucursales → ${suc.status} ${suc.cuerpo}`);

const cat = await pedir("get", "/proveedor/catalogo");
cat.status === 401
  ? ok("/proveedor/catalogo sin token → 401 (protegida, como debe ser)")
  : mal(`/proveedor/catalogo sin token → ${cat.status}: DEBERÍA ser 401`);

const cron = await pedir("post", "/cron/snapshot");
cron.status === 401
  ? ok("/cron/snapshot sin secreto → 401")
  : mal(`/cron/snapshot sin secreto → ${cron.status}: DEBERÍA ser 401`);

console.log(
  fallos
    ? `\n❌ ${fallos} problema(s). El despliegue NO está listo para usarse.\n`
    : `\n✅ El despliegue responde bien.\n`,
);
process.exit(fallos ? 1 : 0);
