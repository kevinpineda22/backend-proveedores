/* =============================================================================
   Seguimiento de las diferencias de costo (migración 011)

   La diferencia se CALCULA leyendo la réplica de SIESA (diferenciasCosto.js).
   Acá vive lo único que se GUARDA: si compras ya corrigió la cotización.

   DOS REGLAS
   1. **Sin fila = pendiente.** No se precarga nada.
   2. **Si la tabla no responde, la pantalla sale igual**, con el seguimiento
      marcado como no disponible. Las diferencias vienen de otra base; perderlas
      porque falló la de seguimiento esconde justo lo que hay que corregir.
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { auditar } from "./auditoria.js";

const TABLA = "pp_diferencias_seguimiento";

/* PostgREST manda el `in.(...)` en la URL. Con dos mil facturas son decenas de KB
   y el pedido se corta. De a tandas. */
const TANDA = 150;

export const llave = (doctoCausacion, item) => `${doctoCausacion}|${Number(item)}`;

/**
 * El seguimiento de las facturas pedidas, como `Map(llave → fila)`.
 * @returns {Promise<{mapa: Map, disponible: boolean}>}
 */
export async function leerSeguimiento(causaciones) {
  const unicas = [...new Set(causaciones)];
  const mapa = new Map();

  try {
    for (let i = 0; i < unicas.length; i += TANDA) {
      const { data, error } = await supabase
        .from(TABLA)
        .select("docto_causacion, item, estado, nota, actualizado_por, actualizado_at")
        .in("docto_causacion", unicas.slice(i, i + TANDA));

      // supabase-js NO lanza: devuelve {error}. Ver services/auditoria.js.
      if (error) throw new Error(error.message);
      for (const s of data ?? []) mapa.set(llave(s.docto_causacion, s.item), s);
    }
    return { mapa, disponible: true };
  } catch (e) {
    console.error(`[diferencias] no se pudo leer el seguimiento: ${e.message}`);
    return { mapa: new Map(), disponible: false };
  }
}

/** Le pega a cada fila su estado. Pura: se prueba sin base. */
export function combinar(filas, mapa) {
  return filas.map((f) => {
    const s = mapa.get(llave(f.doctoCausacion, f.item));
    return {
      ...f,
      seguimiento: {
        estado: s?.estado ?? "pendiente",
        nota: s?.nota ?? null,
        actualizadoPor: s?.actualizado_por ?? null,
        actualizadoAt: s?.actualizado_at ?? null,
      },
    };
  });
}

/**
 * Lo que ve el proveedor: el estado y la fecha, sin la nota interna ni el nombre
 * de quién la marcó. La nota es de compras para compras.
 */
export function paraProveedor(fila) {
  const { seguimiento, ...resto } = fila;
  return {
    ...resto,
    seguimiento: { estado: seguimiento.estado, actualizadoAt: seguimiento.actualizadoAt },
  };
}

/* ── El aviso de Inicio del proveedor (migración 012) ─────────────────────── */

/**
 * Hasta qué carga de la réplica el proveedor ya vio el aviso.
 *
 * NO LANZA: si la columna no existe todavía (012 sin correr) o la consulta
 * falla, devuelve null — el aviso se muestra. Mostrar de más un aviso que se
 * puede cerrar es inofensivo; dejar sin pantalla de diferencias al proveedor
 * por una columna de presentación no lo es.
 */
export async function leerVistasHasta(cuentaId) {
  try {
    const { data, error } = await supabase
      .from("pp_cuentas")
      .select("diferencias_vistas_hasta")
      .eq("id", cuentaId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data?.diferencias_vistas_hasta ?? null;
  } catch (e) {
    console.error(`[diferencias] no se pudo leer el aviso visto de la cuenta ${cuentaId}: ${e.message}`);
    return null;
  }
}

/** El proveedor oculta el aviso de Inicio hasta la carga `hasta`. Solo su cuenta. */
export async function marcarDiferenciasVistas({ cuentaId, hasta }) {
  const { error } = await supabase
    .from("pp_cuentas")
    .update({ diferencias_vistas_hasta: hasta })
    .eq("id", cuentaId);

  if (error) throw new Error(`No se pudo ocultar el aviso: ${error.message}`);
  return { vistasHasta: hasta };
}

/** Compras marca una factura+ítem como corregida o la vuelve a pendiente. */
export async function marcarSeguimiento({ doctoCausacion, item, estado, nota, admin, ip }) {
  const fila = {
    docto_causacion: doctoCausacion,
    item,
    estado,
    nota: nota || null,
    actualizado_por: admin.nombre,
    actualizado_user: admin.userId,
    actualizado_at: new Date().toISOString(), // instante, no fecha de calendario
  };

  const { data, error } = await supabase
    .from(TABLA)
    .upsert(fila, { onConflict: "docto_causacion,item" })
    .select("docto_causacion, item, estado, nota, actualizado_por, actualizado_at")
    .single();

  if (error) throw new Error(`No se pudo guardar el seguimiento: ${error.message}`);

  await auditar({
    entidad: TABLA,
    entidadId: llave(doctoCausacion, item),
    accion: "seguimiento_diferencia",
    estadoNuevo: estado,
    actorUserId: admin.userId,
    actorRol: "pp_admin",
    detalle: nota ? { nota: String(nota).slice(0, 500) } : null,
    ip,
  });

  return {
    doctoCausacion: data.docto_causacion,
    item: data.item,
    seguimiento: {
      estado: data.estado,
      nota: data.nota,
      actualizadoPor: data.actualizado_por,
      actualizadoAt: data.actualizado_at,
    },
  };
}
