/**
 * Transporte hacia el WS web de MGP (`app_cuando_llega/webWS.php`) vía el
 * bridge Python (`bridge/bridge.py`), que resuelve el Turnstile de Cloudflare
 * con Scrapling (patchright, headless) y hace cada request dentro del
 * navegador con page.evaluate(fetch(...)).
 *
 * Reemplaza al approach anterior (CDP crudo + Chrome real + extracción de
 * cf_clearance para repetir con fetch() de Node): dejó de funcionar porque
 * Cloudflare pasó a un Turnstile no-interactivo que un Chrome automatizado
 * por CDP nunca resolvía headless, ni con display real superaba de forma
 * confiable. Scrapling/patchright sí lo resuelve headless. Ver
 * bridge/bridge.py y proxy-bondi/ (la prueba de que este mecanismo funciona).
 *
 * El bridge es un subproceso Python de larga vida, hablado por líneas JSON
 * sobre stdin/stdout. Sólo procesa un comando por vez, así que las llamadas
 * se serializan acá con una cola simple.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import path from "node:path";

const BRIDGE_DIR = path.resolve(process.cwd(), "bridge");
const BRIDGE_SCRIPT = path.join(BRIDGE_DIR, "bridge.py");
const BRIDGE_PYTHON = process.env.MGP_BRIDGE_PYTHON ?? path.join(BRIDGE_DIR, ".venv", "bin", "python3");

/** Timeout de una request normal a webWS.php. */
const FETCH_TIMEOUT_MS = Number(process.env.MGP_BRIDGE_FETCH_TIMEOUT_MS ?? 15_000);
/**
 * Timeout para resolver el challenge. Reusa el nombre de env var del approach
 * viejo (`MGP_CHALLENGE_TIMEOUT_MS`) para que un `render.yaml` existente que
 * ya lo define siga surtiendo efecto sin tocar nada.
 */
const INIT_TIMEOUT_MS = Number(process.env.MGP_CHALLENGE_TIMEOUT_MS ?? 90_000);
/** Cuánto esperar antes de relanzar el subproceso si murió. */
const RESPAWN_DELAY_MS = 2_000;
/**
 * Renovación proactiva en segundo plano, antes de que Cloudflare la dé por
 * vencida. El approach viejo midió ~12-15 min de vigencia real; 9 min deja
 * margen. bridge.py cierra la sesión vieja antes de abrir la nueva (la API
 * sync de Playwright no tolera dos sesiones abiertas a la vez en el mismo
 * proceso), así que hay un hueco de ~10s sin servir durante la renovación.
 * Las requests que lleguen en ese hueco quedan en la cola del bridge (ver
 * `enqueue`) esperando su turno, no se pierden ni fallan.
 */
const RENEW_INTERVAL_MS = Number(process.env.MGP_BRIDGE_RENEW_MS ?? 9 * 60_000);

type BridgeReply = { error?: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Subproceso: arranque, reconexión, protocolo de una línea por comando
// ---------------------------------------------------------------------------

let proc: ChildProcess | null = null;
let rl: Interface | null = null;
let pendingResolve: ((v: BridgeReply) => void) | null = null;
let pendingReject: ((e: Error) => void) | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let mutexTail: Promise<unknown> = Promise.resolve();

let ready = false;
let initPromise: Promise<void> | null = null;
let restarts = -1;
let lastError: string | null = null;
let lastInitAt: number | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;

function log(msg: string): void {
    console.log(`[mgpBridge] ${msg}`);
}

function onDisconnect(reason: string): void {
    if (pendingReject) {
        const reject = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        reject(new Error(`bridge_disconnected: ${reason}`));
    }
    ready = false;
    rl?.close();
    rl = null;
    proc = null;
    log(`subproceso caído (${reason}), reintentando en ${RESPAWN_DELAY_MS}ms`);
    setTimeout(spawnProcess, RESPAWN_DELAY_MS);
}

function spawnProcess(): void {
    restarts++;
    const p = spawn(BRIDGE_PYTHON, [BRIDGE_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    proc = p;
    rl = createInterface({ input: p.stdout! });
    rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let data: BridgeReply;
        try {
            data = JSON.parse(trimmed);
        } catch {
            log(`línea no-JSON del bridge, ignorada: ${trimmed}`);
            return;
        }
        if (pendingResolve) {
            const resolve = pendingResolve;
            pendingResolve = null;
            pendingReject = null;
            if (pendingTimer) {
                clearTimeout(pendingTimer);
                pendingTimer = null;
            }
            resolve(data);
        }
    });
    p.stderr?.on("data", (d) => console.log(`[bridge] ${String(d).trimEnd()}`));
    p.on("error", (err) => onDisconnect(`spawn error: ${err.message}`));
    p.on("exit", (code) => onDisconnect(`exit ${code}`));
}

function send(msg: Record<string, unknown>, timeoutMs: number): Promise<BridgeReply> {
    return new Promise((resolve, reject) => {
        if (!proc?.stdin) return reject(new Error("bridge_no_process"));
        pendingResolve = resolve;
        pendingReject = reject;
        pendingTimer = setTimeout(() => {
            pendingResolve = null;
            pendingReject = null;
            pendingTimer = null;
            reject(new Error("bridge_timeout"));
        }, timeoutMs);
        proc.stdin.write(JSON.stringify(msg) + "\n");
    });
}

/**
 * El bridge lee stdin línea a línea de forma sincrónica: no hay pipelining.
 * Todo lo que le hablamos pasa por acá, en fila.
 */
function enqueue<T extends BridgeReply>(fn: () => Promise<T>): Promise<T> {
    const run = mutexTail.then(fn, fn);
    mutexTail = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

// ---------------------------------------------------------------------------
// Init y renovación
// ---------------------------------------------------------------------------

function scheduleRenew(): void {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = setTimeout(() => {
        log("renovación proactiva en segundo plano...");
        enqueue(() => send({ cmd: "init" }, INIT_TIMEOUT_MS))
            .then((r) => {
                if (r.error) throw new Error(r.error);
                lastError = null;
                lastInitAt = Date.now();
                log("renovación OK");
            })
            .catch((e) => {
                // No forzamos `ready = false` acá: si bridge.py se quedó sin
                // página (cerró la vieja y la nueva falló), la próxima fetch
                // va a recibir un 503 "No page", que `pareceChallenge` ya
                // detecta y dispara un re-init reactivo solo. No hace falta
                // duplicar esa lógica acá.
                lastError = (e as Error).message;
                log(`renovación falló: ${lastError}`);
            })
            .finally(scheduleRenew);
    }, RENEW_INTERVAL_MS);
    renewTimer.unref?.();
}

function ensureInit(): Promise<void> {
    if (ready) return Promise.resolve();
    if (initPromise) return initPromise;
    log("inicializando (resolviendo Cloudflare)...");
    initPromise = enqueue(() => send({ cmd: "init" }, INIT_TIMEOUT_MS))
        .then((r) => {
            if (r.error) throw new Error(r.error);
            ready = true;
            lastError = null;
            lastInitAt = Date.now();
            log(`listo (phpSessId=${r.phpSessId ?? "?"})`);
            scheduleRenew();
        })
        .catch((e) => {
            lastError = (e as Error).message;
            log(`init falló: ${lastError}`);
            throw e;
        })
        .finally(() => {
            initPromise = null;
        });
    return initPromise;
}

/** Fuerza un re-init (p.ej. desde /admin/bridge/restart si queda pegado). */
export function forceReinit(): Promise<void> {
    ready = false;
    return ensureInit();
}

// ---------------------------------------------------------------------------
// La llamada real
// ---------------------------------------------------------------------------

function pareceChallenge(status: number, body: string): boolean {
    if (status === 403 || status === 503) return true;
    const head = body.trimStart().slice(0, 400).toLowerCase();
    return head.startsWith("<") && (head.includes("just a moment") || head.includes("un momento") || head.includes("cf-"));
}

export function isMgpBridgeEnabled(): boolean {
    return (process.env.MGP_TRANSPORT ?? "web") === "web";
}

/**
 * Punto de entrada del transporte. El body viaja tal cual: el contrato del WS
 * web es el mismo que ya habla el frontend, así que no hay traducción.
 */
export async function fetchMgpBridge(body: string): Promise<unknown> {
    await ensureInit();

    let result = await enqueue(() => send({ cmd: "fetch", body }, FETCH_TIMEOUT_MS));
    if (result.error) throw new Error(`bridge_error: ${result.error}`);

    let status = Number(result.status ?? 0);
    let text = String(result.body ?? "");

    // Un challenge acá significa sesión vencida/rechazada: forzamos un re-init
    // y reintentamos una sola vez.
    if (pareceChallenge(status, text)) {
        log(`challenge/HTTP ${status} en webWS.php, forzando re-init`);
        ready = false;
        await ensureInit();
        result = await enqueue(() => send({ cmd: "fetch", body }, FETCH_TIMEOUT_MS));
        if (result.error) throw new Error(`bridge_error: ${result.error}`);
        status = Number(result.status ?? 0);
        text = String(result.body ?? "");
    }

    if (status === 429) throw new Error("webWS.php devolvió 429");
    if (status >= 400 || status === 0) throw new Error(`webWS.php devolvió ${status}`);
    if (!text.trim()) throw new Error("webWS.php devolvió body vacío");

    try {
        return JSON.parse(text);
    } catch {
        throw new Error("webWS.php devolvió respuesta no JSON");
    }
}

export function getBridgeStatus(): {
    ready: boolean;
    initializing: boolean;
    restarts: number;
    lastInitAt: string | null;
    lastError: string | null;
} {
    return {
        ready,
        initializing: Boolean(initPromise),
        restarts: Math.max(restarts, 0),
        lastInitAt: lastInitAt ? new Date(lastInitAt).toISOString() : null,
        lastError,
    };
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

// El proxy arranca el bridge apenas se importa este módulo (si el transporte
// está habilitado): para cuando llega la primera request ya está en curso la
// resolución del challenge en vez de arrancar desde cero. Con
// MGP_TRANSPORT=v670 no hace falta Python instalado en absoluto.
if (isMgpBridgeEnabled()) spawnProcess();
