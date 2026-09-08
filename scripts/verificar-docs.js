/* =============================================================================
   ¿La documentación dice cosas que no existen?

   POR QUÉ EXISTE
   El 2026-09-07 se encontró en `ARQUITECTURA.md` un árbol de archivos del
   frontend que listaba DIEZ que nunca existieron (`TablaCotizaciones.jsx`,
   `DetalleSolicitud.jsx`, `FirmaModal.jsx`…), rutas de la API borradas por la
   migración 006, y una tabla de estado con conteos de tests de tres semanas
   atrás. Nada de eso da error: la doc simplemente manda a buscar cosas que no
   están, y el que la lee pierde media hora antes de desconfiar.

   Esto compara lo que la doc AFIRMA contra lo que hay en disco y en el router.
   No revisa el sentido de nada — revisa que los nombres existan, que es lo
   único automatizable y justo lo que se pudre solo.

   NO ESCRIBE NADA.

   USO
     node scripts/verificar-docs.js
   ============================================================================= */

import fs from "node:fs";
import path from "node:path";

const DOCS = ["docs/ARQUITECTURA.md", "docs/COMO-FUNCIONA.md", "docs/CONTRATO-SIESA.md", "docs/PENDIENTES.md", "README.md"];
const FRONT = path.resolve(process.env.PORTAL_FRONT ?? "../../Pagina-web_React/src/pages/PortalProveedores");

let fallos = 0;
const mal = (t) => { console.log(`  ✗ ${t}`); fallos++; };
const ok = (t) => console.log(`  ✓ ${t}`);

const texto = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const todo = DOCS.map((d) => ({ doc: d, txt: texto(d) })).filter((x) => x.txt);

/* Archivos que la doc menciona y que se pueden verificar en disco. Se buscan en
   varias carpetas porque la doc habla de los dos repos. */
const existe = (nombre, carpetas) =>
  carpetas.some((c) => fs.existsSync(path.join(c, nombre)));

/* Los patrones se escriben LITERALES y no se arman con `replace`. La primera
   versión los construía a partir de la extensión y salía un regex roto: el
   chequeo daba "0 archivos nombrados, todos existen" — verde porque no miró
   nada. Un chequeo que pasa sin comprobar es peor que no tenerlo, porque además
   da confianza. */
/* `backend-traslado` se mira a propósito: la doc cita código de allá que este
   proyecto REUTILIZA (`postConector()`, `ejecutarConsulta()`). Verificarlo es
   mejor que ponerlo en una lista de excepciones — una excepción taparía
   justamente el día que ese archivo se borre en el otro repo y la cita quede
   apuntando al aire. */
const TRASLADO = path.resolve(process.env.BACKEND_TRASLADO ?? "../backend-traslado/src/services");

const buscarEn = [
  { re: /\b[A-Za-z][A-Za-z0-9]*\.jsx\b/g, carpetas: [FRONT, path.join(FRONT, "components")] },
  { re: /\b[a-zA-Z][a-zA-Z0-9]*\.service\.js\b/g, carpetas: ["src/services", TRASLADO] },
];

console.log("\n── Archivos que la doc nombra ─────────────────────────────");
/* Se ignoran los que la doc cita como EJEMPLO de otras partes de la app: son
   referencias legítimas a código que no vive en este proyecto. */
const AJENOS = new Set([
  "RouterApp.jsx", "RutaProtegida.jsx", "CantidadModal.jsx",
  "InventariosFinalizados.jsx", "SignatureModal.jsx", "UserForm.jsx",
]);
/* Y los que la doc nombra JUSTAMENTE para decir que ya no existen. Una nota que
   explica una eliminación tiene que poder nombrar lo eliminado. */
const SEPULTADOS = new Set(["EditarPrecioModal.jsx", "TablaCotizaciones.jsx", "DetalleSolicitud.jsx", "FirmaModal.jsx"]);

const vistos = new Set();
for (const { doc, txt } of todo) {
  for (const { re, carpetas } of buscarEn) {
    for (const nombre of txt.match(re) ?? []) {
      if (AJENOS.has(nombre) || SEPULTADOS.has(nombre) || vistos.has(nombre)) continue;
      vistos.add(nombre);
      if (!existe(nombre, carpetas)) mal(`${doc} nombra "${nombre}" y no existe`);
    }
  }
}
/* Si no encontró NINGÚN nombre, el que falló es este script — no la doc. Sin
   este piso, un patrón roto se lee como "está todo bien": la primera versión
   decía "0 archivos nombrados, todos existen" y daba verde sin mirar nada. */
if (vistos.size < 5) {
  mal(`solo se detectaron ${vistos.size} nombres de archivo: el patrón de búsqueda está roto`);
} else if (!fallos) {
  ok(`${vistos.size} archivos nombrados, todos existen`);
}

/* ── Rutas de la API ─────────────────────────────────────────────────────── */
console.log("\n── Rutas que la doc nombra ────────────────────────────────");
const router = texto("src/routes/index.js") + texto("src/controllers/publico.controller.js");
const antes = fallos;
for (const { doc, txt } of todo) {
  for (const ruta of new Set(txt.match(/\/api\/(admin|proveedor|publico|cron)\/[a-zA-Z0-9/:_-]+/g) ?? [])) {
    /* Se compara el ÚLTIMO tramo estable de la ruta contra el router: los
       parámetros (`:id`) y el prefijo se montan en otro lado. */
    const sinPrefijo = ruta.replace(/^\/api\/(admin|proveedor|publico|cron)/, "");
    const trozo = sinPrefijo.split("?")[0].replace(/:\w+/g, ":");
    const hay = router.replace(/:\w+/g, ":").includes(trozo.replace(/\/$/, ""));
    if (!hay && trozo.length > 1) mal(`${doc} documenta "${ruta}" y el router no la tiene`);
  }
}
if (fallos === antes) ok("todas las rutas documentadas existen en el router");

/* ── Migraciones ─────────────────────────────────────────────────────────── */
console.log("\n── Migraciones ────────────────────────────────────────────");
const enDisco = fs.readdirSync("sql").filter((f) => f.endsWith(".sql")).sort();
const ultima = enDisco[enDisco.length - 1];
const mencionadas = todo.filter((x) => x.txt.includes(ultima.slice(0, 3)));
mencionadas.length
  ? ok(`la última (${ultima}) aparece en ${mencionadas.length} documento(s)`)
  : mal(`la última migración (${ultima}) no está en ninguna doc`);

console.log(
  fallos
    ? `\n❌ ${fallos} referencia(s) rota(s) en la documentación.\n`
    : `\n✅ La documentación no nombra nada que no exista.\n`,
);
process.exit(fallos ? 1 : 0);
