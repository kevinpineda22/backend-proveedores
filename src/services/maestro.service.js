/* =============================================================================
   Maestro de proveedores

   ⚠️ FUENTE PROVISIONAL — se reemplaza cuando llegue la consulta de TERCEROS.

   La consulta de cotizaciones ya trae todo lo que el maestro necesita:
   `IdTercero`, `NitTercero`, `Sucursal`, `DescSucursal` y `RazonSocial`. Con eso
   se puede derivar el maestro HOY y arrancar el flujo completo — asociar correo,
   invitar, ingresar, cotizar— sin esperar nada.

   QUÉ CAMBIA CUANDO LLEGUE LA CONSULTA DE TERCEROS

   Solo esta función. Las tablas, los endpoints y el panel quedan igual, porque
   `pp_proveedores` y `pp_cuentas` ya tienen la forma final.

   QUÉ LE FALTA A ESTA VERSIÓN, Y HAY QUE TENERLO PRESENTE

   Solo ve proveedores CON COTIZACIONES. Un tercero dado de alta en SIESA al que
   todavía no se le cargó ningún precio no aparece acá, y no se le puede asociar
   un correo. Con la consulta de terceros esa limitación desaparece.

   QUÉ NO PISA, NUNCA

   `porcentaje_max`, `bloqueado` y todo lo de `pp_cuentas` (correo, user_id,
   estado) son datos NUESTROS, no de SIESA. El upsert los deja intactos: si esta
   sincronización los sobrescribiera, cada corrida del cron borraría los topes que
   Merkahorro configuró a mano y desactivaría a los proveedores ya invitados.
   ============================================================================= */

import { supabase } from "../config/supabase.js";
import { consultaTerceros, consultarTerceros } from "../config/connekta.js";

/**
 * Extrae proveedores y sucursales únicos de cotizaciones YA NORMALIZADAS.
 *
 * Recibe la salida de `agruparCotizaciones()`, no filas de `pp_cotizaciones`:
 * el snapshot no persiste `nombreSucursal` ni `razonSocial` —se repetirían
 * 18.000 veces— pero sí los tiene en memoria mientras corre. Derivar de ahí evita
 * dos columnas redundantes en cada fila del catálogo.
 *
 * Función pura: el agrupado se prueba sin tocar la base.
 *
 * @param {Array<{idTercero, nit, sucursal, nombreSucursal, razonSocial}>} filas
 * @returns {{proveedores: object[], cuentas: object[]}}
 */
/**
 * Fila CRUDA de la consulta de terceros → la forma que consume `derivarMaestro`.
 *
 * Los alias son los MISMOS que ya trae la de cotizaciones —se pidieron así a
 * propósito— y los CHAR de SQL Server llegan con relleno: `"1020414979      "`.
 * Verificado contra la respuesta real de Connekta el 2026-08-31.
 */
export function normalizarTercero(cruda) {
  const t = (v) => String(v ?? "").trim();
  return {
    idTercero: t(cruda?.IdTercero),
    nit: t(cruda?.NitTercero),
    razonSocial: t(cruda?.RazonSocial),
    sucursal: t(cruda?.Sucursal),
    nombreSucursal: t(cruda?.DescSucursal),
  };
}

export function derivarMaestro(filas = []) {
  const proveedores = new Map();
  const cuentas = new Map();

  for (const f of filas) {
    const nit = String(f?.nit ?? "").trim();
    const sucursal = String(f?.sucursal ?? "").trim();
    if (!nit || !sucursal) continue;

    if (!proveedores.has(nit)) {
      proveedores.set(nit, {
        nit,
        id_tercero: String(f.idTercero ?? nit).trim(),
        razon_social: String(f.razonSocial ?? "").trim() || null,
      });
    }

    const clave = `${nit}|${sucursal}`;
    if (!cuentas.has(clave)) {
      cuentas.set(clave, {
        nit,
        sucursal,
        nombre_sucursal: String(f.nombreSucursal ?? "").trim() || null,
      });
    }
  }

  return { proveedores: [...proveedores.values()], cuentas: [...cuentas.values()] };
}

/** Parte un arreglo en lotes. */
const enLotes = (arr, tam = 500) => {
  const lotes = [];
  for (let i = 0; i < arr.length; i += tam) lotes.push(arr.slice(i, i + tam));
  return lotes;
};

/**
 * Sincroniza `pp_proveedores` y `pp_cuentas` desde el snapshot de cotizaciones.
 *
 * NO BORRA NADA. Un proveedor que dejó de tener cotizaciones sigue en el maestro
 * con su cuenta y su historial de solicitudes. Borrarlo dejaría solicitudes
 * huérfanas y le cortaría el acceso a alguien que quizá solo está entre
 * negociaciones. El alta es automática; la baja es una decisión de Merkahorro.
 *
 * @returns {Promise<{proveedores: number, cuentas: number, duracionMs: number}>}
 */
/**
 * De dónde sale el maestro.
 *
 * Con `SIESA_CONSULTA_TERCEROS` configurada se lee el maestro DE VERDAD, que
 * incluye proveedores todavía sin precios cargados. Sin ella se sigue derivando
 * de las cotizaciones, que es lo que funciona hoy. Ver PENDIENTES §1.1.
 *
 * Si la consulta de terceros falla, NO se cae al fallback en silencio: un
 * maestro derivado tiene un agujero conocido, y taparlo con un log escondido es
 * cómo se llega a "el proveedor nuevo no aparece y nadie sabe por qué".
 */
async function leerFuente(cotizaciones) {
  if (!consultaTerceros()) {
    return { filas: cotizaciones, fuente: "pp_cotizaciones (provisional)" };
  }
  const crudas = await consultarTerceros();
  return { filas: crudas.map(normalizarTercero), fuente: consultaTerceros() };
}

/**
 * Cuántos proveedores puede PERDER una corrida antes de que se considere un
 * filtro mal puesto. 0 = ninguno: el maestro solo debería crecer.
 */
const PERDIDA_TOLERADA = Number(process.env.PROVEEDORES_MAESTRO_PERDIDA_TOLERADA) || 0;

export async function sincronizarMaestro(cotizaciones = []) {
  const inicio = Date.now();
  const { filas, fuente } = await leerFuente(cotizaciones);
  const { proveedores, cuentas } = derivarMaestro(filas);

  /*
   * GUARDA DEL FILTRO. El maestro NO borra a nadie —el upsert usa
   * `ignoreDuplicates`— así que un filtro de más no rompe nada hoy: rompe el
   * día que alguien mire la lista y crea que ésos son todos los proveedores.
   *
   * El riesgo es concreto y medido: de los 337 proveedores con acuerdos de
   * precio, 57 son PERSONAS NATURALES con NIT de cédula. Un filtro razonable a
   * primera vista —"sacar las personas, que son empleados"— se lleva al 17 % de
   * los proveedores reales, y nadie se entera hasta que uno llama preguntando
   * por qué no puede entrar.
   *
   * Por eso se compara contra lo que YA hay. El maestro solo debería crecer.
   */
  const { data: existentes } = await supabase.from("pp_proveedores").select("nit");
  const conocidos = new Set((existentes ?? []).map((p) => p.nit));
  const traidos = new Set(proveedores.map((p) => p.nit));
  const perdidos = [...conocidos].filter((nit) => !traidos.has(nit));

  if (perdidos.length > PERDIDA_TOLERADA) {
    console.error(
      `[maestro] 🔴 la fuente "${fuente}" NO trae ${perdidos.length} proveedor(es) que ya ` +
        `están en el maestro. Si es la consulta de terceros, el filtro está de más: ` +
        `recordá que 57 proveedores legítimos tienen NIT de persona natural. ` +
        `Ejemplos: ${perdidos.slice(0, 8).join(", ")}. ` +
        `Nadie se borra —el upsert no borra— pero la lista quedó incompleta.`,
    );
  }

  for (const lote of enLotes(proveedores)) {
    // `ignoreDuplicates` es la pieza clave: si el proveedor ya existe, NO se toca.
    // Sin esto, cada corrida pisaría `porcentaje_max` y `bloqueado` con los
    // defaults, borrando los topes que Merkahorro configuró a mano.
    const { error } = await supabase
      .from("pp_proveedores")
      .upsert(lote, { onConflict: "nit", ignoreDuplicates: true });
    if (error) throw new Error(`Maestro: falló el upsert de proveedores — ${error.message}`);
  }

  for (const lote of enLotes(cuentas)) {
    // Igual acá: una cuenta ya invitada conserva su correo, su user_id y su estado.
    const { error } = await supabase
      .from("pp_cuentas")
      .upsert(lote, { onConflict: "nit,sucursal", ignoreDuplicates: true });
    if (error) throw new Error(`Maestro: falló el upsert de cuentas — ${error.message}`);
  }

  const resultado = {
    proveedores: proveedores.length,
    cuentas: cuentas.length,
    fuente,
    // Cuántos proveedores ya conocidos NO vinieron en esta corrida. Debe ser 0.
    proveedoresNoTraidos: perdidos.length,
    duracionMs: Date.now() - inicio,
  };

  try {
    await supabase.from("pp_auditoria").insert({
      entidad: "pp_proveedores",
      accion: "sincronizar_maestro",
      actor_rol: "cron",
      detalle: { ...resultado, fuente },
    });
  } catch (e) {
    console.error("[maestro] no se pudo registrar la corrida:", e?.message);
  }

  return resultado;
}
