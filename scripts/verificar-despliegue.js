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

const BASE = (process.argv[2] || "https://backend-proveedores.vercel.app").replace(/\/+$/, "");
const API = `${BASE}/api`;

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
  mal(
    "TODO da 404, incluso /salud.\n" +
      "      No es el código: es `vercel.json`. Tiene que estar en formato LEGACY\n" +
      "      (version + builds + routes), NO en `rewrites`. Con rewrites, Express\n" +
      "      recibe literalmente /src/server.js y no matchea nada.\n" +
      "      Ver docs/ARQUITECTURA.md §11.1. Ya pasó en backend-traslado.",
  );
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
