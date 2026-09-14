/* =============================================================================
   Réplica Postgres de SIESA (esquema `merkahorro_siesa`) — SOLO LECTURA

   QUÉ ES
   Una copia de los movimientos de SIESA que carga OTRA persona con su propio
   proceso (ETL). Este backend no la mantiene, no la corrige y no escribe en ella:
   la lee. Hoy la usa una sola pantalla, la de diferencias de costo.

   POR QUÉ CADA CONSULTA VA DENTRO DE `BEGIN READ ONLY`
   El usuario de la conexión puede escribir. Que este código solo haga SELECT es
   una promesa; `READ ONLY` es una garantía: si algún día se cuela un UPDATE —un
   refactor, una consulta copiada de otro lado—, Postgres lo rechaza con
   `25006 read-only transaction` en vez de ejecutarlo.

   POR QUÉ `SIESA_PG_SSL=disable`
   Medido el 2026-09-14: el servidor responde "The server does not support SSL
   connections". Con `require` no conecta. La ficha de la conexión dice "SSL
   recomendado"; el servidor dice otra cosa, y manda el servidor.

   POR QUÉ UN POOL CHICO
   Corre en Vercel: cada instancia de la función tiene su propio pool. Con un
   `max` alto, veinte instancias frías abren cientos de conexiones contra un
   pooler (puerto 6543) que no es nuestro.
   ============================================================================= */

import "dotenv/config";
import pg from "pg";

let pool = null;

/** Lee la configuración. Separado para poder probarlo sin abrir conexiones. */
export function configuracion(env = process.env) {
  const faltan = ["SIESA_PG_HOST", "SIESA_PG_USER", "SIESA_PG_PASSWORD"].filter((k) => !env[k]);
  if (faltan.length) return { ok: false, faltan };

  return {
    ok: true,
    host: env.SIESA_PG_HOST,
    port: Number(env.SIESA_PG_PORT || 5432),
    user: env.SIESA_PG_USER,
    password: env.SIESA_PG_PASSWORD,
    database: env.SIESA_PG_DATABASE || "postgres",
    // Cualquier valor que no sea `require` es sin SSL. Ver la cabecera.
    ssl: env.SIESA_PG_SSL === "require" ? { rejectUnauthorized: false } : false,
  };
}

function obtenerPool() {
  if (pool) return pool;

  const cfg = configuracion();
  if (!cfg.ok) {
    // Sin credenciales la pantalla de diferencias no puede funcionar, pero el
    // resto del portal sí. Por eso falla ESTA consulta y no el arranque.
    const e = new Error(`Faltan variables de la réplica de SIESA: ${cfg.faltan.join(", ")}`);
    e.status = 503;
    throw e;
  }

  const { ok, ...conexion } = cfg;
  pool = new pg.Pool({
    ...conexion,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });

  // Un error en una conexión ociosa (el pooler la cortó) emite 'error' en el pool.
  // Sin este listener, Node lo trata como excepción no manejada y tumba el proceso.
  pool.on("error", (err) => console.error(`[siesaPg] conexión ociosa cayó: ${err.message}`));
  return pool;
}

/**
 * Ejecuta UNA consulta dentro de una transacción de solo lectura.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<object[]>} las filas
 */
export async function consultarSoloLectura(sql, params = []) {
  const cliente = await obtenerPool().connect();
  try {
    await cliente.query("BEGIN READ ONLY");
    const { rows } = await cliente.query(sql, params);
    await cliente.query("COMMIT");
    return rows;
  } catch (e) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}
