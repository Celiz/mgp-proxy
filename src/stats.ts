/**
 * Métricas operacionales en memoria del bondi-proxy.
 * Persistidas en stats.json entre restarts (best-effort).
 */

import fs from "fs";
import path from "path";

const STATS_FILE = path.join(process.cwd(), "src/data/stats.json");

let BOOT_AT = Date.now();
const RING_SIZE = 500;
const DURATION_RING = 1000;

type RequestRecord = {
    at: number;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    ip?: string | null;
    ua?: string;
};

type ErrorRecord = {
    at: number;
    path: string;
    status: number;
    message: string;
};

type MgpRecord = {
    at: number;
    ok: boolean;
    status: number;
    message?: string;
};

const requests: RequestRecord[] = [];
const errors: ErrorRecord[] = [];
const mgpCalls: MgpRecord[] = [];
const durations: number[] = [];
const mgpErrorMessages = new Map<string, number>();
let breakerOpenAccumMs = 0;
let breakerOpenSince: number | null = null;

const counts = {
    requestsTotal: 0,
    byStatus: new Map<number, number>(),
    byPath: new Map<string, number>(),
    byAccion: new Map<string, number>(),
    byParada: new Map<string, number>(),
    cacheHit: 0,
    cacheMiss: 0,
    cacheStale: 0,
    mgpTotal: 0,
    mgpOk: 0,
    mgp429: 0,
    mgpOtherErr: 0,
};

function pushRing<T>(arr: T[], item: T, max = RING_SIZE): void {
    arr.push(item);
    if (arr.length > max) arr.shift();
}

function bump(map: Map<string | number, number>, key: string | number): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

export function recordRequest(rec: RequestRecord): void {
    pushRing(requests, rec);
    counts.requestsTotal++;
    bump(counts.byStatus, rec.status);
    bump(counts.byPath, `${rec.method} ${rec.path}`);
    pushRing(durations, rec.durationMs, DURATION_RING);
    if (rec.status >= 400) {
        pushRing(errors, {
            at: rec.at,
            path: `${rec.method} ${rec.path}`,
            status: rec.status,
            message: "",
        });
    }
}

export function recordError(path: string, status: number, message: string): void {
    pushRing(errors, { at: Date.now(), path, status, message });
    const key = message.slice(0, 120) || `status ${status}`;
    bump(mgpErrorMessages, key);
}

export function recordAccion(accion: string): void {
    bump(counts.byAccion, accion);
}

export function recordParada(codigo: string): void {
    bump(counts.byParada, codigo);
}

export function recordCache(state: "HIT" | "MISS" | "STALE"): void {
    if (state === "HIT") counts.cacheHit++;
    else if (state === "MISS") counts.cacheMiss++;
    else counts.cacheStale++;
}

export function recordMgp(rec: MgpRecord): void {
    pushRing(mgpCalls, rec);
    counts.mgpTotal++;
    if (rec.ok) counts.mgpOk++;
    else if (rec.status === 429) counts.mgp429++;
    else {
        counts.mgpOtherErr++;
        if (rec.message) bump(mgpErrorMessages, rec.message.slice(0, 120));
    }
}

/** Llamar cuando cambia el breaker (opcional, desde queue). */
export function recordBreakerState(state: "closed" | "open" | "half-open"): void {
    const now = Date.now();
    if (state === "open") {
        if (breakerOpenSince == null) breakerOpenSince = now;
    } else if (breakerOpenSince != null) {
        breakerOpenAccumMs += now - breakerOpenSince;
        breakerOpenSince = null;
    }
}

function topN(map: Map<string, number>, n = 10): { key: string; count: number }[] {
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([key, count]) => ({ key, count }));
}

function bucketRequests(periodMs: number): { count: number; errors: number } {
    const cutoff = Date.now() - periodMs;
    let c = 0;
    let e = 0;
    for (const r of requests) {
        if (r.at >= cutoff) {
            c++;
            if (r.status >= 400) e++;
        }
    }
    return { count: c, errors: e };
}

function lastByCondition<T extends { at: number }>(arr: T[], cond: (r: T) => boolean): T | null {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (cond(arr[i]!)) return arr[i]!;
    }
    return null;
}

function percentile(values: number[], p: number): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx]!;
}

/**
 * Health score 0–100:
 * - éxito MGP
 * - tasa de errores HTTP
 * - 429s
 * - latencia p95
 * - uso de STALE
 */
function computeHealth(opts: {
    mgpOkRate: number;
    errRate: number;
    rate429Share: number;
    p95: number | null;
    staleShare: number;
    breakerOpen: boolean;
}): { score: number; label: string; factors: Record<string, number> } {
    let score = 100;
    const factors: Record<string, number> = {};

    // MGP success (0–35)
    const mgpPenalty = Math.round((1 - opts.mgpOkRate) * 35);
    factors.mgp = -mgpPenalty;
    score -= mgpPenalty;

    // HTTP errors (0–20)
    const errPenalty = Math.min(20, Math.round(opts.errRate * 100 * 2));
    factors.httpErrors = -errPenalty;
    score -= errPenalty;

    // 429 share of MGP (0–20)
    const r429Penalty = Math.min(20, Math.round(opts.rate429Share * 100));
    factors.rateLimit = -r429Penalty;
    score -= r429Penalty;

    // latency p95 (0–15): >2s bad, >500ms mild
    let latPenalty = 0;
    if (opts.p95 != null) {
        if (opts.p95 > 2000) latPenalty = 15;
        else if (opts.p95 > 1000) latPenalty = 10;
        else if (opts.p95 > 500) latPenalty = 5;
    }
    factors.latency = -latPenalty;
    score -= latPenalty;

    // stale share (0–10)
    const stalePenalty = Math.min(10, Math.round(opts.staleShare * 50));
    factors.stale = -stalePenalty;
    score -= stalePenalty;

    if (opts.breakerOpen) {
        factors.breaker = -15;
        score -= 15;
    }

    score = Math.max(0, Math.min(100, score));
    const label = score >= 85 ? "Excelente" : score >= 70 ? "Bien" : score >= 50 ? "Degradado" : "Crítico";
    return { score, label, factors };
}

export function snapshot() {
    const now = Date.now();
    const lastSuccess = lastByCondition(mgpCalls, (r) => r.ok);
    const last429 = lastByCondition(mgpCalls, (r) => r.status === 429);
    const lastErr = lastByCondition(mgpCalls, (r) => !r.ok);

    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);

    const cacheTotal = counts.cacheHit + counts.cacheMiss + counts.cacheStale;
    const mgpOkRate = counts.mgpTotal > 0 ? counts.mgpOk / counts.mgpTotal : 1;
    const recent = bucketRequests(5 * 60_000);
    const errRate = recent.count > 0 ? recent.errors / recent.count : 0;
    const rate429Share = counts.mgpTotal > 0 ? counts.mgp429 / counts.mgpTotal : 0;
    const staleShare = cacheTotal > 0 ? counts.cacheStale / cacheTotal : 0;

    // breaker open time includes current open spell
    let openMs = breakerOpenAccumMs;
    if (breakerOpenSince != null) openMs += now - breakerOpenSince;

    const health = computeHealth({
        mgpOkRate,
        errRate,
        rate429Share,
        p95,
        staleShare,
        breakerOpen: breakerOpenSince != null,
    });

    return {
        bootAt: BOOT_AT,
        uptimeSec: Math.round((now - BOOT_AT) / 1000),
        now,
        memory: process.memoryUsage(),
        health,
        latency: {
            p50,
            p95,
            p99,
            samples: durations.length,
        },
        requests: {
            total: counts.requestsTotal,
            byStatus: Object.fromEntries(counts.byStatus),
            topPaths: topN(counts.byPath),
            topAcciones: topN(counts.byAccion),
            topParadas: topN(counts.byParada, 20),
            last1m: bucketRequests(60_000),
            last5m: bucketRequests(5 * 60_000),
            last15m: bucketRequests(15 * 60_000),
        },
        cache: {
            hit: counts.cacheHit,
            miss: counts.cacheMiss,
            stale: counts.cacheStale,
            hitRate: cacheTotal > 0 ? Math.round((counts.cacheHit / cacheTotal) * 1000) / 10 : null,
            staleRate: cacheTotal > 0 ? Math.round((counts.cacheStale / cacheTotal) * 1000) / 10 : null,
        },
        mgp: {
            total: counts.mgpTotal,
            ok: counts.mgpOk,
            rateLimited: counts.mgp429,
            otherErrors: counts.mgpOtherErr,
            okRate: counts.mgpTotal > 0 ? Math.round(mgpOkRate * 1000) / 10 : null,
            lastSuccessAt: lastSuccess?.at ?? null,
            last429At: last429?.at ?? null,
            lastErrorAt: lastErr?.at ?? null,
            lastErrorMessage: lastErr?.message ?? null,
            topErrors: topN(mgpErrorMessages, 10),
        },
        breaker: {
            openAccumMs: openMs,
            currentlyOpen: breakerOpenSince != null,
        },
        errors: errors.slice(-30).reverse(),
        recentRequests: requests.slice(-30).reverse(),
    };
}

export async function saveStats() {
    try {
        const data = {
            BOOT_AT,
            requests,
            errors,
            mgpCalls,
            durations,
            mgpErrorMessages: Array.from(mgpErrorMessages.entries()),
            breakerOpenAccumMs,
            counts: {
                requestsTotal: counts.requestsTotal,
                byStatus: Array.from(counts.byStatus.entries()),
                byPath: Array.from(counts.byPath.entries()),
                byAccion: Array.from(counts.byAccion.entries()),
                byParada: Array.from(counts.byParada.entries()),
                cacheHit: counts.cacheHit,
                cacheMiss: counts.cacheMiss,
                cacheStale: counts.cacheStale,
                mgpTotal: counts.mgpTotal,
                mgpOk: counts.mgpOk,
                mgp429: counts.mgp429,
                mgpOtherErr: counts.mgpOtherErr,
            },
        };
        await fs.promises.writeFile(STATS_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
        console.error("[stats] Error saving stats:", e);
    }
}

export async function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const fileData = await fs.promises.readFile(STATS_FILE, "utf-8");
            const data = JSON.parse(fileData);

            if (data.BOOT_AT) BOOT_AT = data.BOOT_AT;

            requests.splice(0, requests.length, ...(data.requests || []));
            errors.splice(0, errors.length, ...(data.errors || []));
            mgpCalls.splice(0, mgpCalls.length, ...(data.mgpCalls || []));
            durations.splice(0, durations.length, ...(data.durations || []));
            mgpErrorMessages.clear();
            for (const [k, v] of data.mgpErrorMessages || []) mgpErrorMessages.set(k, v);
            breakerOpenAccumMs = data.breakerOpenAccumMs ?? 0;

            if (data.counts) {
                counts.requestsTotal = data.counts.requestsTotal ?? 0;
                counts.byStatus = new Map(data.counts.byStatus || []);
                counts.byPath = new Map(data.counts.byPath || []);
                counts.byAccion = new Map(data.counts.byAccion || []);
                counts.byParada = new Map(data.counts.byParada || []);
                counts.cacheHit = data.counts.cacheHit ?? 0;
                counts.cacheMiss = data.counts.cacheMiss ?? 0;
                counts.cacheStale = data.counts.cacheStale ?? 0;
                counts.mgpTotal = data.counts.mgpTotal ?? 0;
                counts.mgpOk = data.counts.mgpOk ?? 0;
                counts.mgp429 = data.counts.mgp429 ?? 0;
                counts.mgpOtherErr = data.counts.mgpOtherErr ?? 0;
            }
            console.log("[stats] Loaded existing stats from", STATS_FILE);
        }
    } catch (e) {
        console.error("[stats] Error loading stats:", e);
    }
}
