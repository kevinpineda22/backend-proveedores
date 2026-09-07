import express from "express";
import cors from "cors";
import helmet from "helmet";
import "dotenv/config";

import rutas from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());

/**
 * `trust proxy` es obligatorio detrás de Vercel: sin esto, `req.ip` devuelve la
 * IP del proxy para TODOS los requests. El límite por IP se volvería un límite
 * global —un solo visitante agotaría la cuota de todos— y las IPs guardadas en
 * `pp_firmas` y `pp_auditoria` serían todas la misma, o sea inútiles como prueba.
 */
app.set("trust proxy", 1);

const origenes = (process.env.CORS_ORIGENES || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    // Sin lista configurada se abre, para no frenar el desarrollo local. En
    // producción CORS_ORIGENES tiene que estar puesta.
    origin: origenes.length ? origenes : true,
    credentials: true,
  }),
);

/**
 * 2 MB, no los 100 KB que trae Express por defecto.
 *
 * El trazo de la firma viaja como data URI base64 y ronda los cientos de KB. Con
 * el límite por defecto, el proveedor firma, envía, y recibe un 413 sin
 * explicación justo en el último paso del flujo.
 */
app.use(express.json({ limit: "2mb" }));

app.use("/api", rutas);

app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada" }));
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

// En Vercel el módulo se importa como handler; el listen solo corre en local.
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`🟢 Portal de Proveedores escuchando en http://localhost:${PORT}`);
    if (String(process.env.PROVEEDORES_SANDBOX).toLowerCase() === "true") {
      console.warn("🧪 SANDBOX ACTIVO — no se escribe en SIESA.");
    }
  });
}

/**
 * El límite de duración de la función en Vercel, en segundos.
 *
 * VA ACÁ Y NO EN `vercel.json`. Con el formato `builds` —que este proyecto usa a
 * propósito, ver el comentario largo de vercel.json— Vercel **ignora la sección
 * `functions`**, así que un `maxDuration` puesto allá no hace nada.
 *
 * 300 no es un número al azar: el cron del snapshot recorre las 190 páginas de
 * la consulta de cotizaciones y tardó **27 s** medidos en producción. Con el
 * timeout por defecto se cortaría a la mitad, dejando el catálogo escrito a
 * medias y sin ningún error visible — el snapshot terminaría "bien" con una
 * parte de los precios.
 */
export const maxDuration = 300;

export default app;
