/* =============================================================================
   emailSintetico.js — Traducción NIT + sucursal → identidad de Supabase Auth

   ⚠️ GEMELO DE
   `Pagina-web_React/src/pages/PortalProveedores/utils/emailSintetico.js`.

   Este archivo arma el email al CREAR la cuenta. El del frontend lo arma al
   INICIAR SESIÓN. Si los dos no coinciden carácter por carácter, el proveedor
   recibe su invitación, define su clave, y después no puede entrar — con un
   "contraseña incorrecta" que no dice nada del problema real.

   Los dos tienen los MISMOS tests. Si tocás uno, tocá el otro.

   Ver docs/ARQUITECTURA.md §3.2.
   ============================================================================= */

const DOMINIO = process.env.PORTAL_PROVEEDORES_DOMINIO || "proveedores.merkahorro.com";

/**
 * Normaliza un NIT tal como lo teclea una persona.
 *
 * `900.123.456-7`, `900 123 456` y `900123456` son el mismo NIT, y las tres
 * tienen que producir la misma identidad.
 *
 * EL DÍGITO DE VERIFICACIÓN SE DESCARTA: SIESA guarda el NIT sin él. Ojo con el
 * orden — hay que quitar puntos y espacios ANTES de buscar el guion, o
 * `900.123.456-7` no matchea el patrón.
 */
export function normalizarNit(valor) {
  const limpio = String(valor ?? "")
    .trim()
    .replace(/[.\s]/g, "");

  // Un solo dígito después del guion es un DV. Un guion con más caracteres
  // detrás no se toca: no sabemos qué es, y adivinar sería peor que fallar.
  const conDv = /^(\d+)-\d$/.exec(limpio);
  return conDv ? conDv[1] : limpio;
}

/**
 * Identidad de Supabase Auth para una cuenta de proveedor.
 *
 * @throws {Error} si falta el NIT o la sucursal.
 */
export function emailSintetico(nit, sucursal) {
  const n = normalizarNit(nit);
  const s = String(sucursal ?? "").trim();

  if (!n) throw new Error("Falta el NIT");
  if (!s) throw new Error("Falta la sucursal");

  return `${n}-${s}@${DOMINIO}`.toLowerCase();
}
