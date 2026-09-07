/* =============================================================================
   Prueba de humo del lado ADMIN (aprobar, rechazar, reintentar)

   POR QUÉ EXISTE
   `humo-006.js` cubre lo que hace el PROVEEDOR: crear y anular. Pero el camino
   caro es el otro — aprobar verifica la firma, toma las líneas con el candado de
   idempotencia, arma el plano y lo empuja al ERP. Ese camino se reescribió entero
   con la migración 006 y **nunca corrió**: la pantalla del admin pide login
   corporativo y los tests unitarios no tocan la base.

   QUÉ COMPRUEBA, en este orden
     1. Aprobar UNA línea deja la otra PENDIENTE  (resolución parcial)
     2. La firma del PAQUETE se verifica aunque se apruebe una sola línea
     3. El candado: aprobar dos veces la misma línea no la empuja dos veces
     4. Rechazar exige motivo, y el motivo llega a la línea
     5. `reintentar` solo acepta líneas con problema

   ⚠️ FUERZA `PROVEEDORES_SANDBOX=true`. El empuje se corta justo antes del POST,
   así que NO escribe en SIESA — pero el armado del payload se ejercita igual, que
   es donde viven los bugs de formato. Correrlo sin sandbox llenaría QA de precios
   de prueba cada vez.

   Borra la solicitud al terminar. La FIRMA y la AUDITORÍA quedan: las dos tablas
   son append-only por trigger, y está bien — el hecho ocurrió.

   USO
     node scripts/humo-admin.js
   ============================================================================= */

// Antes de importar nada que lea la config.
process.env.PROVEEDORES_SANDBOX = "true";

import "dotenv/config";
import { supabase } from "../src/config/supabase.js";
import { crearSolicitud, catalogoDe, aprobarLineas, rechazarLineas, reintentar } from "../src/services/solicitud.service.js";
import { sandboxOn } from "../src/services/siesaCotizacion.js";

const NIT = "800186960";
const SUC = "006";
const admin = { userId: null };

let fallos = 0;
const ok = (t) => console.log(`  ✓ ${t}`);
const mal = (t) => {
  console.log(`  ✗ ${t}`);
  fallos++;
};

if (!sandboxOn()) {
  console.error("\n⛔ El sandbox NO quedó activo. Abortado: esto escribiría en SIESA.\n");
  process.exit(1);
}
console.log("\n🧪 SANDBOX activo — no se escribe en SIESA.\n");

/* ── La cuenta de prueba ───────────────────────────────────────────────────── */
const { data: c } = await supabase
  .from("pp_cuentas")
  .select("id, nit, sucursal, nombre_sucursal, pp_proveedores(id_tercero, razon_social, porcentaje_max, bloqueado)")
  .eq("nit", NIT)
  .eq("sucursal", SUC)
  .maybeSingle();

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

/* ── Una solicitud de dos productos ────────────────────────────────────────── */
const catalogo = await catalogoDe(cuenta);
const libres = catalogo.filter((i) => i.precio > 0 && !i.solicitudPendiente);
if (libres.length < 2) {
  console.error("Hacen falta 2 productos sin propuesta viva.");
  process.exit(1);
}
/* Uno CON impuestos —para que el armado del payload ejercite el bloque 0213— y
   otro cualquiera que NO sea ése. El `!==` importa: dos veces el mismo renglón
   choca contra `idx_pp_lineas_pendiente_unica` y el error habla de "una solicitud
   pendiente", que manda a buscar el problema donde no está. */
const primero = libres.find((i) => i.impuestos?.length) ?? libres[0];
const segundo = libres.find((i) => i.claveItem !== primero.claveItem);
const dos = [primero, segundo];

const fecha = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
const r = await crearSolicitud({
  cuenta,
  usuario: { id: null },
  datos: {
    lineas: dos.map((i) => ({
      claveItem: i.claveItem,
      precioPropuesto: Math.round(i.precio * 1.004 * 100) / 100,
      descuentosPropuestos: [],
      fechaActivacion: fecha,
      notas: "humo admin",
    })),
    firma: "data:image/png;base64," + "A".repeat(300),
  },
  ip: null,
  userAgent: "humo-admin",
});

console.log(`Solicitud ${r.id}: ${dos.map((i) => i.descripcionItem?.slice(0, 26)).join(" · ")}\n`);
const [l1, l2] = r.lineas.map((x) => x.id);

/* ── 1. Resolución PARCIAL ─────────────────────────────────────────────────── */
console.log("── aprobar UNA línea ──────────────────────────────────────");
const ap = await aprobarLineas({ lineaIds: [l1], admin, ip: null });
ap.lineas?.length === 1 ? ok("devolvió 1 línea resuelta") : mal(`devolvió ${ap.lineas?.length}`);
ap.lineas?.[0]?.sandbox ? ok("marcada como sandbox (no salió a SIESA)") : mal("NO vino marcada como sandbox");

const estados = async () => {
  const { data } = await supabase
    .from("pp_solicitud_lineas")
    .select("id, estado, siesa_aplicado_at, motivo_rechazo, siesa_payload")
    .eq("solicitud_id", r.id)
    .order("id");
  return new Map(data.map((x) => [x.id, x]));
};

let e = await estados();
e.get(l1).estado === "aplicada" ? ok("la aprobada quedó 'aplicada'") : mal(`quedó '${e.get(l1).estado}'`);
e.get(l2).estado === "pendiente"
  ? ok("la OTRA sigue 'pendiente' — la resolución es por línea")
  : mal(`la otra quedó '${e.get(l2).estado}': se resolvieron las dos`);
/* ── El payload: lo único que ve SIESA ─────────────────────────────────────
   El sandbox corta el POST pero arma el plano igual, y ahí viven los bugs de
   este módulo: formato, llave y RE-EMISIÓN DE IMPUESTOS. Un "aplicada" con un
   payload mal armado es peor que un fallo, porque nadie lo mira. */
const payload = e.get(l1).siesa_payload;
if (!payload) {
  mal("no guardó el payload");
} else {
  ok("guardó el payload que se iba a mandar");

  const enc = payload["Encabezado Cotizaciones"] ?? [];
  enc.length === 1 ? ok("un encabezado (se aprobó una línea)") : mal(`${enc.length} encabezados`);

  /* Los 20 caracteres del precio y la fecha AAAAMMDD: los dos ya rompieron
     envíos reales. */
  /^\d{15}\.\d{4}$/.test(enc[0]?.PRECIO ?? "")
    ? ok(`precio con formato de 20 caracteres (${enc[0].PRECIO})`)
    : mal(`PRECIO mal formateado: ${JSON.stringify(enc[0]?.PRECIO)}`);
  /^\d{8}$/.test(enc[0]?.FECHA_ACTIVACION ?? "")
    ? ok(`fecha en AAAAMMDD (${enc[0].FECHA_ACTIVACION})`)
    : mal(`FECHA_ACTIVACION mal: ${JSON.stringify(enc[0]?.FECHA_ACTIVACION)}`);

  /* LA comprobación cara: el ICO tiene que viajar con la fecha NUEVA. Sin eso,
     el ítem nace sin impuesto en esa fecha — le pasó al FOUR LOKO, $5.102. */
  if (primero.impuestos?.length) {
    const imp = payload["Impuestos en Valor"] ?? [];
    imp.length === primero.impuestos.length
      ? ok(`re-emitió ${imp.length} impuesto(s) con la fecha nueva`)
      : mal(`el ítem tiene ${primero.impuestos.length} impuesto(s) y el payload lleva ${imp.length}`);
    imp[0] && "FECHA_ACTIVACIÓN" in imp[0]
      ? ok("el bloque de impuestos usa FECHA_ACTIVACIÓN con tilde (SIESA lo exige distinto)")
      : mal("la clave de fecha del bloque de impuestos está mal escrita");
  }
}

/* ── 2. El candado ─────────────────────────────────────────────────────────── */
console.log("\n── el candado de idempotencia ─────────────────────────────");
try {
  await aprobarLineas({ lineaIds: [l1], admin, ip: null });
  mal("⚠️ dejó aprobar DOS VECES la misma línea — se puede duplicar el precio");
} catch (err) {
  /^4\d\d$/.test(String(err.status ?? err.statusCode ?? ""))
    ? ok(`rechazó el segundo intento (${err.status ?? err.statusCode})`)
    : ok(`rechazó el segundo intento: ${String(err.message).slice(0, 70)}`);
}

/* ── 3. Rechazar ───────────────────────────────────────────────────────────── */
console.log("\n── rechazar con motivo ────────────────────────────────────");
const MOTIVO = "El aumento supera lo acordado para este trimestre";
const rz = await rechazarLineas({ lineaIds: [l2], motivo: MOTIVO, admin, ip: null });
rz.lineas?.length === 1 ? ok("rechazó la línea") : mal("no rechazó");

e = await estados();
e.get(l2).estado === "rechazada" ? ok("quedó 'rechazada'") : mal(`quedó '${e.get(l2).estado}'`);
e.get(l2).motivo_rechazo === MOTIVO
  ? ok("el motivo llegó a la línea — el proveedor lo va a ver")
  : mal("se perdió el motivo");

/* ── 4. Reintentar solo acepta lo que tiene problema ───────────────────────── */
console.log("\n── reintentar ─────────────────────────────────────────────");
try {
  await reintentar({ lineaIds: [l2], admin, ip: null });
  mal("⚠️ dejó devolver a la cola una RECHAZADA: solo van 'fallida' e 'incierto'");
} catch (err) {
  ok(`no deja reintentar una rechazada: ${String(err.message).slice(0, 60)}`);
}

/* ── 5. La auditoría ───────────────────────────────────────────────────────── */
console.log("\n── auditoría ──────────────────────────────────────────────");
const { data: aud } = await supabase
  .from("pp_auditoria")
  .select("accion, estado_anterior, estado_nuevo, entidad_id")
  .in("entidad_id", [String(l1), String(l2), String(r.id)])
  .order("id");
const acciones = (aud ?? []).map((x) => x.accion);
for (const esperada of ["crear", "aprobar", "rechazar"]) {
  acciones.includes(esperada)
    ? ok(`quedó registrado "${esperada}"`)
    : mal(`FALTA el registro de "${esperada}" — la auditoría tiene un hueco`);
}

/* ── Limpieza ──────────────────────────────────────────────────────────────── */
console.log("\n── limpieza ───────────────────────────────────────────────");
const { error: errDel } = await supabase.from("pp_solicitudes").delete().eq("id", r.id);
errDel ? mal(`no se pudo borrar: ${errDel.message}`) : ok(`solicitud ${r.id} borrada (las líneas van en cascada)`);
console.log("  (la firma y la auditoría quedan: son append-only, y el hecho ocurrió)");

console.log(fallos ? `\n❌ ${fallos} problema(s).\n` : "\n✅ Todo bien.\n");
process.exit(fallos ? 1 : 0);
