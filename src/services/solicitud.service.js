/* =============================================================================
   Solicitudes de cambio de precio — crear, aprobar, rechazar

   Acá se juntan las tres reglas del proyecto: el tope sobre costo neto, la firma
   atada al contenido, y el empuje idempotente a SIESA.
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { createError, createErrorExpuesto } from "../middleware/errorHandler.js";
import { costoNeto, evaluarPropuesta } from "./costoNeto.js";
import { hoyEnColombia, porcentajesDescuento, separarVigentes } from "./normalizarCotizacion.js";
import { registrarFirma, verificarFirmaDeSolicitud } from "./firma.service.js";
import { importarCotizacion } from "./siesaCotizacion.js";

const SELECT_COTIZACION =
  "clave, clave_item, id_tercero, nit, sucursal, moneda, item, descripcion_item, unidad_medida, fecha_activacion, precio, impuestos, descuentos";

/** Fila de `pp_cotizaciones` → el objeto que consumen costoNeto y siesaCotizacion. */
const aCotizacion = (f) => ({
  clave: f.clave,
  claveItem: f.clave_item,
  idTercero: f.id_tercero,
  nit: f.nit,
  sucursal: f.sucursal,
  moneda: f.moneda,
  item: f.item,
  descripcionItem: f.descripcion_item,
  unidadMedida: f.unidad_medida,
  fechaActivacion: f.fecha_activacion,
  precio: Number(f.precio),
  impuestos: f.impuestos ?? [],
  descuentos: f.descuentos ?? [],
});

/**
 * La cotización que rige HOY para un renglón de una cuenta.
 *
 * Filtra por `nit` y `sucursal` DE LA CUENTA, no por lo que mandó el cliente.
 * El `claveItem` del request solo dice qué renglón, nunca de quién: si apunta a
 * un ítem de otro proveedor, esta consulta no devuelve nada y la operación muere
 * acá. Es la regla de ARQUITECTURA §5 aplicada al caso concreto.
 */
export async function vigenteDe(cuenta, claveItem) {
  const { data, error } = await supabase
    .from("pp_cotizaciones")
    .select(SELECT_COTIZACION)
    .eq("clave_item", claveItem)
    .eq("nit", cuenta.nit)
    .eq("sucursal", cuenta.sucursal);

  if (error) throw new Error(`No se pudo leer la cotización: ${error.message}`);
  if (!data?.length) return null;

  // Un ítem+U.M. puede tener varias filas, una por fecha. La que importa para
  // calcular la variación es la que rige hoy — ver CONTRATO-SIESA §2.3.
  const { vigentes } = separarVigentes(data.map(aCotizacion));
  return vigentes[0] ?? null;
}

/**
 * Crea una solicitud de cambio de precio.
 *
 * El orden de los pasos no es casual: primero se valida el tope contra el precio
 * que el SERVIDOR leyó, y recién después se registra la firma. Firmar antes
 * dejaría firmas huérfanas de propuestas que nunca existieron.
 */
export async function crearSolicitud({ cuenta, usuario, datos, ip, userAgent }) {
  const vigente = await vigenteDe(cuenta, datos.claveItem);
  if (!vigente) {
    throw createError(404, "El producto no está disponible para cotizar en su catálogo.");
  }
  if (!(vigente.precio > 0)) {
    throw createError(
      409,
      "Este producto no tiene un precio vigente en el sistema. Comuníquese con el área de compras.",
    );
  }

  if (datos.fechaActivacion < hoyEnColombia()) {
    throw createError(422, "La fecha de activación no puede ser anterior a hoy.");
  }

  const evaluacion = evaluarPropuesta({
    precioActual: vigente.precio,
    descuentosActuales: porcentajesDescuento(vigente),
    precioPropuesto: datos.precioPropuesto,
    descuentosPropuestos: datos.descuentosPropuestos.map((d) => d.porcentaje),
    topePct: cuenta.porcentajeMax,
  });

  // EL TOPE AVISA, NO FRENA — decidido por Johan el 2026-08-27.
  //
  // Antes esto era un 422 y la solicitud no nacía. Ya no: una propuesta que
  // supera el tope se crea igual, queda marcada, y la decide un humano.
  //
  // El tope pasó de ser un candado a ser una ETIQUETA, y eso mueve la única
  // defensa automática al escritorio del admin. Es sostenible porque nada llega
  // a SIESA sin su aprobación explícita — pero SOLO si la marca se ve. Por eso
  // `excede` viaja en la respuesta al proveedor y la bandeja lo devuelve por
  // fila: que se pierda de vista es la forma en que esta decisión sale mal.
  //
  // `porcentaje_max_vigente` se congela en la fila igual que antes: el histórico
  // tiene que poder decir qué tope regía el día que se propuso.

  const datosFirma = {
    cuentaId: cuenta.id,
    claveItem: vigente.claveItem,
    item: vigente.item,
    unidadMedida: vigente.unidadMedida,
    precioActual: vigente.precio,
    descuentosActuales: vigente.descuentos,
    precioPropuesto: datos.precioPropuesto,
    descuentosPropuestos: datos.descuentosPropuestos,
    fechaActivacion: datos.fechaActivacion,
  };

  const firma = await registrarFirma({
    cuentaId: cuenta.id,
    userId: usuario.id,
    datos: datosFirma,
    trazo: datos.firma,
    ip,
    userAgent,
  });

  const { data, error } = await supabase
    .from("pp_solicitudes_precio")
    .insert({
      cuenta_id: cuenta.id,
      clave_item: vigente.claveItem,
      item: vigente.item,
      descripcion_item: vigente.descripcionItem,
      unidad_medida: vigente.unidadMedida,
      precio_actual: vigente.precio,
      descuentos_actuales: vigente.descuentos,
      impuestos_vigentes: vigente.impuestos,
      costo_neto_actual: evaluacion.costoActual,
      precio_propuesto: datos.precioPropuesto,
      descuentos_propuestos: datos.descuentosPropuestos,
      costo_neto_propuesto: evaluacion.costoPropuesto,
      variacion_pct: evaluacion.variacionPct,
      porcentaje_max_vigente: cuenta.porcentajeMax,
      fecha_activacion: datos.fechaActivacion,
      notas: datos.notas,
      firma_id: firma.id,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = violación de único. Acá solo puede ser el índice parcial de
    // pendientes: ya hay una propuesta viva sobre este renglón. No es un error
    // del sistema, es una condición de negocio, y merece un mensaje que la diga.
    if (error.code === "23505") {
      throw createError(
        409,
        "Ya tiene una solicitud pendiente para este producto. Espere la respuesta o anúlela antes de enviar otra.",
      );
    }
    throw new Error(`No se pudo crear la solicitud: ${error.message}`);
  }

  await auditar({
    entidad: "pp_solicitudes_precio",
    entidadId: data.id,
    accion: "crear",
    estadoNuevo: "pendiente",
    actorUserId: usuario.id,
    actorRol: "pp_proveedor",
    detalle: { variacionPct: evaluacion.variacionPct, topePct: evaluacion.topePct },
    ip,
  });

  return { id: data.id, ...evaluacion };
}

/**
 * Aprueba una solicitud y la empuja a SIESA.
 *
 * EL ORDEN IMPORTA Y NO SE CAMBIA:
 *
 *   1. Verificar la firma  — si la solicitud cambió después de firmada, se frena.
 *   2. TOMAR la solicitud  — UPDATE condicionado. Es el candado de idempotencia.
 *   3. Empujar a SIESA     — recién ahora.
 *
 * Tomar ANTES de empujar significa que, en el peor caso, una solicitud queda
 * marcada sin haberse enviado: sale como `fallida` con el detalle y alguien la
 * revisa. Al revés —empujar y después marcar— el peor caso es mandar el mismo
 * precio dos veces. En Traslados eso ya pasó: la misma salida se importó tres
 * veces por no tener este candado.
 */
export async function aprobar({ solicitudId, admin, ip }) {
  const { data: solicitud, error } = await supabase
    .from("pp_solicitudes_precio")
    .select("*")
    .eq("id", solicitudId)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer la solicitud: ${error.message}`);
  if (!solicitud) throw createError(404, "La solicitud no existe");
  if (solicitud.estado !== "pendiente") {
    throw createError(409, `La solicitud ya está en estado "${solicitud.estado}"`);
  }

  const firma = await verificarFirmaDeSolicitud(solicitud);
  if (!firma.valida) {
    await auditar({
      entidad: "pp_solicitudes_precio",
      entidadId: solicitudId,
      accion: "firma_invalida",
      actorUserId: admin.userId,
      actorRol: "pp_admin",
      detalle: { motivo: firma.motivo },
      ip,
    });
    throw createError(409, firma.motivo);
  }

  // El candado. Si otro admin (o un doble clic) llegó primero, esto afecta
  // 0 filas y salimos sin tocar SIESA.
  const { data: tomada, error: errTomar } = await supabase
    .from("pp_solicitudes_precio")
    .update({
      estado: "aprobada",
      siesa_aplicado_at: new Date().toISOString(),
      resuelto_at: new Date().toISOString(),
      resuelto_por: admin.userId,
    })
    .eq("id", solicitudId)
    .eq("estado", "pendiente")
    .is("siesa_aplicado_at", null)
    .select("id")
    .maybeSingle();

  if (errTomar) throw new Error(`No se pudo tomar la solicitud: ${errTomar.message}`);
  if (!tomada) throw createError(409, "La solicitud ya fue procesada por otra persona.");

  const vigente = {
    claveItem: solicitud.clave_item,
    idTercero: null, // se completa abajo desde la cuenta
    sucursal: null,
    item: solicitud.item,
    unidadMedida: solicitud.unidad_medida,
    impuestos: solicitud.impuestos_vigentes ?? [],
  };

  const { data: cuenta } = await supabase
    .from("pp_cuentas")
    .select("sucursal, pp_proveedores(id_tercero)")
    .eq("id", solicitud.cuenta_id)
    .maybeSingle();

  vigente.idTercero = cuenta?.pp_proveedores?.id_tercero;
  vigente.sucursal = cuenta?.sucursal;

  try {
    const r = await importarCotizacion({
      solicitudId,
      vigente,
      propuesta: {
        claveItem: solicitud.clave_item,
        precio: Number(solicitud.precio_propuesto),
        descuentos: solicitud.descuentos_propuestos ?? [],
        fechaActivacion: solicitud.fecha_activacion,
        notas: solicitud.notas ?? "",
      },
    });

    await supabase
      .from("pp_solicitudes_precio")
      .update({ estado: "aplicada", siesa_payload: r.payload, siesa_respuesta: r.respuesta })
      .eq("id", solicitudId);

    await auditar({
      entidad: "pp_solicitudes_precio",
      entidadId: solicitudId,
      accion: "aprobar",
      estadoAnterior: "pendiente",
      estadoNuevo: "aplicada",
      actorUserId: admin.userId,
      actorRol: "pp_admin",
      detalle: { sandbox: Boolean(r.sandbox) },
      ip,
    });

    return { id: solicitudId, estado: "aplicada", sandbox: Boolean(r.sandbox) };
  } catch (e) {
    // Queda `fallida`, con la marca puesta: NO se reintenta sola. Con un write al
    // ERP, "no sé si llegó" es peor que "falló", y un reintento ciego sobre un
    // precio es un precio duplicado. Esto lo mira una persona.
    await supabase
      .from("pp_solicitudes_precio")
      .update({
        estado: "fallida",
        siesa_payload: e.payload ?? null,
        siesa_respuesta: e.siesaData ?? { error: String(e.message).slice(0, 800) },
      })
      .eq("id", solicitudId);

    await auditar({
      entidad: "pp_solicitudes_precio",
      entidadId: solicitudId,
      accion: "empuje_fallido",
      estadoAnterior: "aprobada",
      estadoNuevo: "fallida",
      actorUserId: admin.userId,
      actorRol: "pp_admin",
      detalle: { error: String(e.message).slice(0, 800), httpStatus: e.httpStatus ?? null },
      ip,
    });

    // EXPUESTO a propósito: el mensaje del ERP es lo único que le dice al admin
    // qué corregir. Enmascararlo como "Error interno del servidor" —que es lo que
    // pasaba— convierte un rechazo accionable en un misterio, y obliga a ir a
    // buscar los logs de Vercel para operar el sistema.
    throw createErrorExpuesto(
      502,
      `SIESA rechazó el cambio: ${e.message}`,
      e.siesaData ?? null,
    );
  }
}

/** Rechaza una solicitud. El motivo es obligatorio — lo exige también la base. */
export async function rechazar({ solicitudId, motivo, admin, ip }) {
  const { data, error } = await supabase
    .from("pp_solicitudes_precio")
    .update({
      estado: "rechazada",
      motivo_rechazo: motivo,
      resuelto_at: new Date().toISOString(),
      resuelto_por: admin.userId,
    })
    .eq("id", solicitudId)
    .eq("estado", "pendiente")
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`No se pudo rechazar: ${error.message}`);
  if (!data) throw createError(409, "La solicitud no existe o ya fue resuelta.");

  await auditar({
    entidad: "pp_solicitudes_precio",
    entidadId: solicitudId,
    accion: "rechazar",
    estadoAnterior: "pendiente",
    estadoNuevo: "rechazada",
    actorUserId: admin.userId,
    actorRol: "pp_admin",
    detalle: { motivo },
    ip,
  });

  return { id: solicitudId, estado: "rechazada" };
}

/**
 * Catálogo del proveedor: lo vigente, con el costo neto ya calculado y las
 * propuestas pendientes enganchadas al renglón que les toca.
 */
export async function catalogoDe(cuenta) {
  const { data, error } = await supabase
    .from("pp_cotizaciones")
    .select(SELECT_COTIZACION)
    .eq("nit", cuenta.nit)
    .eq("sucursal", cuenta.sucursal);

  if (error) throw new Error(`No se pudo leer el catálogo: ${error.message}`);

  const { vigentes, programadas } = separarVigentes((data ?? []).map(aCotizacion));

  const { data: pendientes } = await supabase
    .from("pp_solicitudes_precio")
    .select("id, clave_item, precio_propuesto, descuentos_propuestos, fecha_activacion, estado, creado_at")
    .eq("cuenta_id", cuenta.id)
    .eq("estado", "pendiente");

  const porItem = new Map((pendientes ?? []).map((p) => [p.clave_item, p]));
  const programadasPorItem = new Map();
  for (const p of programadas) {
    if (!programadasPorItem.has(p.claveItem)) programadasPorItem.set(p.claveItem, []);
    programadasPorItem.get(p.claveItem).push(p);
  }

  return vigentes.map((c) => ({
    ...c,
    // Se manda calculado y no solo el precio: si el frontend lo recalculara por
    // su cuenta, tendríamos dos fórmulas del mismo número y un día no coinciden.
    costoNeto: c.precio > 0 ? costoNeto(c.precio, porcentajesDescuento(c)) : null,
    solicitudPendiente: porItem.get(c.claveItem) ?? null,
    programadas: programadasPorItem.get(c.claveItem) ?? [],
  }));
}

/** Nunca lanza: una auditoría que falla no puede tumbar la operación auditada. */
async function auditar({ entidad, entidadId, accion, estadoAnterior, estadoNuevo, actorUserId, actorRol, detalle, ip }) {
  try {
    await supabase.from("pp_auditoria").insert({
      entidad,
      entidad_id: String(entidadId),
      accion,
      estado_anterior: estadoAnterior ?? null,
      estado_nuevo: estadoNuevo ?? null,
      actor_user_id: actorUserId ?? null,
      actor_rol: actorRol ?? null,
      detalle: detalle ?? null,
      ip: ip ?? null,
    });
  } catch (e) {
    console.error(`[auditoria] no se pudo registrar "${accion}":`, e?.message);
  }
}
