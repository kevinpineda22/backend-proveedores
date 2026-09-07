/* =============================================================================
   Verificación de las migraciones 006 y 007

   POR QUÉ EXISTE
   Un `CREATE TABLE` que corre sin error no dice que el backfill haya copiado todo,
   ni que las sugerencias de sucursales hermanas hayan salido. Esto lo comprueba y
   —lo más importante— **lista qué grupos difieren en precio antes de prenderlos**.

   NO ESCRIBE NADA. Solo lee.

   USO
     node scripts/verificar-006-007.js
   ============================================================================= */

import "dotenv/config";
import { supabase } from "../src/config/supabase.js";

const linea = (t) => console.log(t);
const ok = (t) => console.log(`  ✓ ${t}`);
const mal = (t) => console.log(`  ✗ ${t}`);

const contar = async (tabla) => {
  const { count, error } = await supabase
    .from(tabla)
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`${tabla}: ${error.message}`);
  return count ?? 0;
};

/* ── 1. El backfill de la 006 ───────────────────────────────────────────────── */
linea("\n── 006 · solicitudes agrupadas ──────────────────────────────────────");

/* La tabla vieja desaparece con la migración 008. Que no exista no es un error:
   es el final feliz de esta verificación. Sin este `catch`, el script reventaría
   justo cuando ya no hay nada que verificar.

   ⚠️ Este camino puede tardar en activarse: vamos por PostgREST, que **cachea el
   esquema**. El 2026-09-07, con la tabla ya borrada, esto siguió contando 0 filas
   durante varias corridas en vez de fallar. Para saber de verdad si una tabla
   existe, la fuente es SQL directo:

     SELECT to_regclass('public.pp_solicitudes_precio');

   y si el caché molesta: NOTIFY pgrst, 'reload schema'; */
let viejas = null;
try {
  viejas = await contar("pp_solicitudes_precio");
} catch {
  console.log("  (pp_solicitudes_precio ya no existe: la migración 008 se corrió)");
}

if (viejas === null) {
  const yaMigradas = await contar("pp_solicitud_lineas");
  ok(`${yaMigradas} línea(s) en el esquema nuevo`);
} else {
const { count: migradas, error: eMig } = await supabase
  .from("pp_solicitud_lineas")
  .select("*", { count: "exact", head: true })
  .not("migrada_de_id", "is", null);
if (eMig) throw new Error(`pp_solicitud_lineas: ${eMig.message}`);

const cabeceras = await contar("pp_solicitudes");
const lineas = await contar("pp_solicitud_lineas");

linea(`  tabla vieja:        ${viejas} solicitudes`);
linea(`  líneas migradas:    ${migradas}`);
linea(`  cabeceras nuevas:   ${cabeceras}`);
linea(`  líneas totales:     ${lineas}`);

/* `viejas` es lo que QUEDA hoy en la tabla vieja; `migradas` es lo que ALGUNA VEZ
   se copió. No tienen por qué coincidir: si alguien borra una fila de la vieja
   —la limpieza de datos de prueba— los números se separan y no falta nada. Lo que
   se comprueba abajo (fila por fila) es lo que de verdad importa. */
if (viejas > (migradas ?? 0)) {
  mal(`FALTAN ${viejas - (migradas ?? 0)} — NO borrar la tabla vieja`);
} else if (viejas < (migradas ?? 0)) {
  ok(`el backfill copió todas (${migradas - viejas} ya no está en la vieja)`);
} else {
  ok("el backfill copió todas");
}

/* El estado es lo único que no se puede perder en el camino: una solicitud que
   quedó 'pendiente' del lado nuevo cuando ya estaba 'aplicada' vuelve a la cola de
   empuje y manda el precio a SIESA por segunda vez. */
const { data: vs } = await supabase
  .from("pp_solicitudes_precio")
  .select("id, estado, siesa_aplicado_at");
const { data: ns } = await supabase
  .from("pp_solicitud_lineas")
  .select("migrada_de_id, estado, siesa_aplicado_at")
  .not("migrada_de_id", "is", null);

const porId = new Map((ns ?? []).map((l) => [l.migrada_de_id, l]));
const desviados = (vs ?? []).filter((v) => {
  const l = porId.get(v.id);
  return !l || l.estado !== v.estado || l.siesa_aplicado_at !== v.siesa_aplicado_at;
});
desviados.length === 0
  ? ok("estado y marca de empuje coinciden en todas")
  : mal(`${desviados.length} con estado/marca distintos: ${desviados.map((d) => d.id).join(", ")}`);
}

/* ── 2. Las sugerencias de la 007 ───────────────────────────────────────────── */
linea("\n── 007 · sucursales hermanas ────────────────────────────────────────");

const { data: grupos, error: eg } = await supabase
  .from("pp_grupos_sucursal")
  .select("id, nit, nombre, activo, origen, pp_grupo_sucursales(sucursal)")
  .order("nit");
if (eg) throw new Error(`pp_grupos_sucursal: ${eg.message}`);

const activos = (grupos ?? []).filter((g) => g.activo);
linea(`  grupos sugeridos:   ${grupos?.length ?? 0}`);
linea(`  grupos ACTIVOS:     ${activos.length}`);
activos.length === 0
  ? ok("ninguno activo todavía — nada se replica hasta que compras confirme")
  : mal(`${activos.length} ya activos: revisar que sea a propósito`);

/* ── 3. Lo que importa: qué se va a pisar al prender cada grupo ─────────────── */
linea("\n── Diferencias de precio DENTRO de cada grupo ───────────────────────");
linea("   (esto es lo que se pisa al activarlo)\n");

const { data: cots, error: ec } = await supabase
  .from("pp_cotizaciones")
  .select("nit, sucursal, item, descripcion_item, unidad_medida, fecha_activacion, precio");
if (ec) throw new Error(`pp_cotizaciones: ${ec.message}`);

const porCuenta = new Map();
for (const c of cots ?? []) {
  const k = `${c.nit}|${c.sucursal}`;
  if (!porCuenta.has(k)) porCuenta.set(k, new Map());
  porCuenta.get(k).set(`${c.item}|${c.unidad_medida}|${c.fecha_activacion}`, c);
}

let limpios = 0;
for (const g of grupos ?? []) {
  const sucs = (g.pp_grupo_sucursales ?? []).map((s) => s.sucursal).sort();
  if (sucs.length < 2) continue;

  const mapas = sucs.map((s) => porCuenta.get(`${g.nit}|${s}`) ?? new Map());
  const [A, B] = mapas;
  const todas = new Set([...A.keys(), ...B.keys()]);

  const distintos = [];
  let soloUno = 0;
  for (const k of todas) {
    const a = A.get(k);
    const b = B.get(k);
    if (!a || !b) {
      soloUno++;
      continue;
    }
    if (Number(a.precio) !== Number(b.precio)) distintos.push({ a, b });
  }

  if (!A.size && !B.size) continue; // sin precios: nada que pisar todavía

  const cabecera =
    `  [${g.id}] ${g.nit} ${g.nombre}  (suc ${sucs.join(" ↔ ")})  ` +
    `${A.size}/${B.size} ítems`;

  if (distintos.length === 0 && soloUno === 0) {
    limpios++;
    continue;
  }

  linea(cabecera);
  if (soloUno) linea(`      · ${soloUno} renglón(es) existen en UNA sola sucursal — no se replican`);
  for (const d of distintos.slice(0, 6)) {
    linea(
      `      ⚠ item ${d.a.item} ${d.a.unidad_medida} ${d.a.fecha_activacion}  ` +
        `${d.a.precio} vs ${d.b.precio}   ${String(d.a.descripcion_item ?? "").slice(0, 40)}`,
    );
  }
  if (distintos.length > 6) linea(`      ⚠ … y ${distintos.length - 6} más`);
  linea("");
}

linea(`  ${limpios} grupo(s) sin ninguna diferencia: se pueden activar sin riesgo.\n`);
