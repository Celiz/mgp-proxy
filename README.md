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

### B. Todo en el celu (Termux + proot-distro)

Termux nativo no tiene Chromium, pero `proot-distro` te da un Debian ARM64 adentro del
teléfono, y ahí sí. Es el mismo entorno que el Dockerfile, con la ventaja de mantener la
IP residencial y el consumo de un celular.

```bash
pkg install proot-distro
proot-distro install debian
proot-distro login debian
```

Ya adentro de Debian:

```bash
apt update && apt install -y curl git chromium xvfb xauth
# el nodejs de apt es la 18 y no alcanza: hace falta WebSocket global (Node 22+)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs

git clone https://github.com/Celiz/mgp-proxy && cd mgp-proxy && npm install
MGP_BROWSER_PATH=/usr/bin/chromium xvfb-run -a npm start
```

Lo que hay que tener en cuenta antes de arrancar: son unos **2 GB** entre el rootfs de
Debian y Chromium, y el navegador se abre **cada ~12 minutos** para renovar el clearance
(unos 20 segundos, ~400 MB de RAM cada vez). En un teléfono viejo con poca RAM eso puede
ser demasiado; ahí conviene la opción A.

### C. Proxy en el celu + clearance desde otra máquina de la red

Si el celu no da para correr Chromium, el proxy puede vivir en Termux nativo (Node solo)
mientras otra máquina de la misma red resuelve el challenge y se lo pasa. Funciona porque
la cookie se ata a la IP pública, que ambos comparten.

En el teléfono, Termux nativo:

```bash
pkg install git nodejs
git clone https://github.com/Celiz/mgp-proxy && cd mgp-proxy && npm install
ADMIN_TOKEN=un-token-secreto npm start
```

En la otra máquina, **cada 10 minutos** (`cron`, o el Programador de tareas de Windows):

```bash
ADMIN_TOKEN=un-token-secreto npx tsx src/scripts/obtenerClearance.ts http://192.168.0.X:4000
```

El precio es que esa máquina tiene que estar prendida siempre: si se apaga, el proxy
aguanta ~12 minutos más y después empieza a devolver 502. Si esa máquina es una PC que
vas a tener encendida igual, es más simple correr el proxy directamente ahí (opción A).

### D. Docker / VPS / Render

El challenge necesita display, así que el arranque va envuelto en `xvfb` — ya está en el
`Dockerfile` y en el `render.yaml`. Sin `DISPLAY`, el proxy avisa con `no_display` en vez
de fallar en silencio.

Dos cosas que muerden acá: `xvfb-run` necesita `xauth` instalado (si no, aborta con
`xauth command not found`), y Chromium bajo root exige `--no-sandbox`, que el proxy
agrega solo al detectar que corre como root en Linux.

Tener en cuenta que sale por IP de datacenter, no residencial, y que abrir Chromium cada
~12 minutos en una instancia de 512 MB es apretado.

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
