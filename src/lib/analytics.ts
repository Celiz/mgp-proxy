/**
 * Analytics de producto — demanda real de arribos.
 *
 * Solo persiste consultas de próximos arribos (RecuperarProximosArribosW).
 * Lectura optimizada: páginas en paralelo + geo cacheado + snapshot en memoria.
 */

import fs from "fs";
import path from "path";
import { supabase } from "./supabase.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 50;
const PAGE_SIZE = 1000;
/** TTL del snapshot en memoria (dashboard refresca cada 60s → casi siempre cache hit). */
const SNAPSHOT_CACHE_TTL_MS = 90_000;
/** TTL del catálogo geo (casi estático). */
const GEO_CACHE_TTL_MS = 10 * 60_000;

/** Única acción que representa “alguien miró arribos en esta parada/línea”. */
export const PRODUCT_ACCION = "RecuperarProximosArribosW";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QueryEvent = {
    accion: string;
    codigo_parada: string | null;
    linea: string | null;
};

export type TopItem = {
    key: string;
    count: number;
    lineas?: { linea: string; count: number }[];
    linea?: string;
    nombre?: string | null;
};

export type HeatmapCell = { hour: number; dow: number; count: number };

export type ParadaGeoPoint = {
    codigo: string;
    nombre: string | null;
    lat: number;
    lng: number;
    count: number;
    lineas?: { linea: string; count: number }[];
};

export type AnalyticsSnapshot = {
    totalEvents: number;
    topParadas: TopItem[];
    topLineas: TopItem[];
    heatmap: HeatmapCell[];
    paradaGeo: ParadaGeoPoint[];
    bufferSize: number;
    supabaseConnected: boolean;
    metric: string;
    note: string;
    uniqueParadas?: number;
    uniqueLineas?: number;
    geoCoverage?: number;
    durationMs?: number;
    cached?: boolean;
};

// ---------------------------------------------------------------------------
// Parada identity (Codigo MGP ↔ Identificador P…)
// ---------------------------------------------------------------------------

let paradaCanonical: Map<string, string> | null = null;

function loadParadaCanonicalMap(): Map<string, string> {
    if (paradaCanonical) return paradaCanonical;
    paradaCanonical = new Map();
    try {
        const dir = path.join(process.cwd(), "src/data/static/linea");
        if (!fs.existsSync(dir)) return paradaCanonical;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json")) continue;
            const fileData = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            for (const arr of Object.values(fileData.paradasByCalleInterseccion ?? {})) {
                for (const p of arr as Array<{ Codigo?: string; Identificador?: string }>) {
                    if (!p.Identificador) continue;
                    const id = String(p.Identificador);
                    paradaCanonical.set(id, id);
                    if (p.Codigo != null && p.Codigo !== "") {
                        paradaCanonical.set(String(p.Codigo), id);
                    }
                }
            }
        }
    } catch (e) {
        console.error("[analytics] Error cargando mapa de paradas:", (e as Error).message);
    }
    return paradaCanonical;
}

export function normalizeParadaId(codigo: string | null | undefined): string | null {
    if (codigo == null || codigo === "") return null;
    const raw = String(codigo).trim();
    if (!raw) return null;
    return loadParadaCanonicalMap().get(raw) ?? raw;
}

// ---------------------------------------------------------------------------
// Buffer (write path)
// ---------------------------------------------------------------------------

let buffer: QueryEvent[] = [];

export function trackQuery(
    accion: string,
    codigoParada?: string | null,
    linea?: string | null,
): void {
    if (!supabase) return;
    if (accion !== PRODUCT_ACCION) return;

    const parada = normalizeParadaId(codigoParada);
    const lineaNorm = linea?.trim() || null;
    if (!parada && !lineaNorm) return;

    buffer.push({
        accion: PRODUCT_ACCION,
        codigo_parada: parada,
        linea: lineaNorm,
    });

    if (buffer.length >= FLUSH_THRESHOLD) {
        void flushBuffer();
    }
}

async function flushBuffer(): Promise<void> {
    if (!supabase || buffer.length === 0) return;

    const batch = buffer;
    buffer = [];

    try {
        const { error } = await supabase.from("query_events").insert(batch);
        if (error) {
            console.error("[analytics] Error insertando batch:", error.message);
            if (buffer.length < 500) buffer.push(...batch);
        } else {
            // Invalidar snapshots: hay datos nuevos
            snapshotCache.clear();
        }
    } catch (e) {
        console.error("[analytics] Flush exception:", (e as Error).message);
    }
}

if (supabase) {
    setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS);

    const onShutdown = () => {
        console.log("[analytics] Flushing buffer antes de cerrar...");
        void flushBuffer();
    };
    process.on("SIGTERM", onShutdown);
    process.on("SIGINT", onShutdown);
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const snapshotCache = new Map<string, { at: number; data: AnalyticsSnapshot }>();

type GeoRow = { codigo: string; nombre: string | null; lat: number; lng: number };
let geoCache: { at: number; byCodigo: Map<string, GeoRow> } | null = null;

// ---------------------------------------------------------------------------
// Fast reads
// ---------------------------------------------------------------------------

type RawEvent = {
    ts?: string;
    codigo_parada?: string | null;
    linea?: string | null;
};

function productFilter(days: number, lineaFilter: string | undefined) {
    if (!supabase) throw new Error("no supabase");
    let q = supabase
        .from("query_events")
        .select("ts, codigo_parada, linea")
        .eq("accion", PRODUCT_ACCION);

    if (days > 0) {
        q = q.gte("ts", new Date(Date.now() - days * 86_400_000).toISOString());
    }
    if (lineaFilter) {
        q = q.eq("linea", lineaFilter);
    }
    // Sin order: el sort en DB es el mayor costo y no lo necesitamos para agregar
    return q;
}

/**
 * Baja todos los eventos de producto en páginas paralelas (~1s para 20k filas).
 */
async function fetchProductEvents(days: number, lineaFilter: string | undefined): Promise<RawEvent[]> {
    if (!supabase) return [];

    const t0 = Date.now();

    // Count barato para saber cuántas páginas pedir
    let countQ = supabase
        .from("query_events")
        .select("*", { count: "exact", head: true })
        .eq("accion", PRODUCT_ACCION);
    if (days > 0) {
        countQ = countQ.gte("ts", new Date(Date.now() - days * 86_400_000).toISOString());
    }
    if (lineaFilter) {
        countQ = countQ.eq("linea", lineaFilter);
    }

    const { count, error: countErr } = await countQ;
    if (countErr) {
        console.error("[analytics] Error count:", countErr.message);
        return [];
    }
    if (!count || count === 0) return [];

    const pages = Math.ceil(count / PAGE_SIZE);
    const results = await Promise.all(
        Array.from({ length: pages }, (_, i) => {
            const from = i * PAGE_SIZE;
            return productFilter(days, lineaFilter).range(from, from + PAGE_SIZE - 1);
        }),
    );

    const all: RawEvent[] = [];
    for (const r of results) {
        if (r.error) {
            console.error("[analytics] Error page:", r.error.message);
            continue;
        }
        if (r.data?.length) all.push(...(r.data as RawEvent[]));
    }

    console.log(`[analytics] fetch ${all.length} events in ${Date.now() - t0}ms (${pages} pages parallel)`);
    return all;
}

async function loadAllParadaGeo(): Promise<Map<string, GeoRow>> {
    if (!supabase) return new Map();

    if (geoCache && Date.now() - geoCache.at < GEO_CACHE_TTL_MS) {
        return geoCache.byCodigo;
    }

    const t0 = Date.now();
    const byCodigo = new Map<string, GeoRow>();
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from("parada_geo")
            .select("codigo, nombre, lat, lng")
            .range(from, from + PAGE_SIZE - 1);

        if (error) {
            console.error("[analytics] Error parada_geo:", error.message);
            break;
        }
        if (!data?.length) break;

        for (const g of data) {
            const codigo = g.codigo as string;
            const canon = normalizeParadaId(codigo) ?? codigo;
            const row: GeoRow = {
                codigo: canon,
                nombre: (g.nombre as string | null) ?? null,
                lat: g.lat as number,
                lng: g.lng as number,
            };
            byCodigo.set(codigo, row);
            byCodigo.set(canon, row);
        }

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }

    geoCache = { at: Date.now(), byCodigo };
    console.log(`[analytics] geo cache ${byCodigo.size} keys in ${Date.now() - t0}ms`);
    return byCodigo;
}

function aggregateTopParadas(data: RawEvent[], limit: number): TopItem[] {
    const counts = new Map<string, { count: number; lineas: Map<string, number> }>();

    for (const row of data) {
        const k = normalizeParadaId(row.codigo_parada);
        if (!k) continue;
        const l = row.linea?.trim() || null;
        let info = counts.get(k);
        if (!info) {
            info = { count: 0, lineas: new Map() };
            counts.set(k, info);
        }
        info.count++;
        if (l) info.lineas.set(l, (info.lineas.get(l) ?? 0) + 1);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([key, info]) => ({
            key,
            count: info.count,
            lineas: [...info.lineas.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([linea, count]) => ({ linea, count })),
        }));
}

function aggregateTopLineas(data: RawEvent[], limit: number): TopItem[] {
    const counts = new Map<string, number>();
    for (const row of data) {
        const l = row.linea?.trim();
        if (!l) continue;
        counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, count]) => ({ key, count, linea: key }));
}

function aggregateHeatmap(data: RawEvent[]): HeatmapCell[] {
    const matrix = new Map<string, number>();
    for (const row of data) {
        if (!row.ts) continue;
        const d = new Date(row.ts);
        if (Number.isNaN(d.getTime())) continue;
        const key = `${d.getHours()}:${d.getDay()}`;
        matrix.set(key, (matrix.get(key) ?? 0) + 1);
    }
    const result: HeatmapCell[] = [];
    for (const [key, count] of matrix) {
        const [hour, dow] = key.split(":").map(Number);
        result.push({ hour: hour!, dow: dow!, count });
    }
    return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function upsertParadaGeo(
    paradas: Array<{ codigo: string; nombre?: string; lat: number; lng: number }>,
): Promise<void> {
    if (!supabase || paradas.length === 0) return;

    const rows = paradas.map((p) => ({
        codigo: p.codigo,
        nombre: p.nombre ?? null,
        lat: p.lat,
        lng: p.lng,
        updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from("parada_geo").upsert(rows, { onConflict: "codigo" });

    if (error) {
        console.error("[analytics] Error guardando parada_geo:", error.message);
    } else {
        geoCache = null;
        console.log(`[analytics] ${rows.length} coordenadas de paradas guardadas`);
    }
}

/**
 * Snapshot para /stats/analytics/data.
 * Cacheado ~45s; cold path ~1s con fetch paralelo.
 */
export async function getAnalyticsSnapshot(days = 0, lineaFilter?: string): Promise<AnalyticsSnapshot> {
    const empty = (): AnalyticsSnapshot => ({
        totalEvents: 0,
        topParadas: [],
        topLineas: [],
        heatmap: [],
        paradaGeo: [],
        bufferSize: buffer.length,
        supabaseConnected: !!supabase,
        metric: PRODUCT_ACCION,
        note: "Solo se cuentan consultas de próximos arribos (no catálogo ni banderas)",
        uniqueParadas: 0,
        uniqueLineas: 0,
        geoCoverage: 0,
    });

    if (!supabase) {
        return { ...empty(), supabaseConnected: false };
    }

    const cacheKey = `${days}|${lineaFilter ?? ""}`;
    const hit = snapshotCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SNAPSHOT_CACHE_TTL_MS) {
        return {
            ...hit.data,
            bufferSize: buffer.length,
            cached: true,
            durationMs: 0,
        };
    }

    const t0 = Date.now();

    // Eventos + geo en paralelo
    const [rawData, geoMap] = await Promise.all([
        fetchProductEvents(days, lineaFilter),
        loadAllParadaGeo(),
    ]);

    const topParadasRaw = aggregateTopParadas(rawData, 10_000);
    const topLineas = aggregateTopLineas(rawData, 50);
    const heatmap = aggregateHeatmap(rawData);

    const topParadas: TopItem[] = topParadasRaw.map((p) => {
        const g = geoMap.get(p.key);
        const nombre = g?.nombre && g.nombre !== g.codigo ? g.nombre : null;
        return { ...p, nombre: nombre ?? null };
    });

    const seen = new Set<string>();
    const paradaGeo: ParadaGeoPoint[] = [];
    for (const p of topParadas) {
        const g = geoMap.get(p.key);
        if (!g || !g.lat || !g.lng) continue;
        if (seen.has(g.codigo)) continue;
        seen.add(g.codigo);
        paradaGeo.push({
            codigo: g.codigo,
            nombre: g.nombre && g.nombre !== g.codigo ? g.nombre : null,
            lat: g.lat,
            lng: g.lng,
            count: p.count,
            lineas: p.lineas ?? [],
        });
    }

    const durationMs = Date.now() - t0;
    const data: AnalyticsSnapshot = {
        totalEvents: rawData.length,
        topParadas,
        topLineas,
        heatmap,
        paradaGeo,
        bufferSize: buffer.length,
        supabaseConnected: true,
        metric: PRODUCT_ACCION,
        note: "Solo se cuentan consultas de próximos arribos (no catálogo ni banderas)",
        uniqueParadas: topParadas.length,
        uniqueLineas: topLineas.length,
        geoCoverage: topParadas.length > 0
            ? Math.round((paradaGeo.length / topParadas.length) * 100)
            : 0,
        durationMs,
        cached: false,
    };

    snapshotCache.set(cacheKey, { at: Date.now(), data });
    console.log(`[analytics] snapshot days=${days} linea=${lineaFilter ?? "*"} in ${durationMs}ms`);
    return data;
}

export { flushBuffer as flushAnalyticsBuffer };
