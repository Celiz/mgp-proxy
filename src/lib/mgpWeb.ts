/**
 * Transporte hacia el WS web de MGP (`app_cuando_llega/webWS.php`).
 *
 * Reemplaza a mgpDirect (app Cordova V670 + auth RSA), que quedó inutilizable:
 * Cloudflare tiene una regla sobre `appWS.php` que devuelve 429 permanente a
 * nuestra IP — medido, hasta un Chrome real con cf_clearance válido y
 * registro.php en 200 se come el mismo 429. No es rate limiting nuestro, así que
 * no hay ajuste de breaker que lo arregle.
 *
 * El WS web no tiene esa regla: está detrás de un managed challenge. La única
 * barrera es conseguir `cf_clearance`, y para eso hace falta un navegador real
 * (`--headless=new` NO lo resuelve; medido, 60s sin pasar).
 *
 * Clave del diseño: el navegador se usa SOLO para obtener/renovar las cookies.
 * Una vez que tenemos cf_clearance + PHPSESSID, `fetch()` común de Node contra
 * webWS.php responde 200 con datos reales, así que las requests normales no
 * pagan el costo del browser (a diferencia de pasar cada una por page.evaluate).
 *
 * El clearance está atado a IP + User-Agent: si el proxy cambia de red, se
 * invalida y se renueva solo al primer 403.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const WS_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/webWS.php";
/** Página que dispara el challenge de Cloudflare. */
const ENTRY_URL = "https://appsl.mardelplata.gob.ar/app_cuando_llega/web/cuando.php";
/** Contexto desde el que el SPA oficial hace sus AJAX (lo usamos como Referer). */
const REFERER = "https://appsl.mardelplata.gob.ar/app_cuando_llega/cuando.php";
const ORIGIN = "https://appsl.mardelplata.gob.ar";

/** Timeout de cada llamada a webWS.php. */
const CALL_TIMEOUT_MS = 12_000;
/**
 * Cuánto dura un clearance de verdad.
 *
 * OJO: el atributo `Expires` de la cookie dice 365 días y es una pista falsa.
 * Cloudflare decide aparte, del lado del servidor, hasta cuándo lo acepta
 * ("challenge passage"), y eso no viaja en la cookie. Medido contra MGP con una
 * request cada 3 minutos: anduvo hasta los 12 min y rebotó a los 15.
 *
 * De ahí los dos umbrales: a los 9 min renovamos en segundo plano mientras
 * seguimos sirviendo con el clearance viejo, y a los 13 lo damos por muerto y
 * las requests esperan. Así el vencimiento no se le aparece nunca al usuario.
 */
const CLEARANCE_RENOVAR_MS = Number(process.env.MGP_CLEARANCE_TTL_MS ?? 9 * 60_000);
const CLEARANCE_VENCIDO_MS = Number(process.env.MGP_CLEARANCE_MAX_MS ?? 13 * 60_000);
/** Techo para resolver el challenge (medido: ~20s en una corrida normal). */
const CHALLENGE_TIMEOUT_MS = Number(process.env.MGP_CHALLENGE_TIMEOUT_MS ?? 90_000);
/** Cooldown tras un fallo de renovación: no abrimos navegadores en ráfaga. */
const RENEW_COOLDOWN_MS = 60_000;

const CLEARANCE_FILE = path.resolve(process.cwd(), "src/data/clearance.json");

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

export type Clearance = {
    /**
     * Cookies del dominio de MGP. La única imprescindible es `cf_clearance`
     * (verificado: sola alcanza; sin ella, 403). Las demás viajan igual porque no
     * molestan y ahorran suposiciones sobre el WS.
     */
    cookies: { name: string; value: string }[];
    /** El UA del navegador que resolvió el challenge: CF lo valida junto a la cookie. */
    ua: string;
    /** Cuándo se obtuvo. */
    at: number;
    /**
     * Vencimiento que declara la cookie, en ms epoch. Informativo nada más: dice
     * 365 días y Cloudflare la rechaza a los ~13 min igual. La vigencia real se
     * calcula sobre `at`.
     */
    expiraEn?: number;
    /** Cómo se obtuvo: navegador local o inyectado desde afuera. */
    origen: "browser" | "externo";
};

/** Todavía sirve, pero conviene ir renovándolo en segundo plano. */
function convieneRenovar(c: Clearance): boolean {
    return Date.now() - c.at >= CLEARANCE_RENOVAR_MS;
}

/** Ya no es confiable: hay que esperar uno nuevo antes de seguir. */
function estaVencido(c: Clearance): boolean {
    return Date.now() - c.at >= CLEARANCE_VENCIDO_MS;
}

let clearance: Clearance | null = null;
let renewing: Promise<Clearance> | null = null;
let renewCooldownUntil = 0;
let ultimoErrorRenovacion: string | null = null;

export function isMgpWebEnabled(): boolean {
    return (process.env.MGP_TRANSPORT ?? "web") === "web";
}

export function getClearanceInfo(): {
    presente: boolean;
    edadMs: number | null;
    venceEn: string | null;
    vigente: boolean;
    origen: string | null;
    renovando: boolean;
    ultimoError: string | null;
} {
    return {
        presente: Boolean(clearance),
        edadMs: clearance ? Date.now() - clearance.at : null,
        venceEn: clearance ? new Date(clearance.at + CLEARANCE_VENCIDO_MS).toISOString() : null,
        vigente: clearance ? !estaVencido(clearance) : false,
        origen: clearance?.origen ?? null,
        renovando: Boolean(renewing),
        ultimoError: ultimoErrorRenovacion,
    };
}

// ---------------------------------------------------------------------------
// Persistencia: sobrevivir reinicios sin volver a abrir el navegador
// ---------------------------------------------------------------------------

function guardarClearance(c: Clearance): void {
    try {
        fs.mkdirSync(path.dirname(CLEARANCE_FILE), { recursive: true });
        fs.writeFileSync(CLEARANCE_FILE, JSON.stringify(c, null, 2));
    } catch (e) {
        console.warn("[mgpWeb] no se pudo persistir el clearance:", (e as Error).message);
    }
}

export function cargarClearanceDeDisco(): void {
    try {
        if (!fs.existsSync(CLEARANCE_FILE)) return;
        const c = JSON.parse(fs.readFileSync(CLEARANCE_FILE, "utf8")) as Clearance;
        if (!c?.cookies?.length || !c.ua) return;
        clearance = c;
        const edadMin = Math.round((Date.now() - c.at) / 60_000);
        console.log(`[mgpWeb] clearance recuperado de disco (${edadMin} min de antigüedad)`);
    } catch (e) {
        console.warn("[mgpWeb] clearance en disco ilegible:", (e as Error).message);
    }
}

/**
 * Inyecta un clearance obtenido en otra máquina de la misma red.
 *
 * El proxy puede vivir donde no haya navegador (Termux) mientras algo en la
 * misma IP pública le acerque las cookies: CF las valida por IP + UA, no por
 * host. Ver `src/scripts/obtenerClearance.ts`.
 */
export function setClearance(c: Omit<Clearance, "at" | "origen"> & { at?: number }): void {
    clearance = {
        cookies: c.cookies,
        ua: c.ua,
        at: c.at ?? Date.now(),
        expiraEn: c.expiraEn,
        origen: "externo",
    };
    ultimoErrorRenovacion = null;
    // Un clearance recién inyectado merece otra oportunidad aunque el navegador
    // local venga fallando: es justamente el caso donde no hay navegador.
    renewCooldownUntil = 0;
    guardarClearance(clearance);
    const vence = c.expiraEn ? ` — vence ${new Date(c.expiraEn).toISOString()}` : "";
    console.log(`[mgpWeb] clearance externo aceptado (${c.cookies.length} cookies)${vence}`);
}

// ---------------------------------------------------------------------------
// Cliente CDP mínimo (evita meter playwright/puppeteer como dependencia)
// ---------------------------------------------------------------------------

type CdpCliente = {
    send: (method: string, params?: unknown, sessionId?: string) => Promise<any>;
    close: () => void;
};

function conectarCdp(url: string): Promise<CdpCliente> {
    // WebSocket global recién existe desde Node 22. En un Debian de proot-distro
    // `apt install nodejs` todavía trae la 18, y sin este chequeo el error que
    // aparece es un "WebSocket is not defined" que no dice qué hacer.
    if (typeof WebSocket === "undefined") {
        return Promise.reject(
            new Error(
                `node_viejo: hace falta Node 22+ para hablar con el navegador (tenés ${process.version}). ` +
                    "En Debian/proot: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs",
            ),
        );
    }
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const pendientes = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
        let id = 0;

        ws.onmessage = (ev: MessageEvent) => {
            const m = JSON.parse(String(ev.data));
            const p = m.id ? pendientes.get(m.id) : undefined;
            if (!p) return;
            pendientes.delete(m.id);
            if (m.error) p.err(new Error(JSON.stringify(m.error)));
            else p.ok(m.result);
        };
        ws.onerror = () => reject(new Error("no se pudo abrir el WebSocket de CDP"));
        ws.onclose = () => {
            for (const p of pendientes.values()) p.err(new Error("conexión CDP cerrada"));
            pendientes.clear();
        };
        ws.onopen = () =>
            resolve({
                send: (method, params = {}, sessionId) =>
                    new Promise((ok, err) => {
                        const msgId = ++id;
                        pendientes.set(msgId, { ok, err });
                        ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
                    }),
                close: () => ws.close(),
            });
    });
}

// ---------------------------------------------------------------------------
// Navegador: dónde está y cómo se lanza
// ---------------------------------------------------------------------------

const CANDIDATOS_NAVEGADOR = [
    process.env.MGP_BROWSER_PATH,
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    // Linux / Docker
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    // Termux
    `${process.env.PREFIX ?? "/data/data/com.termux/files/usr"}/bin/chromium`,
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];

function buscarNavegador(): string | null {
    for (const c of CANDIDATOS_NAVEGADOR) {
        try {
            if (fs.existsSync(c)) return c;
        } catch {
            // ruta inválida en esta plataforma, seguimos
        }
    }
    return null;
}

const PERFIL_DIR = path.resolve(process.cwd(), ".browser-profile");

function leerPuertoCdp(): number | null {
    try {
        const f = path.join(PERFIL_DIR, "DevToolsActivePort");
        const linea = fs.readFileSync(f, "utf8").split("\n")[0]?.trim();
        const puerto = Number(linea);
        return Number.isFinite(puerto) && puerto > 0 ? puerto : null;
    } catch {
        return null;
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Renovación del clearance
// ---------------------------------------------------------------------------

/**
 * Abre un navegador, espera a que Cloudflare libere y devuelve las cookies.
 *
 * Exportada porque `src/scripts/obtenerClearance.ts` la usa para resolver el
 * challenge en una máquina con display y mandárselo a un proxy que no la tiene.
 */
export async function obtenerClearanceConNavegador(): Promise<Clearance> {
    const navegador = buscarNavegador();
    if (!navegador) {
        throw new Error(
            "no_browser: no encontré Chrome/Chromium. Instalalo, o definí MGP_BROWSER_PATH, " +
                "o inyectá el clearance desde otra máquina de la misma red (POST /admin/clearance).",
        );
    }
    // Sin display no hay challenge resuelto: headless=new no pasa. En un server
    // Linux hay que envolver el proceso con xvfb-run.
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.MGP_ALLOW_HEADLESS) {
        throw new Error(
            "no_display: el challenge de Cloudflare no se resuelve headless. " +
                "Arrancá el proxy con `xvfb-run -a npm start` o inyectá el clearance por /admin/clearance.",
        );
    }

    try {
        fs.rmSync(path.join(PERFIL_DIR, "DevToolsActivePort"), { force: true });
    } catch {
        // no existía
    }

    const args = [
        "--remote-debugging-port=0",
        `--user-data-dir=${PERFIL_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,900",
        "--disable-dev-shm-usage",
    ];
    // En un contenedor el proceso corre como root, y Chromium se niega a
    // arrancar así salvo que se desactive el sandbox. Sólo ahí: en una PC
    // normal no hay razón para bajarle las defensas al navegador.
    const esRoot = process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0;
    if (esRoot || process.env.MGP_BROWSER_NO_SANDBOX) {
        args.push("--no-sandbox", "--disable-setuid-sandbox");
    }
    if (process.env.MGP_ALLOW_HEADLESS) args.unshift("--headless=new");

    let proc: ChildProcess | null = spawn(navegador, args, { stdio: "ignore" });
    const matar = () => {
        try {
            proc?.kill();
        } catch {
            // ya murió
        }
        proc = null;
    };

    try {
        // Chrome publica el puerto elegido en DevToolsActivePort.
        let puerto: number | null = null;
        for (let i = 0; i < 60 && !puerto; i++) {
            await sleep(250);
            puerto = leerPuertoCdp();
        }
        if (!puerto) throw new Error("el navegador no expuso el puerto de CDP");

        let version: { webSocketDebuggerUrl: string } | null = null;
        for (let i = 0; i < 40 && !version; i++) {
            try {
                version = (await (await fetch(`http://127.0.0.1:${puerto}/json/version`)).json()) as {
                    webSocketDebuggerUrl: string;
                };
            } catch {
                await sleep(250);
            }
        }
        if (!version) throw new Error("el navegador no respondió en el puerto de CDP");

        const cdp = await conectarCdp(version.webSocketDebuggerUrl);
        try {
            const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
            const enPagina = (method: string, params?: unknown) => cdp.send(method, params, sessionId);
            await enPagina("Page.enable");
            await enPagina("Runtime.enable");
            await enPagina("Page.navigate", { url: ENTRY_URL });

            const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
            while (Date.now() < deadline) {
                await sleep(1500);
                const r = await enPagina("Runtime.evaluate", {
                    expression: "document.title",
                    returnByValue: true,
                });
                const titulo = String(r?.result?.value ?? "");
                const { cookies } = await cdp.send("Storage.getCookies", {});
                const cf = (cookies as { name: string; domain: string; expires?: number }[]).find(
                    (c) => c.name === "cf_clearance" && c.domain.includes("mardelplata"),
                );
                // El título deja de ser "Un momento…"/"Just a moment…" cuando CF libera.
                const enChallenge = /momento|moment/i.test(titulo);
                if (cf && !enChallenge) {
                    const uaRes = await enPagina("Runtime.evaluate", {
                        expression: "navigator.userAgent",
                        returnByValue: true,
                    });
                    const relevantes = (cookies as { name: string; value: string; domain: string }[])
                        .filter((c) => c.domain.includes("mardelplata"))
                        .map((c) => ({ name: c.name, value: c.value }));
                    // CDP da `expires` en segundos epoch; -1 significa cookie de sesión.
                    const expiraEn = cf.expires && cf.expires > 0 ? cf.expires * 1000 : undefined;
                    return {
                        cookies: relevantes,
                        ua: String(uaRes.result.value),
                        at: Date.now(),
                        expiraEn,
                        origen: "browser",
                    };
                }
            }
            throw new Error(`el challenge no se resolvió en ${Math.round(CHALLENGE_TIMEOUT_MS / 1000)}s`);
        } finally {
            cdp.close();
        }
    } finally {
        matar();
    }
}

async function obtenerClearance(): Promise<Clearance> {
    // Todavía fresco: nada que hacer.
    if (clearance && !convieneRenovar(clearance)) return clearance;

    // Zona de gracia: sigue sirviendo pero le queda poco. Disparamos la
    // renovación sin esperarla y contestamos con el actual, así el usuario no
    // paga los ~20s del navegador.
    if (clearance && !estaVencido(clearance)) {
        void renovar().catch(() => {
            // El error ya quedó en ultimoErrorRenovacion; si el clearance llega a
            // vencer del todo, la próxima request espera y ahí sí propaga.
        });
        return clearance;
    }

    if (renewing) return renewing;
    if (Date.now() < renewCooldownUntil) {
        // Con un clearance viejo pero existente conviene intentar igual: puede
        // seguir siendo válido y es mejor que devolver error seguro.
        if (clearance) return clearance;
        throw new Error(`mgp_clearance_cooldown: ${ultimoErrorRenovacion ?? "renovación en cooldown"}`);
    }
    return renovar();
}

/** Renueva el clearance, con una sola renovación en vuelo a la vez. */
function renovar(): Promise<Clearance> {
    if (renewing) return renewing;
    if (Date.now() < renewCooldownUntil) {
        return Promise.reject(
            new Error(`mgp_clearance_cooldown: ${ultimoErrorRenovacion ?? "renovación en cooldown"}`),
        );
    }

    console.log("[mgpWeb] renovando clearance (abriendo navegador)...");
    renewing = obtenerClearanceConNavegador()
        .then((c) => {
            clearance = c;
            ultimoErrorRenovacion = null;
            guardarClearance(c);
            console.log(`[mgpWeb] clearance OK (${c.cookies.length} cookies)`);
            return c;
        })
        .catch((e) => {
            ultimoErrorRenovacion = (e as Error).message;
            renewCooldownUntil = Date.now() + RENEW_COOLDOWN_MS;
            console.warn("[mgpWeb] no se pudo renovar el clearance:", ultimoErrorRenovacion);
            throw e;
        })
        .finally(() => {
            renewing = null;
        });

    return renewing;
}

// ---------------------------------------------------------------------------
// La llamada real
// ---------------------------------------------------------------------------

function pareceChallenge(status: number, text: string): boolean {
    if (status === 403 || status === 503) return true;
    const head = text.trimStart().slice(0, 400).toLowerCase();
    return head.startsWith("<") && (head.includes("just a moment") || head.includes("un momento") || head.includes("cf-"));
}

async function llamar(c: Clearance, body: string): Promise<{ status: number; text: string }> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
    try {
        const res = await fetch(WS_URL, {
            method: "POST",
            headers: {
                "User-Agent": c.ua,
                Cookie: c.cookies.map((k) => `${k.name}=${k.value}`).join("; "),
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                Referer: REFERER,
                Origin: ORIGIN,
                Accept: "*/*",
                "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
            },
            body,
            signal: ctrl.signal,
        });
        return { status: res.status, text: await res.text() };
    } finally {
        clearTimeout(tid);
    }
}

/**
 * Punto de entrada del transporte. El body viaja tal cual: el contrato del WS
 * web es el mismo que ya habla el frontend (RecuperarProximosArribosW,
 * RecuperarCallesPrincipalPorLinea, etc.), así que no hay traducción.
 */
export async function fetchMgpWeb(body: string): Promise<unknown> {
    let c = await obtenerClearance();
    let { status, text } = await llamar(c, body);

    // Un challenge acá significa clearance vencido/atado a otra IP: renovamos y
    // reintentamos una sola vez.
    if (pareceChallenge(status, text)) {
        console.warn(`[mgpWeb] challenge en webWS.php (HTTP ${status}), renovando clearance`);
        clearance = null;
        renewCooldownUntil = 0;
        c = await obtenerClearance();
        ({ status, text } = await llamar(c, body));
    }

    if (status === 429) throw new Error("webWS.php devolvió 429");
    if (status >= 400) throw new Error(`webWS.php devolvió ${status}`);
    if (!text.trim()) throw new Error("webWS.php devolvió body vacío");

    try {
        return JSON.parse(text);
    } catch {
        throw new Error("webWS.php devolvió respuesta no JSON");
    }
}

/**
 * ¿El WS respondió con datos, o con un error de negocio?
 *
 * webWS.php contesta 200 con `CodigoEstado != 0` para cosas como "Parada
 * inexistente" o una acción inválida. Eso no es una falla de red — se le pasa
 * al frontend tal cual, que ya sabe leerlo — pero no hay que cachearlo: una
 * acción semi-estática que falla un instante quedaría 24h pegada en el caché.
 */
export function esRespuestaOk(data: unknown): boolean {
    const estado = (data as { CodigoEstado?: number } | null)?.CodigoEstado;
    return typeof estado !== "number" || estado === 0;
}
