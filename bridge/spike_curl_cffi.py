"""
Spike: ¿alcanza cf_clearance + curl_cffi para consultar webWS.php sin navegador?

Resuelve el Turnstile una vez con Scrapling (igual que bridge.py), extrae las
cookies y el User-Agent reales, y después compara la MISMA consulta hecha de dos
formas: adentro del navegador (el camino actual, control) y con curl_cffi
imitando el fingerprint TLS de Chrome (el camino propuesto).

Si el segundo devuelve los mismos datos, el refactor de bridge.py es viable y se
puede sacar el fetch por request del navegador. Si devuelve 403 o el HTML de
"Just a moment", la idea muere acá y no tocamos nada.

Además de "¿anda?", el spike mide las dos cosas por las que vale la pena el
cambio, que son las que hoy generan el 25% de 502:

  - latencia por request (el p95 de producción está en 61s, no en el p50)
  - concurrencia real: el navegador serializa todo en una cola de 6; curl_cffi
    no debería

Correr donde ya corre el bridge, con su mismo venv:
    bridge/.venv/bin/pip install -r bridge/requirements.txt
    bridge/.venv/bin/python bridge/spike_curl_cffi.py
"""

import json
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from scrapling.fetchers import StealthySession

try:
    from curl_cffi import requests as cffi
except ImportError:
    print("Falta curl_cffi: bridge/.venv/bin/pip install -r bridge/requirements.txt")
    sys.exit(1)

ENTRY_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/web/cuando.php"
REFERER_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/cuando.php"
WS_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/webWS.php"
ORIGIN = "https://appsl.mardelplata.gob.ar"

# Dos consultas, porque sirven para cosas distintas:
#
#   - la estática (el listado de líneas) no cambia entre una llamada y la otra,
#     así que es la única con la que tiene sentido comparar byte a byte el
#     resultado del navegador contra el de curl_cffi;
#   - la de arribos es el 81% del tráfico real y devuelve data viva (los minutos
#     cambian entre llamada y llamada), así que de esa se compara la forma:
#     CodigoEstado, claves y cantidad de registros.
#
# `codigoLineaParada=100` no es una línea: es el centinela "todas las líneas" de
# esa parada. Verificado contra producción -- con una línea concreta que no pare
# ahí el WS contesta 200 con CodigoEstado=-1 "La parada no corresponde a la
# linea", que serviría igual para el spike pero no ejercita el camino real.
BODY_ESTATICA = "accion=RecuperarLineaPorCuandoLlega"
BODY_ARRIBOS = "accion=RecuperarProximosArribosW&identificadorParada=P3606&codigoLineaParada=100"

# curl_cffi tiene que imitar la MISMA versión de Chrome que trae patchright: si
# el fingerprint TLS no coincide con el User-Agent, Cloudflare lo nota. Estos son
# los targets de Chrome que fue teniendo curl_cffi; se prueban ordenados por
# cercanía al UA real, y los que la versión instalada no conozca se descartan
# solos (tiran excepción, que el loop reporta y sigue).
TARGETS_CHROME = [
    "chrome146", "chrome145", "chrome142", "chrome136", "chrome133a",
    "chrome131", "chrome124", "chrome123", "chrome120", "chrome119",
    "chrome116", "chrome110", "chrome107",
]

# El fetch() de adentro de la página, para el control. El body va como argumento
# en vez de interpolado, para no pelearse con el escaping.
CODIGO_FETCH = """async (body) => {
    const resp = await fetch('webWS.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
        },
        body,
    });
    return { status: resp.status, body: await resp.text() };
}"""


def headers_como_el_spa(ua: str) -> dict:
    """
    Los mismos headers que manda el fetch() de adentro de la página. `Origin` va
    porque Chrome lo agrega en todo POST aunque sea same-origin, y `Accept: */*`
    es el default de fetch(). El resto (sec-ch-ua, orden de headers, ALPN) lo
    pone curl_cffi con impersonate.
    """
    return {
        "User-Agent": ua,
        "Accept": "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": ORIGIN,
        "Referer": REFERER_URL,
    }


def candidatos_impersonate(ua: str) -> list[str]:
    """Los targets de TARGETS_CHROME ordenados por cercanía a la versión del UA."""
    m = re.search(r"Chrome/(\d+)", ua)
    if not m:
        return TARGETS_CHROME
    major = int(m.group(1))

    def distancia(target: str) -> tuple[int, int]:
        n = int(re.search(r"\d+", target).group())
        # A igual distancia, preferimos el que no se pase de la versión real.
        return (abs(n - major), 1 if n > major else 0)

    return sorted(TARGETS_CHROME, key=distancia)


def parece_challenge(status: int, texto: str) -> bool:
    """Mismo criterio que `pareceChallenge` en src/lib/mgpBridge.ts."""
    if status in (403, 503):
        return True
    head = texto.lstrip()[:400].lower()
    return head.startswith("<") and (
        "just a moment" in head or "un momento" in head or "cf-" in head
    )


def resumen(texto: str) -> dict:
    """
    Forma de una respuesta, para comparar dos que no tienen por qué ser
    idénticas byte a byte (los arribos cambian entre una llamada y la otra).
    """
    try:
        data = json.loads(texto)
    except Exception:
        return {"json": False, "bytes": len(texto)}
    forma = {"json": True, "claves": sorted(data)} if isinstance(data, dict) else {"json": True}
    if isinstance(data, dict):
        forma["CodigoEstado"] = data.get("CodigoEstado")
        for k, v in data.items():
            if isinstance(v, list):
                forma[f"len({k})"] = len(v)
    return forma


def post_cffi(imp: str, body: str, ua: str, cookies: dict):
    """Un POST por curl_cffi, devolviendo también cuánto tardó."""
    t0 = time.perf_counter()
    r = cffi.post(
        WS_URL,
        data=body,
        cookies=cookies,
        headers=headers_como_el_spa(ua),
        impersonate=imp,
        timeout=20,
    )
    return r, (time.perf_counter() - t0) * 1000


def main() -> int:
    print("Resolviendo el challenge (esto tarda ~10s)...", flush=True)
    with StealthySession(headless=True, solve_cloudflare=True) as session:
        # Cloudflare a veces contesta 403 aunque Scrapling diga "captcha is
        # solved", y a veces ni challenguea y devuelve 200 de una. Es
        # intermitente por IP, así que se reintenta: lo único que necesita el
        # spike es una sesión con cf_clearance, y dar por muerta la hipótesis
        # por un 403 de entrada sería medir cualquier cosa.
        for intento in range(1, 6):
            resp = session.fetch(ENTRY_URL, network_idle=True)
            hay_clearance = any(c["name"] == "cf_clearance" for c in session.context.cookies())
            print(f"  entry status: {resp.status} (intento {intento}, cf_clearance={hay_clearance})")
            if hay_clearance:
                break
            time.sleep(3)

        pages = session.context.pages
        if not pages:
            print("\n  !! La sesión no dejó ninguna página abierta.")
            return 1
        page = pages[0]
        page.goto(REFERER_URL, wait_until="domcontentloaded")

        ua = page.evaluate("navigator.userAgent")
        # Sólo las del dominio de la MGP: context.cookies() devuelve las de
        # todos los dominios que haya tocado el navegador, y un nombre repetido
        # en otro dominio pisaría el bueno.
        cookies = {
            c["name"]: c["value"]
            for c in session.context.cookies()
            if "mardelplata.gob.ar" in c.get("domain", "")
        }

        print(f"  User-Agent: {ua}")
        print(f"  cookies: {sorted(cookies)}")
        if "cf_clearance" not in cookies:
            print("\n  !! No hay cf_clearance. Sin eso el spike no tiene sentido.")
            return 1

        def fetch_navegador(body: str):
            """El camino actual. Se cronometra desde acá, no desde adentro de la
            página: el viaje por CDP es parte de lo que hoy paga cada request."""
            t0 = time.perf_counter()
            r = page.evaluate(CODIGO_FETCH, body)
            return r, (time.perf_counter() - t0) * 1000

        # --- CONTROL: el camino actual, adentro del navegador ------------------
        print("\n[control] fetch dentro del navegador:")
        control = {}
        for nombre, body in (("estatica", BODY_ESTATICA), ("arribos", BODY_ARRIBOS)):
            r, ms = fetch_navegador(body)
            control[nombre] = r
            print(f"  {nombre:<9} -> {r['status']} en {ms:6.0f}ms | {len(r['body'])}b | {r['body'][:80]}")

        # --- PROPUESTA: curl_cffi con las cookies del navegador ----------------
        # Se prueba con la consulta estática, que es la que después se puede
        # comparar byte a byte contra el control.
        print("\n[propuesta] curl_cffi con cf_clearance:")
        exito = None
        respuesta_ok = None
        for imp in candidatos_impersonate(ua):
            try:
                r, ms = post_cffi(imp, BODY_ESTATICA, ua, cookies)
            except Exception as e:
                print(f"  {imp:<10} -> ERROR {type(e).__name__}: {e}")
                continue
            challenge = parece_challenge(r.status_code, r.text)
            marca = "CHALLENGE" if challenge else ("OK" if r.status_code == 200 else "?")
            print(f"  {imp:<10} -> {r.status_code} [{marca}] en {ms:6.0f}ms | {len(r.text)}b | {r.text[:80]}")
            if r.status_code == 200 and not challenge:
                exito = imp
                respuesta_ok = r
                break

        if not exito:
            print("\n" + "=" * 70)
            print("NO VIABLE. Cloudflare no acepta la cookie fuera del navegador.")
            print("-> Dejar bridge.py como está; el cuello hay que atacarlo por otro lado")
            print("   (subir MGP_BRIDGE_MAX_QUEUE, aflojar el breaker, o V670 de respaldo).")
            return 0

        # --- ¿devuelve lo mismo? -----------------------------------------------
        print(f"\n[comparación] impersonate='{exito}':")
        iguales = control["estatica"]["body"].strip() == respuesta_ok.text.strip()
        print(f"  estatica: idéntica byte a byte al control: {iguales}")
        if not iguales:
            print(f"    control  : {resumen(control['estatica']['body'])}")
            print(f"    curl_cffi: {resumen(respuesta_ok.text)}")

        r_arribos, _ = post_cffi(exito, BODY_ARRIBOS, ua, cookies)
        forma_control = resumen(control["arribos"]["body"])
        forma_cffi = resumen(r_arribos.text)
        # Los arribos son data viva: los minutos cambian entre una llamada y la
        # otra, así que acá se compara la forma, no los bytes.
        print(f"  arribos : status {r_arribos.status_code}, misma forma: {forma_control == forma_cffi}")
        print(f"    control  : {forma_control}")
        print(f"    curl_cffi: {forma_cffi}")

        # --- lo que motiva el cambio: latencia y concurrencia ------------------
        print("\n[latencia] 3 requests seguidas de cada lado (consulta de arribos):")
        ms_nav = [fetch_navegador(BODY_ARRIBOS)[1] for _ in range(3)]
        ms_cffi = [post_cffi(exito, BODY_ARRIBOS, ua, cookies)[1] for _ in range(3)]
        print(f"  navegador: mediana {statistics.median(ms_nav):6.0f}ms  {[round(x) for x in ms_nav]}")
        print(f"  curl_cffi: mediana {statistics.median(ms_cffi):6.0f}ms  {[round(x) for x in ms_cffi]}")

        # Lo que el navegador no puede hacer: 5 a la vez. Si el paralelo tarda
        # parecido a UNA sola, se cae la serialización que hoy llena la cola.
        print("\n[concurrencia] 5 requests en paralelo por curl_cffi:")
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=5) as pool:
            futuros = [
                pool.submit(post_cffi, exito, BODY_ARRIBOS, ua, cookies) for _ in range(5)
            ]
            resultados = []
            for f in futuros:
                try:
                    r, ms = f.result()
                    resultados.append((r.status_code, round(ms)))
                except Exception as e:
                    resultados.append((f"ERROR {type(e).__name__}", 0))
        total_ms = (time.perf_counter() - t0) * 1000
        print(f"  {total_ms:.0f}ms las 5 juntas | {resultados}")
        print(f"  (una sola tarda {statistics.median(ms_cffi):.0f}ms; el navegador las haría en fila)")

        # Si las 5 en paralelo no bajan de 5x una sola, el que serializa es PHP:
        # session_start() toma un lock exclusivo del archivo de sesión, así que
        # todo lo que comparta PHPSESSID se atiende de a uno igual. Vale la pena
        # saberlo antes de rediseñar el protocolo del bridge para concurrencia.
        sin_phpsessid = {k: v for k, v in cookies.items() if k != "PHPSESSID"}
        print("\n[concurrencia] las mismas 5 pero sin PHPSESSID (sólo cf_clearance):")
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=5) as pool:
            futuros = [
                pool.submit(post_cffi, exito, BODY_ARRIBOS, ua, sin_phpsessid) for _ in range(5)
            ]
            resultados = []
            for f in futuros:
                try:
                    r, ms = f.result()
                    resultados.append((r.status_code, len(r.text), round(ms)))
                except Exception as e:
                    resultados.append((f"ERROR {type(e).__name__}", 0, 0))
        print(f"  {(time.perf_counter() - t0) * 1000:.0f}ms las 5 juntas | {resultados}")
        print("  (si baja mucho, el cuello era el lock de sesión de PHP, no el navegador)")

        # Que ande en paralelo no sirve si sin sesión el WS contesta otra cosa.
        # Se compara contra el control con la consulta estática, que sí trae
        # contenido -- la de arribos puede estar vacía por el horario y haría
        # pasar por buena una respuesta degradada.
        r_sin, _ = post_cffi(exito, BODY_ESTATICA, ua, sin_phpsessid)
        print(f"  sin PHPSESSID, la consulta estática: status {r_sin.status_code}, {len(r_sin.text)}b, "
              f"idéntica al control: {r_sin.text.strip() == control['estatica']['body'].strip()}")

        # --- veredicto ---------------------------------------------------------
        print("\n" + "=" * 70)
        print(f"VIABLE. Anda con impersonate='{exito}'.")
        print("-> Se puede sacar el fetch por request del navegador.")
        print(f"-> Para prenderlo: MGP_BRIDGE_FAST_FETCH=1 MGP_BRIDGE_FAST_IMPERSONATE={exito}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
