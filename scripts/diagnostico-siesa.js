/* =============================================================================
   Diagnóstico del conector de cotizaciones — ¿SIESA está procesando algo?

   POR QUÉ EXISTE
   La solicitud #5 recibió {"codigo":0,"detalle":"Importacion exitosa"} y en QA
   no entró NADA. O sea: `codigo: 0` no prueba que SIESA haya escrito.

   Este script hace UNA pregunta que separa las dos explicaciones posibles:

     PRUEBA 1 — manda un ITEM que no existe (999999999).
       · Si responde "Importacion exitosa"  → el endpoint NO valida nada. El
         conector, la compañía o el sistema están mal apuntados, y todos los
         "éxitos" anteriores no significan nada.
       · Si responde un error               → el conector SÍ valida. Entonces el
         payload de la #5 entró de verdad y el problema es DÓNDE aterrizó.

     PRUEBA 2 — reenvía el payload EXACTO de la solicitud #5.
       Es seguro por contrato: encabezado e impuestos van con
       `F_ACTUALIZA_REG = 1` (reemplaza), así que reenviar el mismo lote pisa el
       registro con los mismos valores. Ver docs/CONTRATO-SIESA.md §4.
       Sirve para reintentar la escritura real y volver a mirar QA.

   No toca la base de datos. Solo habla con SIESA.

   ⚠️ ARMA EL PAYLOAD A MANO, SALTEÁNDOSE `formatoSiesa.js`.
   Eso es deliberado —sirve para mandar valores inválidos a propósito— pero tiene
   una trampa: lo que este script logra enviar NO prueba qué deja pasar el flujo
   real. Ya costó una conclusión equivocada: se mandó un ITEM de 9 dígitos, SIESA
   lo rechazó por tamaño, y se dio por hecho que no validábamos el largo. Sí lo
   validábamos, con test y todo (`campo.item`). Antes de concluir "no validamos
   X", mirar `formatoSiesa.js`.

   USO
     node scripts/diagnostico-siesa.js          → solo PRUEBA 1 (diagnóstico)
     node scripts/diagnostico-siesa.js --real   → PRUEBA 1 y PRUEBA 2

   Las credenciales salen del .env; este script NUNCA las imprime.
   ============================================================================= */

import axios from "axios";
import "dotenv/config";

const cfg = {
  url:
    process.env.SIESA_COTIZACION_URL ||
    "https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar",
  idCompania: process.env.SIESA_ID_COMPANIA || "7375",
  idSistema: process.env.SIESA_IMPORTAR_ID_SISTEMA || "1",
  idDocumento: process.env.SIESA_COTIZACION_ID_DOCUMENTO || "253851",
  nombreDocumento:
    process.env.SIESA_COTIZACION_NOMBRE_DOCUMENTO || "Cotizaciones_Compras",
  key: process.env.CONNI_KEY,
  token: process.env.CONNI_TOKEN,
};

/* El payload REAL de la solicitud #5, tal como quedó guardado en
   pp_solicitudes_precio.siesa_payload. No se reconstruye: se copia. */
const PAYLOAD_5 = {
  "Encabezado Cotizaciones": [
    {
      "U.M": "UND",
      ITEM: "179313",
      NOTAS: "Aumento de costo de importacion",
      PRECIO: "000000000013920.0000",
      SUCURSAL: "006",
      NIT_PROVEEDOR: "800186960",
      FECHA_ACTIVACION: "20260920",
    },
  ],
  "Impuestos en Valor": [
    {
      "U.M": "UND",
      ITEM: "179313",
      SUCURSAL: "006",
      NIT_PROVEEDOR: "800186960",
      LLAVE_IMPUESTO: "ICO",
      VALOR_IMPUESTO: "000000000004974.0000",
      "FECHA_ACTIVACIÓN": "20260920",
    },
  ],
};

/* Mismo payload con un ITEM que NO EXISTE pero es ESTRUCTURALMENTE VÁLIDO.
 *
 * Ojo con el largo: el conector limita ITEM a 7 caracteres. El primer intento usó
 * "999999999" (9) y SIESA lo rechazó con "supera el tamaño permitido (7)" — o
 * sea, murió en la validación de ESTRUCTURA y nunca llegó a la pregunta que nos
 * importa. `9999999` son 7: pasa la estructura y obliga a SIESA a decidir qué
 * hace con un ítem que no está en su maestro.
 *
 *   · Si responde "Importacion exitosa" → solo valida ESTRUCTURA y descarta en
 *     silencio las filas cuyo ítem/tercero no resuelve. Eso explicaría la #5.
 *   · Si responde error de negocio      → valida existencia, y la #5 entró.
 */
const PAYLOAD_FALSO = {
  "Encabezado Cotizaciones": [
    { ...PAYLOAD_5["Encabezado Cotizaciones"][0], ITEM: "9999999" },
  ],
  "Impuestos en Valor": [
    { ...PAYLOAD_5["Impuestos en Valor"][0], ITEM: "9999999" },
  ],
};

/* Ítem REAL, tercero que NO EXISTE.
 *
 * La PRUEBA 1 demostró que el conector valida el ITEM y su U.M. — pero solo eso.
 * Nunca comprobamos si valida el TERCERO. Si no lo validara, la #5 pudo haberse
 * escrito colgada de un proveedor que no existe, y ahí buscarla por proveedor en
 * el ERP no la encuentra nunca.
 *
 * ⚠️ Tiene un costo: si el tercero NO se valida, esto DEJA un registro basura en
 * QA (ítem real, proveedor inexistente). Por eso va detrás de su propia bandera y
 * no corre solo.
 */
const PAYLOAD_TERCERO_FALSO = {
  "Encabezado Cotizaciones": [
    { ...PAYLOAD_5["Encabezado Cotizaciones"][0], NIT_PROVEEDOR: "999999999" },
  ],
  "Impuestos en Valor": [
    { ...PAYLOAD_5["Impuestos en Valor"][0], NIT_PROVEEDOR: "999999999" },
  ],
};

async function enviar(nombre, payload) {
  console.log(`\n${"─".repeat(70)}\n▶ ${nombre}\n${"─".repeat(70)}`);
  console.log("Payload:", JSON.stringify(payload));

  const { data, status } = await axios
    .post(cfg.url, payload, {
      params: {
        idCompania: cfg.idCompania,
        idSistema: cfg.idSistema,
        idDocumento: cfg.idDocumento,
        nombreDocumento: cfg.nombreDocumento,
      },
      headers: {
        conniKey: cfg.key,
        conniToken: cfg.token,
        "Content-Type": "application/json",
      },
      timeout: 60_000,
      validateStatus: () => true,
    })
    .then(({ data, status }) => ({ data, status }));

  console.log(`\nHTTP ${status}`);
  console.log("Respuesta CRUDA:", JSON.stringify(data, null, 2));
  return { data, status };
}

async function main() {
  const faltan = ["key", "token"].filter((k) => !cfg[k]);
  if (faltan.length) {
    console.error(
      `\n❌ Falta en el .env: ${faltan.map((k) => (k === "key" ? "CONNI_KEY" : "CONNI_TOKEN")).join(", ")}`,
    );
    process.exit(1);
  }

  console.log("\n═══ ADÓNDE ESTOY APUNTANDO ═══");
  console.table({
    url: cfg.url,
    idCompania: cfg.idCompania,
    idSistema: cfg.idSistema,
    idDocumento: cfg.idDocumento,
    nombreDocumento: cfg.nombreDocumento,
    CONNI_KEY: "(presente)",
    CONNI_TOKEN: "(presente)",
  });

  const r1 = await enviar(
    "PRUEBA 1 — ITEM INEXISTENTE PERO BIEN FORMADO (9999999)",
    PAYLOAD_FALSO,
  );

  const esErrorDeEstructura = /estructura/i.test(String(r1.data?.mensaje ?? ""));

  console.log(`\n${"═".repeat(70)}`);
  if (Number(r1.data?.codigo) === 0) {
    console.log(
      "🔴 VEREDICTO: un ítem que NO EXISTE fue aceptado como 'Importacion exitosa'.\n" +
        "   El conector valida SOLO LA ESTRUCTURA y descarta en silencio las filas\n" +
        "   que su maestro no reconoce. 'codigo: 0' nunca significó 'quedó escrito'.\n" +
        "   → Eso explica la #5, y explica por qué QA está vacío.",
    );
  } else if (esErrorDeEstructura) {
    console.log(
      "🟡 VEREDICTO: INCONCLUSO — volvió a morir en la validación de ESTRUCTURA,\n" +
        "   así que todavía no sabemos si valida EXISTENCIA. Mirá el `f_detalle`\n" +
        "   de arriba y ajustá el campo que se queja antes de volver a leer esto.",
    );
  } else {
    console.log(
      "🟢 VEREDICTO: el conector rechazó el ítem por NEGOCIO, no por formato.\n" +
        "   Valida existencia ⇒ el payload de la #5 fue aceptado de verdad.\n" +
        "   El problema es DÓNDE aterrizó: revisar compañía, y buscar en QA los\n" +
        "   registros con FECHA DE ACTIVACIÓN 20/09/2026 (no el precio de hoy).",
    );
  }
  console.log("═".repeat(70));

  if (process.argv.includes("--real")) {
    await enviar("PRUEBA 2 — REENVÍO REAL DE LA SOLICITUD #5", PAYLOAD_5);
    console.log(
      "\n👉 Ahora pedí que miren en SIESA QA:\n" +
        "   ítem 179313 · tercero 800186960 · sucursal 006 · activación 20/09/2026\n" +
        "   → precio $13.920 con ICO $4.974",
    );
  } else {
    console.log(
      "\n(Para reintentar la escritura real de la #5: node scripts/diagnostico-siesa.js --real)",
    );
  }

  if (process.argv.includes("--tercero")) {
    const r3 = await enviar(
      "PRUEBA 3 — ÍTEM REAL, TERCERO INEXISTENTE (999999999)",
      PAYLOAD_TERCERO_FALSO,
    );
    console.log(`\n${"═".repeat(70)}`);
    if (Number(r3.data?.codigo) === 0) {
      console.log(
        "🔴 El conector NO valida el tercero: aceptó una cotización de un\n" +
          "   proveedor inexistente. Entonces buscar por proveedor en el ERP puede\n" +
          "   no encontrar nada aunque el registro exista.\n" +
          "   ⚠️ Quedó un registro basura en QA (ítem 179313, NIT 999999999): borrarlo.",
      );
    } else {
      console.log(
        "🟢 El conector SÍ valida el tercero. Sumado a la PRUEBA 1, la #5 tenía\n" +
          "   ítem, U.M. y proveedor válidos ⇒ el registro EXISTE en QA.\n" +
          "   El problema es la pantalla donde se lo busca, no la escritura.",
      );
    }
    console.log("═".repeat(70));
  }
}

main().catch((e) => {
  console.error("\n💥 Falló la llamada:", e.message);
  process.exit(1);
});
