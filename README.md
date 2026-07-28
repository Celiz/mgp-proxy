# MGP Proxy

Un servidor proxy ultra-ligero construido con [Hono](https://hono.dev/) y Node.js.
Actúa como escudo entre el frontend/backend principal y la API de la Municipalidad de General Pueyrredon (MGP), protegiendo contra baneos y colapsos mediante:

- **Rate Limiting Inteligente:** Limita a 2 peticiones por segundo usando el algoritmo Token Bucket.
- **Singleflight:** Si múltiples usuarios piden el arribo del mismo colectivo simultáneamente, solo 1 petición va a la Muni y el resultado se comparte con el resto.
- **Circuit Breaker:** Si la Muni empieza a devolver errores, el circuito se abre y usa respuestas cacheadas (Stale Cache) para no sobrecargar la API pública.
- **Caché en Memoria (LRU):** Respuestas instantáneas para paradas consultadas recientemente.

## 🚪 Por dónde entra a la MGP

La MGP expone dos web services distintos, y el proxy usa el segundo:

| | `apps/app_cuando_llegaV670/appWS.php` | `app_cuando_llega/webWS.php` ✅ |
|---|---|---|
| Quién lo usa | La app Cordova oficial | El SPA web oficial |
| Autenticación | Token RSA + `registro.php` | Sesión de navegador |
| Estado | **Inutilizable**: Cloudflare le devuelve 429 permanente | Operativo |
| Barrera | — | Managed challenge de Cloudflare |

El camino V670 quedó bloqueado por una regla de Cloudflare sobre `appWS.php`: devuelve
`429 Too Many Requests` con `retry-after: 30` que nunca se cumple. No es rate limiting
propio — se verificó que un Chrome real, con `cf_clearance` válido y `registro.php`
respondiendo 200, recibe exactamente el mismo 429. Sigue disponible con
`MGP_TRANSPORT=v670` por si algún día se libera esa regla.

El WS web no tiene esa regla; su única barrera es el challenge de Cloudflare.

### Cómo se pasa el challenge

`cf_clearance` sólo la consigue un navegador **con display real** (`--headless=new`
no resuelve el challenge). Pero una vez obtenida, un `fetch()` común de Node con esa
cookie funciona perfecto. Entonces:

```
navegador (una vez, ~20s)  ──►  cf_clearance
                                     │
requests normales ──► fetch() con esa cookie ──► webWS.php
```

Tres cosas medidas que vale la pena saber:

- **La cookie dura 365 días.** MGP tiene el TTL de Cloudflare en el máximo, así que
  esto no es un ritual periódico: se resuelve una vez y listo.
- **Alcanza con `cf_clearance` sola** — sin ella es 403; el `PHPSESSID` no hace falta.
- **Está atada a la IP pública y al User-Agent, no al equipo.** Por eso el proxy puede
  correr donde no hay navegador mientras otra máquina de la misma red le acerque la
  cookie.

Lo que la invalida en la práctica no es el tiempo sino un cambio de IP pública. Cuando
pasa, el primer 403 dispara la renovación automática y la request se reintenta sola.

## 🚀 Formas de desplegarlo

### A. Todo en una PC (lo más simple)

Necesita Chrome o Chromium instalado. El proxy resuelve el challenge solo.

```bash
pnpm install
pnpm start
```

### B. Proxy en el celu (Termux) + clearance desde la PC

Chromium en Termux es inviable en la práctica, pero **el proxy sí corre ahí**, que es lo
que importa para conservar la IP residencial. La PC de casa resuelve el challenge una
vez y se lo manda: ambos salen por la misma IP pública, que es lo único que Cloudflare
mira. Como la cookie dura un año, la PC no necesita quedar prendida — sólo la prendés de
nuevo si cambia la IP.

En el teléfono:

```bash
pkg install git nodejs
git clone <este-repo> && cd mgp-proxy && npm install
ADMIN_TOKEN=un-token-secreto npm start
```

En la PC (misma red), una sola vez:

```bash
ADMIN_TOKEN=un-token-secreto npx tsx src/scripts/obtenerClearance.ts http://192.168.0.X:4000
```

El clearance queda persistido en `src/data/clearance.json`, así que sobrevive a los
reinicios del proxy. Si algún día empieza a devolver 502, es que cambió la IP: volvés a
correr ese comando. Se puede dejar agendado por las dudas, pero no hace falta a diario.

### C. Docker / VPS

El challenge necesita display, así que hay que envolver el arranque con `xvfb`:

```bash
apt-get install -y chromium xvfb
xvfb-run -a npm start
```

Sin `DISPLAY`, el proxy avisa con `no_display` en vez de fallar en silencio.

## ⚙️ Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `PORT` / `HOST` | `4000` / `0.0.0.0` | Dónde escucha |
| `MGP_TRANSPORT` | `web` | `web` (WS web) o `v670` (app Cordova, hoy bloqueado) |
| `ADMIN_TOKEN` | — | Habilita `POST /admin/clearance`. Sin esto, el endpoint responde 403 |
| `MGP_BROWSER_PATH` | autodetecta | Ruta al Chrome/Chromium si no está donde se lo busca |
| `MGP_CLEARANCE_TTL_MS` | `21600000` (6 h) | Vigencia asumida **sólo** si la cookie no declara vencimiento; normalmente manda el vencimiento real |
| `MGP_PROXY_URL` | — | Destino por defecto del script de clearance |
| `MGP_RSA_PUBKEY` / `MGP_SHARED_KEY` | — | Sólo con `MGP_TRANSPORT=v670` |
| `ALLOWED_ORIGINS` | todos | Lista separada por comas para CORS |

## 🌐 Exponer a Internet (Túnel de Cloudflare)

Para que tu backend en la nube pueda comunicarse con el proxy local:

```bash
pkg install cloudflared
cloudflared tunnel --url http://localhost:4000
```

Buscá la URL que termina en `.trycloudflare.com` y configurala como `MGP_PROXY_URL` en
tu backend principal. Para una URL fija:

```bash
cloudflared tunnel login
cloudflared tunnel create bondi-proxy
cloudflared tunnel route dns bondi-proxy proxy.tudominio.com
cloudflared tunnel run bondi-proxy
```

## 📊 Monitoreo

- `GET /stats` — dashboard en vivo (requests, caché, breaker, estado del clearance)
- `GET /stats/data` — el mismo snapshot en JSON
- `GET /stats/analytics` — analytics de producto (persistente)

## 🔌 Endpoints

| Ruta | Método | Descripción |
|---|---|---|
| `/` | POST | Proxy principal, body `application/x-www-form-urlencoded` |
| `/mgp/:accion` | GET | Igual pero por querystring |
| `/admin/clearance` | POST | Inyecta un clearance externo. Requiere `x-admin-token` |

### Acciones del WS (`accion=`)

| Acción | Params |
|---|---|
| `RecuperarLineaPorCuandoLlega` | — |
| `RecuperarCallesPrincipalPorLinea` | `codLinea` |
| `RecuperarInterseccionPorLineaYCalle` | `codLinea`, `codCalle` |
| `RecuperarParadasConBanderaPorLineaCalleEInterseccion` | `codLinea`, `codCalle`, `codInterseccion` |
| `RecuperarParadasConBanderaYDestinoPorLinea` | `codLinea`, `isSublinea` |
| `RecuperarRecorridoParaMapaAbrevYAmpliPorEntidadYLinea` | `codLinea`, `isSublinea` |
| `RecuperarBanderasAsociadasAParada` | `identificadorParada` |
| `RecuperarProximosArribosW` | `identificadorParada`, `codigoLineaParada` |

Ojo con `identificadorParada`: es el campo `Identificador` de la parada (`P3608`), no su
`Codigo` numérico — con el código el WS responde "Parada inexistente".
