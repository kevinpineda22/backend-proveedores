# backend-proveedores

API del **Portal de Proveedores** de Merkahorro.

Un proveedor externo entra con NIT + sucursal, ve el catálogo de precios que le
compramos, y **propone** un ajuste con fecha de activación. Firma la propuesta.
Merkahorro la aprueba o la rechaza. Al aprobar, el cambio se escribe en SIESA.

Producción: **https://backend-proveedores.vercel.app**

---

## Por dónde empezar

| Si querés… | Leé |
|---|---|
| **Retomar el proyecto o ver qué falta** | [`docs/PENDIENTES.md`](docs/PENDIENTES.md) ← empezá acá |
| **Entender cómo funciona, paso a paso** | [`docs/COMO-FUNCIONA.md`](docs/COMO-FUNCIONA.md) |
| Entender por qué está armado así | [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) |
| Tocar algo que hable con SIESA | [`docs/CONTRATO-SIESA.md`](docs/CONTRATO-SIESA.md) |
| Cargar o cambiar la consulta | [`docs/CONSULTA-COTIZACIONES.sql`](docs/CONSULTA-COTIZACIONES.sql) |

El frontend vive en `Pagina-web_React/src/pages/PortalProveedores/`.

---

## Arrancar

```bash
npm install
npm test      # 159 pruebas (backend) · 65 en el frontend
npm run dev   # localhost:3000
```

Las migraciones se corren a mano en el SQL Editor de Supabase, en orden:
`sql/001` → `sql/002` → `sql/003` → `sql/004` → `sql/005`.

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
| GET | `/api/admin/admins` | `pp_admins` |
| POST | `/api/admin/admins` | `pp_admins` |
| PATCH | `/api/admin/admins/:userId` | `pp_admins` |
| POST | `/api/cron/snapshot` | `CRON_SECRET` |

---

## Las seis cosas que no hay que romper

Viven en **[`docs/PENDIENTES.md`](docs/PENDIENTES.md) §7**, con el dato real que
demostró cada una.

No se copian acá a propósito: esta lista ya estuvo duplicada en cuatro archivos y
llegó a decir "cinco" en unos y "seis" en otros. Una regla que protege plata no
puede tener dos versiones.
