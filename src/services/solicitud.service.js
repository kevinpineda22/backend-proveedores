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
import { verificarEnSiesa, NO_CONFIRMA } from "./verificarCotizacion.js";
import { revalidarTope } from "./revalidarTope.js";
import { notificarResolucion } from "./notificacion.service.js";

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
      "Este producto no tiene un precio vigente en el sistema. Comuníquese con Merkahorro.",
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
export async function aprobar({ solicitudId, admin, ip, confirmaDesactualizado = false }) {
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

  // ¿La marca que el admin está mirando sigue siendo cierta?
  //
  // `variacion_pct` se congeló al proponer. Si SIESA movió el precio desde
  // entonces, la bandeja puede estar mostrando "dentro del tope" sobre una base
  // que ya no existe. Ver services/revalidarTope.js.
  //
  // Va ANTES del candado a propósito: si frena, la solicitud tiene que quedar
  // `pendiente` y sin marca de empuje, lista para que otro la mire.
  const { data: cuentaTope } = await supabase
    .from("pp_cuentas")
    .select("nit, sucursal")
    .eq("id", solicitud.cuenta_id)
    .maybeSingle();

  if (cuentaTope?.nit && cuentaTope?.sucursal) {
    let revision = null;
    try {
      revision = revalidarTope(solicitud, await vigenteDe(cuentaTope, solicitud.clave_item));
    } catch (e) {
      // No poder releer no puede impedir aprobar: sería dejar el sistema colgado
      // de una consulta. Queda el rastro y sigue.
      console.warn(`[aprobar] no se pudo revalidar el tope de ${solicitudId}: ${e.message}`);
    }

    // Solo frena `empeora`: hoy supera el tope y al proponer NO lo superaba. Si
    // ya lo superaba, el admin está viendo la marca roja y no hay nada nuevo que
    // avisarle — un aviso que sale siempre deja de significar algo.
    if (revision?.empeora && !confirmaDesactualizado) {
      throw createErrorExpuesto(
        409,
        `El precio de SIESA cambió desde que se propuso: era $${revision.precioAntes} y ` +
          `hoy es $${revision.precioHoy}. Con el precio de hoy la propuesta es del ` +
          `${revision.variacionHoy}% y SUPERA el tope de ${solicitud.porcentaje_max_vigente}% ` +
          `(cuando se propuso era ${revision.variacionAntes}%). Revísela antes de aprobar.`,
        revision,
      );
    }
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
    // `correo_notificacion` viaja para el aviso del final. Se pide acá y no en
    // otra consulta: es la misma fila.
    .select("sucursal, correo_notificacion, pp_proveedores(id_tercero)")
    .eq("id", solicitud.cuenta_id)
    .maybeSingle();

  vigente.idTercero = cuenta?.pp_proveedores?.id_tercero;
  vigente.sucursal = cuenta?.sucursal;

  // El try envuelve SOLO el empuje. Todo lo que viene después es contabilidad
  // NUESTRA, y no puede terminar marcando "fallida": ese estado significa "SIESA
  // rechazó" y habilita reintentar. Si un fallo de nuestra base cayera acá, le
  // diríamos al admin que reintente un precio que el ERP YA aceptó — o sea, que
  // lo duplique.
  let r;
  try {
    r = await importarCotizacion({
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
  } catch (e) {
    return await marcarFallida({ solicitudId, admin, ip, e });
  }

  // SIESA respondiendo "exitosa" NO prueba que el precio haya quedado: la #5
  // lo demostró. Se relee y se compara. Ver services/verificarCotizacion.js.
  //
  // En sandbox no hay nada que releer —no se escribió—, así que ni se intenta:
  // una verificación que sale "no encontrado" porque nunca se mandó es ruido.
  const verificacion = r.sandbox
    ? null
    : await verificarEnSiesa({
        idTercero: vigente.idTercero,
        sucursal: vigente.sucursal,
        item: solicitud.item,
        unidadMedida: solicitud.unidad_medida,
        fechaActivacion: solicitud.fecha_activacion,
        precioEsperado: Number(solicitud.precio_propuesto),
        impuestosEsperados: solicitud.impuestos_vigentes ?? [],
      });

  // "No pude comprobarlo" no es "salió mal". Solo los desenlaces que
  // CONTRADICEN el éxito mandan la solicitud a revisión humana.
  const incierta = Boolean(verificacion && NO_CONFIRMA.has(verificacion.estado));
  const estadoFinal = incierta ? "incierto" : "aplicada";

  const { error: errEstado } = await supabase
    .from("pp_solicitudes_precio")
    .update({
      estado: estadoFinal,
      siesa_payload: r.payload,
      siesa_respuesta: r.respuesta,
      siesa_verificacion: verificacion
        ? { ...verificacion, verificado_at: new Date().toISOString() }
        : null,
    })
    .eq("id", solicitudId);

  // Este update NO puede fallar en silencio. Si lo hiciera —un CHECK que no
  // conoce el estado, la migración 004 sin correr, un corte— la solicitud
  // quedaría en "aprobada" sin payload y esta función devolvería éxito: el
  // sistema afirmando algo que no comprobó, que es justo lo que vinimos a
  // matar del lado de SIESA.
  if (errEstado) {
    console.error(
      `[aprobar] solicitud ${solicitudId}: SIESA ACEPTÓ el cambio pero no se pudo ` +
        `guardar el estado "${estadoFinal}": ${errEstado.message}`,
      { payload: r.payload, respuesta: r.respuesta, verificacion },
    );

    await auditar({
      entidad: "pp_solicitudes_precio",
      entidadId: solicitudId,
      accion: "estado_no_guardado",
      estadoAnterior: "aprobada",
      estadoNuevo: "aprobada",
      actorUserId: admin.userId,
      actorRol: "pp_admin",
      detalle: { intento: estadoFinal, error: String(errEstado.message).slice(0, 800) },
      ip,
    });

    // Queda en "aprobada" CON la marca de empuje. Es el estado seguro: el
    // candado impide volver a empujarla y `reintentar()` no la toma, así que
    // nadie puede duplicar el precio por accidente. Necesita una persona.
    throw createErrorExpuesto(
      500,
      `El cambio se envió a SIESA y fue ACEPTADO, pero no se pudo registrar en ` +
        `la base (${errEstado.message}). NO vuelva a aprobar esta solicitud: el ` +
        `precio ya se empujó. Avise a desarrollo.`,
      { solicitudId, estadoIntentado: estadoFinal },
    );
  }

  await auditar({
    entidad: "pp_solicitudes_precio",
    entidadId: solicitudId,
    accion: "aprobar",
    estadoAnterior: "pendiente",
    estadoNuevo: estadoFinal,
    actorUserId: admin.userId,
    actorRol: "pp_admin",
    detalle: {
      sandbox: Boolean(r.sandbox),
      verificacion: verificacion?.estado ?? null,
      verificacionMotivo: verificacion?.motivo ?? null,
    },
    ip,
  });

  // El aviso al proveedor va ÚLTIMO y no puede romper nada: acá el precio ya se
  // empujó al ERP. `notificarResolucion` no lanza, y un `incierto` no se avisa
  // —no se le dice a un proveedor que su precio quedó aplicado sin haberlo
  // comprobado—. Ver notificacion.service.js.
  const aviso = await notificarResolucion({
    solicitud,
    correo: cuenta?.correo_notificacion,
    estado: estadoFinal,
  });

  return {
    id: solicitudId,
    estado: estadoFinal,
    sandbox: Boolean(r.sandbox),
    verificacion: verificacion ?? null,
    avisoAlProveedor: aviso,
  };
}

/**
 * Marca una solicitud como `fallida` cuando SIESA RECHAZÓ el empuje.
 *
 * Se llama SOLO desde el catch que envuelve `importarCotizacion`. Fuera de ahí,
 * un fallo ya no es "SIESA rechazó" sino un problema nuestro, y marcarlo
 * `fallida` invitaría a reintentar un precio que el ERP aceptó.
 *
 * Queda con la marca de empuje puesta: NO se reintenta sola. Con un write al
 * ERP, "no sé si llegó" es peor que "falló", y un reintento ciego sobre un
 * precio es un precio duplicado. Esto lo mira una persona.
 */
async function marcarFallida({ solicitudId, admin, ip, e }) {
  // Tres orígenes distintos, y confundirlos manda al admin a buscar donde no es:
  //
  //   false      → no salió de acá (formato/config). SIESA nunca lo vio.
  //   true       → el ERP lo rechazó explícitamente. Nada quedó escrito.
  //   undefined  → se cortó la red o venció el timeout. NO SABEMOS si llegó.
  //
  // El tercero es el peligroso: es el único donde reintentar puede duplicar.
  const origen =
    e.enviadoASiesa === false
      ? "local"
      : e.enviadoASiesa === true
        ? "rechazo_erp"
        : "sin_respuesta";

  const mensaje =
    origen === "local"
      ? `El cambio NO se envió a SIESA — los datos no pasaron la validación: ${e.message}`
      : origen === "rechazo_erp"
        ? `SIESA rechazó el cambio: ${e.message}`
        : `No hubo respuesta de SIESA: ${e.message}. Puede haber llegado igual.`;

  await supabase
    .from("pp_solicitudes_precio")
    .update({
      estado: "fallida",
      siesa_payload: e.payload ?? null,
      siesa_respuesta: e.siesaData ?? { origen, error: String(e.message).slice(0, 800) },
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
    detalle: {
      origen,
      error: String(e.message).slice(0, 800),
      httpStatus: e.httpStatus ?? null,
    },
    ip,
  });

  // EXPUESTO a propósito: el mensaje del ERP es lo único que le dice al admin
  // qué corregir. Enmascararlo como "Error interno del servidor" —que es lo que
  // pasaba— convierte un rechazo accionable en un misterio, y obliga a ir a
  // buscar los logs de Vercel para operar el sistema.
  // 502 solo cuando el problema es del ERP. Un fallo de validación nuestro es un
  // 422: el admin no tiene nada que revisar allá, el dato está mal de este lado.
  throw createErrorExpuesto(
    origen === "local" ? 422 : 502,
    mensaje,
    e.siesaData ?? null,
  );
}

/**
 * El PROVEEDOR retira su propia propuesta.
 *
 * POR QUÉ EXISTE
 * Un proveedor que se equivocó al escribir el precio quedaba atrapado: el
 * candado `idx_pp_solicitudes_pendiente_unica` permite una sola propuesta viva
 * por renglón, así que tampoco podía mandar la correcta. Su única salida era
 * esperar a que le rechazaran la equivocada.
 *
 * LAS TRES GUARDAS
 *
 * 1. `cuenta_id` sale del JWT, nunca del body. Un proveedor anulando la
 *    propuesta de otro no es un bug menor (ARQUITECTURA §5).
 * 2. Solo en `pendiente`, y la condición viaja en el UPDATE: si un admin la tomó
 *    entre el clic y la escritura, afecta 0 filas y no pasa nada. El precio ya
 *    pudo haber salido hacia SIESA y el proveedor ya no manda sobre eso.
 * 3. La firma NO se toca. `pp_firmas` es append-only y la propuesta existió;
 *    haberla retirado no la desfirma.
 *
 * @returns {Promise<{id: number, estado: "anulada"}>}
 */
export async function anular({ solicitudId, cuenta, userId, ip }) {
  const { data, error } = await supabase
    .from("pp_solicitudes_precio")
    .update({ estado: "anulada", resuelto_at: new Date().toISOString() })
    .eq("id", solicitudId)
    // Las dos condiciones son la guarda, no un filtro de comodidad.
    .eq("cuenta_id", cuenta.id)
    .eq("estado", "pendiente")
    .select("id, item")
    .maybeSingle();

  if (error) throw new Error(`No se pudo anular: ${error.message}`);

  // Mensaje deliberadamente igual para "no existe", "es de otro" y "ya se
  // resolvió": distinguirlos le diría a un proveedor si existe la solicitud de
  // otro. Y el 409 es el correcto para el caso real —el admin llegó primero—,
  // que es el único que le va a pasar a un proveedor legítimo.
  if (!data) {
    throw createError(
      409,
      "La solicitud ya no está pendiente. Es posible que Merkahorro ya la haya resuelto.",
    );
  }

  await auditar({
    entidad: "pp_solicitudes_precio",
    entidadId: solicitudId,
    accion: "anular",
    estadoAnterior: "pendiente",
    estadoNuevo: "anulada",
    // El actor es el proveedor, no un admin: queda con su rol para que la
    // auditoría no lo confunda con una acción interna.
    actorUserId: userId ?? null,
    actorRol: "pp_proveedor",
    detalle: { item: data.item },
    ip,
  });

  return { id: solicitudId, estado: "anulada" };
}

/**
 * Devuelve una solicitud FALLIDA a la cola, para poder volver a intentarla.
 *
 * POR QUÉ EXISTE
 *
 * `fallida` se diseñó para "SIESA rechazó, que lo mire una persona" — y eso está
 * bien. Lo que faltaba era la salida: sin esto, una solicitud que falló por una
 * causa ARREGLABLE (un bug nuestro en el payload, un maestro que faltaba en el
 * ERP, un corte de red) quedaba muerta para siempre, y el proveedor tenía que
 * volver a proponer y firmar todo de nuevo.
 *
 * La regla no era "nunca reintentar": era **nunca reintentar SOLO**. La
 * diferencia es quién decide.
 *
 * POR QUÉ NO RE-EMPUJA DIRECTO
 *
 * Devuelve la solicitud a `pendiente` y limpia el ancla de idempotencia; el
 * empuje vuelve a pasar por `aprobar()`, con todas sus guardas: verificación de
 * firma y candado atómico. Un "reintentar" que empujara por su cuenta sería un
 * segundo camino hacia SIESA, y dos caminos se desincronizan.
 *
 * EL RIESGO QUE HAY QUE MIRAR ANTES
 *
 * Un fallo puede ser "SIESA rechazó" (no entró nada) o "se cortó la respuesta"
 * (pudo haber entrado). En el segundo caso, reintentar duplica el precio. Por eso
 * esto es una decisión humana explícita y queda registrada con nombre.
 */
/** Estados que una persona puede devolver a la cola. Ver migración 004. */
const REVISABLES = new Set(["fallida", "incierto"]);

export async function reintentar({ solicitudId, admin, ip }) {
  const { data: solicitud, error } = await supabase
    .from("pp_solicitudes_precio")
    .select("id, estado, siesa_respuesta, siesa_verificacion")
    .eq("id", solicitudId)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer la solicitud: ${error.message}`);
  if (!solicitud) throw createError(404, "La solicitud no existe");
  // fallida = SIESA lo rechazó.  incierto = SIESA lo aceptó y la relectura
  // no lo encontró (o lo encontró distinto). Las dos necesitan que una persona
  // mire el ERP y decida; ninguna se reintenta sola.
  if (!REVISABLES.has(solicitud.estado)) {
    throw createError(
      409,
      `Solo se puede devolver a la cola una solicitud con problema o incierta. Esta está en "${solicitud.estado}".`,
    );
  }

  const { data: vuelta, error: errUpd } = await supabase
    .from("pp_solicitudes_precio")
    .update({
      estado: "pendiente",
      // Se limpia el ancla para que `aprobar()` pueda volver a tomarla. Es
      // justamente el candado que impide el doble empuje, así que soltarlo es la
      // parte deliberada de esta operación — y por eso solo la hace un humano.
      siesa_aplicado_at: null,
      resuelto_at: null,
      resuelto_por: null,
      // La verificación describía el intento ANTERIOR. Dejarla puesta sobre una
      // solicitud que volvió a "pendiente" haría que la bandeja mostrara un
      // "no encontrado en SIESA" de un empuje que ya no existe. El porqué del
      // reintento no se pierde: queda en pp_auditoria, que es append-only.
      siesa_verificacion: null,
    })
    .eq("id", solicitudId)
    // La condición vuelve a mirar el estado para que dos admins no la suelten a
    // la vez. Va sobre los dos revisables, no sobre "fallida" sola.
    .in("estado", [...REVISABLES])
    .select("id")
    .maybeSingle();

  if (errUpd) throw new Error(`No se pudo reintentar: ${errUpd.message}`);
  if (!vuelta) throw createError(409, "La solicitud ya fue modificada por otra persona.");

  await auditar({
    entidad: "pp_solicitudes_precio",
    entidadId: solicitudId,
    accion: "reintentar",
    estadoAnterior: solicitud.estado,
    estadoNuevo: "pendiente",
    actorUserId: admin.userId,
    actorRol: "pp_admin",
    // Se guarda el fallo anterior: si alguien reintenta tres veces la misma cosa,
    // la auditoría tiene que poder mostrar contra qué se estrelló cada vez.
    detalle: {
      falloAnterior: solicitud.siesa_respuesta ?? null,
      // Se guarda acá porque la columna se limpia arriba: es el único rastro de
      // por qué esta solicitud volvió a la cola.
      verificacionAnterior: solicitud.siesa_verificacion ?? null,
    },
    ip,
  });

  return { id: solicitudId, estado: "pendiente" };
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
    // Se traen los datos del ítem para el aviso: sin esto haría falta releer la
    // fila que se acaba de escribir.
    .select(
      "id, item, descripcion_item, unidad_medida, precio_propuesto, " +
        "fecha_activacion, motivo_rechazo, cuenta_id",
    )
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

  // El aviso de RECHAZO es el que más le sirve al proveedor: es el único
  // desenlace que le pide hacer algo —leer el motivo y decidir si vuelve a
  // proponer—. Sin correo se entera solo si entra al portal por su cuenta.
  const { data: cuenta } = await supabase
    .from("pp_cuentas")
    .select("correo_notificacion")
    .eq("id", data.cuenta_id)
    .maybeSingle();

  const aviso = await notificarResolucion({
    solicitud: data,
    correo: cuenta?.correo_notificacion,
    estado: "rechazada",
  });

  return { id: solicitudId, estado: "rechazada", avisoAlProveedor: aviso };
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
