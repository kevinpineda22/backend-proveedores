/* =============================================================================
   Connekta — lectura de la consulta de cotizaciones

   Adaptado de `backend-traslado/src/config/connekta.js`.

   LA CONSULTA SE RECORRE PAGINADA. La vieja `merkahorro_cotizaciones_dev` no
   aceptaba `paginacion` y había que traer todo de un saque; la nueva
   (docs/CONSULTA-COTIZACIONES.sql) sí, y eso cambia el panorama:

     · Medido 2026-08-27: 18.960 filas, 190 páginas de 100, ~1 s por página.
     · Ya no hace falta el parámetro por NIT que se había planeado para partir
       la carga. La paginación lo resuelve mejor: no depende de tener la lista de
       terceros, y no hay proveedor que se quede afuera por no estar en el maestro.

   Igual sigue sin llamarse NUNCA dentro de un request de usuario: son 190 viajes
   a SIESA. La hace el cron del snapshot.
   ============================================================================= */

import axios from "axios";
import "dotenv/config";

const cfg = {
  baseUrl: () =>
    process.env.CONNEKTA_BASE_URL || "https://servicios.siesacloud.com/api/connekta/v3",
  idCompania: () => process.env.SIESA_ID_COMPANIA || "7375",
  consulta: () => process.env.SIESA_CONSULTA_COTIZACIONES || "merkahorro_cotizaciones_dev",
  key: () => process.env.CONNI_KEY,
  token: () => process.env.CONNI_TOKEN,
};

/* ─── Reintentos ────────────────────────────────────────────────────────────
   Connekta corre sobre SQL Server y bajo carga devuelve 500 con un deadlock. El
   propio motor te dice qué hacer: reintentar. También reintentamos 429 (rate
   limit) y cortes de red. Un 4xx que no sea 429 es culpa nuestra —query mal
   escrita, credenciales— y reintentar no lo arregla.
   ────────────────────────────────────────────────────────────────────────── */

const MAX_INTENTOS = Number(process.env.CONNEKTA_MAX_INTENTOS) || 4;
const BACKOFF_BASE_MS = 800;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const esDeadlock = (detalle) => /deadlock/i.test(String(detalle || ""));

export function esReintentable(error) {
  const status = error?.response?.status;
  if (!status) return true; // timeout / socket cortado / DNS → transitorio
  if (status === 429) return true;
  return status >= 500;
}

/**
 * Cuánto esperar antes del próximo intento.
 *
 * Si Connekta dice cuándo se libera el rate limit (`connekta-rate-limit-reset`,
 * formato "mm:ss"), le hacemos caso. Si no, backoff exponencial con jitter — el
 * jitter importa: sin él, varios workers reintentan al unísono y se vuelven a
 * deadlockear entre ellos.
 */
export function esperaAntesDeReintentar(error, intento) {
  const reset = error?.response?.headers?.["connekta-rate-limit-reset"];
  if (reset) {
    const [mm, ss] = String(reset).split(":").map(Number);
    if (Number.isFinite(mm) && Number.isFinite(ss)) return (mm * 60 + ss) * 1000 + 500;
  }
  const base = BACKOFF_BASE_MS * 2 ** (intento - 1);
  return base + Math.random() * base;
}

export function configFaltante() {
  const faltan = [];
  if (!cfg.key()) faltan.push("CONNI_KEY");
  if (!cfg.token()) faltan.push("CONNI_TOKEN");
  return faltan;
}

/** Filas por página. 100 es lo que sugiere Connekta; 1.000 baja los viajes a 19. */
const TAM_PAGINA = Number(process.env.CONNEKTA_TAM_PAGINA) || 1000;

/**
 * Techo de páginas. No es una optimización: es un fusible.
 *
 * El corte del bucle depende de `total_páginas`, un número que manda SIESA. Si un
 * día viene mal —o no viene—, sin este techo el snapshot pediría páginas para
 * siempre, contra el ERP de producción, dentro de un cron que corre solo.
 */
const MAX_PAGINAS = Number(process.env.CONNEKTA_MAX_PAGINAS) || 2000;

/** Una página, con los reintentos. */
async function pedirPagina({ pagina, tamPag, idTercero, descripcion = cfg.consulta() }) {
  // Mismo formato `nombre=valor` que backend-traslado ya usa en
  // siesaStock.service.js (`parametros=f120_id=<item>`).
  const parametros = idTercero ? `IdTercero=${String(idTercero).trim()}` : undefined;

  let ultimoError;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      const { data } = await axios.get(`${cfg.baseUrl()}/ejecutarconsulta`, {
        headers: { conniKey: cfg.key(), conniToken: cfg.token() },
        params: {
          idCompania: cfg.idCompania(),
          descripcion,
          paginacion: `numPag=${pagina}|tamPag=${tamPag}`,
          // axios omite los `undefined`: sin proveedor no se manda el parámetro.
          ...(parametros ? { parametros } : {}),
        },
        timeout: 120_000,
      });

      if (data?.codigo !== 0) {
        throw new Error(
          `Connekta error [${data?.codigo}]: ${data?.mensaje || ""} — ${data?.detalle || ""}`,
        );
      }

      const d = data?.detalle ?? {};
      const filas = d.Table ?? d.Datos ?? [];
      if (!Array.isArray(filas)) {
        throw new Error("Connekta devolvió un detalle sin arreglo de filas");
      }

      return {
        filas,
        // La clave viene con tilde. Escribirla sin tilde devuelve `undefined`, el
        // bucle cortaría en la página 1 y el snapshot quedaría con el 5% del
        // catálogo — sin error, sin aviso, sin nada raro en los logs.
        totalPaginas: Number(d["total_páginas"] ?? d.total_paginas ?? 1) || 1,
        totalRegistros: Number(d.total_registros ?? 0) || 0,
      };
    } catch (error) {
      ultimoError = error;
      if (!esReintentable(error) || intento === MAX_INTENTOS) break;

      const espera = esperaAntesDeReintentar(error, intento);
      const causa = esDeadlock(error?.response?.data?.detalle)
        ? "deadlock"
        : error?.response?.status || error.code || "error de red";
      console.warn(
        `[connekta] pág ${pagina} falló (${causa}) — reintento ${intento}/${MAX_INTENTOS - 1} en ${Math.round(espera)}ms`,
      );
      await dormir(espera);
    }
  }

  const detalle = ultimoError?.response?.data?.detalle;
  const status = ultimoError?.response?.status;

  // Cuántos intentos hubo DE VERDAD. Antes decía siempre `MAX_INTENTOS`, y con un
  // 401 —que no se reintenta— el mensaje afirmaba "tras 4 intentos" habiendo hecho
  // uno solo. Un log que miente sobre lo que pasó manda a buscar el problema al
  // lugar equivocado: parecía saturación cuando era un permiso.
  const intentos = esReintentable(ultimoError) ? MAX_INTENTOS : 1;

  throw new Error(
    `Connekta falló en la página ${pagina} tras ${intentos} intento${intentos === 1 ? "" : "s"}` +
      `${status ? ` [HTTP ${status}]` : ""}: ` +
      `${detalle || ultimoError?.response?.data?.mensaje || ultimoError?.message || "error desconocido"}`,
    { cause: ultimoError },
  );
}

/**
 * Recorre la consulta de cotizaciones completa, página por página.
 *
 * @param {object} [opciones]
 * @param {string} [opciones.idTercero] Limita a un proveedor. Hoy no hace falta
 *   —la paginación alcanza— pero queda por si la consulta llega a crecer tanto
 *   que convenga partirla por proveedor.
 * @param {number} [opciones.tamPag]
 * @returns {Promise<object[]>} Filas crudas, tal como las manda SIESA.
 */
/**
 * Nombre de la consulta de TERCEROS en Connekta, o `null` si todavía no existe.
 *
 * Mientras sea `null`, el maestro se sigue derivando de las cotizaciones — que
 * funciona, pero solo ve proveedores CON precios cargados. Ver PENDIENTES §1.1.
 */
export const consultaTerceros = () =>
  process.env.SIESA_CONSULTA_TERCEROS?.trim() || null;

/**
 * Recorre la consulta de TERCEROS (proveedores y sus sucursales).
 *
 * Devuelve las filas CRUDAS, con los mismos alias que ya usa la de cotizaciones
 * —`IdTercero`, `NitTercero`, `RazonSocial`, `Sucursal`, `DescSucursal`—, así
 * que el normalizador es casi el mismo. Verificado contra la respuesta real de
 * Connekta el 2026-08-31.
 *
 * @throws {Error} si `SIESA_CONSULTA_TERCEROS` no está configurada. No devuelve
 *   una lista vacía: un maestro vacío se vería igual que "no hay proveedores".
 */
export async function consultarTerceros({ tamPag = TAM_PAGINA } = {}) {
  const descripcion = consultaTerceros();
  if (!descripcion) {
    throw new Error(
      "Falta SIESA_CONSULTA_TERCEROS: no hay consulta de terceros configurada.",
    );
  }
  return recorrer({ tamPag, descripcion });
}

/**
 * Recorre una consulta paginada de Connekta, página por página.
 *
 * Extraído porque ahora hay DOS consultas —cotizaciones y terceros— y el bucle
 * es el mismo: los reintentos, el techo de páginas y el aviso de conjunto movido
 * valen igual para las dos. Duplicarlo garantizaba que una se arreglara y la
 * otra no.
 */
async function recorrer({ tamPag, descripcion, idTercero }) {
  const faltan = configFaltante();
  if (faltan.length) throw new Error(`Falta configuración de Connekta: ${faltan.join(", ")}`);

  const filas = [];
  let pagina = 1;
  let totalPaginas = 1;
  let totalRegistros = 0;

  do {
    const r = await pedirPagina({ pagina, tamPag, idTercero, descripcion });

    // Una página vacía antes del final significa que `total_páginas` mentía o que
    // el conjunto se movió. Cortar acá evita seguir pidiendo páginas que no existen.
    if (r.filas.length === 0) break;

    filas.push(...r.filas);
    totalPaginas = r.totalPaginas;
    totalRegistros = r.totalRegistros;
    pagina += 1;
  } while (pagina <= totalPaginas && pagina <= MAX_PAGINAS);

  if (pagina > MAX_PAGINAS) {
    console.warn(
      `[connekta] ${descripcion}: se alcanzó el techo de ${MAX_PAGINAS} páginas con ` +
        `${filas.length} filas. El resultado está INCOMPLETO — subí CONNEKTA_MAX_PAGINAS.`,
    );
  }

  // La paginación no es atómica: entre la primera página y la última, SIESA puede
  // haber insertado o borrado filas, y el recorrido se pierde algunas o repite.
  // No es motivo para fallar —el snapshot con una fila de menos sirve igual— pero
  // sí para dejarlo dicho: si esto aparece siempre, la consulta necesita un
  // ORDER BY estable del lado de SIESA.
  if (totalRegistros && filas.length !== totalRegistros) {
    console.warn(
      `[connekta] ${descripcion}: se esperaban ${totalRegistros} filas y llegaron ` +
        `${filas.length}. El conjunto cambió mientras se paginaba.`,
    );
  }

  return filas;
}

export async function consultarCotizaciones({ idTercero, tamPag = TAM_PAGINA } = {}) {
  return recorrer({ tamPag, idTercero, descripcion: cfg.consulta() });
}
