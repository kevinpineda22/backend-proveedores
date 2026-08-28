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

export const esquemas = {
  /** POST /api/proveedor/solicitudes */
  crearSolicitud: z.object({
    claveItem: z.string().min(1, "Falta el renglón a cotizar"),
    precioPropuesto: z.number().positive("El precio debe ser mayor a cero"),
    // Máximo 3: es lo que la consulta de SIESA sabe leer. Escribir un cuarto
    // orden sería cargar un descuento que después el portal no puede mostrar.
    descuentosPropuestos: z.array(descuento).max(3).default([]),
    fechaActivacion: fechaISO,
    notas: z.string().max(255).optional().default(""),
    firma: z.string().min(1, "Falta la firma"),
  }),

  /** POST /api/admin/solicitudes/:id/rechazar */
  rechazar: z.object({
    motivo: z
      .string()
      .trim()
      .min(10, "Explique el motivo del rechazo (mínimo 10 caracteres)")
      .max(1000),
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
