"""
Bridge Python para MGP: resuelve el Turnstile de Cloudflare con Scrapling
(patchright, headless) y reenvía requests al WS web sin salir del contexto
del navegador.

Por qué esto y no cookies extraídas + fetch() de Node (el approach viejo de
src/lib/mgpWeb.ts, ver su historia en git): con CDP crudo un Chrome headless
nunca resolvía el Turnstile no-interactivo (medido, no pasaba nunca). Scrapling
con patchright sí lo resuelve headless en unos segundos. Una vez resuelto, en
vez de reintentar la cookie sola en un fetch() de Node -- lo que en teoría
funcionaba antes con el challenge viejo, pero no hay garantía de que siga
sirviendo contra Turnstile, que puede validar más señales que la cookie -- cada
request se hace DENTRO del navegador con page.evaluate(fetch(...)), igual que
el SPA oficial. Verificado funcionando end-to-end (ver proxy-bondi/).

Con MGP_BRIDGE_FAST_FETCH prendido (apagado por default) hay un atajo. El
navegador es imprescindible para RESOLVER el Turnstile, pero no necesariamente
para USAR el resultado: después del init se guardan las cookies (cf_clearance +
PHPSESSID) y el User-Agent reales, y cada request se repite con curl_cffi, que
imita el fingerprint TLS/HTTP2 de Chrome -- justo la objeción que mataba al
fetch() de Node. Si Cloudflare igual la rechaza, esa request cae al camino de
siempre y el atajo se apaga hasta el próximo init: se pierde velocidad, nunca
capacidad.

Protocolo: una línea JSON por comando en stdin, una línea JSON de respuesta
por stdout. No hay pipelining -- quien hable con este proceso debe esperar la
respuesta antes de mandar el siguiente comando (lo serializa mgpBridge.ts).
"""

import os
import time
import re
import sys
import json
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

from scrapling.fetchers import StealthySession

try:
    from curl_cffi import requests as curl_requests
except ImportError:  # el fast path es opcional: sin la lib se sigue por el navegador
    curl_requests = None

ENTRY_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/web/cuando.php"
REFERER_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/cuando.php"
WS_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/webWS.php"
ORIGIN = "https://appsl.mardelplata.gob.ar"

# Fast path: repetir las requests con curl_cffi en vez de pasarlas por el
# navegador. Apagado por default -- así, este archivo hace exactamente lo mismo
# que antes de que existiera el atajo.
FAST_FETCH = os.environ.get("MGP_BRIDGE_FAST_FETCH", "").strip().lower() in ("1", "true", "yes", "on")
# Qué Chrome imita curl_cffi. Vacío = deducido del User-Agent real.
FAST_IMPERSONATE = os.environ.get("MGP_BRIDGE_FAST_IMPERSONATE", "").strip()
# Por debajo de MGP_BRIDGE_FETCH_TIMEOUT_MS (15s del lado Node), para que un
# curl colgado todavía deje tiempo al fallback por navegador en vez de comerse
# el timeout entero y volver como bridge_timeout.
FAST_TIMEOUT_S = 8

# Renovar la clearance sobre la sesión viva en vez de reiniciar Chromium.
# Prendido por default; MGP_BRIDGE_HOT_RENEW=0 lo apaga sin redeployar, que en
# este archivo ya rompió dos veces (ver c98e77a) y conviene poder desarmar
# desde el .env del teléfono.
HOT_RENEW = os.environ.get("MGP_BRIDGE_HOT_RENEW", "1").strip().lower() not in ("0", "false", "no", "off")

# Esperar a que la red quede quieta al pedir el challenge. APAGADO por default:
# era el causante del tail. Medido en el A22, mismo teléfono, mismo día:
#
#   network_idle=True    arranque 3.1s + challenge 72.9s + referer 1.0s = 76.9s
#   network_idle=False   arranque 4.2s + challenge 12.0s + referer 1.0s = 17.1s
#
# Los ~60s de diferencia eran espera muerta: el log mostraba el hueco entero
# ENTRE "Cloudflare captcha is solved" y el "Fetched" siguiente, o sea con el
# challenge ya resuelto. El p95 de producción era 60.982ms. Y cf_clearance
# aparece igual sin la espera, así que no se estaba pagando por nada.
# MGP_BRIDGE_NETWORK_IDLE=1 la vuelve a prender.
NETWORK_IDLE = os.environ.get("MGP_BRIDGE_NETWORK_IDLE", "0").strip().lower() in ("1", "true", "yes", "on")

# Cuántas requests del fast path pueden estar en vuelo a la vez.
#
# El navegador es serial por obligación (la API sync de Playwright no tolera dos
# hilos), pero curl_cffi no lo toca: son llamadas de red y nada más. Hasta ahora
# igual se serializaban, porque el loop de main() atendía un comando por vez --
# así que el fast path bajaba el costo de cada request pero no destrababa el
# throughput, y durante los ~10s de cada renovación no entraba ninguna.
#
# 4 es deliberadamente conservador: el cuello de botella real es MGP, y el lado
# Node ya tiene su propio rate limit (mgpQueue.ts, 2 rps). Esto sólo evita que
# una request tenga que esperar a que termine la anterior.
FAST_WORKERS = max(1, int(os.environ.get("MGP_BRIDGE_FAST_WORKERS", "4")))

# stdout lo comparten el hilo principal y los del pool. Sin esto dos respuestas
# pueden entrelazarse en la misma línea y el lado Node descarta las dos.
_stdout_lock = threading.Lock()


def parece_challenge(status: int, texto: str) -> bool:
    """
    Mismo criterio que `pareceChallenge` en src/lib/mgpBridge.ts, replicado acá
    porque el fast path tiene que decidir solo si cae al navegador.
    """
    if status in (403, 503):
        return True
    head = texto.lstrip()[:400].lower()
    return head.startswith("<") and (
        "just a moment" in head or "un momento" in head or "cf-" in head
    )


def targets_impersonate() -> set:
    """Los `impersonate` que conoce la versión de curl_cffi instalada."""
    try:
        from typing import get_args

        from curl_cffi.requests.impersonate import BrowserTypeLiteral

        return set(get_args(BrowserTypeLiteral))
    except Exception:
        return set()


def respuesta(data: dict, msg_id=None):
    """
    Una línea JSON por respuesta. `msg_id` viaja de vuelta tal cual vino para
    que el lado Node pueda aparear pedido y respuesta: sin eso, una respuesta
    que llega después de que su fetch expiró se apareaba con el comando
    SIGUIENTE y le devolvía datos ajenos (ver mgpBridge.ts).
    """
    if msg_id is not None:
        data = {**data, "id": msg_id}
    linea = json.dumps(data) + "\n"
    with _stdout_lock:
        sys.stdout.write(linea)
        sys.stdout.flush()


def log(msg: str):
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


class Bridge:
    def __init__(self):
        self.session: StealthySession | None = None
        self.api_page = None
        # Credenciales del fast path. Sobreviven a close() a propósito: la
        # clearance vieja sigue valiendo mientras se reconstruye la sesión.
        self.cookies: dict = {}
        self.user_agent: str | None = None
        self.impersonate: str | None = None
        # Cloudflare rechazó la clearance: fast path apagado hasta el próximo
        # init que capture credenciales nuevas.
        self.fast_stale = False

    def init(self, forzado: bool = False) -> dict:
        """
        Consigue una clearance nueva. Dos caminos, en este orden:

        1. Renovación en caliente sobre la sesión que ya está viva, que se
           saltea el arranque de Chromium (~11s medidos en el A22).
        2. Si eso no trae clearance, el camino de siempre: cerrar todo y abrir
           una sesión nueva.

        Ojo con las proporciones: en el A22 se midió un init de 81s, del cual
        el arranque son ~11s y resolver el Turnstile ~9s. Los ~61s restantes se
        van adentro del fetch de ENTRY_URL DESPUÉS de que el captcha ya está
        resuelto -- ver NETWORK_IDLE, que es el sospechoso. O sea que esta
        renovación en caliente ayuda, pero el grueso del tiempo está en otro
        lado; por eso el desglose se loguea abajo.

        Ojo con el orden del camino 2: cierra la sesión vieja ANTES de abrir
        la nueva, a propósito, aunque eso implique un hueco sin servir. La API
        sync de patchright/Playwright no tolera dos sesiones abiertas a la vez
        en el mismo proceso: cada `StealthySession` sync deja su loop de
        asyncio corriendo en segundo plano mientras está abierta, y crear una
        segunda mientras la primera sigue viva revienta con "Playwright Sync
        API inside the asyncio loop" (medido, ver c98e77a). La renovación en
        caliente no cae en eso porque no abre una segunda sesión: reusa la
        única que hay. Ver mgpBridge.ts, que llama a este mismo comando tanto
        para el arranque como para la renovación periódica.
        """
        if HOT_RENEW and self.session is not None:
            renovada = self._renovar_en_caliente(exigir_nueva=forzado)
            if renovada is not None:
                return renovada

        self.close()

        t0 = time.monotonic()
        log("Starting StealthySession...")
        self.session = StealthySession.__enter__(
            StealthySession(headless=True, solve_cloudflare=True)
        )
        t_arranque = time.monotonic() - t0

        log("Solving CF...")
        t1 = time.monotonic()
        resp = self.session.fetch(ENTRY_URL, network_idle=NETWORK_IDLE)
        t_challenge = time.monotonic() - t1
        log(f"CF status: {resp.status}")

        t2 = time.monotonic()
        pages = self.session.context.pages
        if pages:
            self.api_page = pages[0]
            self.api_page.goto(REFERER_URL, wait_until="domcontentloaded")
            log(f"Page: {self.api_page.url}")
        t_referer = time.monotonic() - t2

        # Desglose para saber dónde se va el tiempo sin tener que leer el reloj
        # de las líneas de Scrapling. Medido en el A22: el challenge se resolvía
        # en ~9s pero este tramo tardaba ~70s (ver NETWORK_IDLE).
        log(
            f"init: arranque {t_arranque:.1f}s + challenge {t_challenge:.1f}s + "
            f"referer {t_referer:.1f}s = {time.monotonic() - t0:.1f}s "
            f"(network_idle={NETWORK_IDLE})"
        )

        # El fast path necesita las credenciales de esta sesión nueva. Se
        # capturan sólo con el flag prendido: apagado, init() es el de siempre.
        if FAST_FETCH:
            self._capturar_credenciales()

        php_sess_id = next(
            (c["value"] for c in resp.cookies if c["name"] == "PHPSESSID"), None
        )
        expira_ms = self._clearance_expira_ms()
        log(f"PHPSESSID: {php_sess_id}{self._vencimiento_log(expira_ms)}")
        return {"ok": True, "phpSessId": php_sess_id, "clearanceExpiresAt": expira_ms}

    def _clearance_cookie(self) -> dict | None:
        """La cookie cf_clearance entera de la sesión, si hay."""
        try:
            return next(
                (c for c in self.session.context.cookies() if c["name"] == "cf_clearance"),
                None,
            )
        except Exception:
            return None

    def _clearance_actual(self) -> str | None:
        """El valor de cf_clearance en la sesión, si hay."""
        cookie = self._clearance_cookie()
        return cookie["value"] if cookie else None

    def _clearance_expira_ms(self) -> int | None:
        """
        Cuándo vence la clearance, en epoch ms, o None si no se sabe.

        Es el dato que le faltaba al lado Node para dejar de renovar cada 9
        minutos adivinados: el vencimiento lo pone Cloudflare en la cookie (lo
        que dure el "Challenge Passage" de la zona), así que la renovación se
        puede agendar contra eso en vez de contra una constante. Playwright lo
        devuelve en segundos, y -1 cuando la cookie es de sesión (sin
        vencimiento propio); eso último viaja como None y del otro lado cae al
        intervalo fijo de siempre.
        """
        cookie = self._clearance_cookie()
        if not cookie:
            return None
        expires = cookie.get("expires")
        if not isinstance(expires, (int, float)) or expires <= 0:
            return None
        return int(expires * 1000)

    @staticmethod
    def _vencimiento_log(expira_ms: int | None) -> str:
        """Cuánto le queda a la clearance, para el log."""
        if expira_ms is None:
            return " (clearance sin vencimiento propio)"
        faltan_min = (expira_ms / 1000 - time.time()) / 60
        return f" (clearance vence en {faltan_min:.1f} min)"

    def _renovar_en_caliente(self, exigir_nueva: bool = False) -> dict | None:
        """
        Pide una clearance nueva sobre la sesión que ya está abierta, sin
        reiniciar Chromium. Devuelve None si no salió, y ahí el que llama cae
        al camino completo -- que es el probado, así que ante cualquier duda
        conviene devolver None y pagar los segundos de más.

        `exigir_nueva` es para los re-init disparados por un challenge. Visto en
        producción: Cloudflare rechazaba webWS.php con 403, pero al re-pedir
        ENTRY_URL contestaba 200 sin challenge -- la clearance seguía valiendo
        para esa URL. Sin esta bandera dábamos la renovación por buena, se
        reactivaba el fast path con la MISMA cookie rechazada, volvía el 403, y
        así en loop. Si nos re-inicializamos porque nos rechazaron, una
        clearance que no cambió no arregló nada: hay que rehacer la sesión.
        """
        log("Renovando en caliente (sin reiniciar Chromium)...")
        t0 = time.monotonic()
        clearance_previa = self._clearance_actual()
        try:
            resp = self.session.fetch(ENTRY_URL, network_idle=NETWORK_IDLE)
            log(f"CF status: {resp.status} en {time.monotonic() - t0:.1f}s (en caliente)")

            # La clearance tiene que estar sí o sí: sin eso la renovación no
            # sirvió de nada y es mejor rehacer la sesión entera.
            clearance = self._clearance_actual()
            if clearance is None:
                log("Renovación en caliente sin cf_clearance, rehago la sesión")
                return None

            # Si Cloudflare no challengeó, la cookie vuelve igual: no se renovó
            # nada, se revalidó. No es un problema -- cuando la clearance
            # realmente venza va a haber challenge y se resuelve acá mismo, en
            # esta misma sesión -- pero conviene que el log no diga "renovado"
            # cuando no pasó nada.
            #
            # Y no es sólo cosmético: revalidar tampoco corre el `expires`, así
            # que una renovación que cae en esta rama no compró un solo segundo
            # de vigencia. Por eso el vencimiento ahora viaja al lado Node y la
            # próxima renovación se agenda contra él (`clearanceExpiresAt` y
            # `proximaRenovacionMs` en mgpBridge.ts): renovar antes de que la
            # clearance esté por vencer es pagar el hueco al pedo.
            if clearance != clearance_previa:
                log("Clearance nueva")
            elif exigir_nueva:
                log("Clearance sin cambios pero nos habían rechazado, rehago la sesión")
                return None
            else:
                log("Clearance sin cambios (CF no challengeó, sigue válida)")

            pages = self.session.context.pages
            if not pages:
                log("Renovación en caliente sin páginas, rehago la sesión")
                return None
            self.api_page = pages[0]
            self.api_page.goto(REFERER_URL, wait_until="domcontentloaded")

            if FAST_FETCH:
                self._capturar_credenciales()

            php_sess_id = next(
                (c["value"] for c in resp.cookies if c["name"] == "PHPSESSID"), None
            )
            expira_ms = self._clearance_expira_ms()
            log(
                f"PHPSESSID: {php_sess_id} (renovado en caliente)"
                f"{self._vencimiento_log(expira_ms)}"
            )
            return {
                "ok": True,
                "phpSessId": php_sess_id,
                "hotRenew": True,
                "clearanceExpiresAt": expira_ms,
            }
        except Exception as e:
            log(f"Renovación en caliente falló ({e}), rehago la sesión")
            return None

    def _capturar_credenciales(self):
        """
        Guarda lo que el fast path necesita para repetir las requests fuera del
        navegador: las cookies de la MGP (cf_clearance + PHPSESSID) y el
        User-Agent real. El fingerprint TLS/HTTP2 lo pone curl_cffi.

        Ante cualquier problema deja el fast path apagado en vez de arriesgarse
        con credenciales a medias: el navegador sigue sirviendo igual.
        """
        if curl_requests is None:
            log("fast: MGP_BRIDGE_FAST_FETCH prendido pero falta curl_cffi, sigo por el navegador")
            self.fast_stale = True
            return

        try:
            # Sólo las del dominio de la MGP: context.cookies() devuelve las de
            # todos los dominios que haya tocado el navegador, y un nombre
            # repetido en otro dominio pisaría el bueno.
            cookies = {
                c["name"]: c["value"]
                for c in self.session.context.cookies()
                if "mardelplata.gob.ar" in c.get("domain", "")
            }
            user_agent = self.api_page.evaluate("navigator.userAgent") if self.api_page else None
        except Exception as e:
            log(f"fast: no pude leer cookies/UA ({e}), sigo por el navegador")
            self.fast_stale = True
            return

        if "cf_clearance" not in cookies or not user_agent:
            log(f"fast: sesión sin cf_clearance o sin UA (cookies={sorted(cookies)}), sigo por el navegador")
            self.fast_stale = True
            return

        self.cookies = cookies
        self.user_agent = user_agent
        self.impersonate = self._elegir_impersonate(user_agent)
        self.fast_stale = False
        log(f"fast: listo (cookies={sorted(cookies)}, impersonate={self.impersonate})")

    @staticmethod
    def _elegir_impersonate(user_agent: str) -> str:
        """
        curl_cffi tiene que imitar la MISMA versión de Chrome que trae
        patchright: si el fingerprint TLS no coincide con el User-Agent,
        Cloudflare lo nota. Si la versión exacta no está entre las que soporta
        la curl_cffi instalada, cae a "chrome" (la última que tenga). Se puede
        fijar a mano con MGP_BRIDGE_FAST_IMPERSONATE -- p.ej. la que haya ganado
        spike_curl_cffi.py.
        """
        if FAST_IMPERSONATE:
            return FAST_IMPERSONATE
        m = re.search(r"Chrome/(\d+)", user_agent)
        if m and f"chrome{m.group(1)}" in targets_impersonate():
            return f"chrome{m.group(1)}"
        return "chrome"

    def _headers_spa(self) -> dict:
        """
        Los mismos headers que manda el fetch() de adentro de la página.
        `Origin` va porque Chrome lo agrega en todo POST aunque sea same-origin,
        y `Accept: */*` es el default de fetch(). El resto (sec-ch-ua, orden de
        headers, ALPN) lo pone curl_cffi con impersonate.
        """
        return {
            "User-Agent": self.user_agent,
            "Accept": "*/*",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": ORIGIN,
            "Referer": REFERER_URL,
        }

    def _fast_disponible(self) -> bool:
        return (
            FAST_FETCH
            and curl_requests is not None
            and not self.fast_stale
            and bool(self.cookies)
            and bool(self.user_agent)
        )

    def fetch(self, body: str, permitir_fast: bool = True) -> dict:
        """
        Con el fast path prendido intenta primero por curl_cffi, que no pasa por
        el navegador y por lo tanto no se serializa contra el resto; si eso
        huele a challenge cae al camino de siempre. La red de seguridad no es
        opcional: si Cloudflare invalida la clearance se pierde velocidad, nunca
        capacidad.

        `permitir_fast=False` lo manda el lado Node (`noFast`) cuando la request
        ya fracasó por el atajo y viene a reintentar por el navegador. Sin eso
        se volvía a intentar curl_cffi acá adentro y se pagaban los 8s del
        timeout dos veces por la misma request.
        """
        if permitir_fast and self._fast_disponible():
            rapida = self._fetch_rapido(body)
            if rapida is not None:
                return rapida

        resultado = self._fetch_navegador(body)
        if self.fast_stale:
            # Aviso para el lado Node (hoy lo ignora; el campo es de más): la
            # clearance que usaba el fast path quedó vieja. No re-inicializamos
            # acá adentro -- un init tarda ~10s, reventaría el timeout de fetch
            # y dejaría desfasado el protocolo de una línea por comando. Lo
            # arregla el próximo init, sea la renovación periódica o el re-init
            # reactivo que ya dispara mgpBridge.ts.
            resultado["needsReinit"] = True
        return resultado

    def _fetch_rapido(self, body: str) -> dict | None:
        """
        La misma request, pero fuera del navegador. Devuelve None cuando hay que
        caer al camino de siempre (error de red, o Cloudflare rechazando).
        """
        try:
            resp = curl_requests.post(
                WS_URL,
                data=body,
                cookies=self.cookies,
                headers=self._headers_spa(),
                impersonate=self.impersonate,
                timeout=FAST_TIMEOUT_S,
            )
        except Exception as e:
            log(f"fast: {type(e).__name__}: {e} -- voy por el navegador")
            return None

        texto = resp.text
        if parece_challenge(resp.status_code, texto):
            log(f"fast: challenge (status={resp.status_code}), apago el fast path hasta el próximo init")
            self.fast_stale = True
            return None

        log(f"  fast status={resp.status_code} body={texto[:80]}")
        return {
            "status": resp.status_code,
            "body": texto,
            "headers": {k.lower(): v for k, v in resp.headers.items()},
        }

    def _fetch_navegador(self, body: str) -> dict:
        """El camino de siempre: fetch() adentro de la página, como el SPA."""
        if self.api_page is None:
            return {"status": 503, "body": '{"error":"No page"}', "headers": {}}

        body_escaped = body.replace("\\", "\\\\").replace("'", "\\'")
        code = f"""
            async () => {{
                const resp = await fetch('webWS.php', {{
                    method: 'POST',
                    headers: {{
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest',
                    }},
                    body: '{body_escaped}',
                }});
                const text = await resp.text();
                const hdrs = {{}};
                resp.headers.forEach((v, k) => {{ hdrs[k] = v; }});
                return {{ status: resp.status, body: text, headers: hdrs }};
            }}
        """

        try:
            result = self.api_page.evaluate(code)
        except Exception as e:
            log(f"evaluate error: {e}")
            return {"status": 502, "body": json.dumps({"error": str(e)}), "headers": {}}

        log(f"  status={result['status']} body={result['body'][:80]}")
        return result

    def close(self):
        # Ojo: no se limpian las credenciales del fast path. La clearance es una
        # cookie de Cloudflare, no de esta pestaña: sigue valiendo mientras se
        # reconstruye la sesión, así que permite seguir respondiendo durante el
        # hueco de ~10s de la renovación. La pisa el próximo init exitoso.
        if self.session is not None:
            try:
                self.session.__exit__(None, None, None)
            except Exception:
                pass
            self.session = None
            self.api_page = None


def con_estado(bridge: "Bridge", data: dict) -> dict:
    """
    `fastReady` le dice al lado Node si este comando se puede mandar sin pasar
    por su mutex. Viaja en cada respuesta porque el estado cambia solo: un
    challenge apaga el fast path hasta el próximo init, y Node necesita
    enterarse sin tener que preguntar.
    """
    return {**data, "fastReady": bridge._fast_disponible()}


def atender_fast(bridge: "Bridge", body: str, msg_id):
    """
    Atiende un fetch en un hilo del pool. SÓLO curl_cffi, nunca el navegador:
    la API sync de Playwright revienta si se la toca fuera del hilo principal,
    así que cuando el atajo no sirve devolvemos `retrySerial` y el lado Node
    reenvía el mismo body por el camino serial (con `noFast`, para no volver a
    caer acá y quedar en loop).
    """
    try:
        rapida = bridge._fetch_rapido(body)
    except Exception:
        log(traceback.format_exc())
        rapida = None

    if rapida is None:
        respuesta({"retrySerial": True, "fastReady": bridge._fast_disponible()}, msg_id)
        return
    respuesta(con_estado(bridge, rapida), msg_id)


def main():
    bridge = Bridge()
    log("Bridge ready")
    if FAST_FETCH:
        log(f"fast path prendido (MGP_BRIDGE_FAST_FETCH), curl_cffi={'ok' if curl_requests else 'FALTA'}")
        log(f"fast workers: {FAST_WORKERS}")

    pool = ThreadPoolExecutor(max_workers=FAST_WORKERS, thread_name_prefix="fast")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            respuesta({"error": f"Invalid JSON: {e}"})
            continue

        cmd = msg.get("cmd")
        msg_id = msg.get("id")
        try:
            if cmd == "init":
                respuesta(con_estado(bridge, bridge.init(bool(msg.get("force")))), msg_id)
            elif cmd == "fetch":
                # El fast path se va al pool y deja el loop libre para seguir
                # leyendo. El camino por navegador se atiende acá mismo, en
                # serie, que es la única forma en que Playwright sync funciona.
                noFast = bool(msg.get("noFast"))
                if bridge._fast_disponible() and not noFast:
                    pool.submit(atender_fast, bridge, msg["body"], msg_id)
                else:
                    respuesta(con_estado(bridge, bridge.fetch(msg["body"], not noFast)), msg_id)
            elif cmd == "shutdown":
                log("Shutting down...")
                pool.shutdown(wait=False)
                bridge.close()
                respuesta({"ok": True}, msg_id)
                break
            else:
                respuesta({"error": f"Unknown cmd: {cmd}"}, msg_id)
        except Exception as e:
            log(traceback.format_exc())
            respuesta({"error": str(e)}, msg_id)


if __name__ == "__main__":
    main()
