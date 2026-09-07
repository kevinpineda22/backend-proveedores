/* =============================================================================
   Solicitudes de cambio de precio — crear, aprobar, rechazar

   Acá se juntan las tres reglas del proyecto: el tope sobre costo neto, la firma
   atada al contenido, y el empuje idempotente a SIESA.

   DESDE LA MIGRACIÓN 006 UNA SOLICITUD ES UN PAQUETE

       pp_solicitudes       → el paquete. Tiene LA firma.  Una solicitud, una firma.
       pp_solicitud_lineas  → cada producto. Tiene SU estado.

   El proveedor firma una vez; el admin resuelve línea por línea. No se
   contradicen: la firma dice qué propuso el PROVEEDOR —y eso no cambia porque
   Merkahorro apruebe tres de cuatro—, y el estado dice qué decidió MERKAHORRO,
   que es por producto porque se negocia por producto.

   Por eso casi todas las funciones de acá abajo reciben `lineaIds` y no un id de
   solicitud: aprobar "todo el paquete" es mandar todas sus líneas.
   ============================================================================= */

import { codigosDe, conCodigos } from "./codigosBarras.service.js";
import { supabase } from "../config/supabase.js";
import { createError, createErrorExpuesto } from "../middleware/errorHandler.js";
import { costoNeto, evaluarPropuesta } from "./costoNeto.js";
import { hoyEnColombia, porcentajesDescuento, separarVigentes } from "./normalizarCotizacion.js";
import { registrarFirma, verificarFirmaDeSolicitud } from "./firma.service.js";
import { importarLote } from "./siesaCotizacion.js";
import { verificarEnSiesa, NO_CONFIRMA } from "./verificarCotizacion.js";
import { revalidarTope } from "./revalidarTope.js";
import { notificarResolucion } from "./notificacion.service.js";
import { avisarSolicitudNueva } from "./compras.service.js";
import {
  hermanasDe,
  vigentesEnSucursal,
  claveEnSucursal,
  planificarReplicas,
} from "./grupos.service.js";

const SELECT_COTIZACION =
  "clave, clave_item, id_tercero, nit, sucursal, moneda, item, descripcion_item, unidad_medida, fecha_activacion, precio, impuestos, descuentos";

const SELECT_LINEA = "*";

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

/* ═══════════════════════════════════════════════════════════════════════════
   CREAR
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Crea una solicitud: un paquete de productos con UNA firma.
 *
 * El orden de los pasos no es casual: primero se valida TODO el paquete contra
 * los precios que el SERVIDOR leyó, y recién después se registra la firma.
 * Firmar antes dejaría firmas huérfanas de propuestas que nunca existieron.
 */
export async function crearSolicitud({ cuenta, usuario, datos, ip, userAgent }) {
  const hoy = hoyEnColombia();

  /* ── 1. Validar y evaluar cada línea contra el precio del servidor ──────── */
  const preparadas = [];
  for (const l of datos.lineas) {
    const vigente = await vigenteDe(cuenta, l.claveItem);

    /* Los mensajes nombran el PRODUCTO. Con un paquete de cuarenta, "el producto
       no está disponible" obliga a adivinar cuál de los cuarenta — y el proveedor
       termina borrando de a uno hasta que pasa. */
    if (!vigente) {
      throw createError(
        404,
        `Uno de los productos no está disponible para cotizar en su catálogo (${l.claveItem}).`,
      );
    }
    if (!(vigente.precio > 0)) {
      throw createError(
        409,
        `"${vigente.descripcionItem}" no tiene un precio vigente en el sistema. ` +
          `Quítelo de la solicitud o comuníquese con Merkahorro.`,
      );
    }
    /* FUTURA, no "de hoy en adelante".
       María José (compras), 2026-09-07: *"la fecha sí o sí debe ser una fecha
       futura, no tiene sentido permitir que la fecha sea pasada"*.

       Hoy tampoco entra, y el caso no es teórico: un pedido puesto esta mañana al
       precio viejo y recibido esta tarde entraría al nuevo. Es la fecha
       retroactiva otra vez, en chiquito.

       La pantalla ya lo impide, pero la regla vive ACÁ: el portal no es el único
       que puede llamar a esta API, y una regla que solo existe en el navegador es
       una sugerencia. */
    if (l.fechaActivacion <= hoy) {
      throw createError(
        422,
        `El precio de "${vigente.descripcionItem}" tiene que regir desde una fecha futura, ` +
          `no desde hoy ni antes.`,
      );
    }

    const evaluacion = evaluarPropuesta({
      precioActual: vigente.precio,
      descuentosActuales: porcentajesDescuento(vigente),
      precioPropuesto: l.precioPropuesto,
      descuentosPropuestos: l.descuentosPropuestos.map((d) => d.porcentaje),
      topePct: cuenta.porcentajeMax,
    });

    /* `impuestosPropuestos` ausente significa "no los tocó". Se resuelve ACÁ, una
       sola vez, y a partir de este punto la columna siempre tiene la lista
       EFECTIVA: lo que se firma, lo que ve el admin y lo que se le manda a SIESA
       son el mismo array. Dejar el `undefined` viajando obligaría a que cada
       consumidor volviera a decidir qué significa, y alguno se equivocaría. */
    const impuestosPropuestos = l.impuestosPropuestos ?? vigente.impuestos ?? [];

    preparadas.push({ linea: l, vigente, evaluacion, impuestosPropuestos });
  }

  /* ── 2. La firma, sobre el paquete COMPLETO ─────────────────────────────── */
  //
  // EL TOPE AVISA, NO FRENA — decidido por Johan el 2026-08-27. Una propuesta que
  // supera el tope se crea igual, queda marcada, y la decide un humano. Es
  // sostenible porque nada llega a SIESA sin aprobación explícita, pero SOLO si
  // la marca se ve: `excede` viaja en la respuesta y la bandeja lo muestra por
  // línea. Que se pierda de vista es la forma en que esta decisión sale mal.
  const firma = await registrarFirma({
    cuentaId: cuenta.id,
    userId: usuario.id,
    datos: {
      cuentaId: cuenta.id,
      lineas: preparadas.map((p) => ({
        claveItem: p.vigente.claveItem,
        item: p.vigente.item,
        unidadMedida: p.vigente.unidadMedida,
        precioActual: p.vigente.precio,
        descuentosActuales: p.vigente.descuentos,
        impuestosVigentes: p.vigente.impuestos,
        precioPropuesto: p.linea.precioPropuesto,
        descuentosPropuestos: p.linea.descuentosPropuestos,
        impuestosPropuestos: p.impuestosPropuestos,
        fechaActivacion: p.linea.fechaActivacion,
      })),
    },
    trazo: datos.firma,
    ip,
    userAgent,
  });

  /* ── 3. La cabecera ────────────────────────────────────────────────────── */
  const { data: cabecera, error: errCab } = await supabase
    .from("pp_solicitudes")
    .insert({ cuenta_id: cuenta.id, firma_id: firma.id })
    .select("id")
    .single();

  if (errCab) throw new Error(`No se pudo crear la solicitud: ${errCab.message}`);

  /* ── 4. Las líneas propias + las réplicas a sucursales hermanas ─────────── */
  const { replicas, omitidas } = await armarReplicas({ cuenta, preparadas });

  const filas = [
    ...preparadas.map((p) => ({
      solicitud_id: cabecera.id,
      cuenta_destino_id: cuenta.id,
      origen: "proveedor",
      clave_item: p.vigente.claveItem,
      item: p.vigente.item,
      descripcion_item: p.vigente.descripcionItem,
      unidad_medida: p.vigente.unidadMedida,
      precio_actual: p.vigente.precio,
      descuentos_actuales: p.vigente.descuentos,
      impuestos_vigentes: p.vigente.impuestos,
      costo_neto_actual: p.evaluacion.costoActual,
      precio_propuesto: p.linea.precioPropuesto,
      descuentos_propuestos: p.linea.descuentosPropuestos,
      impuestos_propuestos: p.impuestosPropuestos,
      costo_neto_propuesto: p.evaluacion.costoPropuesto,
      variacion_pct: p.evaluacion.variacionPct,
      porcentaje_max_vigente: cuenta.porcentajeMax,
      fecha_activacion: p.linea.fechaActivacion,
      notas: p.linea.notas,
    })),
  ];

  const { data: insertadas, error: errLin } = await supabase
    .from("pp_solicitud_lineas")
    .insert(filas)
    .select("id, clave_item, item, descripcion_item, unidad_medida, variacion_pct");

  if (errLin) {
    /* La cabecera ya existe y las líneas no. Supabase no da transacciones desde
       el cliente, así que se limpia a mano: una cabecera sin líneas es una
       solicitud fantasma que aparece en la bandeja del admin sin nada adentro.

       La FIRMA no se borra —`pp_firmas` es append-only por trigger— y está bien:
       el proveedor firmó, ese hecho ocurrió. Queda una firma sin solicitud, que
       es inofensiva y honesta. */
    await supabase.from("pp_solicitudes").delete().eq("id", cabecera.id);

    if (errLin.code === "23505") {
      // 23505 = violación de único. Acá solo puede ser `idx_pp_lineas_pendiente_unica`:
      // ya hay una propuesta viva sobre alguno de estos renglones. No es un error
      // del sistema, es una condición de negocio.
      throw createError(
        409,
        "Ya tiene una solicitud pendiente para alguno de estos productos. " +
          "Espere la respuesta o anúlela antes de enviar otra.",
      );
    }
    throw new Error(`No se pudieron crear las líneas de la solicitud: ${errLin.message}`);
  }

  /* Las réplicas van DESPUÉS y en su propio insert: si fallaran, la solicitud del
     proveedor ya existe y no se puede perder por un problema de una configuración
     interna que él ni conoce. Se registra el fallo y se sigue. */
  let replicadas = 0;
  if (replicas.length) {
    const porClave = new Map(insertadas.map((i) => [i.clave_item, i.id]));
    const filasReplica = replicas.map((r) => ({
      solicitud_id: cabecera.id,
      cuenta_destino_id: r.cuenta.id,
      origen: "replica",
      replica_de_id: porClave.get(r.claveItemOrigen) ?? null,
      clave_item: r.vigente.claveItem,
      item: r.vigente.item,
      descripcion_item: r.vigente.descripcionItem,
      unidad_medida: r.vigente.unidadMedida,
      precio_actual: r.vigente.precio,
      descuentos_actuales: r.vigente.descuentos,
      impuestos_vigentes: r.vigente.impuestos,
      costo_neto_actual: r.evaluacion.costoActual,
      precio_propuesto: r.propuesta.precio,
      descuentos_propuestos: r.propuesta.descuentos,
      impuestos_propuestos: r.propuesta.impuestos,
      costo_neto_propuesto: r.evaluacion.costoPropuesto,
      variacion_pct: r.evaluacion.variacionPct,
      porcentaje_max_vigente: cuenta.porcentajeMax,
      fecha_activacion: r.propuesta.fechaActivacion,
      notas: r.propuesta.notas,
    }));

    const { error: errRep } = await supabase.from("pp_solicitud_lineas").insert(filasReplica);
    if (errRep) {
      console.error(
        `[replica] solicitud ${cabecera.id}: no se pudieron crear ${filasReplica.length} ` +
          `líneas replicadas — ${errRep.message}`,
      );
    } else {
      replicadas = filasReplica.length;
    }
  }

  await auditar({
    entidad: "pp_solicitudes",
    entidadId: cabecera.id,
    accion: "crear",
    estadoNuevo: "pendiente",
    actorUserId: usuario.id,
    actorRol: "pp_proveedor",
    detalle: {
      lineas: insertadas.length,
      replicadas,
      // Las omitidas quedan registradas: son renglones que el proveedor cree que
      // van a las dos sucursales y solo van a una. El admin tiene que poder verlo.
      omitidas,
      excedenTope: preparadas.filter((p) => p.evaluacion.excede).length,
    },
    ip,
  });

  /* El aviso a compras va último y NO puede romper nada: la solicitud ya existe.
     Si el correo falla, el proveedor no tiene por qué enterarse ni reintentar. */
  const avisoCompras = await avisarSolicitudNueva({
    solicitudId: cabecera.id,
    cuenta,
    lineas: preparadas.map((p) => ({
      descripcion: p.vigente.descripcionItem,
      item: p.vigente.item,
      unidadMedida: p.vigente.unidadMedida,
      precioActual: p.vigente.precio,
      precioPropuesto: p.linea.precioPropuesto,
      variacionPct: p.evaluacion.variacionPct,
      excede: p.evaluacion.excede,
      // Un cambio de impuesto NO pasa por el tope —lo fija la ley, no se
      // negocia—, así que el único control es que una persona lo mire. Va
      // marcado en el correo para que se vea sin abrir el portal.
      cambiaImpuestos: cambianImpuestos(p.vigente.impuestos, p.impuestosPropuestos),
    })),
  });

  return {
    id: cabecera.id,
    lineas: insertadas.map((i, n) => ({
      id: i.id,
      claveItem: i.clave_item,
      descripcion: i.descripcion_item,
      ...preparadas[n].evaluacion,
    })),
    replicadas,
    omitidas,
    avisoCompras,
  };
}

/**
 * ¿Esta propuesta toca los impuestos?
 *
 * Compara por llave+valor, sin importar el orden: la consulta de SIESA duplica el
 * renglón por impuesto y el agrupador los acumula en un array cuyo orden no está
 * garantizado. Comparar los arrays crudos daría "cambió" cuando no cambió nada.
 */
export function cambianImpuestos(vigentes = [], propuestos = []) {
  const canon = (lista) =>
    [...(lista ?? [])]
      .filter((i) => i && i.llave != null)
      .map((i) => `${i.llave}:${Number(i.valor ?? 0).toFixed(4)}`)
      .sort()
      .join(",");
  return canon(vigentes) !== canon(propuestos);
}

/** Lee las hermanas y planifica qué se replica y qué no. Una consulta por hermana. */
async function armarReplicas({ cuenta, preparadas }) {
  const hermanas = await hermanasDe(cuenta);
  if (!hermanas.length) return { replicas: [], omitidas: [] };

  const items = preparadas.map((p) => p.vigente.item);
  const catalogos = new Map();
  for (const h of hermanas) {
    catalogos.set(h.id, await vigentesEnSucursal(h, items, aCotizacion));
  }

  const replicas = [];
  const omitidas = [];

  for (const p of preparadas) {
    const propuesta = {
      precio: p.linea.precioPropuesto,
      descuentos: p.linea.descuentosPropuestos,
      impuestos: p.impuestosPropuestos,
      fechaActivacion: p.linea.fechaActivacion,
      notas: p.linea.notas,
    };

    const plan = planificarReplicas({
      propuesta,
      topePct: cuenta.porcentajeMax,
      hermanas: hermanas.map((h) => ({
        cuenta: h,
        vigente:
          catalogos.get(h.id)?.get(claveEnSucursal(p.vigente.item, p.vigente.unidadMedida)) ?? null,
      })),
    });

    for (const r of plan.replicas) {
      replicas.push({ ...r, claveItemOrigen: p.vigente.claveItem });
    }
    for (const o of plan.omitidas) {
      omitidas.push({ ...o, item: p.vigente.item, descripcion: p.vigente.descripcionItem });
    }
  }

  return { replicas, omitidas };
}

/* ═══════════════════════════════════════════════════════════════════════════
   LECTURA
   ═══════════════════════════════════════════════════════════════════════════ */

/** Todas las líneas de una solicitud, réplicas incluidas. */
async function lineasDeSolicitud(solicitudId) {
  const { data, error } = await supabase
    .from("pp_solicitud_lineas")
    .select(SELECT_LINEA)
    .eq("solicitud_id", solicitudId)
    .order("id");

  if (error) throw new Error(`No se pudieron leer las líneas: ${error.message}`);
  return data ?? [];
}

/* ═══════════════════════════════════════════════════════════════════════════
   APROBAR
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Aprueba un conjunto de líneas y las empuja a SIESA.
 *
 * EL ORDEN IMPORTA Y NO SE CAMBIA:
 *
 *   1. Verificar la firma  — del PAQUETE, aunque se apruebe una sola línea.
 *   2. TOMAR las líneas    — UPDATE condicionado. Es el candado de idempotencia.
 *   3. Empujar a SIESA     — recién ahora.
 *
 * Tomar ANTES de empujar significa que, en el peor caso, una línea queda marcada
 * sin haberse enviado: sale como `fallida` con el detalle y alguien la revisa. Al
 * revés —empujar y después marcar— el peor caso es mandar el mismo precio dos
 * veces. En Traslados eso ya pasó: la misma salida se importó tres veces por no
 * tener este candado.
 *
 * SE AGRUPA POR SUCURSAL DESTINO, no en un solo plano gigante.
 * Se midió que el conector acepta varios encabezados (CONTRATO-SIESA §5bis), pero
 * lo que se midió fue un plano de una sola sucursal. Mezclar sucursales en un
 * mismo plano no se probó, y un lote es todo-o-nada: si el ERP lo rechazara por
 * eso, caerían también las líneas que no tienen nada que ver.
 */
export async function aprobarLineas({ lineaIds, admin, ip, confirmaDesactualizado = false }) {
  const { data: lineas, error } = await supabase
    .from("pp_solicitud_lineas")
    .select(SELECT_LINEA)
    .in("id", lineaIds);

  if (error) throw new Error(`No se pudieron leer las líneas: ${error.message}`);
  if (!lineas?.length) throw createError(404, "No se encontró ninguna de esas líneas.");

  const noPendientes = lineas.filter((l) => l.estado !== "pendiente");
  if (noPendientes.length) {
    throw createError(
      409,
      `${noPendientes.length} de las líneas seleccionadas ya fueron resueltas ` +
        `(${[...new Set(noPendientes.map((l) => l.estado))].join(", ")}). Actualice la bandeja.`,
    );
  }

  /* ── 1. La firma, del paquete completo ──────────────────────────────────── */
  const porSolicitud = new Map();
  for (const l of lineas) {
    if (!porSolicitud.has(l.solicitud_id)) porSolicitud.set(l.solicitud_id, []);
    porSolicitud.get(l.solicitud_id).push(l);
  }

  for (const solicitudId of porSolicitud.keys()) {
    const { data: solicitud } = await supabase
      .from("pp_solicitudes")
      .select("*")
      .eq("id", solicitudId)
      .maybeSingle();

    if (!solicitud) throw createError(404, `La solicitud ${solicitudId} no existe`);

    // Con TODAS sus líneas, no solo las que se están aprobando: si alguien le
    // agregó un producto al paquete después de la firma, aprobar una línea "sana"
    // del mismo paquete tiene que frenarse igual.
    const firma = await verificarFirmaDeSolicitud(solicitud, await lineasDeSolicitud(solicitudId));
    if (!firma.valida) {
      await auditar({
        entidad: "pp_solicitudes",
        entidadId: solicitudId,
        accion: "firma_invalida",
        actorUserId: admin.userId,
        actorRol: "pp_admin",
        detalle: { motivo: firma.motivo },
        ip,
      });
      throw createError(409, firma.motivo);
    }
  }

  /* ── 2. ¿La marca que el admin está mirando sigue siendo cierta? ─────────── */
  //
  // `variacion_pct` se congeló al proponer. Si SIESA movió el precio desde
  // entonces, la bandeja puede estar mostrando "dentro del tope" sobre una base
  // que ya no existe. Va ANTES del candado: si frena, las líneas tienen que
  // quedar `pendiente` y sin marca de empuje, listas para que otro las mire.
  const cuentas = await cuentasDe(lineas.map((l) => l.cuenta_destino_id));

  for (const l of lineas) {
    const cuenta = cuentas.get(l.cuenta_destino_id);
    if (!cuenta?.nit) continue;

    let revision = null;
    try {
      revision = revalidarTope(l, await vigenteDe(cuenta, l.clave_item));
    } catch (e) {
      // No poder releer no puede impedir aprobar: sería dejar el sistema colgado
      // de una consulta. Queda el rastro y sigue.
      console.warn(`[aprobar] no se pudo revalidar el tope de la línea ${l.id}: ${e.message}`);
    }

    // Solo frena `empeora`: hoy supera el tope y al proponer NO lo superaba. Si
    // ya lo superaba, el admin está viendo la marca roja y no hay nada nuevo que
    // avisarle — un aviso que sale siempre deja de significar algo.
    if (revision?.empeora && !confirmaDesactualizado) {
      throw createErrorExpuesto(
        409,
        `El precio de SIESA cambió desde que se propuso "${l.descripcion_item}": era ` +
          `$${revision.precioAntes} y hoy es $${revision.precioHoy}. Con el precio de hoy la ` +
          `propuesta es del ${revision.variacionHoy}% y SUPERA el tope de ` +
          `${l.porcentaje_max_vigente}% (cuando se propuso era ${revision.variacionAntes}%). ` +
          `Revísela antes de aprobar.`,
        { lineaId: l.id, ...revision },
      );
    }
  }

  /* ── 3. El candado ──────────────────────────────────────────────────────── */
  const ahora = new Date().toISOString();
  const { data: tomadas, error: errTomar } = await supabase
    .from("pp_solicitud_lineas")
    .update({
      estado: "aprobada",
      siesa_aplicado_at: ahora,
      resuelto_at: ahora,
      resuelto_por: admin.userId,
    })
    .in("id", lineaIds)
    .eq("estado", "pendiente")
    .is("siesa_aplicado_at", null)
    .select(SELECT_LINEA);

  if (errTomar) throw new Error(`No se pudieron tomar las líneas: ${errTomar.message}`);
  if (!tomadas?.length) throw createError(409, "Las líneas ya fueron procesadas por otra persona.");

  if (tomadas.length !== lineas.length) {
    // Alguien tomó parte del lote entre la lectura y el candado. Las que sí se
    // tomaron ya están marcadas, así que hay que seguir con ellas: soltarlas sería
    // dejarlas marcadas y sin empujar.
    console.warn(
      `[aprobar] se pidieron ${lineas.length} líneas y se tomaron ${tomadas.length}: ` +
        `otra persona resolvió el resto mientras tanto.`,
    );
  }

  /* ── 4. Empuje, agrupado por sucursal destino ───────────────────────────── */
  const porDestino = new Map();
  for (const l of tomadas) {
    if (!porDestino.has(l.cuenta_destino_id)) porDestino.set(l.cuenta_destino_id, []);
    porDestino.get(l.cuenta_destino_id).push(l);
  }

  const resultados = [];
  for (const [cuentaId, lote] of porDestino) {
    resultados.push(...(await empujarLote({ cuentaId, lote, cuentas, admin, ip })));
  }

  return { lineas: resultados };
}

/** Las cuentas destino que hacen falta, con su tercero. Una sola consulta. */
async function cuentasDe(ids) {
  const { data, error } = await supabase
    .from("pp_cuentas")
    // `correo_notificacion` viaja para el aviso del final: es la misma fila.
    .select("id, nit, sucursal, correo_notificacion, pp_proveedores(id_tercero)")
    .in("id", [...new Set(ids)]);

  if (error) throw new Error(`No se pudieron leer las cuentas: ${error.message}`);
  return new Map((data ?? []).map((c) => [c.id, c]));
}

/**
 * Empuja UN lote (todas las líneas de la misma sucursal) y registra el desenlace.
 *
 * Todo-o-nada: el lote es UNA transacción del ERP. Si falla, TODAS las líneas del
 * lote van a `fallida`; marcar solo algunas mentiría sobre lo que quedó escrito.
 */
async function empujarLote({ cuentaId, lote, cuentas, admin, ip }) {
  const cuenta = cuentas.get(cuentaId);
  const idTercero = cuenta?.pp_proveedores?.id_tercero;
  const sucursal = cuenta?.sucursal;

  // El try envuelve SOLO el empuje. Todo lo que viene después es contabilidad
  // NUESTRA, y no puede terminar marcando "fallida": ese estado significa "SIESA
  // rechazó" y habilita reintentar. Si un fallo de nuestra base cayera acá, le
  // diríamos al admin que reintente un precio que el ERP YA aceptó — o sea, que
  // lo duplique.
  let r;
  try {
    r = await importarLote({
      referencia: `líneas ${lote.map((l) => l.id).join(",")}`,
      cotizaciones: lote.map((l) => ({
        vigente: {
          claveItem: l.clave_item,
          idTercero,
          sucursal,
          item: l.item,
          unidadMedida: l.unidad_medida,
          impuestos: l.impuestos_vigentes ?? [],
        },
        propuesta: {
          claveItem: l.clave_item,
          precio: Number(l.precio_propuesto),
          descuentos: l.descuentos_propuestos ?? [],
          // La lista EFECTIVA, resuelta al crear. Nunca `undefined` acá: si lo
          // fuera, armarPayload re-emitiría los vigentes y un impuesto que el
          // proveedor quitó volvería solo, en contra de lo que firmó.
          impuestos: l.impuestos_propuestos ?? [],
          fechaActivacion: l.fecha_activacion,
          notas: l.notas ?? "",
        },
      })),
    });
  } catch (e) {
    return await marcarLoteFallido({ lote, admin, ip, e });
  }

  /* SIESA respondiendo "exitosa" NO prueba que el precio haya quedado: la
     solicitud #5 lo demostró. Se relee y se compara, LÍNEA POR LÍNEA — un acuse
     sobre un plano de veinte no dice que entraron las veinte. */
  const resultados = [];
  for (const l of lote) {
    const verificacion = r.sandbox
      ? null
      : await verificarEnSiesa({
          idTercero,
          sucursal,
          item: l.item,
          unidadMedida: l.unidad_medida,
          fechaActivacion: l.fecha_activacion,
          precioEsperado: Number(l.precio_propuesto),
          impuestosEsperados: l.impuestos_propuestos ?? [],
        });

    // "No pude comprobarlo" no es "salió mal". Solo los desenlaces que
    // CONTRADICEN el éxito mandan la línea a revisión humana.
    const incierta = Boolean(verificacion && NO_CONFIRMA.has(verificacion.estado));
    const estadoFinal = incierta ? "incierto" : "aplicada";

    const { error: errEstado } = await supabase
      .from("pp_solicitud_lineas")
      .update({
        estado: estadoFinal,
        siesa_payload: r.payload,
        siesa_respuesta: r.respuesta,
        siesa_verificacion: verificacion
          ? { ...verificacion, verificado_at: new Date().toISOString() }
          : null,
      })
      .eq("id", l.id);

    /* Este update NO puede fallar en silencio. Si lo hiciera, la línea quedaría en
       "aprobada" sin payload y esta función devolvería éxito: el sistema afirmando
       algo que no comprobó, que es justo lo que vinimos a matar del lado de SIESA.

       Queda en "aprobada" CON la marca de empuje. Es el estado seguro: el candado
       impide volver a empujarla y `reintentar()` no la toma, así que nadie puede
       duplicar el precio por accidente. Necesita una persona. */
    if (errEstado) {
      console.error(
        `[aprobar] línea ${l.id}: SIESA ACEPTÓ el cambio pero no se pudo guardar el ` +
          `estado "${estadoFinal}": ${errEstado.message}`,
        { payload: r.payload, respuesta: r.respuesta, verificacion },
      );
      await auditar({
        entidad: "pp_solicitud_lineas",
        entidadId: l.id,
        accion: "estado_no_guardado",
        estadoAnterior: "aprobada",
        estadoNuevo: "aprobada",
        actorUserId: admin.userId,
        actorRol: "pp_admin",
        detalle: { intento: estadoFinal, error: String(errEstado.message).slice(0, 800) },
        ip,
      });
      throw createErrorExpuesto(
        500,
        `El cambio de "${l.descripcion_item}" se envió a SIESA y fue ACEPTADO, pero no se ` +
          `pudo registrar en la base (${errEstado.message}). NO vuelva a aprobar esta línea: ` +
          `el precio ya se empujó. Avise a desarrollo.`,
        { lineaId: l.id, estadoIntentado: estadoFinal },
      );
    }

    await auditar({
      entidad: "pp_solicitud_lineas",
      entidadId: l.id,
      accion: "aprobar",
      estadoAnterior: "pendiente",
      estadoNuevo: estadoFinal,
      actorUserId: admin.userId,
      actorRol: "pp_admin",
      detalle: {
        sandbox: Boolean(r.sandbox),
        origen: l.origen,
        enLoteDe: lote.length,
        verificacion: verificacion?.estado ?? null,
        verificacionMotivo: verificacion?.motivo ?? null,
      },
      ip,
    });

    resultados.push({
      id: l.id,
      estado: estadoFinal,
      sandbox: Boolean(r.sandbox),
      verificacion: verificacion ?? null,
    });
  }

  /* El aviso al proveedor va ÚLTIMO y no puede romper nada: acá el precio ya se
     empujó al ERP. `notificarResolucion` no lanza, y un `incierto` no se avisa —no
     se le dice a un proveedor que su precio quedó aplicado sin haberlo comprobado.

     Solo por las líneas PROPIAS: una réplica es una decisión interna de
     Merkahorro, y el proveedor no sabe que existe. */
  for (const res of resultados) {
    const l = lote.find((x) => x.id === res.id);
    if (l.origen === "replica") continue;
    res.avisoAlProveedor = await notificarResolucion({
      solicitud: aFilaDeAviso(l),
      correo: cuenta?.correo_notificacion,
      estado: res.estado,
    });
  }

  return resultados;
}

/** `notificacion.service` habla en columnas de la tabla vieja. Se traduce acá. */
const aFilaDeAviso = (l) => ({
  item: l.item,
  descripcion_item: l.descripcion_item,
  unidad_medida: l.unidad_medida,
  precio_propuesto: l.precio_propuesto,
  fecha_activacion: l.fecha_activacion,
  motivo_rechazo: l.motivo_rechazo,
});

/**
 * Marca TODO el lote como `fallido` cuando SIESA RECHAZÓ el empuje.
 *
 * Se llama SOLO desde el catch que envuelve `importarLote`. Fuera de ahí, un
 * fallo ya no es "SIESA rechazó" sino un problema nuestro, y marcarlo `fallida`
 * invitaría a reintentar un precio que el ERP aceptó.
 *
 * Todas las líneas del lote, sin excepción: fue una sola transacción del ERP.
 * Marcar una sí y otra no diría que entró media, y nadie sabe eso.
 */
async function marcarLoteFallido({ lote, admin, ip, e }) {
  /* Tres orígenes distintos, y confundirlos manda al admin a buscar donde no es:
       false      → no salió de acá (formato/config). SIESA nunca lo vio.
       true       → el ERP lo rechazó explícitamente. Nada quedó escrito.
       undefined  → se cortó la red o venció el timeout. NO SABEMOS si llegó.
     El tercero es el peligroso: es el único donde reintentar puede duplicar. */
  const origen =
    e.enviadoASiesa === false
      ? "local"
      : e.enviadoASiesa === true
        ? "rechazo_erp"
        : "sin_respuesta";

  const cuantos = lote.length === 1 ? "El cambio" : `Los ${lote.length} cambios`;
  const mensaje =
    origen === "local"
      ? `${cuantos} NO se enviaron a SIESA — los datos no pasaron la validación: ${e.message}`
      : origen === "rechazo_erp"
        ? `SIESA rechazó el envío: ${e.message}`
        : `No hubo respuesta de SIESA: ${e.message}. Puede haber llegado igual.`;

  await supabase
    .from("pp_solicitud_lineas")
    .update({
      estado: "fallida",
      siesa_payload: e.payload ?? null,
      siesa_respuesta: e.siesaData ?? { origen, error: String(e.message).slice(0, 800) },
    })
    .in("id", lote.map((l) => l.id));

  for (const l of lote) {
    await auditar({
      entidad: "pp_solicitud_lineas",
      entidadId: l.id,
      accion: "empuje_fallido",
      estadoAnterior: "aprobada",
      estadoNuevo: "fallida",
      actorUserId: admin.userId,
      actorRol: "pp_admin",
      detalle: {
        origen,
        enLoteDe: lote.length,
        error: String(e.message).slice(0, 800),
        httpStatus: e.httpStatus ?? null,
      },
      ip,
    });
  }

  /* EXPUESTO a propósito: el mensaje del ERP es lo único que le dice al admin qué
     corregir. Enmascararlo como "Error interno del servidor" convierte un rechazo
     accionable en un misterio, y obliga a leer los logs de Vercel para operar.
     502 solo cuando el problema es del ERP; un fallo de validación nuestro es un
     422 — el admin no tiene nada que revisar allá, el dato está mal de este lado. */
  throw createErrorExpuesto(origen === "local" ? 422 : 502, mensaje, e.siesaData ?? null);
}

/* ═══════════════════════════════════════════════════════════════════════════
   RECHAZAR
   ═══════════════════════════════════════════════════════════════════════════ */

/** Rechaza líneas. El motivo es obligatorio — lo exige también la base. */
export async function rechazarLineas({ lineaIds, motivo, admin, ip }) {
  const { data, error } = await supabase
    .from("pp_solicitud_lineas")
    .update({
      estado: "rechazada",
      motivo_rechazo: motivo,
      resuelto_at: new Date().toISOString(),
      resuelto_por: admin.userId,
    })
    .in("id", lineaIds)
    .eq("estado", "pendiente")
    .select(SELECT_LINEA);

  if (error) throw new Error(`No se pudo rechazar: ${error.message}`);
  if (!data?.length) throw createError(409, "Ninguna de esas líneas sigue pendiente.");

  const cuentas = await cuentasDe(data.map((l) => l.cuenta_destino_id));

  for (const l of data) {
    await auditar({
      entidad: "pp_solicitud_lineas",
      entidadId: l.id,
      accion: "rechazar",
      estadoAnterior: "pendiente",
      estadoNuevo: "rechazada",
      actorUserId: admin.userId,
      actorRol: "pp_admin",
      detalle: { motivo, origen: l.origen },
      ip,
    });
  }

  /* El aviso de RECHAZO es el que más le sirve al proveedor: es el único
     desenlace que le pide hacer algo —leer el motivo y decidir si vuelve a
     proponer—. Sin correo se entera solo si entra al portal por su cuenta.

     Las réplicas no se avisan: él no sabe que existen. */
  const avisos = [];
  for (const l of data) {
    if (l.origen === "replica") continue;
    avisos.push(
      await notificarResolucion({
        solicitud: aFilaDeAviso(l),
        correo: cuentas.get(l.cuenta_destino_id)?.correo_notificacion,
        estado: "rechazada",
      }),
    );
  }

  return { lineas: data.map((l) => ({ id: l.id, estado: "rechazada" })), avisos };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ANULAR — el proveedor retira su propio paquete
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * El PROVEEDOR retira su propia solicitud.
 *
 * POR QUÉ EXISTE
 * Un proveedor que se equivocó al escribir el precio quedaba atrapado: el candado
 * `idx_pp_lineas_pendiente_unica` permite una sola propuesta viva por renglón, así
 * que tampoco podía mandar la correcta.
 *
 * ANULA EL PAQUETE ENTERO, no una línea. Lo que se firmó fue el conjunto: dejar
 * media solicitud viva sería dejar vigente una firma que ampara algo que ya no
 * existe. Si quiere cambiar un producto, retira y vuelve a firmar.
 *
 * LAS TRES GUARDAS
 * 1. `cuenta_id` sale del JWT, nunca del body (ARQUITECTURA §5).
 * 2. Solo las líneas en `pendiente`, y la condición viaja en el UPDATE: si un
 *    admin tomó alguna entre el clic y la escritura, esa no se toca. El precio ya
 *    pudo haber salido hacia SIESA y el proveedor ya no manda sobre eso.
 * 3. La firma NO se toca. `pp_firmas` es append-only y la propuesta existió.
 *
 * Las RÉPLICAS se anulan también: son la sombra de la línea del proveedor, y una
 * réplica viva de una propuesta retirada le mandaría a SIESA un precio que su
 * dueño ya retiró.
 */
export async function anular({ solicitudId, cuenta, userId, ip }) {
  const { data: solicitud } = await supabase
    .from("pp_solicitudes")
    .select("id, cuenta_id")
    .eq("id", solicitudId)
    .eq("cuenta_id", cuenta.id)
    .maybeSingle();

  /* Mensaje deliberadamente igual para "no existe", "es de otro" y "ya se
     resolvió": distinguirlos le diría a un proveedor si existe la solicitud de
     otro. */
  if (!solicitud) {
    throw createError(
      409,
      "La solicitud ya no está pendiente. Es posible que Merkahorro ya la haya resuelto.",
    );
  }

  const { data, error } = await supabase
    .from("pp_solicitud_lineas")
    .update({ estado: "anulada", resuelto_at: new Date().toISOString() })
    .eq("solicitud_id", solicitudId)
    .eq("estado", "pendiente")
    .select("id, item, origen");

  if (error) throw new Error(`No se pudo anular: ${error.message}`);
  if (!data?.length) {
    throw createError(
      409,
      "La solicitud ya no está pendiente. Es posible que Merkahorro ya la haya resuelto.",
    );
  }

  await auditar({
    entidad: "pp_solicitudes",
    entidadId: solicitudId,
    accion: "anular",
    estadoAnterior: "pendiente",
    estadoNuevo: "anulada",
    // El actor es el proveedor, no un admin: queda con su rol para que la
    // auditoría no lo confunda con una acción interna.
    actorUserId: userId ?? null,
    actorRol: "pp_proveedor",
    detalle: {
      lineas: data.filter((l) => l.origen === "proveedor").length,
      replicas: data.filter((l) => l.origen === "replica").length,
    },
    ip,
  });

  return { id: solicitudId, estado: "anulada", lineas: data.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
   REINTENTAR
   ═══════════════════════════════════════════════════════════════════════════ */

/** Estados que una persona puede devolver a la cola. Ver migración 004. */
const REVISABLES = new Set(["fallida", "incierto"]);

/**
 * Devuelve líneas con problema a la cola, para poder volver a intentarlas.
 *
 * La regla nunca fue "no reintentar": era **no reintentar SOLO**. La diferencia
 * es quién decide.
 *
 * NO RE-EMPUJA DIRECTO: devuelve las líneas a `pendiente` y limpia el ancla de
 * idempotencia; el empuje vuelve a pasar por `aprobarLineas()`, con todas sus
 * guardas. Un "reintentar" que empujara por su cuenta sería un segundo camino
 * hacia SIESA, y dos caminos se desincronizan.
 *
 * EL RIESGO QUE HAY QUE MIRAR ANTES: un fallo puede ser "SIESA rechazó" (no entró
 * nada) o "se cortó la respuesta" (pudo haber entrado). En el segundo caso,
 * reintentar duplica el precio. Por eso es una decisión humana y queda registrada
 * con nombre.
 */
export async function reintentar({ lineaIds, admin, ip }) {
  const { data: lineas, error } = await supabase
    .from("pp_solicitud_lineas")
    .select("id, estado, siesa_respuesta, siesa_verificacion")
    .in("id", lineaIds);

  if (error) throw new Error(`No se pudieron leer las líneas: ${error.message}`);
  if (!lineas?.length) throw createError(404, "No se encontró ninguna de esas líneas.");

  // fallida = SIESA lo rechazó.  incierto = SIESA lo aceptó y la relectura no lo
  // encontró (o lo encontró distinto). Las dos necesitan que una persona mire el
  // ERP y decida; ninguna se reintenta sola.
  const noRevisables = lineas.filter((l) => !REVISABLES.has(l.estado));
  if (noRevisables.length) {
    throw createError(
      409,
      `Solo se puede devolver a la cola una línea con problema o incierta. ` +
        `${noRevisables.length} está(n) en "${[...new Set(noRevisables.map((l) => l.estado))].join(", ")}".`,
    );
  }

  const { data: vueltas, error: errUpd } = await supabase
    .from("pp_solicitud_lineas")
    .update({
      estado: "pendiente",
      // Se limpia el ancla para que `aprobarLineas()` pueda volver a tomarla. Es
      // justamente el candado que impide el doble empuje, así que soltarlo es la
      // parte deliberada de esta operación — y por eso solo la hace un humano.
      siesa_aplicado_at: null,
      resuelto_at: null,
      resuelto_por: null,
      // La verificación describía el intento ANTERIOR. Dejarla puesta sobre una
      // línea que volvió a "pendiente" haría que la bandeja mostrara un "no
      // encontrado en SIESA" de un empuje que ya no existe. El porqué del
      // reintento no se pierde: queda en pp_auditoria, que es append-only.
      siesa_verificacion: null,
    })
    .in("id", lineaIds)
    // La condición vuelve a mirar el estado para que dos admins no las suelten a
    // la vez.
    .in("estado", [...REVISABLES])
    .select("id")
    .order("id");

  if (errUpd) throw new Error(`No se pudo reintentar: ${errUpd.message}`);
  if (!vueltas?.length) throw createError(409, "Las líneas ya fueron modificadas por otra persona.");

  for (const l of lineas) {
    await auditar({
      entidad: "pp_solicitud_lineas",
      entidadId: l.id,
      accion: "reintentar",
      estadoAnterior: l.estado,
      estadoNuevo: "pendiente",
      actorUserId: admin.userId,
      actorRol: "pp_admin",
      // Se guarda el fallo anterior: si alguien reintenta tres veces la misma
      // cosa, la auditoría tiene que mostrar contra qué se estrelló cada vez. Y la
      // verificación se guarda acá porque la columna se limpia arriba.
      detalle: {
        falloAnterior: l.siesa_respuesta ?? null,
        verificacionAnterior: l.siesa_verificacion ?? null,
      },
      ip,
    });
  }

  return { lineas: vueltas.map((l) => ({ id: l.id, estado: "pendiente" })) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   CATÁLOGO
   ═══════════════════════════════════════════════════════════════════════════ */

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

  /* Las pendientes de ESTA cuenta. `origen = 'proveedor'` porque una réplica que
     aterrizó acá la generó el sistema para la sucursal hermana: mostrarla en el
     catálogo le revelaría al proveedor un reparto interno que no maneja — y le
     bloquearía el renglón con una propuesta que él no hizo. */
  const { data: pendientes } = await supabase
    .from("pp_solicitud_lineas")
    .select(
      "id, solicitud_id, clave_item, precio_propuesto, descuentos_propuestos, " +
        "impuestos_propuestos, fecha_activacion, estado, creado_at",
    )
    .eq("cuenta_destino_id", cuenta.id)
    .eq("origen", "proveedor")
    .eq("estado", "pendiente");

  const porItem = new Map((pendientes ?? []).map((p) => [p.clave_item, p]));
  const programadasPorItem = new Map();
  for (const p of programadas) {
    if (!programadasPorItem.has(p.claveItem)) programadasPorItem.set(p.claveItem, []);
    programadasPorItem.get(p.claveItem).push(p);
  }

  const conCostos = vigentes.map((c) => ({
    ...c,
    // Se manda calculado y no solo el precio: si el frontend lo recalculara por
    // su cuenta, tendríamos dos fórmulas del mismo número y un día no coinciden.
    costoNeto: c.precio > 0 ? costoNeto(c.precio, porcentajesDescuento(c)) : null,
    solicitudPendiente: porItem.get(c.claveItem) ?? null,
    programadas: programadasPorItem.get(c.claveItem) ?? [],
  }));

  /* El código de barras es lo que el proveedor tiene A MANO: está impreso en la
     caja que está mirando. El código SIESA (`1032`) y la descripción no están en
     ningún lado del producto, así que buscar por ellos obliga a saber cómo lo
     llama Merkahorro por dentro.

     Va acá y no en `pp_cotizaciones` a propósito: el dato ya vive en
     `siesa_codigos_barras` y duplicarlo en el snapshot crearía dos verdades que
     se desincronizan. Se paga una consulta más por catálogo —que se pide una vez
     al abrir la pantalla— y a cambio no hay nada que mantener sincronizado. */
  return conCodigos(conCostos, await codigosDe(conCostos));
}

/* ═══════════════════════════════════════════════════════════════════════════ */

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
