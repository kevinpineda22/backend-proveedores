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

   DÓNDE ESTÁ EL LÍMITE QUE SÍ CUENTA (2026-08-31)

   Para el endpoint que MANDA CORREOS a terceros (`/publico/recuperar`) esto no
   alcanzaba, y ahí el daño no es nuestro: es la bandeja de un proveedor. Ese
   freno se movió a donde importa —la CUENTA— y vive en la base, que todas las
   instancias comparten (`invitacion.service.js`, `COOLDOWN_MS`). No hizo falta
   Redis: la marca de tiempo ya estaba, porque cada pedido inserta su fila en
   `pp_invitaciones`.

   La lección, por si aparece otro endpoint parecido: **limitar por IP es limitar
   un proxy de lo que querés proteger**. Cuando se puede identificar el recurso
   real —una cuenta, un correo, un documento—, el límite va ahí, y de paso deja
   de importar en qué instancia cayó el pedido.

   Este middleware sigue siendo el lomo de burro de los endpoints públicos que
   solo LEEN. Para eso alcanza, y no agrega una dependencia.
   ============================================================================= */

import { createError } from "./errorHandler.js";

const contadores = new Map();

/** Evita que el Map crezca sin techo si alguien rota IPs. */
const MAX_ENTRADAS = 10_000;

/**
 * Hace lugar cuando el Map se llena, SIN vaciarlo.
 *
 * Antes acá había un `contadores.clear()`, y eso convertía el tope en un botón
 * de reinicio: quien rotaba 10.000 IPs borraba el contador de TODOS —el suyo
 * incluido— y volvía a empezar. El techo pensado para proteger la memoria era la
 * forma más barata de saltarse el límite.
 *
 * SE DESALOJA POR CUENTA MÁS BAJA, no por antigüedad.
 *
 * Desalojar "las más viejas" parece razonable y NO sirve: como todas las
 * ventanas duran lo mismo, más viejo es lo mismo que creado primero — y el que
 * está atacando desde hace rato es justamente el primero. Sale él y entran sus
 * 10.000 IPs falsas. Es el mismo botón de reinicio con otro nombre.
 *
 * La cuenta sí discrimina: una entrada en 1 es alguien que pasó una vez, y
 * perderla solo le regala una ventana nueva a quien no estaba molestando. Una
 * entrada alta es la que está haciendo el ruido, y es la que hay que conservar.
 */
function hacerLugar(ahora) {
  for (const [ip, e] of contadores) {
    if (ahora > e.reinicia) contadores.delete(ip);
  }
  if (contadores.size < MAX_ENTRADAS) return;

  const porMenosRuidosa = [...contadores.entries()].sort((a, b) => a[1].cuenta - b[1].cuenta);
  for (let i = 0; i < Math.ceil(porMenosRuidosa.length / 2); i++) {
    contadores.delete(porMenosRuidosa[i][0]);
  }
}

export function limitePorIp({ maximo = 20, ventanaMs = 60_000 } = {}) {
  return (req, res, next) => {
    const ahora = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || "desconocida";
    const entrada = contadores.get(ip);

    if (!entrada || ahora > entrada.reinicia) {
      if (contadores.size >= MAX_ENTRADAS) hacerLugar(ahora);
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
