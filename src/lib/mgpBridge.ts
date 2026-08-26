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
/** Cada cuánto reintenta la renovación si la cola está ocupada (ver `attemptRenew`). */
const RENEW_IDLE_RETRY_MS = 5_000;
/** Techo de espera por "no hay hueco libre": pasado esto, renueva igual. */
const RENEW_MAX_DEFER_MS = 60_000;
/**
 * Tope de requests esperando turno en el bridge. Por encima de esto,
 * `enqueue()` rechaza de una con `bridge_busy` en vez de sumarse a una fila
 * que de todos modos va a terminar en timeout — evita que una ráfaga (o una
 * renovación en curso) genere una cola sin techo. mgpQueue.ts no cuenta estos
 * rechazos para el circuit breaker: no llegamos ni a intentar hablar con MGP,
 * así que no son evidencia de que MGP esté fallando.
 */
const MAX_QUEUE_DEPTH = Number(process.env.MGP_BRIDGE_MAX_QUEUE ?? 6);
/**
 * Techo de requests del fast path en vuelo a la vez.
 *
 * Estas no pasan por `enqueue()`: el mutex existe porque bridge.py atendía un
 * comando por vez, y eso ya no es cierto para el atajo por curl_cffi, que
 * corre en un pool de hilos y no toca el navegador. Mantener el mutex acá
 * significaba serializar requests que no lo necesitan -- y peor, dejarlas
 * afuera durante los ~10s de cada renovación, que es de donde salían los
 * 43.874 `bridge_initializing: renovando la sesión`.
 *
 * Tiene que acompañar a `MGP_BRIDGE_FAST_WORKERS` del lado Python (mismo
 * default, 4): si Node deja entrar más de las que el pool puede atender, las de
 * más esperan turno adentro de bridge.py y se comen dos veces el timeout de
 * curl (8s) contra el techo de 15s de `FETCH_TIMEOUT_MS` -- o sea que volverían
 * como `bridge_timeout`, que es justo lo que esto viene a evitar.
 */
const FAST_MAX_INFLIGHT = Number(process.env.MGP_BRIDGE_FAST_INFLIGHT ?? 4);
/**
 * Techo de espera de `waitForBridgeReady`, para las requests que no tienen
 * caché con qué responder. Un init completo mide ~20s en el A22 de producción,
 * así que 25s deja margen sin colgar al cliente para siempre.
 */
const INIT_WAIT_MS = Number(process.env.MGP_BRIDGE_INIT_WAIT_MS ?? 25_000);

type BridgeReply = { error?: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Subproceso: arranque, reconexión, protocolo de una línea por comando
// ---------------------------------------------------------------------------

let proc: ChildProcess | null = null;
let rl: Interface | null = null;
/**
 * Comandos esperando respuesta, por id.
 *
 * Antes había un solo `pendingResolve` global, y ahí estaba el problema: al
 * vencer el timeout de un fetch lo limpiábamos y rechazábamos, pero el comando
 * ya había salido por stdin y el bridge iba a contestar igual. Esa respuesta
 * tardía llegaba cuando ya había OTRO comando esperando, y resolvía ese —
 * cada request se quedaba con los datos de la anterior. Si le tocaba la
 * respuesta de un `init` (`{ok, phpSessId}`, sin campo `status`), abajo daba
 * `webWS.php devolvió 0`: 369 de esos en 30 días, y como sí cuentan para el
 * breaker, cada timeout se multiplicaba en una ráfaga de `circuit_open`.
 *
 * Con el id, una respuesta cuyo comando ya expiró no encuentra a nadie y se
 * descarta, que es lo correcto.
 */
type Pending = {
    resolve: (v: BridgeReply) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<number, Pending>();
let nextCmdId = 0;
let mutexTail: Promise<unknown> = Promise.resolve();

let ready = false;
/**
 * ¿El bridge llegó a estar listo alguna vez desde que arrancó el proceso?
 *
 * Distingue el arranque en frío (hay que esperar el challenge sí o sí, no hay
 * caché ni nada que servir) de una renovación (ya hubo tráfico, así que
 * conviene contestar stale al toque en vez de hacer esperar 20s).
 */
let everReady = false;
let initPromise: Promise<void> | null = null;
let restarts = -1;
let lastError: string | null = null;
let lastInitAt: number | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;
/** Hay una renovación proactiva ocupando el mutex del bridge (ver `attemptRenew`). */
let renewing = false;
/**
 * El próximo init tiene que rehacer la sesión de verdad, no alcanza con renovar
 * en caliente.
 *
 * Se prende cuando nos re-inicializamos porque Cloudflare nos rechazó. Visto en
 * producción: webWS.php devolvía 403, pero el re-fetch de la entrada contestaba
 * 200 sin challenge (la clearance seguía valiendo para esa URL), así que la
 * renovación en caliente se daba por buena, el fast path se reactivaba con la
 * misma cookie rechazada y volvía el 403 -- en loop. bridge.py lo recibe como
 * `force` y ahí exige que la clearance realmente cambie.
 */
let forceNextInit = false;
let queueDepth = 0;
let busyRejections = 0;
/**
 * ¿bridge.py puede atender un fetch por el atajo, sin navegador? Lo dice él en
 * cada respuesta (`fastReady`), porque el estado cambia solo: un challenge
 * apaga el fast path hasta el próximo init. Arranca en false y se enciende con
 * la primera respuesta del init.
 */
let fastReady = false;
let fastInflight = 0;
/** Cuántos fetch se sirvieron por cada camino. Para /stats/data. */
let fastServed = 0;
let fastFallbacks = 0;

function log(msg: string): void {
    console.log(`[mgpBridge] ${msg}`);
}

function onDisconnect(reason: string): void {
    // Si el subproceso se cayó, ninguno de los comandos en vuelo va a tener
    // respuesta nunca: se rechazan todos en vez de dejarlos hasta su timeout.
    for (const [id, p] of pending) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.reject(new Error(`bridge_disconnected: ${reason}`));
    }
    ready = false;
    // El proceso nuevo arranca sin cookies, así que su fast path no está listo
    // por más que el viejo lo estuviera. Sin esto, la primera request post-crash
    // se iría por el atajo contra un bridge que todavía no tiene sesión.
    fastReady = false;
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
        // Viaja en toda respuesta del bridge, incluso en las que se descartan
        // por tardías: es estado del proceso, no de este comando.
        if (typeof data.fastReady === "boolean") fastReady = data.fastReady;
        const id = typeof data.id === "number" ? data.id : null;
        if (id === null) {
            // Sólo puede pasar si el bridge no pudo ni parsear el comando y no
            // supo a qué id contestar. Sin id no hay forma de aparearla sin
            // arriesgarse a dársela al comando equivocado, así que se descarta
            // y el que la esperaba cae por timeout.
            log(`respuesta del bridge sin id, descartada: ${trimmed.slice(0, 120)}`);
            return;
        }
        const p = pending.get(id);
        if (!p) {
            // La respuesta llegó después de que su comando expiró. Descartarla
            // acá es justamente lo que evita que contamine al siguiente.
            log(`respuesta tardía del bridge (id=${id}), descartada`);
            return;
        }
        pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(data);
    });
    p.stderr?.on("data", (d) => console.log(`[bridge] ${String(d).trimEnd()}`));
    p.on("error", (err) => onDisconnect(`spawn error: ${err.message}`));
    p.on("exit", (code) => onDisconnect(`exit ${code}`));
}

function send(msg: Record<string, unknown>, timeoutMs: number): Promise<BridgeReply> {
    return new Promise((resolve, reject) => {
        if (!proc?.stdin) return reject(new Error("bridge_no_process"));
        const id = ++nextCmdId;
        const timer = setTimeout(() => {
            // Se saca del mapa antes de rechazar: si el bridge contesta más
            // tarde, esa respuesta ya no encuentra a nadie y se descarta sola.
            pending.delete(id);
            reject(new Error("bridge_timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        proc.stdin.write(JSON.stringify({ ...msg, id }) + "\n");
    });
}

/**
 * El bridge lee stdin línea a línea de forma sincrónica: no hay pipelining.
 * Todo lo que le hablamos pasa por acá, en fila.
 *
 * `bypassCap` es para comandos de control (init/renovación): no deben
 * rechazarse por cola llena, porque son justamente lo que la destraba.
 */
function enqueue<T extends BridgeReply>(fn: () => Promise<T>, opts?: { bypassCap?: boolean }): Promise<T> {
    if (!opts?.bypassCap && queueDepth >= MAX_QUEUE_DEPTH) {
        busyRejections++;
        return Promise.reject(new Error(`bridge_busy: cola del bridge llena (${queueDepth} esperando turno)`));
    }
    queueDepth++;
    const run = mutexTail.then(fn, fn);
    mutexTail = run.then(
        () => undefined,
        () => undefined,
    );
    // `.finally()` devuelve una promise nueva que replica el rechazo de `run`.
    // `run` ya lo maneja quien nos llama (await/try-catch más arriba); esta
    // copia derivada no la observa nadie más, y sin el catch acá Node la
    // reporta como unhandledRejection cada vez que `run` rechaza (medido).
    run.finally(() => {
        queueDepth--;
    }).catch(() => {});
    return run;
}

// ---------------------------------------------------------------------------
// Init y renovación
// ---------------------------------------------------------------------------

function scheduleRenew(): void {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = setTimeout(() => attemptRenew(Date.now()), RENEW_INTERVAL_MS);
    renewTimer.unref?.();
}

/**
 * Dispara la renovación, pero evitando meterla a la fuerza en medio de una
 * ráfaga: si hay requests esperando turno, reintenta en unos segundos en vez
 * de sumarse a la cola ahí mismo. `dueSince` acota cuánto puede postergarse
 * -- pasado `RENEW_MAX_DEFER_MS` renueva igual, para no dejarla esperando
 * para siempre bajo carga sostenida.
 */
function attemptRenew(dueSince: number): void {
    if (queueDepth > 0 && Date.now() - dueSince < RENEW_MAX_DEFER_MS) {
        renewTimer = setTimeout(() => attemptRenew(dueSince), RENEW_IDLE_RETRY_MS);
        renewTimer.unref?.();
        return;
    }
    log("renovación proactiva en segundo plano...");
    // `ready` queda en true durante la renovación (la sesión vieja sigue
    // sirviendo hasta que la nueva esté), así que hace falta esta bandera
    // aparte para que `fetchMgpBridge` sepa que hay un init ocupando el mutex
    // y conteste stale en vez de encolarse detrás. Es el caso más común de
    // todos: pasa cada MGP_BRIDGE_RENEW_MS.
    renewing = true;
    enqueue(() => send({ cmd: "init" }, INIT_TIMEOUT_MS), { bypassCap: true })
        .then((r) => {
            if (r.error) throw new Error(r.error);
            lastError = null;
            lastInitAt = Date.now();
            log("renovación OK");
        })
        .catch((e) => {
            // No forzamos `ready = false` acá: si bridge.py se quedó sin
            // página (cerró la vieja y la nueva falló), la próxima fetch va a
            // recibir un 503 "No page", que `pareceChallenge` ya detecta y
            // dispara un re-init reactivo solo. No hace falta duplicar esa
            // lógica acá.
            lastError = (e as Error).message;
            log(`renovación falló: ${lastError}`);
        })
        .finally(() => {
            renewing = false;
            scheduleRenew();
        });
}

function ensureInit(): Promise<void> {
    if (ready) return Promise.resolve();
    if (initPromise) return initPromise;
    const force = forceNextInit;
    forceNextInit = false;
    log(`inicializando (resolviendo Cloudflare)${force ? ", forzando sesión nueva" : ""}...`);
    initPromise = enqueue(() => send({ cmd: "init", force }, INIT_TIMEOUT_MS), { bypassCap: true })
        .then((r) => {
            if (r.error) throw new Error(r.error);
            ready = true;
            everReady = true;
            lastError = null;
            lastInitAt = Date.now();
            log(`listo (phpSessId=${r.phpSessId ?? "?"}${r.hotRenew ? ", en caliente" : ""})`);
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

/**
 * Espera a que termine el init en curso, con techo.
 *
 * `fetchMgpBridge` rechaza rápido con `bridge_initializing` para que se sirva
 * caché stale en vez de hacer esperar al usuario. Pero cuando no hay NADA
 * cacheado eso devuelve 502, y ahí es peor: visto en producción, durante una
 * reconstrucción de sesión las paradas nunca consultadas antes se comían un 502
 * en 4ms, cuando antes habrían esperado y respondido bien. Para ese caso
 * index.ts espera acá y reintenta una vez -- preferimos tardar a no responder.
 */
export function waitForBridgeReady(timeoutMs = INIT_WAIT_MS): Promise<void> {
    if (ready && !renewing) return Promise.resolve();
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = (): void => {
            if (ready && !renewing) return resolve();
            if (Date.now() >= deadline) {
                return reject(new Error("bridge_initializing: se agotó la espera del init"));
            }
            setTimeout(tick, 250);
        };
        tick();
    });
}

/** Fuerza un re-init (p.ej. desde /admin/bridge/restart si queda pegado). */
export function forceReinit(): Promise<void> {
    ready = false;
    forceNextInit = true;
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
/**
 * Traduce la respuesta cruda del bridge. La comparten los dos caminos (atajo y
 * navegador), porque el contenido es el mismo: lo único que cambia es cómo se
 * llegó hasta acá.
 */
function interpretarRespuesta(result: BridgeReply): unknown {
    if (result.error) throw new Error(`bridge_error: ${result.error}`);

    const status = Number(result.status ?? 0);
    const text = String(result.body ?? "");

    // Un challenge acá significa sesión vencida/rechazada. Se dispara el
    // re-init en segundo plano y se corta: reintentar en línea significaba
    // sumarle a esta misma request los ~20s del challenge más otro fetch.
    if (pareceChallenge(status, text)) {
        log(`challenge/HTTP ${status} en webWS.php, disparando re-init en segundo plano`);
        ready = false;
        // Nos rechazaron: la sesión hay que rehacerla de verdad. Sin esto, la
        // renovación en caliente devolvía la misma clearance, se daba por
        // buena, y volvíamos a comer 403 en loop (visto en producción).
        forceNextInit = true;
        ensureInit().catch(() => {});
        throw new Error("bridge_initializing: challenge en webWS.php, sirvo stale");
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

export async function fetchMgpBridge(body: string): Promise<unknown> {
    // Camino rápido: sin mutex y sin esperar a que termine una renovación.
    //
    // `enqueue()` existe porque bridge.py atendía un comando por vez. Para el
    // atajo por curl_cffi eso ya no es cierto -- corre en un pool de hilos y no
    // toca el navegador -- así que pasarlo por el mutex serializaba requests que
    // no lo necesitan, y las dejaba afuera durante los ~10s de cada renovación.
    // De ahí salían los 43.874 `bridge_initializing: renovando la sesión`.
    //
    // Ojo con el orden: esto va ANTES del guard de abajo a propósito. La sesión
    // que se está renovando es la del navegador; la clearance que usa el atajo
    // sigue viva (bridge.py no la limpia en `close()`, justamente por esto).
    if (fastReady && fastInflight < FAST_MAX_INFLIGHT) {
        fastInflight++;
        try {
            const rapida = await send({ cmd: "fetch", body }, FETCH_TIMEOUT_MS);
            if (!rapida.retrySerial) {
                fastServed++;
                return interpretarRespuesta(rapida);
            }
            // El atajo no pudo (error de red, o Cloudflare rechazando). Cae al
            // camino de siempre, que sí puede usar el navegador.
            fastFallbacks++;
        } finally {
            fastInflight--;
        }
    }

    // Resolver el challenge cuesta ~20s en el A22 de producción (~11s de
    // arrancar Chromium + ~9s de Turnstile), y hasta ahora ese costo lo pagaba
    // el usuario: `await ensureInit()` acá adentro, con techo de 90s. En el log
    // de producción se ven dos requests de 21s y 9s esperando el mismo init, y
    // el p99 de 85.974ms contra un INIT_TIMEOUT_MS de 90.000 no es casualidad.
    //
    // Ahora sólo se espera cuando no hay alternativa: en el arranque en frío,
    // donde no existe ni caché para servir. Si el bridge ya sirvió alguna vez,
    // el re-init arranca en segundo plano y esta request se rechaza al toque
    // con `bridge_initializing` -- que mgpQueue.ts no cuenta para el breaker, y
    // que hace que index.ts conteste con caché stale en vez de colgar al
    // usuario 20s.
    if (!ready || renewing) {
        if (!everReady) {
            await ensureInit();
        } else {
            if (!renewing) ensureInit().catch(() => {});
            throw new Error("bridge_initializing: renovando la sesión, sirvo stale");
        }
    }

    // `noFast` para que bridge.py no vuelva a mandarlo al pool: si llegamos
    // hasta acá es porque el atajo ya falló, o porque nunca estuvo disponible.
    const result = await enqueue(() => send({ cmd: "fetch", body, noFast: true }, FETCH_TIMEOUT_MS));
    return interpretarRespuesta(result);
}

export function getBridgeStatus(): {
    ready: boolean;
    initializing: boolean;
    restarts: number;
    lastInitAt: string | null;
    lastError: string | null;
    queueDepth: number;
    maxQueueDepth: number;
    busyRejections: number;
    fastReady: boolean;
    fastInflight: number;
    fastServed: number;
    fastFallbacks: number;
} {
    return {
        ready,
        initializing: Boolean(initPromise),
        restarts: Math.max(restarts, 0),
        lastInitAt: lastInitAt ? new Date(lastInitAt).toISOString() : null,
        lastError,
        queueDepth,
        maxQueueDepth: MAX_QUEUE_DEPTH,
        busyRejections,
        // Sin esto no había forma de saber desde afuera si el atajo estaba
        // funcionando o cayéndose en silencio al navegador: bridge.py lo
        // loguea a stderr y nadie lo guardaba.
        fastReady,
        fastInflight,
        fastServed,
        fastFallbacks,
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
