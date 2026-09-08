/* =============================================================================
   Verificación de la migración 009 — el tope por sucursal

   POR QUÉ EXISTE
   Un `ALTER TABLE` que corre sin error no dice que la columna esté visible para
   la API, ni que el CHECK esté puesto, ni que `topeDe()` resuelva lo que la
   pantalla promete. Esto lo comprueba contra los datos reales.

   QUÉ ESCRIBE
   Casi nada, y NUNCA un tope de NIT. La única escritura posible es la sonda del
   punto 2: intenta guardar un `-1` en UNA cuenta para comprobar que el CHECK lo
   rechaza. Si el CHECK está —que es lo que se espera— la base rechaza el UPDATE y
   NO SE ESCRIBE NADA. Si llegara a pasar, el script lo devuelve al valor anterior
   en el acto y avisa a los gritos: significaría que el tope negativo es posible.

   USO
     node scripts/verificar-009.js
   ============================================================================= */

import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import { topeDe, excedeTope } from "../src/services/costoNeto.js";

const linea = (t) => console.log(t);
const ok = (t) => console.log(`  ✓ ${t}`);
const mal = (t) => console.log(`  ✗ ${t}`);
const nota = (t) => console.log(`    ${t}`);

let fallas = 0;
const fallar = (t) => {
  fallas += 1;
  mal(t);
};

/* ── 1. ¿La columna existe y la ve la API? ──────────────────────────────────── */
linea("\n── 1 · la columna ───────────────────────────────────────────────────");

const { data: muestra, error: errorColumna } = await supabase
  .from("pp_cuentas")
  .select("id, nit, sucursal, porcentaje_max")
  .limit(1);

if (errorColumna) {
  fallar(`pp_cuentas.porcentaje_max no se puede leer: ${errorColumna.message}`);
  /* PostgREST CACHEA EL ESQUEMA. Ya nos pasó con la 008: la tabla estaba borrada y
     la API siguió respondiendo como si existiera durante varias corridas. Acá el
     problema es el espejo — la columna puede existir y la API todavía no verla. */
  nota("Si la migración ya corrió, puede ser el caché del esquema. En el SQL editor:");
  nota("  NOTIFY pgrst, 'reload schema';");
  nota("…y volvé a correr esto.");
} else {
  ok("pp_cuentas.porcentaje_max existe y la API la ve");
  if (!muestra?.length) nota("(la tabla está vacía, no hay cuentas que mirar)");
}

/* ── 2. El CHECK: un tope negativo no puede entrar ──────────────────────────── */
linea("\n── 2 · el CHECK (pp_cuentas_pct_valido) ─────────────────────────────");

if (errorColumna) {
  nota("se saltea: sin columna legible no hay nada que probar");
} else if (!muestra?.length) {
  nota("se saltea: no hay ninguna cuenta sobre la cual probar");
} else {
  const cobayo = muestra[0];
  const antes = cobayo.porcentaje_max;

  const { error: errorSonda } = await supabase
    .from("pp_cuentas")
    .update({ porcentaje_max: -1 })
    .eq("id", cobayo.id);

  if (errorSonda) {
    ok(`el CHECK rechaza un tope negativo (${errorSonda.code ?? "sin código"})`);
    nota("no se escribió nada: el UPDATE fue rechazado por la base");
  } else {
    fallar("¡EL CHECK NO ESTÁ! La base aceptó un tope de -1 %");
    const { error: errorVuelta } = await supabase
      .from("pp_cuentas")
      .update({ porcentaje_max: antes })
      .eq("id", cobayo.id);
    if (errorVuelta) {
      fallar(`Y NO SE PUDO REVERTIR la cuenta ${cobayo.id}: ${errorVuelta.message}`);
      nota(`Corregila a mano: UPDATE pp_cuentas SET porcentaje_max = ${antes ?? "NULL"} WHERE id = ${cobayo.id};`);
    } else {
      nota(`la cuenta ${cobayo.id} quedó como estaba (${antes ?? "NULL"})`);
    }
    nota("Volvé a correr el bloque del CHECK de sql/009_tope_por_sucursal.sql");
  }
}

/* ── 3. El estado real: quién tiene tope y de dónde ─────────────────────────── */
linea("\n── 3 · los datos ────────────────────────────────────────────────────");

const { data: proveedores, error: errorProv } = await supabase
  .from("pp_proveedores")
  .select("nit, razon_social, porcentaje_max");

const { data: cuentas, error: errorCuentas } = await supabase
  .from("pp_cuentas")
  .select("id, nit, sucursal, nombre_sucursal, porcentaje_max");

if (errorProv || errorCuentas) {
  fallar(`no se pudo leer el maestro: ${(errorProv ?? errorCuentas).message}`);
} else {
  /* Guarda contra la trampa en la que ya caí tres veces: un `.filter()` sobre un
     arreglo vacío devuelve 0 y el informe queda lleno de ceros tranquilizadores
     que en realidad significan "no leí nada". */
  if (!proveedores.length || !cuentas.length) {
    fallar(`ALARMA: leí ${proveedores.length} proveedores y ${cuentas.length} cuentas`);
    nota("con cero filas, todo lo que sigue diría 'está bien' sin haber mirado nada");
  } else {
    const porNit = new Map(proveedores.map((p) => [p.nit, p]));

    const conTopeNit = proveedores.filter((p) => p.porcentaje_max != null);
    const conTopePropio = cuentas.filter((c) => c.porcentaje_max != null);

    ok(`${proveedores.length} proveedores · ${cuentas.length} cuentas`);
    linea(`  · NITs con tope: ${conTopeNit.length}`);
    linea(`  · sucursales con tope PROPIO: ${conTopePropio.length}`);

    if (!conTopePropio.length) {
      nota("Ninguna todavía: es lo esperado recién migrado. Todas heredan el del NIT,");
      nota("así que la 009 no le cambió el comportamiento a nadie.");
    }

    /* Dónde el tope por sucursal cambia algo de verdad: NITs con más de una. */
    const sucursalesPorNit = new Map();
    for (const c of cuentas) {
      sucursalesPorNit.set(c.nit, (sucursalesPorNit.get(c.nit) ?? 0) + 1);
    }
    const multiples = [...sucursalesPorNit.entries()]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1]);

    linea(`  · NITs con más de una sucursal: ${multiples.length}`);
    for (const [nit, n] of multiples.slice(0, 5)) {
      const p = porNit.get(nit);
      linea(
        `      ${nit} · ${n} sucursales · tope del NIT: ${p?.porcentaje_max ?? "sin tope"} · ${p?.razon_social ?? "?"}`,
      );
    }
    if (multiples.length > 5) nota(`… y ${multiples.length - 5} más`);
  }
}

/* ── 4. `topeDe()` resuelve lo que la pantalla promete ──────────────────────── */
linea("\n── 4 · la resolución ────────────────────────────────────────────────");

/* Casos armados a mano. Es la regla que el front repite en su propio `topeDe()`,
   y si se separan, la pantalla promete un máximo y el servidor aplica otro.

   El cuarto argumento es `hayTopesPropios`: si alguna HERMANA del NIT ya tiene
   tope propio. De él depende que el vacío de una sucursal signifique "heredá el
   del NIT" o "sin tope" — regla de Merkahorro del 2026-09-08. */
const casos = [
  ["la sucursal manda sobre el NIT", { porcentajeMax: 3 }, { porcentajeMax: 8 }, false, 3],
  ["sin hermanas configuradas, hereda", { porcentajeMax: null }, { porcentajeMax: 8 }, false, 8],
  ["con una hermana configurada, NO hereda", { porcentajeMax: null }, { porcentajeMax: 8 }, true, null],
  ["la hermana configurada conserva el suyo", { porcentajeMax: 3 }, { porcentajeMax: 8 }, true, 3],
  ["un CERO es un tope real", { porcentajeMax: 0 }, { porcentajeMax: 8 }, false, 0],
  ["…y sobrevive aunque el NIT ya no rija", { porcentajeMax: 0 }, { porcentajeMax: 8 }, true, 0],
  ["si el NIT tampoco tiene, no hay", { porcentajeMax: null }, { porcentajeMax: null }, false, null],
];

for (const [nombre, cuenta, proveedor, hayTopesPropios, esperado] of casos) {
  const dio = topeDe(cuenta, proveedor, { hayTopesPropios });
  if (dio === esperado) ok(`${nombre} → ${dio ?? "sin tope"}`);
  else fallar(`${nombre}: esperaba ${esperado ?? "sin tope"}, dio ${dio ?? "sin tope"}`);
}

/* El cero tiene que BLOQUEAR, no desaparecer. Si `topeDe` devolviera null por un
   cero, esto pasaría de "ninguna subida" a "sin tope" sin que nadie lo note. */
if (excedeTope(0.5, topeDe({ porcentajeMax: 0 }, { porcentajeMax: 8 }))) {
  ok("con tope 0, una subida de 0,5 % se bloquea");
} else {
  fallar("con tope 0, una subida de 0,5 % PASA — el cero se está leyendo como 'sin tope'");
}

/* Y una BAJA pasa siempre, incluso con tope 0: nos favorece. */
if (!excedeTope(-2, 0)) ok("una baja pasa aunque el tope sea 0");
else fallar("una baja se está bloqueando");

/* ── Cierre ─────────────────────────────────────────────────────────────────── */
linea("\n─────────────────────────────────────────────────────────────────────");
if (fallas === 0) {
  linea("✓ La 009 está aplicada y resolviendo bien.");
  linea("  Los topes por sucursal se ponen desde el panel: Maestro → proveedor → Sucursales.");
} else {
  linea(`✗ ${fallas} ${fallas === 1 ? "problema" : "problemas"}. Ver arriba.`);
}
linea("");
process.exit(fallas === 0 ? 0 : 1);
