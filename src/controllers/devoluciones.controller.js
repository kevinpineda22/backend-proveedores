import { consultarSoloLectura } from "../config/siesaPg.js";
import { createError, createErrorExpuesto } from "../middleware/errorHandler.js";
import { SQL_ACTUALIZADO, diaSiguiente, normalizarRango } from "../services/diferenciasCosto.js";
import {
  ESTADOS_DEVOLUCION,
  MESES_DEVOLUCIONES,
  SQL_DEVOLUCIONES,
  armarDevoluciones,
} from "../services/devoluciones.js";

/**
 * Consulta la réplica y arma la respuesta normalizada.
 *
 * `nit` y `sucursal` en null = todos. Para el proveedor salen SIEMPRE de
 * `req.cuenta` (el JWT), nunca del query: ver ARQUITECTURA §5.
 */
async function devoluciones({ query, nit = null, sucursal = null }) {
  const rango = normalizarRango({ desde: query.desde, hasta: query.hasta }, undefined, MESES_DEVOLUCIONES);
  if (!rango.ok) throw createError(422, rango.mensaje);

  let crudas;
  let actualizado = null;
  try {
    [crudas, [{ actualizado } = {}]] = await Promise.all([
      consultarSoloLectura(SQL_DEVOLUCIONES, [
        rango.desde,
        diaSiguiente(rango.hasta),
        [...ESTADOS_DEVOLUCION],
        nit,
        sucursal,
      ]),
      consultarSoloLectura(SQL_ACTUALIZADO),
    ]);
  } catch (e) {
    console.error(`[devoluciones] falló la consulta a la réplica de SIESA: ${e.message}`);
    // El mensaje de pg trae nombres de tabla y columnas: no sale. Este sí.
    throw createErrorExpuesto(
      e.status === 503 ? 503 : 502,
      "No se pudo consultar la información de SIESA. Intente de nuevo en unos minutos.",
    );
  }

  return {
    rango: { desde: rango.desde, hasta: rango.hasta, minimo: rango.minimo, maximo: rango.maximo },
    actualizado,
    ...armarDevoluciones(crudas),
  };
}

/** GET /api/admin/devoluciones?desde&hasta — todo; compras filtra en pantalla */
export async function listarAdmin(req, res, next) {
  try {
    res.json(await devoluciones({ query: req.query }));
  } catch (e) {
    next(e);
  }
}

/** GET /api/proveedor/devoluciones?desde&hasta — solo lo de SU sucursal */
export async function listarProveedor(req, res, next) {
  try {
    res.json(
      await devoluciones({ query: req.query, nit: req.cuenta.nit, sucursal: req.cuenta.sucursal }),
    );
  } catch (e) {
    next(e);
  }
}
