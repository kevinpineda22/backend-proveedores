/* =============================================================================
   Maestro de proveedores

   FUENTE: la consulta de TERCEROS (`merkahorro_terceros_dev_cotiz`), prendida en
   producción el 2026-09-01. El maestro pasó de 337 proveedores derivados de
   cotizaciones a 3.535 leídos del maestro real: un tercero dado de alta en SIESA
   al que todavía no se le cargó ningún precio ahora aparece igual y se le puede
   habilitar el acceso.

   (Hasta esa fecha el maestro se derivaba de las cotizaciones y SOLO veía
   proveedores con precios cargados. Ya no. El SQL vive en
   docs/CONSULTA-TERCEROS.sql, que es una COPIA: el original está en Connekta.)

   EL FILTRO ES UN JOIN POR TIPO DE TERCERO, NO UN WHERE SOBRE EL NIT

   `INNER JOIN t202_mm_proveedores`. Filtrar por la FORMA del NIT —"sacar las
   personas, que son empleados"— se lleva 57 de los 337 proveedores con acuerdos
   vigentes, que son personas naturales con NIT de cédula.

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

/**
 * ¿Cuál de dos nombres describe mejor a la MISMA sucursal?
 *
 * Hace falta porque la consulta de terceros devuelve el mismo `(nit, sucursal)`
 * más de una vez con descripciones distintas — medido el 2026-09-06: **232 pares
 * duplicados de 3.679**. Vienen del `INNER JOIN` contra `t202_mm_proveedores`,
 * que empareja por `id_cia`: un tercero dado de alta en dos compañías del grupo
 * aparece dos veces, y cada compañía le puso el nombre que quiso.
 *
 *     900256457 | 001 → "COPA ZONA 2  RAMA"  y  "ZONA 2 DISTRIBUCIONES SAS"
 *     800088702 | 001 → "EPS SURA"           y  "EPS SURAMERICANA SA"
 *
 * Antes ganaba el primero que llegaba. Y como la consulta **no puede llevar
 * `ORDER BY`** (Connekta la envuelve para paginar y SQL Server lo prohíbe ahí),
 * el orden no está garantizado: el nombre de una sucursal podía cambiar de una
 * corrida del cron a la siguiente, sin que nadie tocara nada.
 *
 * El criterio: gana el nombre que NO es la razón social. Cuando una compañía no
 * le puso nombre propio a la sucursal, SIESA repite el de la empresa — que es el
 * dato genérico. El otro es el que distingue la sucursal, y es justamente el que
 * necesita la detección de sucursales hermanas (migración 007): sin él,
 * "COPA ZONA 2 RAMA" desaparece y el par no se detecta nunca.
 *
 * Si los dos difieren de la razón social —o los dos coinciden— desempata el orden
 * alfabético. Es arbitrario, pero es ESTABLE, que es lo único que se le pide a un
 * desempate.
 *
 * ⚠️ ARREGLO DE FONDO, PENDIENTE DE SIESA: agregarle `f200_id_cia` a
 * `merkahorro_terceros_dev_cotiz` y quedarse con la compañía donde viven los
 * precios. Ahí no hay que adivinar nada. Esto es el paliativo mientras tanto.
 */
export function mejorNombreSucursal(a, b, razonSocial) {
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;

  const generico = String(razonSocial ?? "").trim().toUpperCase();
  const aEsGenerico = a.trim().toUpperCase() === generico;
  const bEsGenerico = b.trim().toUpperCase() === generico;

  if (aEsGenerico !== bEsGenerico) return aEsGenerico ? b : a;
  return a <= b ? a : b;
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
    const nombre = String(f.nombreSucursal ?? "").trim() || null;

    if (!cuentas.has(clave)) {
      cuentas.set(clave, { nit, sucursal, nombre_sucursal: nombre });
    } else {
      // Duplicado: elegir, no quedarse con el que llegó primero.
      const ya = cuentas.get(clave);
      ya.nombre_sucursal = mejorNombreSucursal(
        ya.nombre_sucursal,
        nombre,
        proveedores.get(nit)?.razon_social,
      );
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
