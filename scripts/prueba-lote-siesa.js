/* =============================================================================
   ¿Acepta el conector un plano con VARIOS encabezados?

   POR QUÉ EXISTE
   Con la migración 006 una solicitud pasó a ser un PAQUETE de productos. Al
   aprobarlo hay dos maneras de mandarlo al ERP:

     A) UN plano con N encabezados      → una transacción, un consecutivo
     B) N envíos de un encabezado c/u   → como hoy, en un bucle

   Johan (2026-09-06): "debemos hacerlo como lo acepte SIESA". Eso se MIDE.

   ⚠️ Y HAY UN RIESGO CONOCIDO, QUE ES LA MITAD DEL PUNTO
   QA reportó el 2026-09-02 que SIESA saca *"el precio es exactamente igual"* con
   dos presentaciones del mismo ítem en múltiplo exacto (UND 4.000 · P2 8.000).
   Se midió que NO afectaba al portal, y la razón era precisa: `armarPayload` arma
   **un encabezado por envío**. Agrupar reabre esa puerta.

   Por eso son DOS pruebas y no una:

     LOTE-1  tres ítems DISTINTOS en un plano   → ¿acepta el lote?
     LOTE-2  el MISMO ítem en dos U.M.          → ¿reaparece el rechazo?

   LOTE-1 puede pasar y LOTE-2 fallar. Ese resultado no dice "no agrupar": dice
   "agrupar sí, pero sin meter dos presentaciones del mismo ítem en el mismo plano".

   PASA POR EL CÓDIGO DE PRODUCCIÓN, a propósito. El payload de cada línea lo arma
   `armarPayload()` y la fusión la hace `fusionarPayloads()` — las dos del
   servicio. Armar el body a mano acá ya costó un diagnóstico equivocado una vez
   (PENDIENTES §5.7).

   USO
     node scripts/prueba-lote-siesa.js               # arma y MUESTRA. No manda nada.
     node scripts/prueba-lote-siesa.js --real        # manda a QA de verdad
     node scripts/prueba-lote-siesa.js --caso LOTE-2
     node scripts/prueba-lote-siesa.js --fecha 2026-11-20

   ADÓNDE ESCRIBE: a QA. `SIESA_COTIZACION_URL` no está en el .env y el default es
   `serviciosqa.siesacloud.com` — ausente a propósito (PENDIENTES §1.4). Si alguien
   la puso apuntando a producción, este script lo dice antes de mandar y aborta.
   ============================================================================= */

import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import {
  armarPayload,
  fusionarPayloads,
  postConectorCrudo,
} from "../src/services/siesaCotizacion.js";

const args = process.argv.slice(2);
const REAL = args.includes("--real");

const valorDe = (bandera, porDefecto) => {
  const i = args.indexOf(bandera);
  return i === -1 ? porDefecto : args[i + 1];
};

const soloCaso = valorDe("--caso", null);
const FECHA = valorDe("--fecha", "2026-11-18");

const NIT = "800186960"; // ALTIPAL SAS
const SUC = "006"; // ALTIPAL CATALOGO GENERAL — la cuenta de prueba

/* ---------------------------------------------------------------------------
   Los dos casos. Cada uno dice QUÉ prueba y QUÉ significa cada desenlace: sin
   escribir antes qué se espera, cualquier respuesta parece un resultado.
   --------------------------------------------------------------------------- */
const CASOS = [
  {
    id: "LOTE-1",
    titulo: "Tres ítems DISTINTOS en un solo plano",
    lineas: [
      { item: 9659, um: "UND", factor: 1.01 },
      { item: 2092, um: "UND", factor: 1.01 }, // trae ICO: prueba la sección de impuestos
      { item: 10765, um: "UND", factor: 1.01 }, // sin impuestos ni descuentos
    ],
    lectura: {
      ok:
        "El conector ACEPTA varios encabezados. Se puede empujar el paquete en UNA " +
        "transacción. Verificar en SIESA que estén las TRES filas y que el ítem 2092 " +
        "conserve su ICO — un 'exitosa' que escribió una sola es peor que un rechazo.",
      falla:
        "El conector NO acepta el lote. El empuje va en bucle, un envío por línea, " +
        "con su propia marca de idempotencia (que es como está hoy y ya funciona).",
    },
  },
  {
    id: "LOTE-2",
    titulo: "El MISMO ítem en dos U.M. dentro del mismo plano",
    lineas: [
      { item: 1032, um: "UND", precio: 4000 },
      { item: 1032, um: "P2", precio: 8000 }, // exactamente el doble
    ],
    lectura: {
      ok:
        "El múltiplo exacto NO molesta ni siquiera en el mismo plano. La agrupación " +
        "queda libre de esa restricción.",
      falla:
        "Vuelve el rechazo de QA del 2026-09-02. Agrupar SÍ, pero el armador tiene " +
        "que separar en planos distintos las presentaciones del mismo ítem. NO es " +
        "motivo para no agrupar.",
    },
  },

  /* ── IMP-1 / IMP-2: los impuestos editables ─────────────────────────────────

     Requerimiento del 2026-09-06: el proveedor edita ICO/IBUA. Hasta acá se
     re-emitían fijos desde la vigente, así que el conector nunca recibió un valor
     distinto ni una ausencia deliberada.

     Van en FECHAS DISTINTAS a propósito. La fecha es parte de la llave: si los dos
     casos cayeran en la misma, el segundo no probaría nada — estaría pisando lo
     que dejó el primero, y no se podría distinguir "nació sin ICO" de "el ICO
     quedó del envío anterior".
     ───────────────────────────────────────────────────────────────────────── */
  {
    id: "IMP-1",
    titulo: "Un impuesto con OTRO valor",
    fecha: "2026-11-19",
    lineas: [{ item: 2092, um: "UND", factor: 1.02, impuestos: [{ llave: "ICO", valor: 5000 }] }],
    lectura: {
      ok: "El conector acepta un valor de impuesto distinto al vigente. Verificar en la pantalla que el ICO diga 5.000 y no 4.313.",
      falla: "El impuesto NO se puede editar por el conector. El requerimiento 2 necesita otro camino — avisar a compras.",
    },
  },
  {
    id: "IMP-2",
    titulo: "Un impuesto QUITADO — la sección no se manda",
    fecha: "2026-11-20",
    lineas: [{ item: 2092, um: "UND", factor: 1.03, impuestos: [] }],
    lectura: {
      ok:
        "El conector acepta el plano sin sección de impuestos. PERO esto solo prueba " +
        "que no lo rechaza: que la cotización haya NACIDO SIN ICO hay que verlo en la " +
        "pantalla. Es el mismo mecanismo por el que el FOUR LOKO perdió su ICO — acá " +
        "se usa a propósito.",
      falla: "Quitar un impuesto por ausencia no funciona. Habría que emitirlo en 0, que significa otra cosa.",
    },
  },
];

/* ---------------------------------------------------------------------------- */

const arr = (v) => (Array.isArray(v) ? v : []);
const money = (n) => Number(n).toLocaleString("es-CO", { maximumFractionDigits: 2 });

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

  const hoy = new Date().toISOString().slice(0, 10);
  return data.find((c) => c.fecha_activacion <= hoy) ?? data[data.length - 1];
}

const aVigente = (f) => ({
  claveItem: f.clave_item,
  idTercero: f.id_tercero,
  nit: f.nit,
  sucursal: f.sucursal,
  item: f.item,
  unidadMedida: f.unidad_medida,
  precio: Number(f.precio),
  moneda: f.moneda,
  impuestos: arr(f.impuestos),
  descuentos: arr(f.descuentos),
  fechaActivacion: f.fecha_activacion,
});

/* ── La guarda: adónde va a escribir ──────────────────────────────────────── */
const destino =
  process.env.SIESA_COTIZACION_URL ||
  "https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar";

if (REAL && !/serviciosqa\./i.test(destino)) {
  console.error(
    `\n⛔ ABORTADO. SIESA_COTIZACION_URL no apunta a QA:\n   ${destino}\n\n` +
      `   Este script escribe precios de prueba. Contra producción metería basura\n` +
      `   en el catálogo real de ALTIPAL. Si de verdad querés eso, sacá la guarda a mano.\n`,
  );
  process.exit(1);
}

/* ---------------------------------------------------------------------------- */

async function correr(caso) {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`${caso.id} · ${caso.titulo}`);
  console.log(`${"═".repeat(78)}`);

  // Un caso puede fijar su propia fecha: los de impuestos NECESITAN fechas
  // distintas para que el segundo no pise lo que dejó el primero.
  const fecha = caso.fecha ?? FECHA;
  if (caso.fecha) console.log(`  (fecha propia del caso: ${fecha})`);

  const payloads = [];
  for (const l of caso.lineas) {
    const fila = await vigenteDe(l.item, l.um);
    if (!fila) {
      console.log(`  ❌ no hay cotización vigente para ${l.item} / ${l.um} en ${NIT}-${SUC}`);
      return { id: caso.id, ok: false, motivo: "sin cotización vigente" };
    }
    const vigente = aVigente(fila);
    const precio = l.precio ?? Math.round(vigente.precio * l.factor * 100) / 100;

    console.log(
      `  ${String(l.item).padStart(6)} ${l.um.padEnd(4)} ` +
        `${money(vigente.precio).padStart(12)} → ${money(precio).padStart(12)}` +
        `   imptos: ${vigente.impuestos.length}  dsctos: ${vigente.descuentos.length}`,
    );

    const propuesta = {
      claveItem: vigente.claveItem,
      precio,
      descuentos: vigente.descuentos, // no se tocan: acá se mide el lote y los impuestos
      fechaActivacion: fecha,
      notas: `Prueba ${caso.id}`,
    };
    // Solo si el caso lo declara: `undefined` significa "re-emitir los vigentes",
    // que es lo que tienen que hacer los casos LOTE-*.
    if (l.impuestos !== undefined) propuesta.impuestos = l.impuestos;

    payloads.push(armarPayload({ vigente, propuesta }));
  }

  const plano = fusionarPayloads(payloads);
  const secciones = Object.entries(plano)
    .map(([k, v]) => `${k}: ${v.length}`)
    .join(" · ");
  console.log(`\n  PLANO FUSIONADO → ${secciones}`);

  if (!REAL) {
    console.log(`\n${JSON.stringify(plano, null, 2)}`);
    console.log(`\n  🧪 No se mandó nada. Agregá --real para escribir en QA.`);
    return { id: caso.id, ok: null, motivo: "sandbox" };
  }

  const { data, status } = await postConectorCrudo(plano);
  const cuerpo = JSON.stringify(data);
  const acepto = status < 400 && /exitos/i.test(cuerpo);

  console.log(`\n  HTTP ${status}`);
  console.log(`  ${cuerpo.slice(0, 900)}`);
  console.log(`\n  ${acepto ? "✅ ACEPTADO" : "❌ RECHAZADO"}`);
  console.log(`  → ${acepto ? caso.lectura.ok : caso.lectura.falla}`);

  return { id: caso.id, ok: acepto, status, data };
}

/* ---------------------------------------------------------------------------- */

console.log(`\nDestino:  ${destino}`);
console.log(`Modo:     ${REAL ? "REAL — escribe en QA" : "sandbox — no manda nada"}`);
console.log(`Fecha:    ${FECHA}`);
console.log(`Cuenta:   ${NIT} / ${SUC} (ALTIPAL)`);

const aCorrer = soloCaso ? CASOS.filter((c) => c.id === soloCaso.toUpperCase()) : CASOS;
if (!aCorrer.length) {
  console.error(`\nNo existe el caso "${soloCaso}". Hay: ${CASOS.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

const resultados = [];
for (const c of aCorrer) resultados.push(await correr(c));

console.log(`\n${"═".repeat(78)}\nRESUMEN\n${"═".repeat(78)}`);
for (const r of resultados) {
  const marca = r.ok === null ? "🧪" : r.ok ? "✅" : "❌";
  console.log(`  ${marca} ${r.id}${r.motivo ? ` — ${r.motivo}` : ""}`);
}

if (REAL) {
  const fechas = [...new Set(aCorrer.map((c) => c.fecha ?? FECHA))].sort();
  console.log(
    `\n  Falta la mitad que este script NO PUEDE hacer: mirar en la pantalla de\n` +
      `  SIESA QA qué quedó escrito, con fecha ${fechas.join(" / ")}.\n\n` +
      `  "Importación exitosa" es un acuse de recibo, no una prueba — y acá no se\n` +
      `  puede verificar por código: la consulta LEE de producción y el conector\n` +
      `  ESCRIBE en QA (PENDIENTES §1.4). Es la misma asimetría que hace que\n` +
      `  verificarCotizacion() devuelva 'no_verificable'.\n\n` +
      `  Lo que hay que mirar de cada caso está en docs/PENDIENTES.md §2.4.\n`,
  );
}
