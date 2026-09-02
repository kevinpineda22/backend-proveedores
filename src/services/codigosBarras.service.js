/* =============================================================================
   Códigos de barras del catálogo

   POR QUÉ EXISTE
   El proveedor busca sus productos por el código de barras de la etiqueta — es
   lo que tiene a mano cuando está mirando la caja. El catálogo del portal traía
   solo el código SIESA (`1032`) y la descripción, y ninguno de los dos está
   impreso en el producto.

   DE DÓNDE SALEN
   De `siesa_codigos_barras`, que llena el módulo SiesaPosSync en el mismo
   proyecto de Supabase. **No es una tabla `pp_`**: el portal la LEE y no la
   escribe ni la mantiene. Si algún día ese módulo la cambia, esto es lo único
   que hay que tocar.

   Cobertura medida el 2026-09-02 sobre las 18.748 cotizaciones del catálogo:

     · 18.682 (99,6 %) tienen código para ese ítem Y esa unidad de medida
     ·     13 (0,1 %)  tienen código, pero solo en otra unidad
     ·     53 (0,3 %)  no tienen ninguno

   LAS TRES REGLAS QUE NO SON OBVIAS

   1. **Un ítem+U.M. tiene VARIOS códigos, y no todos son escaneables.** El ítem
      150 en UND convive con `7702044200486` (el EAN de la etiqueta),
      `M7702044200486`, `150UND` (código interno) y `150+`. Mostrarle `150UND` a
      un proveedor no le sirve para nada.

   2. **El `+` final no existe para el lector.** SIESA guarda 19.651 códigos con
      un `+` al final y ninguna etiqueta física lo tiene. Se compara siempre
      normalizado. Es la misma regla que documenta `siesaMatching.js` del módulo
      ecommerce; no se importa de allá porque acá alcanza con normalizar, y
      acoplar dos módulos por una línea sale más caro que la línea.

   3. **La unidad de medida es parte de la llave.** El mismo ítem tiene códigos
      distintos en UND y en P2 — son cajas distintas con etiquetas distintas.
      Buscar solo por ítem devolvería el código de la presentación equivocada.
   ============================================================================= */

import { supabase } from "../config/supabase.js";

/** Sin espacios, en mayúsculas y sin el `+` final que SIESA agrega. */
export const normalizarCodigo = (v) =>
  String(v ?? "").trim().toUpperCase().replace(/\+$/, "");

const llave = (item, unidadMedida) =>
  `${String(item ?? "").trim()}|${String(unidadMedida ?? "").trim().toUpperCase()}`;

/**
 * ¿Este código sirve para que un humano encuentre el producto?
 *
 * Un EAN/UPC es todo dígitos y tiene entre 8 y 14. Lo que queda afuera son los
 * códigos internos (`150UND`), los que llevan prefijo de sistema
 * (`M7702044200486`) y los que son el número de ítem disfrazado (`150+` → `150`,
 * cuatro dígitos). Ninguno está impreso en una caja.
 *
 * Se filtra para MOSTRAR, no para BUSCAR: si alguien tiene anotado un código
 * interno, que lo encuentre igual.
 */
export const esEscaneable = (codigo) => {
  const c = normalizarCodigo(codigo);
  return /^\d{8,14}$/.test(c);
};

/**
 * Códigos de barras para una lista de renglones del catálogo.
 *
 * Se piden solo los ítems que hacen falta, en lotes: la tabla tiene 101.868
 * filas y traerla entera para el catálogo de un proveedor —1.237 renglones en el
 * caso más grande— sería pedir cien veces lo que se usa.
 *
 * @param {Array<{item: number|string, unidadMedida: string}>} renglones
 * @returns {Promise<Map<string, {codigos: string[], principal: string|null}>>}
 *   Indexado por `"item|UM"`.
 */
export async function codigosDe(renglones = []) {
  const items = [...new Set(renglones.map((r) => r?.item).filter((v) => v != null))];
  if (!items.length) return new Map();

  const filas = [];
  const TAM = 300; // `in` con miles de valores arma una URL que PostgREST rechaza
  for (let i = 0; i < items.length; i += TAM) {
    const { data, error } = await supabase
      .from("siesa_codigos_barras")
      .select("f120_id, codigo_barras, unidad_medida")
      .in("f120_id", items.slice(i, i + TAM));

    // Un fallo acá NO puede tumbar el catálogo: el proveedor perdería la
    // pantalla entera por no poder mostrar una columna de ayuda. Se avisa y se
    // sigue sin códigos.
    if (error) {
      console.error(`[codigosBarras] no se pudieron leer: ${error.message}`);
      return new Map();
    }
    filas.push(...(data ?? []));
  }

  const mapa = new Map();
  for (const f of filas) {
    const k = llave(f.f120_id, f.unidad_medida);
    if (!mapa.has(k)) mapa.set(k, new Set());
    const c = normalizarCodigo(f.codigo_barras);
    if (c) mapa.get(k).add(c);
  }

  const resultado = new Map();
  for (const [k, set] of mapa) {
    const codigos = [...set].sort();
    const escaneables = codigos.filter(esEscaneable);
    resultado.set(k, {
      codigos,
      // El que se muestra. Se prefiere el EAN de 13 —el estándar de góndola en
      // Colombia— antes que cualquier otro largo, y `null` si no hay ninguno
      // escaneable: es más honesto que mostrar `150UND` como si fuera el código
      // de la etiqueta.
      principal:
        escaneables.find((c) => c.length === 13) ?? escaneables[0] ?? null,
    });
  }
  return resultado;
}

/** Engancha los códigos a cada renglón del catálogo. */
export function conCodigos(renglones, mapa) {
  return renglones.map((r) => {
    const e = mapa.get(llave(r.item, r.unidadMedida));
    return {
      ...r,
      codigoBarras: e?.principal ?? null,
      // Todos, para que el buscador encuentre por cualquiera — incluido el
      // interno que alguien pueda tener anotado.
      codigosBarras: e?.codigos ?? [],
    };
  });
}
