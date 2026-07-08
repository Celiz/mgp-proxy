/**
 * Métricas en memoria del bondi-api. Sin persistencia: se resetean en cada
 * restart, pero alcanzan para el dashboard /stats. La idea es que Mati pueda
 * mirar de un vistazo qué tan caliente está el server y si MGP nos está dando
 * problemas.
 */

import fs from "fs";
import path from "path";

const STATS_FILE = path.join(process.cwd(), "src/data/stats.json");

let BOOT_AT = Date.now();
const RING_SIZE = 200;

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
    /** http status MGP (o 0 si fue throw de red). */
    status: number;
    message?: string;
};

const requests: RequestRecord[] = [];
const errors: ErrorRecord[] = [];
const mgpCalls: MgpRecord[] = [];

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

function pushRing<T>(arr: T[], item: T): void {
    arr.push(item);
    if (arr.length > RING_SIZE) arr.shift();
}

function bump(map: Map<string | number, number>, key: string | number): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

export function recordRequest(rec: RequestRecord): void {
    pushRing(requests, rec);
    counts.requestsTotal++;
    bump(counts.byStatus, rec.status);
    bump(counts.byPath, `${rec.method} ${rec.path}`);
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
    else counts.mgpOtherErr++;
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

export function snapshot() {
    const now = Date.now();
    const lastSuccess = lastByCondition(mgpCalls, (r) => r.ok);
    const last429 = lastByCondition(mgpCalls, (r) => r.status === 429);
    const lastErr = lastByCondition(mgpCalls, (r) => !r.ok);
    return {
        bootAt: BOOT_AT,
        uptimeSec: Math.round((now - BOOT_AT) / 1000),
        now,
        memory: process.memoryUsage(),
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
        },
        mgp: {
            total: counts.mgpTotal,
            ok: counts.mgpOk,
            rateLimited: counts.mgp429,
            otherErrors: counts.mgpOtherErr,
            lastSuccessAt: lastSuccess?.at ?? null,
            last429At: last429?.at ?? null,
            lastErrorAt: lastErr?.at ?? null,
            lastErrorMessage: lastErr?.message ?? null,
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
