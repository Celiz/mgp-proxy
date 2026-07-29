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

Cloudflare pasó a un **Turnstile no-interactivo**. Un Chrome automatizado por CDP (el
approach viejo de este proxy) nunca lo resolvía headless, y ni con un display real lo
pasaba de forma confiable — medido, se quedó sin funcionar. La solución que sí anda:
[Scrapling](https://github.com/D4Vinci/Scrapling) con `patchright` (un fork "stealth" de
Playwright), que resuelve el Turnstile **headless** en unos 10 segundos.

La otra diferencia con el approach viejo: en vez de extraer `cf_clearance` y repetirla
con `fetch()` de Node (lo que andaba con el challenge anterior, pero no hay garantía
de que siga sirviendo contra Turnstile — puede validar más señales que la cookie sola,
como el fingerprint TLS/HTTP2), **cada request se hace adentro del navegador** con
`page.evaluate(fetch(...))`, igual que el SPA oficial:

```
Node (proxy)  ◄──stdin/stdout, JSON por línea──►  bridge/bridge.py (Scrapling)
                                                          │
                                          navegador headless (patchright)
                                                          │
                                          fetch('webWS.php') desde la página
```

El bridge es un subproceso Python de larga vida (`bridge/bridge.py`) que el proxy
arranca solo. Mantiene una sesión de navegador viva y la renueva en segundo plano cada
~9 minutos (configurable con `MGP_BRIDGE_RENEW_MS`) sin cortar servicio: no tira la
sesión vieja hasta tener la nueva lista. Si una respuesta huele a challenge (403/503 o
HTML de "Just a moment"), fuerza un re-init y reintenta una vez.

Ver `src/lib/mgpBridge.ts` (el lado Node: spawn del subproceso, cola de comandos,
renovación) y `bridge/bridge.py` (el lado Python: Scrapling + la llamada real).

## 🚀 Formas de desplegarlo

### A. PC / servidor Linux

Hace falta Node 22+ y Python 3.10+ (no hace falta Chrome del sistema: patchright baja su
propio Chromium). El bridge corre en un venv aparte, en `bridge/`:

```bash
npm install
npm run setup:bridge   # crea bridge/.venv, instala Scrapling y baja Chromium
npm start
```

`setup:bridge` es un atajo de:

```bash
python3 -m venv bridge/.venv
bridge/.venv/bin/pip install -r bridge/requirements.txt
bridge/.venv/bin/patchright install chromium
```

No hace falta display ni `xvfb`: el Turnstile se resuelve headless.

### B. Docker / VPS / Render

```bash
docker build -t mgp-proxy .
docker run -p 4000:4000 mgp-proxy
```

El `Dockerfile` instala el venv del bridge y su Chromium en la imagen. `render.yaml`
tiene la config lista para Render — el health check pega a `/stats/data`.

No está verificado cuánta RAM pide `patchright` en un contenedor de 512 MB reales (el
approach viejo, con Chrome real + Xvfb, confirmadamente no entraba ahí). Si el
contenedor muere por OOM, la salida es subir de plan; el timeout del challenge
(`MGP_CHALLENGE_TIMEOUT_MS`) ya viene generoso por si la CPU es lenta.

### C. Celu / Termux

No verificado con este stack. La razón por la que antes hacía falta `proot-distro` +
Debian (o inyectar el clearance desde otra máquina de la red) era la necesidad de un
display real para resolver el challenge — eso ya no aplica, `patchright` resuelve
headless. Pero sigue haciendo falta correr su Chromium, que puede no tener build para
Termux nativo (Android/Termux no es una distro Linux estándar); probablemente siga
haciendo falta `proot-distro` con Debian ARM64 y seguir la opción A ahí adentro. Si lo
probás, contribuí la receta.

## ⚙️ Variables de entorno

| Variable | Default | Para qué |
|---|---|---|
| `PORT` / `HOST` | `4000` / `0.0.0.0` | Dónde escucha |
| `MGP_TRANSPORT` | `web` | `web` (WS web vía bridge) o `v670` (app Cordova, hoy bloqueado) |
| `ADMIN_TOKEN` | — | Habilita `POST /admin/bridge/restart`. Sin esto, el endpoint responde 403 |
| `MGP_BRIDGE_PYTHON` | `bridge/.venv/bin/python3` | Ruta al intérprete Python del bridge |
| `MGP_CHALLENGE_TIMEOUT_MS` | `90000` | Techo para resolver el Turnstile (medido: ~10s en una PC) |
| `MGP_BRIDGE_FETCH_TIMEOUT_MS` | `15000` | Timeout de cada request a `webWS.php` vía el bridge |
| `MGP_BRIDGE_RENEW_MS` | `540000` (9 min) | Cada cuánto renueva la sesión en segundo plano |
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

- `GET /stats` — dashboard en vivo (requests, caché, breaker, estado del bridge)
- `GET /stats/data` — el mismo snapshot en JSON (incluye `bridge: { ready, restarts, lastError, ... }`)
- `GET /stats/analytics` — analytics de producto (persistente)

## 🔌 Endpoints

| Ruta | Método | Descripción |
|---|---|---|
| `/` | POST | Proxy principal, body `application/x-www-form-urlencoded` |
| `/mgp/:accion` | GET | Igual pero por querystring |
| `/admin/bridge/restart` | POST | Fuerza un re-init del bridge. Requiere `x-admin-token` |

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
