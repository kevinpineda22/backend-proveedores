import { Router } from "express";
import { requiereProveedor, puedeProponer, requiereAdmin } from "../middleware/auth.js";
import { validar, esquemas } from "../middleware/validators.js";
import { limitePorIp } from "../middleware/rateLimit.js";
import { createError } from "../middleware/errorHandler.js";
import * as proveedor from "../controllers/proveedor.controller.js";
import * as admin from "../controllers/admin.controller.js";
import { sucursalesPorNit } from "../controllers/publico.controller.js";
import { sincronizar } from "../services/snapshot.service.js";
import { invitar, activar } from "../services/invitacion.service.js";

const router = Router();

router.get("/salud", (req, res) => res.json({ ok: true, servicio: "portal-proveedores" }));

/* ── PÚBLICO ──────────────────────────────────────────────────────────────
   La ÚNICA superficie sin autenticar del sistema. Devuelve exclusivamente
   sucursal y nombre — nunca correos, nunca si la cuenta está activa.
   Ver ARQUITECTURA §3.3.
   ───────────────────────────────────────────────────────────────────────── */
const publico = Router();
publico.get(
  "/sucursales",
  limitePorIp({ maximo: 20, ventanaMs: 60_000 }),
  validar(esquemas.sucursalesPorNit, "query"),
  sucursalesPorNit,
);

// Activación: el proveedor llega con el token del correo y define su contraseña.
// Límite MÁS DURO que el de sucursales — acá se prueban tokens, no NITs.
publico.post(
  "/activar",
  limitePorIp({ maximo: 5, ventanaMs: 60_000 }),
  validar(esquemas.activar),
  async (req, res, next) => {
    try {
      res.json(await activar(req.body));
    } catch (e) {
      next(e);
    }
  },
);
router.use("/publico", publico);

/* ── PROVEEDOR ────────────────────────────────────────────────────────────
   Router propio con middleware propio. No comparte nada con /admin: el
   proveedor no puede ni llegar al maestro. Tercera capa de ARQUITECTURA §5.
   ───────────────────────────────────────────────────────────────────────── */
const rProveedor = Router();
rProveedor.use(requiereProveedor);
rProveedor.get("/cuenta", proveedor.miCuenta);
rProveedor.get("/catalogo", proveedor.catalogo);
rProveedor.get("/solicitudes", proveedor.misSolicitudes);
rProveedor.post(
  "/solicitudes",
  puedeProponer,
  validar(esquemas.crearSolicitud),
  proveedor.crear,
);
router.use("/proveedor", rProveedor);

/* ── ADMIN ────────────────────────────────────────────────────────────────── */
const rAdmin = Router();
rAdmin.use(requiereAdmin);
rAdmin.get("/proveedores", admin.maestro);
rAdmin.patch("/proveedores/:nit", validar(esquemas.configurarProveedor), admin.configurarProveedor);
rAdmin.post("/cuentas/:id/invitar", validar(esquemas.invitar), async (req, res, next) => {
  try {
    res.json(
      await invitar({
        cuentaId: req.params.id,
        correo: req.body.correo,
        admin: req.admin,
        ip: req.ip,
      }),
    );
  } catch (e) {
    next(e);
  }
});
rAdmin.get("/solicitudes", admin.bandeja);
rAdmin.get("/firmas/:id", admin.verFirma);
rAdmin.post("/solicitudes/:id/aprobar", admin.aprobarSolicitud);
rAdmin.post("/solicitudes/:id/rechazar", validar(esquemas.rechazar), admin.rechazarSolicitud);
router.use("/admin", rAdmin);

/* ── CRON ─────────────────────────────────────────────────────────────────
   Vercel manda `Authorization: Bearer $CRON_SECRET`. Sin secreto configurado
   la ruta queda CERRADA: una URL que repuebla el catálogo entero y puede
   barrer filas no puede quedar abierta por olvidar una variable.
   ───────────────────────────────────────────────────────────────────────── */
/** `sincronizar()` ya deriva el maestro adentro y lo devuelve en `maestro`. */
async function correrSnapshot(req, res, next) {
  try {
    res.json(await sincronizar());
  } catch (e) {
    next(e);
  }
}

router.post("/cron/snapshot", cronAutorizado, correrSnapshot);
router.get("/cron/snapshot", cronAutorizado, correrSnapshot);

function cronAutorizado(req, res, next) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return next(createError(503, "CRON_SECRET no está configurado"));

  const enviado =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.headers["x-cron-secret"];

  if (enviado !== secreto) return next(createError(401, "No autorizado"));
  next();
}

export default router;
