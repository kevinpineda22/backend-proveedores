/* =============================================================================
   Validación de entrada (Zod)

   OJO — Zod DESCARTA lo que no está declarado. Si un campo llega del frontend y
   acá no figura, el controlador nunca lo ve y el error se lee como "falta X"
   sobre un formulario que sí mandó X. Declarar todo lo que se espera recibir.
   ============================================================================= */

import { z } from "zod";
import { createError } from "./errorHandler.js";

/** `AAAA-MM-DD`. Se valida como texto: por acá no pasa ningún `Date`. */
const fechaISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD");

const descuento = z.object({
  orden: z.number().int().min(1).max(3),
  porcentaje: z.number().min(0).max(100),
});

/* Un impuesto es una LLAVE y un VALOR EN PESOS, no un porcentaje.
   Las llaves observadas en producción son `ICO` e `IBU3` — la documentación del
   conector decía "IBUA", que no existe. No se valida contra una lista cerrada: si
   mañana la ley agrega una, un enum acá bloquearía el catálogo entero. La llave
   sale del dato, no de un correo (ver PENDIENTES §2.1).

   `valor: 0` es válido y NO es lo mismo que omitir el impuesto: cero dice "está
   sujeto y hoy paga cero", la ausencia dice "no existe en esta fecha". */
const impuesto = z.object({
  llave: z.string().trim().min(1).max(10),
  valor: z.number().min(0),
});

/* Cuántos decimales acepta el conector en un precio en COP.

   Verificado contra SIESA QA el 2026-09-02: `4891.27` entra, `4891.275` se
   rechaza con *"el precio no cumple con los decimales unitarios de la moneda"*.

   ⚠️ SIESA ALMACENA precios con más decimales de los que su propio conector
   acepta al escribir. En el catálogo hay **218 cotizaciones (1,2 %, 36
   proveedores)** con 3 o 4 decimales — todas nacidas de dividir el precio de una
   presentación: `4891.275` es la mitad de `9782.55`, `4583.3333` es un tercio.

   Por eso esto se valida ACÁ y no más adentro: sin esta regla, un proveedor de
   esos 36 proponía, FIRMABA, el admin aprobaba, y recién ahí el ERP lo rechazaba
   con un mensaje sobre "decimales unitarios" que no le dice nada a nadie. El
   error tiene que aparecer cuando todavía se puede corregir. */
const DECIMALES_COP = 2;

const cuentaDecimales = (n) => {
  const [, dec = ""] = String(n).split(".");
  return dec.length;
};

const precio = z
  .number()
  .positive("El precio debe ser mayor a cero")
  .refine((n) => cuentaDecimales(n) <= DECIMALES_COP, {
    message: `El precio no puede tener más de ${DECIMALES_COP} decimales. Redondéelo (por ejemplo, 4891,275 → 4891,27).`,
  });

export const esquemas = {
  /** POST /api/proveedor/solicitudes — un PAQUETE de productos con UNA firma */
  crearSolicitud: z.object({
    lineas: z
      .array(
        z.object({
          claveItem: z.string().min(1, "Falta el renglón a cotizar"),
          precioPropuesto: precio,
          // Máximo 3: es lo que la consulta de SIESA sabe leer. Escribir un cuarto
          // orden sería cargar un descuento que después el portal no puede mostrar.
          descuentosPropuestos: z.array(descuento).max(3).default([]),
          /* OPCIONAL A PROPÓSITO, y `undefined` NO es `[]`:
               ausente → el proveedor no los tocó, se re-emiten los vigentes
               []      → los quitó
             Un `.default([])` acá convertiría "no los tocó" en "los quitó" y le
             borraría el ICO a cada producto que pase sin declararlos. */
          impuestosPropuestos: z.array(impuesto).max(10).optional(),
          fechaActivacion: fechaISO,
          notas: z.string().max(255).optional().default(""),
        }),
      )
      .min(1, "La solicitud no tiene ningún producto")
      /* El tope es del plano que se le manda a SIESA, no de la pantalla. Un
         paquete gigante es un POST gigante y un rechazo del ERP que no dice cuál
         de las 400 líneas está mal. Que el corte lo ponga el portal, con un
         mensaje que se entiende. */
      .max(100, "No se pueden enviar más de 100 productos en una misma solicitud")
      /* Dos veces el mismo renglón chocaría contra `idx_pp_lineas_pendiente_unica`
         con un 23505 que se lee como "ya tiene una solicitud pendiente" — un
         mensaje sobre otra solicitud, cuando el problema está en ésta. */
      .refine(
        (ls) => new Set(ls.map((l) => l.claveItem)).size === ls.length,
        "Hay un producto repetido en la solicitud. Cada renglón puede ir una sola vez.",
      ),
    firma: z.string().min(1, "Falta la firma"),
  }),

  /** POST /api/proveedor/solicitudes/lineas/vistas — apagar avisos del inicio */
  marcarVistas: z.object({
    /* El tope es alto a propósito: "no me muestres más ninguno" tiene que caber
       en UN pedido. Partirlo en tandas dejaría al proveedor con la mitad de la
       pantalla apagada si la segunda falla. */
    lineaIds: z
      .array(z.number().int().positive())
      .min(1, "No se indicó ningún aviso")
      .max(500),
  }),

  /** POST /api/admin/solicitudes/lineas/aprobar — una, varias o todas */
  resolverLineas: z.object({
    lineaIds: z
      .array(z.number().int().positive())
      .min(1, "No se seleccionó ninguna línea")
      .max(100),
    confirmaDesactualizado: z.boolean().optional().default(false),
  }),

  /** POST /api/admin/solicitudes/lineas/rechazar */
  rechazarLineas: z.object({
    lineaIds: z.array(z.number().int().positive()).min(1, "No se seleccionó ninguna línea").max(100),
    motivo: z
      .string()
      .trim()
      .min(10, "Explique el motivo del rechazo (mínimo 10 caracteres)")
      .max(1000),
  }),

  /** PATCH /api/admin/cuentas/:id — el tope de UNA sucursal (migración 009) */
  configurarCuenta: z.object({
    /* `null` acá es HEREDAR el tope del NIT, no "sin tope". Se acepta explícito
       para que borrar el tope de una sucursal sea una decisión y no el efecto de
       omitir un campo. */
    porcentajeMax: z.number().min(0).max(1000).nullable(),
  }),

  /** PATCH /api/admin/proveedores/:nit */
  configurarProveedor: z.object({
    // `null` es SIN TOPE, y es distinto de 0. `.nullable()` sin default para que
    // mandar null sea una decisión explícita y no el efecto de omitir el campo.
    porcentajeMax: z.number().min(0).max(1000).nullable().optional(),
    bloqueado: z.boolean().optional(),
  }),

  /** POST /api/admin/cuentas/:id/invitar */
  invitar: z.object({
    correo: z.string().email("Ingrese un correo válido").max(255),
  }),

  /** POST /api/admin/admins — alta o reactivación de un admin del portal */
  agregarAdmin: z.object({
    correo: z.string().trim().email("Ingrese un correo válido").max(255),
  }),

  /** PATCH /api/admin/admins/:userId — activar o desactivar. Nunca borrar. */
  cambiarEstadoAdmin: z.object({
    // Obligatorio y sin default: desactivar a alguien que aprueba precios no
    // puede ser el efecto de omitir un campo. Se dice explícitamente.
    activo: z.boolean({ required_error: "Indique si el administrador queda activo o inactivo" }),
  }),

  /** GET /api/publico/sucursales?nit=… */
  sucursalesPorNit: z.object({
    nit: z.string().trim().min(5, "NIT inválido").max(15),
  }),

  /** POST /api/publico/recuperar — el proveedor pide un enlace nuevo */
  recuperar: z.object({
    nit: z.string().trim().min(5, "NIT inválido").max(15),
    sucursal: z.string().trim().min(1, "Falta la sucursal").max(3),
  }),

  /** POST /api/publico/activar — el proveedor define su contraseña */
  activar: z.object({
    token: z.string().min(32, "Enlace inválido"),
    // 8 es el mínimo de Supabase Auth. Validarlo acá da un mensaje que se
    // entiende; dejarlo pasar devuelve el error crudo del proveedor de auth.
    clave: z
      .string()
      .min(8, "La contraseña debe tener al menos 8 caracteres")
      .max(72, "La contraseña es demasiado larga"),
  }),
};

/** Valida `req[fuente]` y lo reemplaza por el resultado tipado. */
export const validar = (esquema, fuente = "body") => (req, res, next) => {
  const r = esquema.safeParse(req[fuente]);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => ({
      campo: i.path.join(".") || "(raíz)",
      mensaje: i.message,
    }));
    return next(createError(422, "Datos inválidos", detalle));
  }
  req[fuente] = r.data;
  next();
};
