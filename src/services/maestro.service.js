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
import { ciaDominante } from "./normalizarCotizacion.js";

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
    // Agregada a la consulta el 2026-09-07. Es lo que resuelve los nombres
    // duplicados de sucursal, ver `derivarMaestro`.
    idCia: t(cruda?.IdCia),
  };
}

/**
 * ¿Cuál de dos nombres describe mejor a la MISMA sucursal?
 *
 * ⚠️ RED DE SEGURIDAD, YA NO EL CAMINO PRINCIPAL.
 *
 * El problema: la consulta de terceros devuelve el mismo `(nit, sucursal)` más de
 * una vez con descripciones distintas, porque el `INNER JOIN` contra
 * `t202_mm_proveedores` empareja por compañía y un tercero dado de alta en dos
 * compañías del grupo aparece dos veces:
 *
 *     900256457 | 001 → "COPA ZONA 2  RAMA"  y  "ZONA 2 DISTRIBUCIONES SAS"
 *     800088702 | 001 → "EPS SURA"           y  "EPS SURAMERICANA SA"
 *
 * Ganaba el primero que llegaba, y como la consulta **no puede llevar `ORDER BY`**
 * el orden no está garantizado: el nombre cambiaba de una corrida del cron a la
 * siguiente sin que nadie tocara nada.
 *
 * **Resuelto de fondo el 2026-09-07**: la consulta ahora trae `IdCia` y
 * `derivarMaestro` se queda con la fila de la compañía donde viven los PRECIOS.
 * Eso resolvió los 138 pares ambiguos, los 138, sin perder ni un proveedor.
 *
 * Esta función queda para el caso que el dato no puede decidir: dos filas de la
 * MISMA compañía, o una corrida sin `IdCia`. El criterio es que gana el nombre que
 * NO es la razón social —cuando una compañía no le puso nombre propio a la
 * sucursal, SIESA repite el de la empresa, que es el genérico— y desempata el
 * orden alfabético. Arbitrario, pero ESTABLE, que es lo único que se le pide.
 *
 * No se borra porque un empate silencioso que elige al azar es exactamente el bug
 * que esto vino a cerrar.
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

/**
 * @param {Array} filas             salida de `normalizarTercero`
 * @param {string|null} ciaConPrecios  la compañía donde viven las cotizaciones
 */
export function derivarMaestro(filas = [], ciaConPrecios = null) {
  const proveedores = new Map();
  const cuentas = new Map();
  const cia = String(ciaConPrecios ?? "").trim();

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
    const suCia = String(f.idCia ?? "").trim();

    const ya = cuentas.get(clave);
    if (!ya) {
      cuentas.set(clave, { nit, sucursal, nombre_sucursal: nombre, _cia: suCia });
      continue;
    }

    /* DUPLICADO. Gana la fila de la compañía donde están los PRECIOS.
       Es el nombre que compras reconoce, porque es el de la operación real.
       Medido el 2026-09-07: resuelve los 138 pares ambiguos, los 138. */
    if (cia && suCia === cia && ya._cia !== cia) {
      cuentas.set(clave, { nit, sucursal, nombre_sucursal: nombre, _cia: suCia });
      continue;
    }
    if (cia && ya._cia === cia && suCia !== cia) continue; // el que está ya es el bueno

    /* Las dos filas son de la misma compañía —o no sabemos cuál tiene precios—.
       Ahí no hay dato que decida y se cae al desempate por nombre, que al menos
       es ESTABLE. No debería pasar: se deja porque un empate silencioso que
       elige al azar es exactamente el bug que esto vino a cerrar. */
    ya.nombre_sucursal = mejorNombreSucursal(
      ya.nombre_sucursal,
      nombre,
      proveedores.get(nit)?.razon_social,
    );
  }

  // `_cia` es andamiaje: no es una columna de `pp_cuentas` y el upsert la
  // rechazaría.
  const limpias = [...cuentas.values()].map(({ _cia, ...c }) => c);
  return { proveedores: [...proveedores.values()], cuentas: limpias };
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

  /* En qué compañía de SIESA viven los precios. Se MIDE sobre las cotizaciones
     de esta misma corrida —no se fija a mano— y es lo que desempata los nombres
     de sucursal duplicados. Ver `derivarMaestro`. */
  const cia = ciaDominante(cotizaciones);
  if (!cia) {
    /* Sin cia no se rompe nada: se cae al desempate por nombre, que es estable
       aunque adivine. Pero se avisa, porque significa que la consulta dejó de
       traer `IdCia` — y el síntoma silencioso sería nombres cambiando solos. */
    console.warn(
      "[maestro] las cotizaciones no traen IdCia: los nombres de sucursal " +
        "duplicados se resuelven por heurística. ¿Se cambió la consulta?",
    );
  }

  const { proveedores, cuentas } = derivarMaestro(filas, cia);

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
