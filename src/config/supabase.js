import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️  Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env");
  console.warn("   Los endpoints que tocan la base van a fallar hasta configurarlas.");
}

/**
 * Cliente con SERVICE KEY: pasa por encima de RLS.
 *
 * Eso es exactamente por qué el aislamiento entre proveedores NO puede apoyarse
 * solo en RLS del lado del backend. Con esta llave, una consulta sin filtro
 * devuelve las filas de todos. El filtro lo pone el middleware, derivando el
 * `cuenta_id` del JWT — ver middleware/auth.js y docs/ARQUITECTURA.md §5.
 *
 * RLS sigue siendo indispensable, pero para el OTRO camino: el frontend tiene
 * sesión de Supabase con la anon key y podría consultar las tablas directo.
 */
export const supabase = createClient(supabaseUrl || "http://localhost", supabaseKey || "sin-clave", {
  auth: { autoRefreshToken: false, persistSession: false },
});
