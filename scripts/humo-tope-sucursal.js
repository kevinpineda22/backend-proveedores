/* =============================================================================
   Prueba de humo del tope POR SUCURSAL (migración 009)

   POR QUÉ EXISTE
   `verificar-009.js` comprueba que la columna esté y que `topeDe()` resuelva bien
   con casos de laboratorio. Lo que no comprueba es el camino que el admin va a
   usar de verdad: guardar un tope desde el panel y que ESE tope sea el que
   después bloquea una propuesta. Ese camino atraviesa el controlador, la
   auditoría y la resolución, y nunca corrió — la pantalla del admin pide login
   corporativo y los tests unitarios no tocan la base.

   ⚠️ ESTO SÍ ESCRIBE, y por eso está acotado:
     · toca UNA cuenta, la de prueba de Altipal (800186960 / 006)
     · NO toca `pp_proveedores`: ningún tope de NIT se crea ni se modifica
     · la deja como la encontró, pase lo que pase (hay un `finally`)
   Las filas de `pp_auditoria` quedan: la tabla es append-only por trigger, y está
   bien — el cambio ocurrió.

   USO
     node scripts/humo-tope-sucursal.js
   ============================================================================= */

import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import { configurarCuenta } from "../src/controllers/admin.controller.js";
import { topeDe, excedeTope } from "../src/services/costoNeto.js";

const NIT = "800186960";
const SUC = "006";

/* `pp_auditoria.ip` es de tipo `inet`: cualquier texto que no sea una IP hace
   fallar el insert. Y como el controlador NO mira el error de ese insert, el
   fallo es invisible — la primera versión de este script mandaba "script", la
   auditoría no quedaba, y nada se quejó. */
const IP = "127.0.0.1";

let fallos = 0;
const ok = (t) => console.log(`  ✓ ${t}`);
const mal = (t) => {
  console.log(`  ✗ ${t}`);
  fallos++;
};

/** Llama al controlador real con un req/res de mentira y devuelve lo que respondió. */
const patch = (id, porcentajeMax) =>
  new Promise((resolve, reject) => {
    configurarCuenta(
      { params: { id: String(id) }, body: { porcentajeMax }, admin: { userId: null }, ip: IP },
      { json: resolve },
      reject,
    );
  });

/** Relee la cuenta y su proveedor, tal como los ve el resto del sistema. */
const leer = async (id) => {
  const { data: cuenta } = await supabase
    .from("pp_cuentas")
    .select("id, nit, sucursal, porcentaje_max")
    .eq("id", id)
    .single();
  const { data: proveedor } = await supabase
    .from("pp_proveedores")
    .select("nit, porcentaje_max")
    .eq("nit", cuenta.nit)
    .single();

  /* `topeDe` espera el objeto NORMALIZADO (camelCase), no la fila cruda. Pasarle
     la fila devolvería `undefined` siempre y todo daría "hereda" — el script
     pasaría en verde sin haber probado nada. */
  return {
    cuenta: { porcentajeMax: cuenta.porcentaje_max },
    proveedor: { porcentajeMax: proveedor?.porcentaje_max ?? null },
    crudo: cuenta,
    topeDelNit: proveedor?.porcentaje_max ?? null,
  };
};

console.log("\n── tope por sucursal · humo ─────────────────────────────────────────");

const { data: cuenta } = await supabase
  .from("pp_cuentas")
  .select("id, nit, sucursal, nombre_sucursal, porcentaje_max")
  .eq("nit", NIT)
  .eq("sucursal", SUC)
  .maybeSingle();

if (!cuenta) {
  console.error(`\n⛔ No existe la cuenta ${NIT}/${SUC}. Abortado.\n`);
  process.exit(1);
}

const original = cuenta.porcentaje_max;
console.log(`  cuenta ${cuenta.id} · ${NIT}/${SUC} · tope actual: ${original ?? "NULL (hereda)"}`);

try {
  /* ── 1. Guardar un tope propio ──────────────────────────────────────────── */
  const r1 = await patch(cuenta.id, 3);
  if (r1.porcentajeMax === 3) ok("el controlador respondió 3");
  else mal(`el controlador respondió ${JSON.stringify(r1)}`);

  const e1 = await leer(cuenta.id);
  if (e1.crudo.porcentaje_max === 3) ok("quedó guardado en la base");
  else mal(`en la base quedó ${e1.crudo.porcentaje_max}`);

  /* Lo que importa: el tope del NIT de Altipal es NULL (sin tope). Si la
     resolución da 3, el de la sucursal MANDÓ sobre el del NIT — que es todo el
     punto de la migración. */
  const rige1 = topeDe(e1.cuenta, e1.proveedor);
  if (rige1 === 3) ok(`rige el de la sucursal (3) sobre el del NIT (${e1.topeDelNit ?? "sin tope"})`);
  else mal(`rige ${rige1}, esperaba 3`);

  if (excedeTope(5, rige1)) ok("una subida del 5 % se bloquea contra el tope de la sucursal");
  else mal("una subida del 5 % NO se bloquea");

  /* ── 2. El CERO, que es donde se rompe ──────────────────────────────────── */
  await patch(cuenta.id, 0);
  const e2 = await leer(cuenta.id);
  const rige2 = topeDe(e2.cuenta, e2.proveedor);

  if (e2.crudo.porcentaje_max === 0) ok("un 0 se guarda como 0, no como NULL");
  else mal(`un 0 quedó guardado como ${e2.crudo.porcentaje_max}`);

  /* Éste es EL caso. Si el 0 se leyera como ausencia, la resolución devolvería el
     del NIT —que en Altipal es "sin tope"— y una sucursal congelada a propósito
     pasaría a aceptar cualquier aumento. Silenciosamente. */
  if (rige2 === 0) ok("el 0 resuelve como tope real, no como ausencia");
  else mal(`el 0 resolvió como ${rige2}: se está leyendo como 'sin tope'`);

  if (excedeTope(0.01, rige2)) ok("con tope 0, una subida de 0,01 % se bloquea");
  else mal("con tope 0, una subida de 0,01 % PASA");

  /* ── 3. Volver a heredar ────────────────────────────────────────────────── */
  await patch(cuenta.id, null);
  const e3 = await leer(cuenta.id);
  const rige3 = topeDe(e3.cuenta, e3.proveedor);

  if (e3.crudo.porcentaje_max === null) ok("un null borra el tope propio");
  else mal(`un null dejó ${e3.crudo.porcentaje_max}`);

  if (rige3 === e3.topeDelNit) ok(`vuelve a heredar del NIT (${e3.topeDelNit ?? "sin tope"})`);
  else mal(`rige ${rige3}, esperaba heredar ${e3.topeDelNit}`);

  /* ── 4. La auditoría guardó el ANTES ────────────────────────────────────── */
  const { data: auditoria } = await supabase
    .from("pp_auditoria")
    .select("accion, detalle, creado_at")
    .eq("entidad", "pp_cuentas")
    .eq("entidad_id", String(cuenta.id))
    .order("creado_at", { ascending: false })
    .limit(3);

  if (auditoria?.length === 3) ok("quedaron los 3 cambios en la auditoría");
  else mal(`en la auditoría hay ${auditoria?.length ?? 0} filas de las 3 esperadas`);

  /* Sin el valor anterior, la auditoría dice qué quedó pero no qué se cambió — y
     después de un aumento raro, la segunda pregunta es siempre "¿qué había antes?". */
  const ultimo = auditoria?.[0];
  if (ultimo && ultimo.detalle?.antes === 0 && ultimo.detalle?.despues === null) {
    ok("el último registro guarda antes=0 y después=null");
  } else {
    mal(`el último registro dice antes=${ultimo?.detalle?.antes}, después=${ultimo?.detalle?.despues}`);
  }
} finally {
  /* Pase lo que pase, la cuenta vuelve como estaba. Un script de verificación que
     deja un tope puesto es peor que no correrlo: nadie sabría de dónde salió. */
  await supabase.from("pp_cuentas").update({ porcentaje_max: original }).eq("id", cuenta.id);
  const { data: final } = await supabase
    .from("pp_cuentas")
    .select("porcentaje_max")
    .eq("id", cuenta.id)
    .single();

  if (final.porcentaje_max === original) {
    console.log(`\n  ↩ la cuenta quedó como estaba (${original ?? "NULL"})`);
  } else {
    console.log(`\n  ⚠️ NO SE PUDO REVERTIR. Quedó en ${final.porcentaje_max}, era ${original ?? "NULL"}`);
    console.log(`     UPDATE pp_cuentas SET porcentaje_max = ${original ?? "NULL"} WHERE id = ${cuenta.id};`);
    fallos++;
  }
}

console.log(
  fallos === 0
    ? "\n✓ El camino completo funciona: guardar → resolver → bloquear → auditar.\n"
    : `\n✗ ${fallos} ${fallos === 1 ? "problema" : "problemas"}.\n`,
);
process.exit(fallos === 0 ? 0 : 1);
