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

Protocolo: una línea JSON por comando en stdin, una línea JSON de respuesta
por stdout. No hay pipelining -- quien hable con este proceso debe esperar la
respuesta antes de mandar el siguiente comando (lo serializa mgpBridge.ts).
"""

import sys
import json
import traceback

from scrapling.fetchers import StealthySession

ENTRY_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/web/cuando.php"
REFERER_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/cuando.php"


def respuesta(data: dict):
    sys.stdout.write(json.dumps(data) + "\n")
    sys.stdout.flush()


def log(msg: str):
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


class Bridge:
    def __init__(self):
        self.session: StealthySession | None = None
        self.api_page = None

    def init(self) -> dict:
        """
        Resuelve el challenge y arma una sesión nueva.

        Cierra la sesión vieja ANTES de abrir la nueva -- a propósito, aunque
        eso implique un hueco de ~10s sin servir durante una renovación. La
        API sync de patchright/Playwright no tolera dos sesiones abiertas a
        la vez en el mismo proceso: cada `StealthySession` sync deja su loop
        de asyncio corriendo en segundo plano mientras está abierta, y crear
        una segunda mientras la primera sigue viva revienta con "Playwright
        Sync API inside the asyncio loop" (medido). Ver mgpBridge.ts, que
        llama a este mismo comando tanto para el arranque como para la
        renovación periódica.
        """
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

        php_sess_id = next(
            (c["value"] for c in resp.cookies if c["name"] == "PHPSESSID"), None
        )
        log(f"PHPSESSID: {php_sess_id}")
        return {"ok": True, "phpSessId": php_sess_id}

    def fetch(self, body: str) -> dict:
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
        try:
            if cmd == "init":
                respuesta(bridge.init())
            elif cmd == "fetch":
                respuesta(bridge.fetch(msg["body"]))
            elif cmd == "shutdown":
                log("Shutting down...")
                bridge.close()
                respuesta({"ok": True})
                break
            else:
                respuesta({"error": f"Unknown cmd: {cmd}"})
        except Exception as e:
            log(traceback.format_exc())
            respuesta({"error": str(e)})


if __name__ == "__main__":
    main()
