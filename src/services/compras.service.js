/* =============================================================================
   Avisarle a COMPRAS que entró una solicitud

   POR QUÉ EXISTE
   Hasta acá, una propuesta de precio se enteraba de que existía el que se
   acordaba de abrir la bandeja. Pedido por compras el 2026-09-06: que llegue un
   correo cuando un proveedor sube una cotización.

   LAS DOS REGLAS

   1. **Un fallo de correo NUNCA deshace la solicitud.** Cuando esto corre, la
      solicitud ya está creada y firmada. Tirar una excepción acá convertiría "el
      correo no salió" en "no se pudo enviar su propuesta", y el proveedor volvería
      a mandarla — chocando contra el candado de pendiente única, con un mensaje
      que habla de una solicitud que él cree que no existe. Se registra y sigue.
      Es la misma regla de notificacion.service.js, por la misma razón.

   2. **El destino NO se hardcodea.** Sale de `COMPRAS_EMAIL`. Mientras no esté
      configurada, el aviso se escribe en el log y se devuelve `{enviado:false,
      motivo:"sin_destinatario"}`. No es un fallo: el portal todavía está en
      pruebas y llenarle la casilla a alguien con correos de prueba es peor que no
      avisar. Ver docs/PENDIENTES.md §2.

   EL AVISO DE IMPUESTOS NO ES UN ADORNO
   Un ICO o un IBU3 los fija la ley, no la negociación. Por eso NO pasan por el
   tope de % —meterlos ahí lo aflojaría— y el único control que queda es que una
   persona de compras los mire. Este correo ES ese control: si no sale, un cambio
   de impuesto entra sin que nadie lo haya revisado.
   ============================================================================= */

import { enviar } from "./email.service.js";

/* Púrpura corporativo (`--sfc-medium`). En un correo no hay tokens de CSS, así
   que el hex va literal — pero es el MISMO que usa la app. */
const MORADO = "#2d1578";
const MORADO_CLARO = "#cfc6ec";
const GRIS = "#64748b";
const AMBAR = "#b45309";
const AMBAR_FONDO = "#fef3c7";

export const destinatario = () => String(process.env.COMPRAS_EMAIL || "").trim();

const dinero = (v) => `$${Number(v).toLocaleString("es-CO", { maximumFractionDigits: 2 })}`;

const pct = (v) => `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)} %`;

const escapar = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/**
 * Resume el paquete en una frase de asunto.
 *
 * El asunto es lo único que se lee en el teléfono sin abrir nada, así que lleva
 * lo que decide si hay que abrirlo YA: cuántos productos, y si algo se sale de lo
 * normal. "Nueva solicitud de precios" no dice nada que ayude a priorizar.
 */
export function asuntoDe({ razonSocial, lineas = [] }) {
  const excede = lineas.filter((l) => l.excede).length;
  const impuestos = lineas.filter((l) => l.cambiaImpuestos).length;

  const partes = [`${lineas.length} producto${lineas.length === 1 ? "" : "s"}`];
  if (excede) partes.push(`${excede} sobre el tope`);
  if (impuestos) partes.push(`${impuestos} con cambio de IMPUESTOS`);

  return `Portal Proveedores · ${razonSocial} — ${partes.join(", ")}`;
}

const encabezado = `
  <div style="background:${MORADO};padding:24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;color:#fff;font-size:20px">Portal de Proveedores</h1>
    <p style="margin:4px 0 0;color:${MORADO_CLARO};font-size:14px">Merkahorro</p>
  </div>`;

const marco = (interior) => `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;color:#1d1d1f">
  ${encabezado}
  <div style="border:1px solid #d9e2ec;border-top:none;border-radius:0 0 8px 8px;padding:24px">
    ${interior}
    <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;line-height:1.6">
      Este es un aviso automático. Para resolverla, entre al portal.
    </p>
  </div>
</div>`;

/* Ámbar, no verde ni rojo.

   Verde diría "esto ya está bien" sobre algo que nadie revisó todavía, y rojo
   diría "hay un problema" sobre una propuesta que puede ser perfectamente normal.
   Lo que esta fila significa es "mirá esto antes de aprobar", y eso es ámbar. */
const aviso = (texto) => `
  <p style="margin:0 0 16px;padding:10px 14px;background:${AMBAR_FONDO};color:${AMBAR};
            border-radius:6px;font-size:14px;line-height:1.5">${texto}</p>`;

const filaLinea = (l) => {
  const marca = [
    l.excede ? "supera el tope" : null,
    l.cambiaImpuestos ? "cambia impuestos" : null,
  ].filter(Boolean);

  return `
  <tr>
    <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:14px">
      ${escapar(l.descripcion || l.item)}
      <span style="color:${GRIS};font-size:12px"><br>Ítem ${escapar(l.item)} · ${escapar(l.unidadMedida)}</span>
      ${
        marca.length
          ? `<br><span style="color:${AMBAR};font-size:12px;font-weight:600">${marca.join(" · ")}</span>`
          : ""
      }
    </td>
    <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:14px;text-align:right;white-space:nowrap">
      ${dinero(l.precioActual)} → <strong>${dinero(l.precioPropuesto)}</strong>
    </td>
    <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:14px;text-align:right;
               white-space:nowrap;color:${l.excede ? AMBAR : GRIS};font-weight:${l.excede ? "700" : "400"}">
      ${pct(l.variacionPct)}
    </td>
  </tr>`;
};

const textoPlano = ({ razonSocial, nit, sucursal, lineas }) =>
  [
    `${razonSocial} (NIT ${nit}, sucursal ${sucursal}) envió una solicitud de precios.`,
    "",
    ...lineas.map(
      (l) =>
        `- ${l.descripcion || l.item} (${l.unidadMedida}): ${dinero(l.precioActual)} → ` +
        `${dinero(l.precioPropuesto)} (${pct(l.variacionPct)})` +
        `${l.excede ? " [SUPERA EL TOPE]" : ""}` +
        `${l.cambiaImpuestos ? " [CAMBIA IMPUESTOS]" : ""}`,
    ),
    "",
    "Entre al portal para revisarla.",
  ].join("\n");

/**
 * Avisa que entró una solicitud nueva.
 *
 * NO LANZA. Devuelve qué pasó, para que quien llame lo pueda registrar o
 * mostrar, pero jamás para que aborte lo que ya está hecho.
 *
 * @returns {Promise<{enviado: boolean, motivo?: string}>}
 */
export async function avisarSolicitudNueva({ solicitudId, cuenta, lineas = [] }) {
  const para = destinatario();

  const conImpuestos = lineas.filter((l) => l.cambiaImpuestos).length;
  const conTope = lineas.filter((l) => l.excede).length;

  if (!para) {
    /* No es un fallo y no se calla: que el aviso NO tenga a dónde ir es
       información operativa, sobre todo cuando lo que no se está avisando es un
       cambio de impuestos, que no tiene ningún otro control automático. */
    console.warn(
      `[compras] solicitud ${solicitudId} de ${cuenta?.razonSocial ?? cuenta?.nit}: ` +
        `${lineas.length} línea(s), ${conTope} sobre el tope, ${conImpuestos} con cambio de ` +
        `impuestos. NO se avisó: falta configurar COMPRAS_EMAIL.`,
    );
    return { enviado: false, motivo: "sin_destinatario" };
  }

  const datos = {
    razonSocial: cuenta?.razonSocial ?? cuenta?.nit ?? "Proveedor",
    nit: cuenta?.nit,
    sucursal: cuenta?.sucursal,
    lineas,
  };

  const cuerpo = `
    <p style="margin:0 0 16px;line-height:1.6">
      <strong>${escapar(datos.razonSocial)}</strong><br>
      <span style="color:${GRIS};font-size:14px">
        NIT ${escapar(datos.nit)} &middot; Sucursal ${escapar(datos.sucursal)}
        ${cuenta?.nombreSucursal ? `&middot; ${escapar(cuenta.nombreSucursal)}` : ""}
      </span>
    </p>
    ${
      conImpuestos
        ? aviso(
            `<strong>${conImpuestos} producto${conImpuestos === 1 ? "" : "s"} cambia${conImpuestos === 1 ? "" : "n"} los impuestos (ICO/IBU3).</strong> ` +
              `Los impuestos no pasan por el tope de porcentaje: los fija la ley, no la negociación. ` +
              `La revisión de esta parte es humana.`,
          )
        : ""
    }
    ${
      conTope
        ? aviso(
            `${conTope} producto${conTope === 1 ? "" : "s"} supera${conTope === 1 ? "" : "n"} el máximo autorizado para esta cuenta.`,
          )
        : ""
    }
    <table style="width:100%;border-collapse:collapse;margin:8px 0 0">
      <thead>
        <tr>
          <th style="padding:8px 10px;text-align:left;font-size:12px;color:${GRIS};border-bottom:2px solid #cbd5e1">PRODUCTO</th>
          <th style="padding:8px 10px;text-align:right;font-size:12px;color:${GRIS};border-bottom:2px solid #cbd5e1">PRECIO</th>
          <th style="padding:8px 10px;text-align:right;font-size:12px;color:${GRIS};border-bottom:2px solid #cbd5e1">VARIACIÓN</th>
        </tr>
      </thead>
      <tbody>${lineas.map(filaLinea).join("")}</tbody>
    </table>`;

  try {
    const r = await enviar({
      para,
      asunto: asuntoDe(datos),
      html: marco(cuerpo),
      texto: textoPlano(datos),
    });
    return r;
  } catch (e) {
    // `enviar` ya está escrito para no lanzar, pero esta función es la última
    // línea de una operación que YA ocurrió. Un throw acá desharía una solicitud
    // firmada por un problema de SMTP.
    console.error(`[compras] no se pudo avisar la solicitud ${solicitudId}: ${e?.message}`);
    return { enviado: false, motivo: "error_envio" };
  }
}
