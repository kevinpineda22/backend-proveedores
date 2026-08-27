/* =============================================================================
   Límite por IP

   HONESTIDAD SOBRE LO QUE ESTO ES: el contador vive en memoria del proceso, y en
   Vercel cada instancia serverless tiene la suya. O sea que N instancias
   multiplican el límite por N, y un despliegue lo reinicia.

   Es un lomo de burro, no un muro.

   La protección real del endpoint público es su FORMA: devuelve solo sucursal y
   nombre, nunca correos ni estados de cuenta, y responde igual exista o no el
   NIT. Un atacante que enumere NITs consigue una lista de sucursales que ya está
   en cualquier factura.

   Si mañana hace falta un límite de verdad, va contra Redis o contra el WAF de
   Vercel. Mientras tanto, esto corta el scraping casual sin agregar una
   dependencia.
   ============================================================================= */

import { createError } from "./errorHandler.js";

const contadores = new Map();

/** Evita que el Map crezca sin techo si alguien rota IPs. */
const MAX_ENTRADAS = 10_000;

export function limitePorIp({ maximo = 20, ventanaMs = 60_000 } = {}) {
  return (req, res, next) => {
    const ahora = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || "desconocida";
    const entrada = contadores.get(ip);

    if (!entrada || ahora > entrada.reinicia) {
      if (contadores.size >= MAX_ENTRADAS) contadores.clear();
      contadores.set(ip, { cuenta: 1, reinicia: ahora + ventanaMs });
      return next();
    }

    entrada.cuenta += 1;
    if (entrada.cuenta > maximo) {
      const seg = Math.ceil((entrada.reinicia - ahora) / 1000);
      res.setHeader("Retry-After", String(seg));
      return next(createError(429, `Demasiadas consultas. Intente de nuevo en ${seg} segundos.`));
    }

    next();
  };
}

/** Solo para pruebas. */
export const _reiniciar = () => contadores.clear();
