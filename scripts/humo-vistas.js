/* =============================================================================
   Prueba de humo de "dar por visto un aviso" (migración 010)

   POR QUÉ EXISTE
   Es una escritura NUEVA en la superficie del proveedor, y lo que hay que probar
   no es que funcione —eso es una línea— sino que NO ALCANCE lo ajeno. El servicio
   escribe con la service key, que pasa por encima de RLS: si los filtros de
   `marcarVistas` estuvieran mal, un id adivinado marcaría la línea de otra
   sucursal. Eso no se ve en un test unitario con mocks.

   QUÉ COMPRUEBA
     1. Marca las propias, y `visto_at` queda escrito
     2. No re-marca lo ya visto: la fecha original no se pisa
     3. Una cuenta NO alcanza la línea de otra  ← el caso que importa
     4. NO marca las de OTRA cuenta, si existen
     5. NO marca las RÉPLICAS, si existen
     6. NO marca las PENDIENTES, si existen

   Los casos 4 a 6 dependen de que la base TENGA esas filas. Cuando no las hay se
   dicen como salteados y NO se dan por buenos — y los mismos filtros están
   cubiertos siempre en `src/services/marcarVistas.test.js`, que no depende de
   los datos.

   ⚠️ ESCRIBE, y sobre datos reales. Solo toca `visto_at` —nunca un estado, nunca
   un precio— y devuelve cada línea a su valor anterior en un `finally`.

   USO
     node scripts/humo-vistas.js
   ============================================================================= */

import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import { marcarVistas } from "../src/services/solicitud.service.js";

let fallos = 0;
/* Casos que no se pudieron probar por falta de datos. NO son fallos, pero el
   cierre TIENE que nombrarlos: la primera versión cerraba con "no alcanza lo
   ajeno" habiendo salteado tres de los cuatro casos de aislamiento. */
const saltados = [];
const ok = (t) => console.log(`  ✓ ${t}`);
const mal = (t) => {
  console.log(`  ✗ ${t}`);
  fallos++;
};

const leer = async (ids) => {
  const { data } = await supabase
    .from("pp_solicitud_lineas")
    .select("id, cuenta_destino_id, origen, estado, visto_at")
    .in("id", ids);
  return new Map((data ?? []).map((l) => [l.id, l]));
};

/* Todo vive dentro de `main()` para que los cortes tempranos sean `return` de
   verdad. Con `process.exit()` el proceso se corta con handles abiertos de
   Supabase y libuv escupe un assert en Windows; con `process.exitCode` suelto,
   la ejecución SEGUÍA y reventaba más abajo con un error que no era el real. */
async function main() {
  console.log("\n── dar por visto · humo ─────────────────────────────────────────────");

  /* La columna primero: sin ella todo lo demás falla con un mensaje que no
     explica nada. PostgREST cachea el esquema, así que un error acá puede ser eso. */
  const { error: errorColumna } = await supabase
    .from("pp_solicitud_lineas")
    .select("id, visto_at")
    .limit(1);

  if (errorColumna) {
    console.error(`\n⛔ pp_solicitud_lineas.visto_at no se puede leer: ${errorColumna.message}`);
    console.error("   ¿Corriste sql/010_linea_vista.sql? Si ya la corriste, puede ser el caché:");
    console.error("   NOTIFY pgrst, 'reload schema';\n");
    return 1;
  }
  ok("la columna visto_at existe y la API la ve");

  const { data: candidatas } = await supabase
    .from("pp_solicitud_lineas")
    .select("id, cuenta_destino_id, origen, estado, visto_at")
    .limit(500);

  if (!candidatas?.length) {
    console.log("\n  (no hay ninguna línea en la base todavía: nada que probar)\n");
    return 0;
  }

  /* Se elige una línea RESUELTA y propia como cobayo, y como "ajena" cualquiera
     de otra cuenta. Si no hay de alguna clase, ese caso se saltea DICIÉNDOLO —
     dar por bueno un caso que no se probó es peor que no probarlo. */
  const propia = candidatas.find((l) => l.origen === "proveedor" && l.estado !== "pendiente");
  if (!propia) {
    console.log("\n  (no hay ninguna línea resuelta del proveedor: nada que marcar)\n");
    return 0;
  }

  const cuenta = { id: propia.cuenta_destino_id };
  const ajena = candidatas.find((l) => l.cuenta_destino_id !== cuenta.id);
  const replica = candidatas.find((l) => l.origen === "replica" && l.cuenta_destino_id === cuenta.id);
  const pendiente = candidatas.find(
  (l) => l.estado === "pendiente" && l.cuenta_destino_id === cuenta.id && l.origen === "proveedor",
  );

  const tocadas = [propia, ajena, replica, pendiente].filter(Boolean);
  const antes = new Map(tocadas.map((l) => [l.id, l.visto_at]));
  console.log(`  cuenta ${cuenta.id} · cobayo: línea ${propia.id} (${propia.estado})`);

  try {
  /* ── 1. La propia ───────────────────────────────────────────────────────── */
  const r1 = await marcarVistas({ lineaIds: [propia.id], cuenta });
  if (r1.vistas === 1) ok("marcó la línea propia");
  else mal(`marcó ${r1.vistas} en vez de 1`);

  const e1 = await leer([propia.id]);
  if (e1.get(propia.id)?.visto_at) ok("visto_at quedó escrito");
  else mal("visto_at siguió en null");

  /* ── 2. No se pisa la fecha ─────────────────────────────────────────────── */
  const marcaOriginal = e1.get(propia.id).visto_at;
  const r2 = await marcarVistas({ lineaIds: [propia.id], cuenta });
  const e2 = await leer([propia.id]);
  if (r2.vistas === 0) ok("marcar dos veces no vuelve a contar");
  else mal(`la segunda vez contó ${r2.vistas}`);
  if (e2.get(propia.id).visto_at === marcaOriginal) {
    ok("la fecha original no se pisó");
  } else {
    mal("la fecha se corrió: se perdió cuándo lo leyó de verdad");
  }

  /* ── 3. LA CUENTA AJENA, al revés ────────────────────────────────────────
     No hace falta que exista una línea de otra sucursal: alcanza con pedir LA
     MISMA línea desde OTRA cuenta. Prueba el mismo filtro y funciona siempre,
     con los datos que haya. Antes este caso dependía de encontrar una fila
     ajena, y sin ella el script decía "no se pudo probar" — y cerraba igual
     diciendo "no alcanza lo ajeno". */
  const intruso = { id: cuenta.id + 1000 };
  const rIntruso = await marcarVistas({ lineaIds: [propia.id], cuenta: intruso });
  const eIntruso = await leer([propia.id]);
  if (rIntruso.vistas === 0 && eIntruso.get(propia.id).visto_at === marcaOriginal) {
    ok(`la cuenta ${intruso.id} NO pudo tocar la línea de la cuenta ${cuenta.id}`);
  } else {
    mal(`¡LA CUENTA ${intruso.id} ESCRIBIÓ SOBRE UNA LÍNEA AJENA! Revisar marcarVistas`);
  }

  /* ── 4. Una línea ajena de verdad, si la hay ────────────────────────────── */
  if (ajena) {
    const r3 = await marcarVistas({ lineaIds: [ajena.id], cuenta });
    const e3 = await leer([ajena.id]);
    if (r3.vistas === 0 && e3.get(ajena.id).visto_at === antes.get(ajena.id)) {
      ok(`NO tocó la línea ${ajena.id} de la cuenta ${ajena.cuenta_destino_id}`);
    } else {
      mal(`¡ESCRIBIÓ SOBRE LA CUENTA ${ajena.cuenta_destino_id}! Revisar los filtros de marcarVistas`);
    }
  } else {
    saltados.push("una línea de OTRA cuenta");
  }

  /* ── 5. La réplica ──────────────────────────────────────────────────────── */
  if (replica) {
    const r4 = await marcarVistas({ lineaIds: [replica.id], cuenta });
    if (r4.vistas === 0) ok("NO tocó una réplica (el proveedor no sabe que existe)");
    else mal("marcó una réplica: el proveedor no debería poder ni nombrarla");
  } else {
    saltados.push("una RÉPLICA");
  }

  /* ── 6. La pendiente ────────────────────────────────────────────────────── */
  if (pendiente) {
    const r5 = await marcarVistas({ lineaIds: [pendiente.id], cuenta });
    if (r5.vistas === 0) ok("NO apagó una pendiente: todavía espera respuesta");
    else mal("apagó una pendiente: le escondería lo único que está esperando ver");
  } else {
    saltados.push("una PENDIENTE");
  }
  } finally {
  for (const l of tocadas) {
    await supabase
      .from("pp_solicitud_lineas")
      .update({ visto_at: antes.get(l.id) ?? null })
      .eq("id", l.id);
  }
  const final = await leer(tocadas.map((l) => l.id));
  const mal_revertidas = tocadas.filter((l) => (final.get(l.id)?.visto_at ?? null) !== (antes.get(l.id) ?? null));
  if (!mal_revertidas.length) {
    console.log(
      tocadas.length === 1
        ? `\n  ↩ la línea ${tocadas[0].id} quedó como estaba`
        : `\n  ↩ las ${tocadas.length} líneas quedaron como estaban`,
    );
  } else {
    console.log(`\n  ⚠️ NO SE REVIRTIERON: ${mal_revertidas.map((l) => l.id).join(", ")}`);
    console.log(`     UPDATE pp_solicitud_lineas SET visto_at = NULL WHERE id IN (${mal_revertidas.map((l) => l.id).join(", ")});`);
    fallos++;
  }
  }
  return fallos;
}

const fallas = await main();
if (fallas > 0) {
  console.log(`\n✗ ${fallas} ${fallas === 1 ? "problema" : "problemas"}.\n`);
} else {
  console.log("\n✓ Apagar un aviso funciona, y una cuenta no alcanza la línea de otra.");

  /* EL CIERRE NO PUEDE PROMETER MÁS DE LO QUE MIRÓ.
     La primera versión decía "no alcanza lo ajeno" habiendo salteado tres de los
     cuatro casos de aislamiento por falta de datos. Un resumen que da por bueno
     lo que no probó es peor que no correr el script: deja tranquilo. */
  if (saltados.length) {
    console.log(`\n  ⚠ Sin datos para probar contra la base: ${saltados.join(", ")}.`);
    console.log("    Esos filtros SÍ están cubiertos por src/services/marcarVistas.test.js,");
    console.log("    que no depende de que la base tenga la fila justa:");
    console.log("      node --test src/services/marcarVistas.test.js");
  }
  console.log("");
}
process.exitCode = fallas === 0 ? 0 : 1;
