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
import re
import sys
import json
import traceback

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
    sys.stdout.write(json.dumps(data) + "\n")
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

    def init(self) -> dict:
        """
        Consigue una clearance nueva. Dos caminos, en este orden:

        1. Renovación en caliente sobre la sesión que ya está viva. Medido en
           el A22 de producción, un init completo son ~20s de los cuales ~11s
           son sólo levantar Chromium: volver a pedir el challenge sobre la
           sesión existente se saltea esa mitad.
        2. Si eso no trae clearance, el camino de siempre: cerrar todo y abrir
           una sesión nueva.

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
            renovada = self._renovar_en_caliente()
            if renovada is not None:
                return renovada

        self.close()

        log("Starting StealthySession...")
        self.session = StealthySession.__enter__(
            StealthySession(headless=True, solve_cloudflare=True)
        )

        log("Solving CF...")
        resp = self.session.fetch(ENTRY_URL, network_idle=True)
        log(f"CF status: {resp.status}")

        pages = self.session.context.pages
        if pages:
            self.api_page = pages[0]
            self.api_page.goto(REFERER_URL, wait_until="domcontentloaded")
            log(f"Page: {self.api_page.url}")

        # El fast path necesita las credenciales de esta sesión nueva. Se
        # capturan sólo con el flag prendido: apagado, init() es el de siempre.
        if FAST_FETCH:
            self._capturar_credenciales()

        php_sess_id = next(
            (c["value"] for c in resp.cookies if c["name"] == "PHPSESSID"), None
        )
        log(f"PHPSESSID: {php_sess_id}")
        return {"ok": True, "phpSessId": php_sess_id}

    def _renovar_en_caliente(self) -> dict | None:
        """
        Pide una clearance nueva sobre la sesión que ya está abierta, sin
        reiniciar Chromium. Devuelve None si no salió, y ahí el que llama cae
        al camino completo -- que es el probado, así que ante cualquier duda
        conviene devolver None y pagar los segundos de más.
        """
        log("Renovando en caliente (sin reiniciar Chromium)...")
        try:
            resp = self.session.fetch(ENTRY_URL, network_idle=True)
            log(f"CF status: {resp.status} (en caliente)")

            # La clearance tiene que estar sí o sí: sin eso la renovación no
            # sirvió de nada y es mejor rehacer la sesión entera.
            cookies = self.session.context.cookies()
            if not any(c["name"] == "cf_clearance" for c in cookies):
                log("Renovación en caliente sin cf_clearance, rehago la sesión")
                return None

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
            log(f"PHPSESSID: {php_sess_id} (renovado en caliente)")
            return {"ok": True, "phpSessId": php_sess_id, "hotRenew": True}
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

    def fetch(self, body: str) -> dict:
        """
        Con el fast path prendido intenta primero por curl_cffi, que no pasa por
        el navegador y por lo tanto no se serializa contra el resto; si eso
        huele a challenge cae al camino de siempre. La red de seguridad no es
        opcional: si Cloudflare invalida la clearance se pierde velocidad, nunca
        capacidad.
        """
        if self._fast_disponible():
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


def main():
    bridge = Bridge()
    log("Bridge ready")
    if FAST_FETCH:
        log(f"fast path prendido (MGP_BRIDGE_FAST_FETCH), curl_cffi={'ok' if curl_requests else 'FALTA'}")

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
                respuesta(bridge.init(), msg_id)
            elif cmd == "fetch":
                respuesta(bridge.fetch(msg["body"]), msg_id)
            elif cmd == "shutdown":
                log("Shutting down...")
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
