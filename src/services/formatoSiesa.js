/* =============================================================================
   Formateadores del conector Cotizaciones_Compras (idDocumento 253851)

   SIESA no acepta "4672". Acepta "000000000004672.0000" — ancho fijo, relleno con
   ceros, punto obligatorio. Un campo corto se rechaza; un campo truncado entra
   MAL, que es peor, porque nadie se entera.

   La regla que gobierna todo este módulo: ante un valor que no entra en el campo,
   SE LANZA. Nunca se trunca en silencio. Un precio truncado no es un precio
   aproximado — es un precio distinto, cargado como si fuera el bueno.

   Formatos, de docs/CONTRATO-SIESA.md §6.
   ============================================================================= */

/** Los CHAR de SQL Server llegan con relleno: "UND ", "800186960      ". */
export const trim = (v) => String(v ?? "").trim();

/**
 * Decimal de ancho fijo: `enteros` dígitos + punto + `decimales` dígitos.
 *
 * @param {number|string} valor
 * @param {number} enteros    Dígitos antes del punto.
 * @param {number} decimales  Dígitos después del punto.
 * @param {string} campo      Nombre del campo, solo para el mensaje de error.
 */
export function decimal(valor, enteros, decimales, campo = "campo") {
  // `Number(null)`, `Number("")`, `Number([])` y `Number(false)` valen 0 — todos
  // pasarían el chequeo de `isFinite` y entrarían a SIESA como un precio de CERO,
  // o sea "gratis". Un dato ausente NO es un cero: se rechaza antes de convertir.
  if (valor == null || valor === "" || typeof valor === "boolean" || Array.isArray(valor)) {
    throw new TypeError(`${campo}: valor ausente o no numérico ${JSON.stringify(valor)}`);
  }

  const n = Number(valor);

  if (!Number.isFinite(n)) {
    throw new TypeError(`${campo}: valor no numérico ${JSON.stringify(valor)}`);
  }
  // El ancho es fijo y no reserva lugar para el signo: un negativo desalinearía
  // todo el registro. Y un precio negativo no existe — es data rota.
  if (n < 0) {
    throw new RangeError(`${campo}: no admite negativos (${n})`);
  }

  const texto = (Math.round((n + Number.EPSILON) * 10 ** decimales) / 10 ** decimales).toFixed(
    decimales,
  );
  const [ent, dec] = texto.split(".");

  if (ent.length > enteros) {
    throw new RangeError(
      `${campo}: ${n} tiene ${ent.length} enteros y el campo admite ${enteros}`,
    );
  }

  return `${ent.padStart(enteros, "0")}.${dec}`;
}

/** Un valor monetario cualquiera: 15 + punto + 4 = 20. Sin límite de moneda. */
export const valorMonetario = (v, campo = "VALOR") => decimal(v, 15, 4, campo);

/* Decimales significativos que el conector acepta en el PRECIO de la cotización.

   El campo tiene 4 decimales, pero el conector rechaza un precio cuyos dos
   últimos no sean cero: *"el precio no cumple con los decimales unitarios de la
   moneda"*. Verificado contra SIESA QA el 2026-09-02 — `4891.2700` entra,
   `4891.2750` vuelve con HTTP 400 sobre el registro 212.

   ⚠️ SIESA ALMACENA precios con más decimales de los que su conector acepta al
   escribir: 218 cotizaciones del catálogo (1,2 %, 36 proveedores) tienen 3 o 4,
   todas nacidas de dividir el precio de una presentación —`4891.275` es la mitad
   de `9782.55`, `4583.3333` un tercio—. O sea que el problema no lo trae el
   proveedor: lo trae el catálogo, y aparece cuando alguien propone dejar el
   precio como está y cambiar solo el descuento.

   `validators.js` lo frena en el borde de entrada, cuando todavía se puede
   corregir. Esto es la segunda red, para el precio que no viene del formulario.

   ⚠️ SOLO PARA EL PRECIO. `VALOR_IMPUESTO` usa `valorMonetario`, sin este
   límite, porque **no está verificado** que el conector lo aplique ahí: el
   rechazo que se midió fue del registro 212. Y no es teórico — hay dos ICO
   reales con 4 decimales (ítems 6213 y 17809: 22.045,0333 y 5.605,8666) que se
   RE-EMITEN tal cual, sin que el proveedor los toque. Bloquearlos sin evidencia
   dejaría esos dos productos fuera del portal por una regla inventada. Si algún
   día SIESA los rechaza, va a venir con `enviadoASiesa: true` y un detalle que
   lo diga. */
export const DECIMALES_MONEDA = 2;

/**
 * Redondea a los decimales de la moneda. **La única forma de redondear un precio
 * en este proyecto**, para que el valor que sugiere un mensaje de error sea
 * exactamente el que el sistema va a mandar.
 *
 * Ojo con el medio centavo: `4891.275` no existe en punto flotante — la máquina
 * guarda `4891.27499999…`, así que redondea a **4891.27**, no a 4891.28. Es el
 * valor que SIESA QA aceptó el 2026-09-02. `toFixed(2)` da lo mismo; la
 * diferencia entre las dos formas aparece en otros valores, no acá.
 *
 * Si algún día el negocio necesita redondeo half-up de verdad —el que llevaría
 * `4891.275` a `4891.28`— hay que hacerlo sobre la representación decimal, no
 * sobre el flotante, y cambiarlo ACÁ: es el único lugar.
 */
export const redondearAMoneda = (v) =>
  Math.round(Number(v) * 10 ** DECIMALES_MONEDA) / 10 ** DECIMALES_MONEDA;

export const precio = (v, campo = "PRECIO") => {
  const formateado = valorMonetario(v, campo);

  // Se mira el TEXTO ya formateado, no el número de entrada: `decimal()` redondea
  // con EPSILON y es su salida la que viaja a SIESA. Validar el número de antes
  // dejaría pasar lo que el redondeo pudiera cambiar.
  const decimales = formateado.split(".")[1] ?? "";
  if (decimales.slice(DECIMALES_MONEDA).replace(/0/g, "") !== "") {
    throw new RangeError(
      `${campo}: ${v} tiene más de ${DECIMALES_MONEDA} decimales y el conector lo rechaza ` +
        `("no cumple con los decimales unitarios de la moneda"). ` +
        `Redondear a ${redondearAMoneda(v)}.`,
    );
  }
  return formateado;
};

/** `F214_PORCENTAJE_DSCTO` — 3 + punto + 4 = 8. Tope real 100. */
export function porcentaje(v, campo = "%_DESCUENTO") {
  const n = Number(v);
  if (Number.isFinite(n) && n > 100) {
    throw new RangeError(`${campo}: ${n} supera el 100%`);
  }
  return decimal(v, 3, 4, campo);
}

/**
 * `F212_FECHA_ACTIVACION` — AAAAMMDD.
 *
 * NO PASA POR `Date`, Y ESO ES DELIBERADO. Este backend corre en Vercel, en UTC.
 * `new Date("2026-09-01")` se interpreta como medianoche UTC, que en Colombia
 * (UTC−5) todavía es el 31 de agosto a las 19:00. Formatear eso de vuelta con un
 * método local devuelve `20260831`: el precio arranca un día antes de lo que el
 * proveedor pidió y lo firmó.
 *
 * Acepta lo que manda Connekta (`2023-09-01T00:00:00`) y lo que devuelve un DATE
 * de Postgres (`2026-09-01`). En los dos casos los primeros 10 caracteres YA son
 * la fecha en el calendario correcto: se recortan y listo. Sin husos, sin
 * corrimientos, sin sorpresas.
 */
export function fecha(v, campo = "FECHA_ACTIVACION") {
  const s = trim(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);

  if (!m) {
    throw new TypeError(
      `${campo}: se esperaba AAAA-MM-DD o ISO, llegó ${JSON.stringify(v)}`,
    );
  }

  const [, a, mes, dia] = m;
  const nMes = Number(mes);
  const nDia = Number(dia);
  if (nMes < 1 || nMes > 12 || nDia < 1 || nDia > 31) {
    throw new RangeError(`${campo}: fecha inexistente ${s.slice(0, 10)}`);
  }

  return `${a}${mes}${dia}`;
}

/**
 * Campo alfanumérico. Recorta el relleno de SIESA y valida el largo máximo.
 * NO rellena a la derecha: el conector recibe JSON, no un archivo de ancho fijo.
 */
export function texto(v, max, campo = "campo") {
  const s = trim(v);
  if (s.length > max) {
    throw new RangeError(
      `${campo}: ${s.length} caracteres, el campo admite ${max} — "${s.slice(0, 40)}…"`,
    );
  }
  return s;
}

/** Campo entero como texto, con tope de dígitos. */
export function entero(v, maxDigitos, campo = "campo") {
  const n = Number(trim(v));
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`${campo}: se esperaba un entero ≥ 0, llegó ${JSON.stringify(v)}`);
  }
  const s = String(n);
  if (s.length > maxDigitos) {
    throw new RangeError(`${campo}: ${n} excede los ${maxDigitos} dígitos del campo`);
  }
  return s;
}

/* ── Campos del conector, con sus anchos ya puestos ───────────────────────── */

export const campo = {
  nitProveedor: (v) => texto(v, 15, "NIT_PROVEEDOR"),
  sucursal: (v) => texto(v, 3, "SUCURSAL"),
  item: (v) => entero(v, 7, "ITEM"),
  unidadMedida: (v) => texto(v, 4, "U.M"),
  fechaActivacion: (v) => fecha(v, "FECHA_ACTIVACION"),
  precio: (v) => precio(v, "PRECIO"),
  notas: (v) => texto(v ?? "", 255, "NOTAS"),
  llaveImpuesto: (v) => texto(v, 4, "LLAVE_IMPUESTO"),
  // `valorMonetario`, NO `precio`: el límite de 2 decimales está verificado solo
  // para el precio del encabezado. Ver la nota en `precio`.
  valorImpuesto: (v) => valorMonetario(v, "VALOR_IMPUESTO"),
  nroOrden: (v) => {
    const s = entero(v, 1, "NRO_ORDEN");
    if (s === "0") throw new RangeError("NRO_ORDEN: el orden va de 1 a 9, llegó 0");
    return s;
  },
  porcentajeDescuento: (v) => porcentaje(v, "%_DESCUENTO"),
  valorDescuento: (v) => precio(v, "VALOR_DESCUENTO"),
};
