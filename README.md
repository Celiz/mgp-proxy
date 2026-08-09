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
~9 minutos (configurable con `MGP_BRIDGE_RENEW_MS`).

La renovación intenta primero **en caliente**: le vuelve a pedir el challenge a la sesión
que ya está abierta, sin reiniciar Chromium. Medido en el A22 de producción, un init
completo son ~20s de los cuales ~11s son sólo levantar el navegador, así que saltearse
eso es más de la mitad del costo. Si la renovación en caliente no devuelve `cf_clearance`
(o falla), cae al camino completo: cerrar la sesión y abrir una nueva. Ese orden —cerrar
antes de abrir— es a propósito: la API sync de Playwright/patchright no tolera dos
sesiones abiertas a la vez en el mismo proceso. La renovación en caliente no cae en eso
porque no abre una segunda sesión, reusa la única que hay. Se puede desactivar con
`MGP_BRIDGE_HOT_RENEW=0`.

**Mientras haya un init en curso, las requests no esperan.** Antes se encolaban detrás y
el usuario pagaba los ~20s del challenge (en producción se midieron requests de 21s, y un
p99 de 85.974 ms contra un `MGP_CHALLENGE_TIMEOUT_MS` de 90.000 que no era casualidad).
Ahora se rechazan al toque con `bridge_initializing`, que `mgpQueue.ts` no cuenta para el
circuit breaker y que hace que se sirva caché stale. La única excepción es el arranque en
frío, donde no hay nada que servir y sí se espera. Lo mismo si una respuesta huele a
challenge (403/503 o HTML de "Just a moment"): dispara el re-init en segundo plano en vez
de reintentar en línea.

Como el bridge sólo procesa un comando por vez (no hay pipelining), toda request pasa
por una cola FIFO. Tres cosas la protegen para que una renovación o una ráfaga no
terminen tirando el circuit breaker general (`src/lib/mgpQueue.ts`):

- La renovación evita meterse a la fuerza en medio de tráfico: si hay algo en cola,
  reintenta en unos segundos (hasta un techo, para no postergarse para siempre).
- Por encima de `MGP_BRIDGE_MAX_QUEUE` (6 por defecto) requests esperando turno, las
  nuevas se rechazan rápido con `bridge_busy` en vez de sumarse a una fila sin techo.
- `bridge_busy` no cuenta para el circuit breaker: significa que el bridge está
  saturado, no que MGP esté fallando, así que `mgpQueue.ts` lo deja pasar sin sumar a
  `consecutiveErrors`. El resto de los errores (los que sí vienen de una respuesta real
  de MGP) siguen contando normal.

Ver `src/lib/mgpBridge.ts` (el lado Node: spawn del subproceso, cola de comandos,
renovación, tope de cola) y `bridge/bridge.py` (el lado Python: Scrapling + la llamada
real).

### Fast path con `curl_cffi` (experimental, apagado por default)

Esa serialización es hoy el cuello de botella real: medido en producción sobre 30 días,
el p50 está en ~570 ms pero el p95 en ~61 s, y el 25 % de las requests termina en 502
(mayormente `circuit_open` detrás de `bridge_busy`). MGP no es el problema — su okRate es
93,6 % y nunca devolvió 429.

La hipótesis del fast path: el navegador es imprescindible para **resolver** el Turnstile,
pero no para **usar** el resultado. Con `MGP_BRIDGE_FAST_FETCH=1`, después de cada init el
bridge guarda las cookies (`cf_clearance` + `PHPSESSID`) y el User-Agent reales, y repite
las requests con [`curl_cffi`](https://github.com/lexiforest/curl_cffi), que imita el
fingerprint TLS/HTTP2 de Chrome. Eso ataca justo la objeción que descartaba reusar la
cookie con `fetch()` de Node (que Turnstile valide más señales que la cookie sola), y saca
cada request del navegador, que es lo que las serializa.

La red de seguridad no es opcional: si `curl_cffi` recibe 403/503 o el HTML de "Just a
moment", esa request **cae al camino de siempre** (`page.evaluate`) y el fast path queda
apagado hasta el próximo init, que lo vuelve a prender con credenciales frescas. Si
Cloudflare invalida la clearance se pierde velocidad, nunca capacidad. Un error de red
transitorio también cae al navegador, pero sin apagar el atajo.

Antes de prenderlo en producción hay que correr `bridge/spike_curl_cffi.py`, que resuelve
el challenge una vez y compara la misma consulta por los dos caminos (más latencia y una
prueba de 5 requests en paralelo). El `impersonate` que gane el spike va en
`MGP_BRIDGE_FAST_IMPERSONATE`:

```bash
bridge/.venv/bin/python bridge/spike_curl_cffi.py
```

Con el flag apagado (el default) `bridge.py` se comporta exactamente como antes: no
captura credenciales en el init ni importa nada del fast path.

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

Termux nativo no sirve directo: es un entorno Android/bionic, no una distro Linux
estándar, y el Chromium que baja `patchright` es un build glibc que no corre ahí. Hace
falta `proot-distro` para tener una Debian ARM64 de verdad adentro del teléfono — Debian
arm64 es plataforma [oficialmente soportada por
Playwright](https://playwright.dev/docs/intro#system-requirements) (la base de
`patchright`), y ya es el mismo entorno que este repo usaba con el approach viejo (donde
Chromium corría bien; lo único que fallaba era el CDP crudo sin poder resolver el
Turnstile, no la plataforma). Dicho esto, **no está probado en un Android real** — si lo
corrés, contá cómo te fue.

```bash
pkg install proot-distro
proot-distro install debian
proot-distro login debian
```

Ya adentro de la Debian:

```bash
apt update && apt install -y curl git python3 python3-venv python3-pip
# el nodejs de apt suele quedar viejo; Node 22+ vía nodesource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs

git clone https://github.com/Celiz/mgp-proxy && cd mgp-proxy
npm install
npm run setup:bridge   # crea bridge/.venv, instala Scrapling y baja Chromium
npm start
```

Es la misma receta que la Opción A — no hace falta nada extra por estar en el teléfono
(sin display, sin `xvfb`: el Turnstile se resuelve headless). Si `patchright install
chromium` no encuentra build para la arquitectura del teléfono, la salida es instalar
`chromium` por `apt` y apuntar el bridge a ese binario con `MGP_BRIDGE_PYTHON` +
adaptando `bridge/bridge.py` para pasarle `executable_path` a `StealthySession` — no
debería hacer falta si Debian arm64 sigue estando soportado, pero queda como plan B.

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
| `MGP_BRIDGE_HOT_RENEW` | `1` (prendido) | Renovar la clearance sobre la sesión viva en vez de reiniciar Chromium. `0` lo apaga y vuelve al camino completo |
| `MGP_BRIDGE_MAX_QUEUE` | `6` | Tope de requests esperando turno en el bridge antes de rechazar rápido con `bridge_busy` |
| `MGP_BRIDGE_FAST_FETCH` | apagado | Fast path experimental: repite las requests con `curl_cffi` en vez de pasarlas por el navegador. Prender con `1`/`true`. Ante un challenge cae solo al camino de siempre |
| `MGP_BRIDGE_FAST_IMPERSONATE` | auto | Qué Chrome imita `curl_cffi` (`chrome131`, `chrome124`, …). Por defecto lo deduce del User-Agent real; usar el que gane `bridge/spike_curl_cffi.py` |
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
