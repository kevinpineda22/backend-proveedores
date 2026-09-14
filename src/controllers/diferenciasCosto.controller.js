import { consultarSoloLectura } from "../config/siesaPg.js";
import { createError, createErrorExpuesto } from "../middleware/errorHandler.js";
import {
  CAUSACIONES,
  SQL_ACTUALIZADO,
  SQL_DIFERENCIAS,
  aFila,
  diaSiguiente,
  normalizarRango,
} from "../services/diferenciasCosto.js";
import {
  combinar,
  leerSeguimiento,
  leerVistasHasta,
  marcarDiferenciasVistas,
  marcarSeguimiento,
  paraProveedor,
} from "../services/seguimientoDiferencias.js";

/**
 * Consulta la réplica y le pega el seguimiento.
 *
 * `nit` y `sucursal` en null = todos. Para el proveedor salen SIEMPRE de
 * `req.cuenta` (el JWT), nunca del query: ver ARQUITECTURA §5.
 */
async function diferencias({ query, nit = null, sucursal = null }) {
  const rango = normalizarRango({ desde: query.desde, hasta: query.hasta });
  if (!rango.ok) throw createError(422, rango.mensaje);

  let crudas;
  let actualizado = null;
  try {
    [crudas, [{ actualizado } = {}]] = await Promise.all([
      consultarSoloLectura(SQL_DIFERENCIAS, [
        rango.desde,
        diaSiguiente(rango.hasta),
        [...CAUSACIONES],
        nit,
        sucursal,
      ]),
      consultarSoloLectura(SQL_ACTUALIZADO),
    ]);
  } catch (e) {
    console.error(`[diferencias] falló la consulta a la réplica de SIESA: ${e.message}`);
    // El mensaje de pg trae nombres de tabla y columnas: no sale. Este sí.
    throw createErrorExpuesto(
      e.status === 503 ? 503 : 502,
      "No se pudo consultar la información de SIESA. Intente de nuevo en unos minutos.",
    );
  }

  const filas = crudas.map(aFila);
  const { mapa, disponible } = await leerSeguimiento(filas.map((f) => f.doctoCausacion));

  return {
    rango: { desde: rango.desde, hasta: rango.hasta, minimo: rango.minimo, maximo: rango.maximo },
    // Hasta cuándo cargó la réplica. La carga la hace otra persona: si se frena,
    // la pantalla tiene que decirlo en vez de mostrar datos viejos como vigentes.
    actualizado,
    seguimientoDisponible: disponible,
    filas: combinar(filas, mapa),
  };
}

/** GET /api/admin/diferencias-costo?desde&hasta&nit */
export async function listarAdmin(req, res, next) {
  try {
    res.json(await diferencias({ query: req.query, nit: req.query.nit || null }));
  } catch (e) {
    next(e);
  }
}

/** GET /api/proveedor/diferencias-costo?desde&hasta — solo lo de SU sucursal */
export async function listarProveedor(req, res, next) {
  try {
    const [r, vistasHasta] = await Promise.all([
      diferencias({ query: req.query, nit: req.cuenta.nit, sucursal: req.cuenta.sucursal }),
      leerVistasHasta(req.cuenta.id),
    ]);
    // `vistasHasta` decide el aviso de Inicio (migración 012).
    res.json({ ...r, vistasHasta, filas: r.filas.map(paraProveedor) });
  } catch (e) {
    next(e);
  }
}

/** POST /api/proveedor/diferencias-costo/visto — ocultar el aviso de Inicio */
export async function marcarVisto(req, res, next) {
  try {
    // La cuenta sale del JWT, nunca del body: ARQUITECTURA §5.
    res.json(await marcarDiferenciasVistas({ cuentaId: req.cuenta.id, hasta: req.body.hasta }));
  } catch (e) {
    next(e);
  }
}

/** PUT /api/admin/diferencias-costo/seguimiento — solo compras marca */
export async function marcar(req, res, next) {
  try {
    res.json(await marcarSeguimiento({ ...req.body, admin: req.admin, ip: req.ip }));
  } catch (e) {
    next(e);
  }
}
