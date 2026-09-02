/* =============================================================================
   Banco de pruebas del conector — descuentos, unidades de medida e impuestos

   POR QUÉ EXISTE
   QA confirmó el 2026-09-02 que la solicitud #5 sí quedó escrita, y pidió probar
   además los DESCUENTOS y las UNIDADES DE MEDIDA distintas. Este script arma esos
   casos con datos reales del catálogo y los manda a QA.

   ⚠️ PASA POR EL CÓDIGO DE PRODUCCIÓN, a propósito.
   `diagnostico-siesa.js` arma el payload a mano, y eso ya costó un diagnóstico
   equivocado (PENDIENTES §5.7): se concluyó que faltaba una validación que sí
   existía, porque el script se saltaba la capa que la hacía. Acá se llama a
   `importarCotizacion()` igual que lo hace `solicitud.service.js`, así que lo que
   se prueba es el sistema y no una imitación.

   USO
     node scripts/pruebas-siesa-qa.js              # SANDBOX: arma y muestra, no escribe
     node scripts/pruebas-siesa-qa.js --real       # manda a SIESA de verdad
     node scripts/pruebas-siesa-qa.js --caso B     # un solo caso

   Empezá SIN `--real`: el sandbox corta justo antes del POST y después de armar
   el payload, así se revisa lo que se iba a mandar. Los bugs de este módulo son
   de formato y de re-emisión, y todos viven en el armado.

   LA FECHA
   Todos los casos activan en la misma fecha futura para que QA los encuentre
   juntos. Cambiala con `--fecha 2026-10-15`.
   ============================================================================= */

import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import { importarCotizacion, armarPayload } from "../src/services/siesaCotizacion.js";

const args = process.argv.slice(2);
const REAL = args.includes("--real");

/* `indexOf` devuelve -1 cuando la bandera no está, y `args[-1 + 1]` es `args[0]`:
   sin bandera, `--caso` se quedaba con el PRIMER argumento. Corriendo
   `--real` a secas, el filtro buscaba un caso llamado "--REAL", no encontraba
   ninguno y el script terminaba sin correr nada — con un resumen vacío que
   parecía un resultado. */
const valorDe = (bandera, porDefecto) => {
  const i = args.indexOf(bandera);
  return i === -1 ? porDefecto : args[i + 1];
};

const soloCaso = valorDe("--caso", null);
const FECHA = valorDe("--fecha", "2026-10-15");

const NIT = "800186960"; // ALTIPAL SAS
const SUC = "006"; // ALTIPAL CATALOGO GENERAL — la cuenta de prueba

/* -----------------------------------------------------------------------------
   Los casos.

   Cada uno nombra QUÉ prueba y QUÉ tiene que verse en SIESA después. Esa segunda
   parte es la que convierte "mandamos algo" en "verificamos algo": sin decir
   antes qué se espera, cualquier resultado parece bien.

   `item` + `um` identifican la cotización vigente real del catálogo. La propuesta
   se arma sobre ella.
   --------------------------------------------------------------------------- */
const CASOS = [
  {
    id: "A",
    titulo: "Descuento que BAJA — el precio no cambia y el costo neto SUBE",
    item: 9659,
    um: "UND",
    descripcion: "ATUN ISABEL ACEITE DE GIRASOL X160G · hoy 3 % de descuento",
    propuesta: (v) => ({
      precio: v.precio, // idéntico
      descuentos: [{ orden: 1, porcentaje: 1 }], // 3 % → 1 %
    }),
    esperado:
      "Una fila con el MISMO precio y el descuento de orden 1 en 1 %. " +
      "Merkahorro paga MÁS que antes sin que el precio se haya movido: por eso el " +
      "tope del portal se evalúa sobre el costo neto y no sobre el precio.",
  },
  {
    id: "B",
    titulo: "Descuento que se QUITA — se representa por AUSENCIA, no por 0 %",
    item: 9659,
    um: "P3",
    descripcion: "El mismo atún, pero en la presentación P3",
    propuesta: (v) => ({
      precio: v.precio,
      descuentos: [], // se quita el 3 %
    }),
    esperado:
      "Una fila SIN ninguna línea de descuento para esa fecha. NO una línea en 0 %. " +
      "Como la fecha es parte de la llave, no mandar el orden significa que ese " +
      "orden no existe en la fecha nueva.",
  },
  {
    id: "C",
    titulo: "DOS órdenes de descuento en cascada",
    item: 1032,
    um: "UND",
    descripcion: "ATUN ALAMAR ENSALADA NATURAL · hoy sin descuentos",
    // El precio se REDONDEA a 2 decimales a propósito: el vigente es 4891.275 y
    // el conector lo rechaza (ver caso H). Sin esto, C moría por los decimales
    // antes de llegar a probar lo que vino a probar.
    propuesta: (v) => ({
      precio: Math.round(v.precio * 100) / 100,
      descuentos: [
        { orden: 1, porcentaje: 4 },
        { orden: 2, porcentaje: 15 },
      ],
    }),
    esperado:
      "DOS filas de descuento, órdenes 1 y 2, con 4 % y 15 %. Verificar que SIESA " +
      "los aplica en cascada (4 % y después 15 % sobre el resultado), que es como " +
      "los calcula el portal.",
  },
  {
    id: "H",
    titulo: "El precio VIGENTE de SIESA con 3 decimales — ¿lo acepta de vuelta?",
    item: 1032,
    um: "UND",
    descripcion: "El precio vigente es 4891.275, tal cual lo devuelve SIESA",
    propuesta: (v) => ({
      precio: v.precio, // SIN redondear: el valor exacto que SIESA nos dio
      descuentos: [],
    }),
    esperado:
      "Se ESPERA UN RECHAZO: 'el precio no cumple con los decimales unitarios de " +
      "la moneda'. SIESA almacena precios con más decimales de los que su propio " +
      "conector acepta al escribir. 218 cotizaciones del catálogo (1,2 %, 36 " +
      "proveedores) están en esa situación — todas nacidas de dividir el precio de " +
      "una presentación. Si este caso PASA, el límite cambió y hay que revisar la " +
      "validación del portal.",
    esperaFallo: true,
  },
  {
    id: "D",
    titulo: "Unidad de medida distinta de UND",
    item: 1032,
    um: "P2",
    descripcion: "El mismo atún en presentación P2 — precio ~2× el de UND",
    propuesta: (v) => ({
      precio: Math.round(v.precio * 1.05 * 100) / 100,
      descuentos: [],
    }),
    esperado:
      "Una fila con U.M. = P2 y el precio nuevo. NO tiene que tocar la línea de UND " +
      "del mismo ítem: cada unidad de medida lleva su propia línea de tiempo de precios.",
  },
  {
    id: "E",
    titulo: "El MISMO ítem, la otra U.M. — no se pisan entre sí",
    item: 1032,
    um: "UND",
    descripcion: "Se manda junto con el caso D. Mismo ítem, otra presentación",
    propuesta: (v) => ({
      precio: Math.round(v.precio * 1.02 * 100) / 100,
      descuentos: [],
    }),
    esperado:
      "Después de D y E, el ítem 1032 tiene DOS filas nuevas en la misma fecha: " +
      "una en P2 y otra en UND, con precios distintos. Si aparece una sola, la U.M. " +
      "no está entrando en la llave y un cambio pisa al otro.",
  },
  {
    id: "F",
    titulo: "El impuesto se RE-EMITE con la fecha nueva",
    item: 2092,
    um: "UND",
    descripcion: "VINO CARIÑOSO MANZANA X 750 ML · ICO 4.313",
    propuesta: (v) => ({
      precio: Math.round(v.precio * 1.03 * 100) / 100,
      descuentos: [],
    }),
    esperado:
      "La fila nueva tiene que llevar su ICO de 4.313. Si el precio queda SIN el " +
      "ICO, el ítem perdió su impuesto en la fecha nueva — es el bug que ya le " +
      "costó un ICO de $5.102 al FOUR LOKO. El proveedor NO edita impuestos: se " +
      "re-emiten tal cual los de la cotización vigente.",
  },
  {
    id: "G",
    titulo: "Sin impuestos ni descuentos — las secciones vacías se OMITEN",
    item: 10765,
    um: "UND",
    descripcion: "BOCADOS ALAMAR EN ACEITE · sin impuestos ni descuentos",
    propuesta: (v) => ({
      precio: Math.round(v.precio * 1.04 * 100) / 100,
      descuentos: [],
    }),
    esperado:
      "El payload NO lleva las claves 'Impuestos en Valor' ni 'Descuentos'. " +
      "Mandarlas vacías (`[]`) hace que el conector devuelva 400.",
  },

  /* ── I y J: el múltiplo exacto entre presentaciones ─────────────────────────

     QA reportó el 2026-09-02: si al UND se le pone 4.000 y al P2 8.000, SIESA
     saca error *"el precio es exactamente igual"*; con una equivalencia que no
     dé el múltiplo exacto —como el montaje de los casos D y E— entra bien.

     La U.M. codifica el factor: `P2` son 2 unidades, `P4` son 4, `P6` son 6.
     Medido sobre el catálogo: **321 pares (UND ↔ PN) tienen hoy ratio entero
     exacto** y 324 no. La mitad del catálogo multi-presentación está ahí.

     Y ahí está la contradicción que hay que resolver ANTES de validar nada: si
     SIESA rechazara el múltiplo exacto, esos 321 pares no podrían existir — y
     existen, almacenados hoy. Lo más probable es que el rechazo aparezca solo al
     subir los DOS renglones en el mismo plano, y el portal manda UNO por
     solicitud (`armarPayload` arma un solo encabezado).

     Estos dos casos lo miden en vez de suponerlo. Correr I y después J, con la
     MISMA fecha. Si J entra, el portal no está afectado.
     ───────────────────────────────────────────────────────────────────────── */
  {
    id: "I",
    titulo: "Múltiplo exacto (1 de 2) — el UND en un número redondo",
    item: 1032,
    um: "UND",
    descripcion: "ATUN ALAMAR · se fija el unitario en 4.000",
    propuesta: () => ({ precio: 4000, descuentos: [] }),
    esperado:
      "Entra sin problema. Por sí solo no tiene nada de raro: es el primero de un " +
      "par, y lo que se mide es qué pasa con J.",
  },
  {
    id: "J",
    titulo: "Múltiplo exacto (2 de 2) — el P2 en exactamente el doble",
    item: 1032,
    um: "P2",
    descripcion: "El mismo atún en P2, a 8.000 = 2 × 4.000",
    propuesta: () => ({ precio: 8000, descuentos: [] }),
    esperado:
      "LA PREGUNTA. Si ENTRA, el rechazo que vio QA solo ocurre subiendo los dos " +
      "renglones en el mismo plano, y el portal —que manda uno por solicitud— no " +
      "está afectado: no hay nada que validar. Si lo RECHAZA, anotar el mensaje " +
      "EXACTO: es lo que hay que detectar antes de que el proveedor firme.",
  },
];

/* ---------------------------------------------------------------------------- */

const arr = (v) => (Array.isArray(v) ? v : []);

async function vigenteDe(item, um) {
  const { data, error } = await supabase
    .from("pp_cotizaciones")
    .select("*")
    .eq("nit", NIT)
    .eq("sucursal", SUC)
    .eq("item", item)
    .eq("unidad_medida", um)
    .order("fecha_activacion", { ascending: false });

  if (error) throw new Error(error.message);
  if (!data?.length) return null;

  // La que rige HOY: la fecha más alta que no sea futura. Si todas son futuras
  // —producto cargado solo a futuro— se toma la más cercana.
  const hoy = new Date().toISOString().slice(0, 10);
  return data.find((c) => c.fecha_activacion <= hoy) ?? data[data.length - 1];
}

function aVigente(fila) {
  return {
    claveItem: fila.clave_item,
    idTercero: fila.id_tercero,
    nit: fila.nit,
    sucursal: fila.sucursal,
    item: fila.item,
    unidadMedida: fila.unidad_medida,
    precio: Number(fila.precio),
    moneda: fila.moneda,
    impuestos: arr(fila.impuestos),
    descuentos: arr(fila.descuentos),
    fechaActivacion: fila.fecha_activacion,
  };
}

const money = (n) => Number(n).toLocaleString("es-CO", { maximumFractionDigits: 2 });

function costoNeto(precio, descuentos) {
  return arr(descuentos)
    .sort((a, b) => a.orden - b.orden)
    .reduce((acc, d) => acc * (1 - Number(d.porcentaje) / 100), Number(precio));
}

async function correr(caso) {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`CASO ${caso.id} · ${caso.titulo}`);
  console.log(`${"═".repeat(78)}`);
  console.log(`  ${caso.descripcion}`);

  const fila = await vigenteDe(caso.item, caso.um);
  if (!fila) {
    console.log(`  ❌ No hay cotización vigente para ${caso.item} / ${caso.um} en ${NIT}-${SUC}`);
    return { id: caso.id, ok: false, motivo: "sin cotización vigente" };
  }

  const vigente = aVigente(fila);
  const p = caso.propuesta(vigente);
  const propuesta = {
    claveItem: vigente.claveItem,
    precio: p.precio,
    descuentos: p.descuentos,
    fechaActivacion: FECHA,
    notas: `Prueba QA caso ${caso.id}`,
  };

  const netoAntes = costoNeto(vigente.precio, vigente.descuentos);
  const netoDespues = costoNeto(propuesta.precio, propuesta.descuentos);
  const variacion = ((netoDespues / netoAntes - 1) * 100).toFixed(2);

  console.log(`\n  VIGENTE   precio ${money(vigente.precio)} · dsctos ${JSON.stringify(vigente.descuentos)} · imptos ${JSON.stringify(vigente.impuestos)}`);
  console.log(`  PROPUESTA precio ${money(propuesta.precio)} · dsctos ${JSON.stringify(propuesta.descuentos)}`);
  console.log(`  COSTO NETO ${money(netoAntes)} → ${money(netoDespues)}  (${variacion > 0 ? "+" : ""}${variacion} %)`);
  console.log(`\n  QUÉ TIENE QUE VERSE EN SIESA:\n    ${caso.esperado.replace(/\. /g, ".\n    ")}`);

  // El payload se arma SIEMPRE, aunque no se mande: es donde viven los bugs.
  let payload;
  try {
    payload = armarPayload({ vigente, propuesta });
  } catch (e) {
    console.log(`\n  ❌ El armado LANZÓ antes del POST: ${e.message}`);
    return { id: caso.id, ok: false, motivo: `armado: ${e.message}` };
  }

  const secciones = Object.keys(payload);
  console.log(`\n  Secciones del payload: ${secciones.join(", ")}`);
  console.dir(payload, { depth: null });

  if (!REAL) {
    console.log("\n  🧪 SANDBOX — no se mandó. Correr con --real para escribir en QA.");
    return { id: caso.id, ok: true, enviado: false };
  }

  try {
    const r = await importarCotizacion({ solicitudId: `qa-${caso.id}`, vigente, propuesta });

    // `PROVEEDORES_SANDBOX=true` corta dentro de `importarCotizacion`, así que
    // `--real` puede terminar sin escribir nada. Decir "enviado" igual sería el
    // mismo reporte engañoso que este banco de pruebas existe para evitar: QA
    // saldría a buscar en el ERP unos registros que nunca salieron de acá.
    if (r?.sandbox) {
      console.log("\n  🧪 El BACKEND está en sandbox (PROVEEDORES_SANDBOX=true) — NO se escribió.");
      return { id: caso.id, ok: true, enviado: "no · backend en sandbox" };
    }

    if (caso.esperaFallo) {
      console.log(
        `\n  ⚠️ PASÓ, y se esperaba un rechazo · ${JSON.stringify(r?.respuesta ?? r)}\n` +
          "     El límite del conector cambió: revisar la validación del portal.",
      );
      return { id: caso.id, ok: false, enviado: "sí", motivo: "pasó y se esperaba rechazo" };
    }
    console.log(`\n  ✅ Enviado ·`, JSON.stringify(r?.respuesta ?? r));
    return { id: caso.id, ok: true, enviado: "sí" };
  } catch (e) {
    // Un caso que viene a documentar un límite del conector se cumple FALLANDO.
    // Marcarlo en rojo mezclaría "el conector se comporta como esperábamos" con
    // "algo se rompió", y en un resumen de siete líneas esa diferencia es todo.
    if (caso.esperaFallo) {
      console.log(`\n  ✅ Rechazado, como se esperaba · ${e.message}`);
      return { id: caso.id, ok: true, enviado: "rechazado (esperado)" };
    }
    console.log(
      `\n  ❌ Falló · enviadoASiesa=${e.enviadoASiesa} · ${e.message}`,
    );
    return { id: caso.id, ok: false, enviado: e.enviadoASiesa, motivo: e.message };
  }
}

const aCorrer = soloCaso ? CASOS.filter((c) => c.id === soloCaso.toUpperCase()) : CASOS;

/* Cero casos no es un resultado, es un error. Sin esto el script imprimía un
   resumen vacío y el mensaje final "para QA: buscar los ítems: " —con la lista
   en blanco— como si hubiera hecho algo. Un banco de pruebas que puede terminar
   en verde sin ejecutar nada es peor que no tenerlo. */
if (!aCorrer.length) {
  console.error(
    `\n❌ No hay ningún caso que correr.` +
      (soloCaso ? ` "--caso ${soloCaso}" no existe.` : "") +
      `\n   Casos disponibles: ${CASOS.map((c) => c.id).join(", ")}\n`,
  );
  process.exit(1);
}

console.log(`\nProveedor: ${NIT} sucursal ${SUC} · fecha de activación: ${FECHA}`);
console.log(REAL ? "MODO: REAL — escribe en SIESA\n" : "MODO: SANDBOX — no escribe\n");

const resultados = [];
for (const caso of aCorrer) resultados.push(await correr(caso));

console.log(`\n${"═".repeat(78)}\nRESUMEN\n${"═".repeat(78)}`);
console.table(resultados);

const escritos = resultados.filter((r) => r.enviado === "sí");

if (REAL && escritos.length) {
  console.log(
    `\n📋 Para QA: buscar en SIESA QA las cotizaciones del NIT ${NIT}, sucursal ${SUC},\n` +
      `   con FECHA DE ACTIVACIÓN ${FECHA.split("-").reverse().join("/")}.\n` +
      `   Ítems: ${[...new Set(aCorrer.map((c) => c.item))].join(", ")}.\n` +
      `   Casos escritos: ${escritos.map((r) => r.id).join(", ")}.\n` +
      `   El detalle de qué esperar en cada uno está arriba, caso por caso.\n`,
  );
} else if (REAL) {
  console.log(
    "\n⚠️ Se pidió --real pero NO se escribió nada en SIESA. Revisá el resumen:\n" +
      "   si dice 'backend en sandbox', apagá PROVEEDORES_SANDBOX y volvé a correr.\n",
  );
}

if (resultados.some((r) => !r.ok)) process.exitCode = 1;
