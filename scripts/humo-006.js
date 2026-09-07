/* =============================================================================
   Prueba de humo del esquema nuevo (migraciones 006 y 007)

   POR QUÉ EXISTE
   295 tests unitarios no prueban que la solicitud AGRUPADA se escriba de verdad:
   las columnas nuevas, los CHECK, el índice de pendiente única y la firma sobre
   varias líneas solo se ejercitan contra la base.

   QUÉ HACE
     1. Crea una solicitud de DOS productos sobre la cuenta de prueba (ALTIPAL).
     2. Comprueba que la firma del paquete verifique.
     3. La ANULA — y por eso es seguro: no deja nada pendiente ni toca SIESA.

   NO toca SIESA. `crearSolicitud` no empuja nada: eso es `aprobarLineas`.

   USO
     node scripts/humo-006.js            # crea, verifica y anula
     node scripts/humo-006.js --dejar    # la deja pendiente para mirarla en la UI
   ============================================================================= */

import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import { crearSolicitud, anular, catalogoDe } from "../src/services/solicitud.service.js";
import { verificarFirmaDeSolicitud } from "../src/services/firma.service.js";

const DEJAR = process.argv.includes("--dejar");
const NIT = "800186960";
const SUC = "006";

const ok = (t) => console.log(`  ✓ ${t}`);
const mal = (t) => {
  console.log(`  ✗ ${t}`);
  process.exitCode = 1;
};

/* ── La cuenta de prueba, tal como la arma el middleware de auth ───────────── */
const { data: c, error: eC } = await supabase
  .from("pp_cuentas")
  .select("id, nit, sucursal, nombre_sucursal, pp_proveedores(id_tercero, razon_social, porcentaje_max, bloqueado)")
  .eq("nit", NIT)
  .eq("sucursal", SUC)
  .maybeSingle();

if (eC || !c) {
  console.error(`No se encontró la cuenta ${NIT}/${SUC}: ${eC?.message ?? "no existe"}`);
  process.exit(1);
}

const cuenta = {
  id: c.id,
  nit: c.nit,
  sucursal: c.sucursal,
  nombreSucursal: c.nombre_sucursal,
  idTercero: c.pp_proveedores.id_tercero,
  razonSocial: c.pp_proveedores.razon_social,
  porcentajeMax: c.pp_proveedores.porcentaje_max,
  bloqueado: Boolean(c.pp_proveedores.bloqueado),
};

console.log(`\nCuenta:  ${cuenta.razonSocial} · ${cuenta.nit}/${cuenta.sucursal} (id ${cuenta.id})`);
console.log(`Tope:    ${cuenta.porcentajeMax ?? "SIN TOPE"}\n`);

/* ── Dos productos del catálogo, sin propuesta viva ────────────────────────── */
const catalogo = await catalogoDe(cuenta);
const libres = catalogo.filter((i) => i.precio > 0 && !i.solicitudPendiente);
if (libres.length < 2) {
  console.error("Hacen falta al menos 2 productos sin solicitud pendiente.");
  process.exit(1);
}

// Uno CON impuestos y uno sin: así el paquete ejercita las dos ramas.
const conImpuesto = libres.find((i) => i.impuestos?.length) ?? libres[0];
const sinImpuesto = libres.find((i) => i !== conImpuesto && !i.impuestos?.length) ?? libres[1];

// Futura sí o sí: desde el 2026-09-07 la activación no puede ser hoy ni antes.
const fecha = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);

const lineas = [
  {
    claveItem: conImpuesto.claveItem,
    // +0,5 %, redondeado a 2 decimales: el conector rechaza más (validators.js).
    precioPropuesto: Math.round(conImpuesto.precio * 1.005 * 100) / 100,
    descuentosPropuestos: [],
    fechaActivacion: fecha,
    notas: "humo 006",
    // A propósito NO se manda `impuestosPropuestos`: tiene que resolverse a los
    // vigentes, no a vacío. Es la diferencia que le borraría el ICO a todos.
  },
  {
    claveItem: sinImpuesto.claveItem,
    precioPropuesto: Math.round(sinImpuesto.precio * 1.005 * 100) / 100,
    descuentosPropuestos: [],
    fechaActivacion: fecha,
    notas: "humo 006",
  },
];

console.log(`Productos:`);
for (const l of lineas) {
  const i = catalogo.find((x) => x.claveItem === l.claveItem);
  console.log(
    `  ${String(i.item).padStart(7)} ${i.unidadMedida.padEnd(4)} ${i.descripcionItem?.slice(0, 40).padEnd(42)} ` +
      `${i.precio} → ${l.precioPropuesto}   imptos: ${i.impuestos?.length ?? 0}`,
  );
}

/* ── Crear ─────────────────────────────────────────────────────────────────── */
console.log(`\n── crearSolicitud ───────────────────────────────────────────`);
const r = await crearSolicitud({
  cuenta,
  usuario: { id: null },
  datos: { lineas, firma: "data:image/png;base64," + "A".repeat(300) },
  ip: null,
  userAgent: "humo-006",
});

console.log(`  solicitud ${r.id} · ${r.lineas.length} línea(s) · ${r.replicadas} réplica(s)`);
r.lineas.length === 2 ? ok("se crearon las dos líneas") : mal(`se crearon ${r.lineas.length}`);
if (r.omitidas.length) console.log(`  omitidas: ${JSON.stringify(r.omitidas)}`);
console.log(`  aviso a compras: ${JSON.stringify(r.avisoCompras)}`);

/* ── Los impuestos: la comprobación que más plata vale ─────────────────────── */
const { data: guardadas } = await supabase
  .from("pp_solicitud_lineas")
  .select("id, item, origen, impuestos_vigentes, impuestos_propuestos, variacion_pct, estado")
  .eq("solicitud_id", r.id)
  .order("id");

const conImp = guardadas.find((g) => g.item === conImpuesto.item);
if (conImpuesto.impuestos?.length) {
  JSON.stringify(conImp.impuestos_propuestos) === JSON.stringify(conImp.impuestos_vigentes)
    ? ok("omitir `impuestosPropuestos` conservó los vigentes (no los borró)")
    : mal(
        `los impuestos se perdieron: vigentes ${JSON.stringify(conImp.impuestos_vigentes)} ` +
          `→ propuestos ${JSON.stringify(conImp.impuestos_propuestos)}`,
      );
} else {
  console.log("  (el catálogo no tiene ningún producto libre con impuestos: no se pudo probar)");
}

/* ── La firma, sobre el paquete completo ───────────────────────────────────── */
console.log(`\n── firma ───────────────────────────────────────────────────`);
const { data: solicitud } = await supabase.from("pp_solicitudes").select("*").eq("id", r.id).maybeSingle();
const { data: todas } = await supabase.from("pp_solicitud_lineas").select("*").eq("solicitud_id", r.id);

const v = await verificarFirmaDeSolicitud(solicitud, todas);
v.valida ? ok("la firma del paquete verifica") : mal(`la firma NO verifica: ${v.motivo}`);

/* Y tiene que ROMPERSE si se toca una línea. Sin esto, la firma no prueba nada. */
const alterada = todas.map((l, i) => (i === 0 ? { ...l, precio_propuesto: 999999 } : l));
const v2 = await verificarFirmaDeSolicitud(solicitud, alterada);
v2.valida
  ? mal("⚠️ la firma sigue válida con el precio cambiado — NO está cubriendo el contenido")
  : ok("cambiar el precio de una línea ROMPE la firma");

/* Y también si se le agrega una línea que no se firmó. */
const conDeMas = [...todas, { ...todas[0], id: -1, clave_item: "COP|X|999|999|UND", item: 999 }];
const v3 = await verificarFirmaDeSolicitud(solicitud, conDeMas);
v3.valida
  ? mal("⚠️ la firma sigue válida con una línea AGREGADA")
  : ok("agregar una línea al paquete ROMPE la firma");

/* ── Limpieza ──────────────────────────────────────────────────────────────── */
console.log(`\n── limpieza ────────────────────────────────────────────────`);
if (DEJAR) {
  console.log(`  --dejar: la solicitud ${r.id} queda PENDIENTE. Anulala vos.`);
} else {
  const a = await anular({ solicitudId: r.id, cuenta, userId: null, ip: null });
  a.estado === "anulada" ? ok(`solicitud ${r.id} anulada (${a.lineas} línea/s)`) : mal("no se anuló");
}

console.log(process.exitCode ? "\n❌ Hay fallos arriba.\n" : "\n✅ Todo bien.\n");
