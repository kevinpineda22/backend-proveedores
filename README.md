# backend-proveedores

API del **Portal de Proveedores** de Merkahorro.

Un proveedor externo entra con NIT + sucursal, ve el catálogo de precios que le
compramos, y **propone** un ajuste con fecha de activación. Firma la propuesta.
Compras la aprueba o la rechaza. Al aprobar, el cambio se escribe en SIESA.

Producción: **https://backend-proveedores.vercel.app**

---

## Por dónde empezar

| Si querés… | Leé |
|---|---|
| **Retomar el proyecto** | [`docs/ESTADO-Y-PENDIENTES.md`](docs/ESTADO-Y-PENDIENTES.md) |
| Entender por qué está armado así | [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) |
| Tocar algo que hable con SIESA | [`docs/CONTRATO-SIESA.md`](docs/CONTRATO-SIESA.md) |
| Cargar o cambiar la consulta | [`docs/CONSULTA-COTIZACIONES.sql`](docs/CONSULTA-COTIZACIONES.sql) |

El frontend vive en `Pagina-web_React/src/pages/PortalProveedores/`.

---

## Arrancar

```bash
npm install
npm test      # 142 pruebas
npm run dev   # localhost:3000
```

Las migraciones se corren a mano en el SQL Editor de Supabase, en orden:
`sql/001` → `sql/002` → `sql/003`.

---

## Variables de entorno

```
SUPABASE_URL                        SUPABASE_SERVICE_KEY
CONNI_KEY                           CONNI_TOKEN
SIESA_CONSULTA_COTIZACIONES=merkahorro_cotizaciones_dev_2
CRON_SECRET                         ← sin esto el snapshot queda CERRADO
CORS_ORIGENES=https://merkahorro.com,http://localhost:5173
PORTAL_PROVEEDORES_URL              ← el enlace del correo de invitación
EMAIL_USER  EMAIL_PASS  SMTP_HOST  SMTP_PORT  SMTP_SECURE
```

Interruptores útiles mientras se prueba:

| Variable | Qué hace |
|---|---|
| `PROVEEDORES_SANDBOX=true` | Arma el payload y lo deja en el log, **sin escribir en SIESA** |
| `PROVEEDORES_MAIL_PRUEBA=true` | Escribe el correo en el log en vez de mandarlo |

Cada consulta dinámica de Connekta tiene **sus propios** `ConniKey`/`ConniToken`.
Un 401 con "verifique si tiene permisos" casi siempre significa credenciales de
otra consulta, no un permiso faltante.

---

## Endpoints

| | Ruta | Quién |
|---|---|---|
| GET | `/api/salud` | público |
| GET | `/api/publico/sucursales?nit=` | público, rate-limited |
| POST | `/api/publico/activar` | público, con token de invitación |
| GET | `/api/proveedor/cuenta` · `/catalogo` · `/solicitudes` | proveedor |
| POST | `/api/proveedor/solicitudes` | proveedor no bloqueado |
| GET | `/api/admin/proveedores` · `/solicitudes` · `/firmas/:id` | `pp_admins` |
| PATCH | `/api/admin/proveedores/:nit` | `pp_admins` |
| POST | `/api/admin/cuentas/:id/invitar` | `pp_admins` |
| POST | `/api/admin/solicitudes/:id/aprobar` · `/rechazar` | `pp_admins` |
| POST | `/api/cron/snapshot` | `CRON_SECRET` |

---

## Cinco cosas que no hay que romper

1. **El tope se evalúa sobre el costo neto, no sobre el precio.** Bajar un
   descuento sube lo que pagamos aunque el precio no se mueva. Desde el
   2026-08-27 el tope **avisa, no frena**: la marca en la bandeja es la única
   defensa automática que queda, así que no se suaviza ni se esconde.
2. **Los impuestos se re-emiten con la fecha nueva**, o el ítem los pierde.
3. **El `cuenta_id` sale del JWT**, nunca del body.
4. **Aprobar toma la solicitud antes de empujar** a SIESA.
5. **Ninguna fecha pasa por `new Date()`** — el servidor corre en UTC.

El porqué de cada una está en `ESTADO-Y-PENDIENTES.md` §6, con los datos reales
que lo demostraron.
