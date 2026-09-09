/* =============================================================================
   Los filtros de `marcarVistas` (migración 010)

   POR QUÉ ESTE ARCHIVO EXISTE
   `scripts/humo-vistas.js` prueba esto contra la base real, pero solo puede
   probar los casos para los que HAYA datos. Corriéndolo el 2026-09-08, tres de
   los cuatro casos de aislamiento salieron *"no se pudo probar"* —no hay líneas
   de otra cuenta, ni réplicas, ni pendientes— y aun así el script cerró diciendo
   "no alcanza lo ajeno". Eso es afirmar sin comprobar.

   Acá los filtros se verifican SIEMPRE, con un cliente de mentira que anota qué
   se le pidió. No dependen de que la base tenga la fila justa.

   LO QUE SE PROTEGE
   `marcarVistas` escribe con la service key, que pasa por encima de RLS. Los dos
   filtros de la política `pp_lineas_propias` están repetidos a mano en el código,
   y si alguien borra uno, nada falla: simplemente se empieza a poder escribir
   sobre líneas ajenas. Un test que mira el UPDATE es lo único que lo nota.
   ============================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { marcarVistas } from "./solicitud.service.js";

/**
 * Un cliente de Supabase de mentira que anota la cadena de llamadas.
 *
 * Devuelve `this` en cada filtro —igual que el real— y resuelve como una promesa
 * al llegar a `.select()`, que es donde el servicio hace el `await`.
 */
function clienteFalso({ filas = [], error = null } = {}) {
  const registro = { tabla: null, update: null, filtros: [] };

  const cadena = {
    update(cambios) {
      registro.update = cambios;
      return cadena;
    },
    in(campo, valores) {
      registro.filtros.push(["in", campo, valores]);
      return cadena;
    },
    eq(campo, valor) {
      registro.filtros.push(["eq", campo, valor]);
      return cadena;
    },
    neq(campo, valor) {
      registro.filtros.push(["neq", campo, valor]);
      return cadena;
    },
    is(campo, valor) {
      registro.filtros.push(["is", campo, valor]);
      return cadena;
    },
    select() {
      return Promise.resolve({ data: filas, error });
    },
  };

  return {
    registro,
    cliente: {
      from(tabla) {
        registro.tabla = tabla;
        return cadena;
      },
    },
  };
}

/** ¿Se aplicó este filtro? */
const tiene = (registro, op, campo, valor) =>
  registro.filtros.some(
    ([o, c, v]) => o === op && c === campo && JSON.stringify(v) === JSON.stringify(valor),
  );

test("escribe SOLO visto_at: nunca un estado ni un precio", async () => {
  const { cliente, registro } = clienteFalso({ filas: [{ id: 1 }] });
  await marcarVistas({ lineaIds: [1], cuenta: { id: 59 } }, cliente);

  assert.equal(registro.tabla, "pp_solicitud_lineas");
  assert.deepEqual(Object.keys(registro.update), ["visto_at"]);
  // Y es una fecha, no un booleano: sirve para saber CUÁNDO lo leyó.
  assert.ok(!Number.isNaN(Date.parse(registro.update.visto_at)));
});

test("filtra por la cuenta del JWT", async () => {
  // Sin esto, un id adivinado marcaría la línea de otra sucursal. La service key
  // pasa por encima de RLS: si el filtro no está acá, no está en ningún lado.
  const { cliente, registro } = clienteFalso();
  await marcarVistas({ lineaIds: [1], cuenta: { id: 59 } }, cliente);
  assert.ok(tiene(registro, "eq", "cuenta_destino_id", 59), "falta el filtro de cuenta");
});

test("NUNCA toca una réplica", async () => {
  /* Las réplicas las genera Merkahorro para la sucursal hermana y el proveedor
     NO SABE QUE EXISTEN. Que el efecto visible sea nulo no alcanza: la escritura
     habría cruzado la frontera entre dos proveedores. */
  const { cliente, registro } = clienteFalso();
  await marcarVistas({ lineaIds: [1], cuenta: { id: 59 } }, cliente);
  assert.ok(tiene(registro, "eq", "origen", "proveedor"), "falta el filtro de origen");
});

test("NO apaga una pendiente", async () => {
  // Todavía espera respuesta. Apagarla le escondería lo único que está mirando.
  const { cliente, registro } = clienteFalso();
  await marcarVistas({ lineaIds: [1], cuenta: { id: 59 } }, cliente);
  assert.ok(tiene(registro, "neq", "estado", "pendiente"), "falta el filtro de estado");
});

test("no re-marca lo ya visto: la fecha original no se pisa", async () => {
  // Esa fecha es el único rastro de cuándo el proveedor leyó el rechazo.
  const { cliente, registro } = clienteFalso();
  await marcarVistas({ lineaIds: [1], cuenta: { id: 59 } }, cliente);
  assert.ok(tiene(registro, "is", "visto_at", null), "falta el filtro de ya-visto");
});

test("solo los ids pedidos", async () => {
  const { cliente, registro } = clienteFalso();
  await marcarVistas({ lineaIds: [7, 8, 9], cuenta: { id: 59 } }, cliente);
  assert.ok(tiene(registro, "in", "id", [7, 8, 9]));
});

test("devuelve cuántas marcó, no cuáles fallaron", async () => {
  /* Responder "esa línea no es tuya" confirmaría que existe, y eso es lo que
     ARQUITECTURA §5 no quiere que se pueda averiguar probando números. Se piden
     tres y vuelve una: la respuesta dice 1 y no dice nada de las otras dos. */
  const { cliente } = clienteFalso({ filas: [{ id: 7 }] });
  const r = await marcarVistas({ lineaIds: [7, 8, 9], cuenta: { id: 59 } }, cliente);
  assert.deepEqual(r, { vistas: 1 });
});

test("un error de la base se propaga en vez de mentir un éxito", async () => {
  const { cliente } = clienteFalso({ error: { message: "tabla bloqueada" } });
  await assert.rejects(
    () => marcarVistas({ lineaIds: [1], cuenta: { id: 59 } }, cliente),
    /tabla bloqueada/,
  );
});

test("sin nada que marcar devuelve cero, no revienta", async () => {
  const { cliente } = clienteFalso({ filas: null });
  assert.deepEqual(await marcarVistas({ lineaIds: [1], cuenta: { id: 59 } }, cliente), {
    vistas: 0,
  });
});
