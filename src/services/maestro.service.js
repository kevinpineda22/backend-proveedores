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
   compras configuró a mano y desactivaría a los proveedores ya invitados.
   ============================================================================= */

import { supabase } from "../config/supabase.js";

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
 * negociaciones. El alta es automática; la baja es una decisión de compras.
 *
 * @returns {Promise<{proveedores: number, cuentas: number, duracionMs: number}>}
 */
export async function sincronizarMaestro(cotizaciones = []) {
  const inicio = Date.now();
  const { proveedores, cuentas } = derivarMaestro(cotizaciones);

  for (const lote of enLotes(proveedores)) {
    // `ignoreDuplicates` es la pieza clave: si el proveedor ya existe, NO se toca.
    // Sin esto, cada corrida pisaría `porcentaje_max` y `bloqueado` con los
    // defaults, borrando los topes que compras configuró a mano.
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
    duracionMs: Date.now() - inicio,
  };

  try {
    await supabase.from("pp_auditoria").insert({
      entidad: "pp_proveedores",
      accion: "sincronizar_maestro",
      actor_rol: "cron",
      detalle: { ...resultado, fuente: "pp_cotizaciones (provisional)" },
    });
  } catch (e) {
    console.error("[maestro] no se pudo registrar la corrida:", e?.message);
  }

  return resultado;
}
