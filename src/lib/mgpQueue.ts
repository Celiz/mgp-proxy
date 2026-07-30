/**
 * Cola centralizada de requests a MGP.
 *
 * Todos los componentes del server que necesitan pegarle a appWS.php
 * (POST /, GET /mgp, /lineas/arribos, warmup, scheduler) pasan por acá.
 *
 * Capas (de afuera hacia adentro):
 *   1. Singleflight — deduplica requests in-flight con el mismo body.
 *   2. Token-bucket rate limiter — máximo N req/s a MGP.
 *   3. Circuit breaker — corta si MGP está caído/rate-limiting.
 *   4. fetchMgpDirect / callMgpProxy — el fetch real.
 */

import { fetchMgpDirect, isMgpDirectEnabled } from "./mgpDirect.js";
import { fetchMgpBridge, isMgpBridgeEnabled } from "./mgpBridge.js";
import { recordBreakerState, recordMgp } from "../stats.js";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/** Requests por segundo sostenidas. */
const RATE_LIMIT_RPS = 2;
/** Burst máximo (tokens acumulados). */
const RATE_LIMIT_BURST = 4;
/** Timeout para esperar un token antes de rechazar. */
const TOKEN_WAIT_TIMEOUT_MS = 10_000;

/** Duración base del circuit breaker (se escala con backoff). */
const BREAKER_BASE_MS = 30_000;
/**
 * Duración máxima del circuit breaker.
 *
 * Cuando MGP entra en rate limit sostenido, su ventana no se resetea sola: hay
 * que dejar de pegarle. Medido, 7 min a 1 req/min no alcanzan para salir. Un
 * corte corto (60s) mantiene el bloqueo vivo indefinidamente, así que el corte
 * tiene que ser largo — y el stale de 10 min de arribos lo cubre entero, que es
 * lo que evita que el usuario vea el corte.
 */
const BREAKER_MAX_MS = 5 * 60 * 1000;
/** Errores consecutivos para abrir el breaker (sin 429 explícito). */
const BREAKER_ERROR_THRESHOLD = 3;
/** 429/503 consecutivos para abrir el breaker. */
const BREAKER_RATE_LIMIT_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Token Bucket Rate Limiter
// ---------------------------------------------------------------------------

let tokens = RATE_LIMIT_BURST;
let lastRefill = Date.now();

function refillTokens(): void {
    const now = Date.now();
    const elapsed = now - lastRefill;
    const added = (elapsed / 1000) * RATE_LIMIT_RPS;
    tokens = Math.min(RATE_LIMIT_BURST, tokens + added);
    lastRefill = now;
}

function tryAcquireToken(): boolean {
    refillTokens();
    if (tokens >= 1) {
        tokens -= 1;
        return true;
    }
    return false;
}

function waitForToken(): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + TOKEN_WAIT_TIMEOUT_MS;
        const interval = setInterval(() => {
            if (tryAcquireToken()) {
                clearInterval(interval);
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(interval);
                reject(new Error("mgp_queue_timeout: no se pudo obtener token en tiempo"));
            }
        }, 250);
    });
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

type BreakerState = "closed" | "open" | "half-open";

let breakerState: BreakerState = "closed";
let breakerOpenUntil = 0;
let consecutiveErrors = 0;
let consecutiveRateLimits = 0;
let breakerBackoffMultiplier = 1;
/** Cuando está half-open, solo dejamos pasar 1 request de prueba. */
let halfOpenProbeInFlight = false;

function openBreaker(reason: string): void {
    const duration = Math.min(BREAKER_BASE_MS * breakerBackoffMultiplier, BREAKER_MAX_MS);
    breakerOpenUntil = Date.now() + duration;
    breakerState = "open";
    recordBreakerState("open");
    breakerBackoffMultiplier = Math.min(breakerBackoffMultiplier * 2, BREAKER_MAX_MS / BREAKER_BASE_MS);
    console.warn(
        `[mgpQueue] circuit breaker OPEN por ${Math.round(duration / 1000)}s — razón: ${reason}`,
    );
}

function checkBreaker(): void {
    if (breakerState === "closed") return;
    if (breakerState === "open" && Date.now() >= breakerOpenUntil) {
        breakerState = "half-open";
        recordBreakerState("half-open");
        halfOpenProbeInFlight = false;
        console.log("[mgpQueue] circuit breaker → HALF-OPEN (probando 1 request)");
    }
}

function onSuccess(): void {
    consecutiveErrors = 0;
    consecutiveRateLimits = 0;
    if (breakerState === "half-open") {
        breakerState = "closed";
        recordBreakerState("closed");
        breakerBackoffMultiplier = 1;
        halfOpenProbeInFlight = false;
        console.log("[mgpQueue] circuit breaker → CLOSED (probe exitosa)");
    }
}

function onError(status: number, message: string): void {
    consecutiveErrors++;
    if (status === 429 || status === 503) {
        consecutiveRateLimits++;
        // Un 429 suelto es ruido normal bajo carga: MGP nos frena un instante y
        // sigue respondiendo. Abrir el breaker por uno solo cortaba minutos de
        // servicio por un rechazo puntual — 1.620 429s reales terminaron
        // cortando 50.157 requests. Exigimos evidencia de saturación real.
        if (consecutiveRateLimits >= BREAKER_RATE_LIMIT_THRESHOLD) {
            openBreaker(`${consecutiveRateLimits} x HTTP ${status}`);
        }
    } else if (consecutiveErrors >= BREAKER_ERROR_THRESHOLD) {
        openBreaker(`${consecutiveErrors} errores consecutivos: ${message}`);
    }
    if (breakerState === "half-open") {
        openBreaker(`probe falló: ${message}`);
        halfOpenProbeInFlight = false;
    }
}

export function isBreakerOpen(): boolean {
    checkBreaker();
    return breakerState === "open";
}

// ---------------------------------------------------------------------------
// Singleflight (request coalescing)
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();

// ---------------------------------------------------------------------------
// Proxy fallback (cuando mgpDirect no está habilitado)
// ---------------------------------------------------------------------------

let proxyUrl: string | undefined;

export function setProxyUrl(url: string | undefined): void {
    proxyUrl = url;
}

async function callMgpProxy(body: string): Promise<unknown> {
    if (!proxyUrl) throw new Error("no_mgp_config");
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8_000);
    try {
        const r = await fetch(proxyUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
            signal: ctrl.signal,
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return JSON.parse(text);
    } finally {
        clearTimeout(tid);
    }
}

// ---------------------------------------------------------------------------
// Core: el fetch real a MGP (directo o proxy)
// ---------------------------------------------------------------------------

async function doFetch(body: string): Promise<unknown> {
    // Transporte por defecto: el WS web vía el bridge Python (Scrapling +
    // patchright resuelve Cloudflare, ver mgpBridge.ts). El camino V670
    // (mgpDirect) quedó detrás de MGP_TRANSPORT=v670 porque Cloudflare lo
    // tiene con 429 permanente — se conserva por si algún día se libera esa
    // regla.
    if (isMgpBridgeEnabled()) return fetchMgpBridge(body);
    return isMgpDirectEnabled() ? fetchMgpDirect(body) : callMgpProxy(body);
}

// ---------------------------------------------------------------------------
// API Pública
// ---------------------------------------------------------------------------

export type QueuePriority = "high" | "low";

export type QueueStats = {
    breakerState: BreakerState;
    breakerOpenUntil: number;
    consecutiveErrors: number;
    backoffMultiplier: number;
    inflightCount: number;
    tokensAvailable: number;
    rateRps: number;
    rateBurst: number;
};

export function getMgpQueueStats(): QueueStats {
    refillTokens();
    return {
        breakerState,
        breakerOpenUntil,
        consecutiveErrors,
        backoffMultiplier: breakerBackoffMultiplier,
        inflightCount: inflight.size,
        tokensAvailable: Math.floor(tokens),
        rateRps: RATE_LIMIT_RPS,
        rateBurst: RATE_LIMIT_BURST,
    };
}

/**
 * Punto de entrada único para todas las requests a MGP.
 *
 * - Deduplica requests con el mismo body (singleflight).
 * - Respeta el rate limiter (token bucket).
 * - Respeta el circuit breaker.
 * - Registra métricas.
 */
export async function enqueueMgp(
    body: string,
    opts?: { priority?: QueuePriority },
): Promise<unknown> {
    // 1. Circuit breaker check
    checkBreaker();
    if (breakerState === "open") {
        throw new Error("circuit_open: MGP circuit breaker abierto");
    }
    if (breakerState === "half-open" && halfOpenProbeInFlight) {
        // Ya hay un probe en vuelo, no dejamos pasar más requests.
        throw new Error("circuit_half_open: esperando resultado del probe");
    }
    if (breakerState === "half-open") {
        halfOpenProbeInFlight = true;
    }

    // 2. Singleflight: si ya hay un fetch para este body, colgarse de él.
    const existing = inflight.get(body);
    if (existing) {
        return existing;
    }

    // 3. Crear la promise del fetch.
    const promise = (async () => {
        // 4. Rate limiter: esperar token.
        if (!tryAcquireToken()) {
            // Low priority: rechazar en lugar de esperar.
            if (opts?.priority === "low") {
                throw new Error("mgp_rate_limited: sin tokens disponibles (low priority, no espera)");
            }
            await waitForToken();
        }

        // 5. Fetch real.
        try {
            const data = await doFetch(body);
            onSuccess();
            recordMgp({ at: Date.now(), ok: true, status: 200 });
            return data;
        } catch (e) {
            const message = (e as Error).message;
            const m = message.match(/(\d{3})/);
            const status = m ? Number(m[1]) : 0;
            recordMgp({ at: Date.now(), ok: false, status, message });

            // "bridge_busy" es la cola interna del bridge rechazando de una
            // por saturación (ver mgpBridge.ts): ni siquiera se intentó
            // hablar con MGP, así que no es evidencia de que MGP esté
            // fallando. Contarlo acá abriría el circuit breaker por una
            // congestión nuestra, no de MGP.
            if (message.startsWith("bridge_busy")) {
                if (breakerState === "half-open") halfOpenProbeInFlight = false;
                throw e;
            }

            onError(status, message);
            throw e;
        }
    })();

    // Registrar en singleflight y limpiar al resolver.
    inflight.set(body, promise);
    promise.finally(() => {
        inflight.delete(body);
    });

    return promise;
}
