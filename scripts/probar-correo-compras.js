/* =============================================================================
   Ver cómo le llega a compras el aviso de una solicitud nueva

   POR QUÉ EXISTE
   `COMPRAS_EMAIL` todavía no está configurada en producción, así que el aviso se
   escribe en el log y nadie lo vio nunca. Antes de apuntar una casilla real
   conviene mirar el correo: si el asunto no dice lo que hay que decidir, se lee
   una vez y después se archiva sin abrir.

   Arma el correo con PRODUCTOS REALES del catálogo y fuerza los dos casos que
   importan —uno que supera el tope y uno que cambia impuestos—, porque son los
   que tienen que saltar a la vista. Un correo de prueba con todo en orden no
   prueba lo que hace falta probar.

   POR DEFECTO NO MANDA NADA: imprime el asunto y guarda el HTML en un archivo
   para abrirlo en el navegador. Con `--enviar` sí lo manda.

     node scripts/probar-correo-compras.js
     node scripts/probar-correo-compras.js --enviar johanmerkahorro777@gmail.com
   ============================================================================= */

import "dotenv/config";
import fs from "node:fs";
import { supabase } from "../src/config/supabase.js";
import { asuntoDe, avisarSolicitudNueva, destinatario } from "../src/services/compras.service.js";

const args = process.argv.slice(2);
const ENVIAR = args.includes("--enviar");
const PARA = args.find((a) => a.includes("@")) || destinatario();

const NIT = "800186960";
const SUC = "006";

/* ── Productos reales, para que los números sean creíbles ──────────────────── */
const { data: cots } = await supabase
  .from("pp_cotizaciones")
  .select("item, descripcion_item, unidad_medida, precio, impuestos")
  .eq("nit", NIT)
  .eq("sucursal", SUC)
  .gt("precio", 0)
  .limit(40);

const conIco = (cots ?? []).find((c) => c.impuestos?.length) ?? cots[0];
const otros = (cots ?? []).filter((c) => c !== conIco).slice(0, 3);

const linea = (c, { variacionPct, excede = false, cambiaImpuestos = false }) => ({
  descripcion: c.descripcion_item,
  item: c.item,
  unidadMedida: c.unidad_medida,
  precioActual: Number(c.precio),
  precioPropuesto: Math.round(Number(c.precio) * (1 + variacionPct / 100) * 100) / 100,
  variacionPct,
  excede,
  cambiaImpuestos,
});

/* Los dos casos que tienen que saltar a la vista van primeros a propósito. */
const lineas = [
  linea(conIco, { variacionPct: 3.2, cambiaImpuestos: true }),
  linea(otros[0], { variacionPct: 12.5, excede: true }),
  linea(otros[1], { variacionPct: 1.8 }),
  linea(otros[2], { variacionPct: -2.4 }),
];

const cuenta = {
  nit: NIT,
  sucursal: SUC,
  razonSocial: "ALTIPAL SAS",
  nombreSucursal: "ALTIPAL CATALOGO GENERAL",
};

console.log(`\nASUNTO:  ${asuntoDe({ razonSocial: cuenta.razonSocial, lineas })}`);
console.log(`PARA:    ${PARA || "(sin destinatario — falta COMPRAS_EMAIL)"}`);
console.log(`MODO:    ${ENVIAR ? "ENVÍA de verdad" : "vista previa, no manda nada"}\n`);

for (const l of lineas) {
  const marcas = [l.excede ? "SUPERA EL TOPE" : null, l.cambiaImpuestos ? "CAMBIA IMPUESTOS" : null]
    .filter(Boolean)
    .join(" · ");
  console.log(
    `  ${String(l.item).padStart(7)} ${String(l.descripcion).slice(0, 38).padEnd(40)} ` +
      `${String(l.variacionPct > 0 ? "+" : "") + l.variacionPct}%`.padStart(8) +
      (marcas ? `   ← ${marcas}` : ""),
  );
}

if (!ENVIAR) {
  /* El HTML a un archivo: el asunto se lee en la consola, pero si los avisos de
     tope e impuestos se ven o no es una pregunta visual. */
  process.env.COMPRAS_EMAIL = "vista-previa@ejemplo.com";
  process.env.PROVEEDORES_MAIL_PRUEBA = "true"; // corta antes del SMTP
  await avisarSolicitudNueva({ solicitudId: "PRUEBA", cuenta, lineas });
  console.log(`\n  (modo prueba: el correo quedó en el log de arriba, no salió)`);
  console.log(`  Para mandarlo de verdad:\n`);
  console.log(`     node scripts/probar-correo-compras.js --enviar ${PARA || "alguien@merkahorrosas.com"}\n`);
  process.exit(0);
}

if (!PARA) {
  console.error("Falta el destinatario. Pasalo como argumento o configurá COMPRAS_EMAIL.\n");
  process.exit(1);
}

process.env.COMPRAS_EMAIL = PARA;
process.env.PROVEEDORES_MAIL_PRUEBA = "false";

const r = await avisarSolicitudNueva({ solicitudId: "PRUEBA", cuenta, lineas });
console.log(`\nResultado: ${JSON.stringify(r)}`);
console.log(
  r.enviado
    ? `\n✅ Enviado a ${PARA}. Revisá también la carpeta de spam.\n`
    : `\n❌ No salió (${r.motivo}). Revisá EMAIL_USER / EMAIL_PASS en el .env.\n`,
);
