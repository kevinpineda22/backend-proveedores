/* =============================================================================
   Devoluciones a proveedores (CDP): qué se devuelve, a quién y por qué

   QUÉ RESPONDE
   Cada CDP es una devolución de mercancía al proveedor, con un MOTIVO de SIESA
   (averías, mercancía no pedida, faltantes, mal estado…) y las notas que escribió
   quien la hizo. La pantalla totaliza por motivo, proveedor, producto, sede y mes,
   y ordena lo más crítico por valor, cantidad de devoluciones y crecimiento.

   LAS REGLAS — María José (compras), 2026-09-23
   1. Todos los motivos entran; ninguno se excluye.
   2. Ventana de 6 meses.
   3. Las notas son `notas_documento`, tal cual las escribió SIESA.
   4. Compras ve todo y filtra; el proveedor ve SOLO lo de su sucursal (JWT).

   LO QUE DICEN LOS DATOS (medido el 2026-09-23 sobre 6 meses)
   - **El motivo va por LÍNEA, no por documento.** 3 devoluciones mezclan dos
     motivos. Agrupar el motivo por documento le cargaría a uno el valor del otro.
   - **Se cuentan "Facturado" Y "Contabilizado".** Desde el 2026-09-14 la réplica
     carga incremental y no vuelve a leer lo que ya trajo: una CDP que se cargó
     contabilizada no pasa nunca a facturada. Filtrar por "Facturado" dejaba
     septiembre casi vacío (292 CDP atascadas). "Anulado" y "En elaboración" no
     son devoluciones hechas: quedan afuera.
   - `valor_neto_local = bruto − descuentos + impuestos` en el 100 % de las filas,
     y ninguna tiene valor en cero. El valor que se muestra es el NETO: lo que el
     proveedor le tiene que reconocer a Merkahorro.
   - `cantidad` son unidades sueltas (`cantidad_inv` va en la U.M. del documento:
     ver el comentario de la réplica en `diferenciasCosto.js`).
   - 8.439 devoluciones y 22.758 líneas en 6 meses: la respuesta va NORMALIZADA
     (catálogos + índices) para no mandar 22.758 veces el nombre del proveedor.
   ============================================================================= */

/** Estados que son una devolución hecha. Ver la cabecera: por qué "Contabilizado". */
export const ESTADOS_DEVOLUCION = Object.freeze(["Facturado", "Contabilizado"]);

/** Ventana de consulta. María José, 2026-09-23. */
export const MESES_DEVOLUCIONES = 6;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const redondear = (n, dec = 2) => Math.round(n * 10 ** dec) / 10 ** dec;

/**
 * $1 desde (AAAA-MM-DD) · $2 hasta EXCLUSIVO · $3 estados · $4 NIT o null
 * · $5 sucursal o null
 *
 * Una fila por (devolución, proveedor, sede, ítem, motivo). El proveedor y la sede
 * entran a la llave porque la réplica tiene documentos que los mezclan; el motivo,
 * porque va por línea (ver la cabecera).
 *
 * `fecha` sale como TEXTO: un DATE lo convierte el driver en un `Date` en la hora
 * del servidor (UTC en Vercel) y corre el día.
 */
export const SQL_DEVOLUCIONES = `
SELECT documento,
       to_char(min(fecha)::date, 'YYYY-MM-DD') AS fecha,
       max(estado) AS estado,
       btrim(proveedor) AS nit,
       btrim(sucursal) AS sucursal,
       max(razon_social_proveedor) AS razon_social,
       max(desc_sucursal) AS nombre_sucursal,
       btrim(bodega) AS bodega,
       max(desc_bodega) AS nombre_bodega,
       item,
       btrim(max(desc_item)) AS descripcion,
       btrim(motivo) AS motivo,
       max(desc_motivo) AS desc_motivo,
       string_agg(DISTINCT nullif(btrim(notas_documento), ''), ' · ') AS notas,
       sum(cantidad) AS unidades,
       sum(valor_neto_local) AS valor
FROM merkahorro_siesa.compras
WHERE left(documento,3) = 'CDP'
  AND estado = ANY($3::text[])
  AND fecha >= $1::date AND fecha < $2::date
  AND ($4::text IS NULL OR btrim(proveedor) = $4)
  AND ($5::text IS NULL OR btrim(sucursal) = $5)
GROUP BY documento, btrim(proveedor), btrim(sucursal), btrim(bodega), item, btrim(motivo)
ORDER BY min(fecha) DESC, documento, item
`;

/**
 * Filas crudas → respuesta normalizada.
 *
 *   proveedores: [{ nit, sucursal, razonSocial, nombreSucursal }]
 *   sedes:       [{ bodega, nombre }]
 *   motivos:     [{ codigo, descripcion }]           orden por código
 *   productos:   { [item]: descripcion }
 *   documentos:  [{ documento, fecha, estado, proveedor, sede, notas }]
 *                 proveedor/sede = índice en su catálogo
 *   lineas:      [{ doc, item, motivo, unidades, valor }]   doc = índice en documentos
 *
 * Un "documento" es (CDP, proveedor, sede): lo que el proveedor reconoce como una
 * devolución. Si SIESA mezcló dos proveedores en un CDP, salen como dos.
 */
export function armarDevoluciones(filas) {
  const proveedores = [];
  const idxProveedor = new Map();
  const sedes = [];
  const idxSede = new Map();
  const motivos = new Map();
  const productos = {};
  const documentos = [];
  const idxDocumento = new Map();
  const lineas = [];

  for (const f of filas) {
    const clavePv = `${f.nit}|${f.sucursal}`;
    if (!idxProveedor.has(clavePv)) {
      idxProveedor.set(clavePv, proveedores.length);
      proveedores.push({
        nit: f.nit,
        sucursal: f.sucursal,
        razonSocial: f.razon_social?.trim() || f.nit,
        nombreSucursal: f.nombre_sucursal?.trim() || null,
      });
    }

    if (!idxSede.has(f.bodega)) {
      idxSede.set(f.bodega, sedes.length);
      sedes.push({ bodega: f.bodega, nombre: f.nombre_bodega?.trim() || f.bodega });
    }

    const motivo = f.motivo || "—";
    if (!motivos.has(motivo)) {
      motivos.set(motivo, { codigo: motivo, descripcion: f.desc_motivo?.trim() || "Sin motivo" });
    }

    const item = Number(f.item);
    if (!(item in productos)) productos[item] = f.descripcion || `Ítem ${item}`;

    const claveDoc = `${f.documento}|${clavePv}|${f.bodega}`;
    if (!idxDocumento.has(claveDoc)) {
      idxDocumento.set(claveDoc, documentos.length);
      documentos.push({
        documento: f.documento,
        fecha: f.fecha,
        estado: f.estado,
        proveedor: idxProveedor.get(clavePv),
        sede: idxSede.get(f.bodega),
        notas: f.notas || null,
      });
    }

    lineas.push({
      doc: idxDocumento.get(claveDoc),
      item,
      motivo,
      unidades: redondear(num(f.unidades), 4),
      valor: redondear(num(f.valor)),
    });
  }

  return {
    proveedores,
    sedes,
    motivos: [...motivos.values()].sort((a, b) => a.codigo.localeCompare(b.codigo)),
    productos,
    documentos,
    lineas,
  };
}
