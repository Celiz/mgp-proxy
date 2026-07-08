/**
 * Analytics engine — persistencia de consultas en Supabase.
 *
 * Recolecta eventos de queries (parada, línea, acción) en un buffer
 * en memoria y los flushea en batch a Supabase cada FLUSH_INTERVAL_MS
 * o cuando el buffer alcanza FLUSH_THRESHOLD.
 *
 * Si Supabase no está configurado, todo se loguea y se descarta
 * silenciosamente (el proxy sigue funcionando).
 */

import { supabase } from "./supabase.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QueryEvent = {
    accion: string;
    codigo_parada: string | null;
    linea: string | null;
};

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

let buffer: QueryEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Registra una consulta. Fire-and-forget, nunca bloquea.
 */
export function trackQuery(
    accion: string,
    codigoParada?: string | null,
    linea?: string | null,
): void {
    if (!supabase) return;

    buffer.push({
        accion,
        codigo_parada: codigoParada ?? null,
        linea: linea ?? null,
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
            // Re-enqueue failed batch (limit to avoid infinite growth)
            if (buffer.length < 500) {
                buffer.push(...batch);
            }
        }
    } catch (e) {
        console.error("[analytics] Flush exception:", (e as Error).message);
    }
}

// Start periodic flush
if (supabase) {
    flushTimer = setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS);

    // Flush on shutdown
    const gracefulShutdown = () => {
        console.log("[analytics] Flushing buffer antes de cerrar...");
        void flushBuffer().then(() => process.exit(0));
    };
    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGINT", gracefulShutdown);
}

// ---------------------------------------------------------------------------
// Queries para el dashboard
// ---------------------------------------------------------------------------

export type TopItem = { key: string; count: number };
export type HeatmapCell = { hour: number; dow: number; count: number };
export type ParadaGeoPoint = {
    codigo: string;
    nombre: string | null;
    lat: number;
    lng: number;
    count: number;
};

/**
 * Top N paradas más consultadas.
 * @param days - filtrar últimos N días (0 = todo)
 */
export async function getTopParadas(limit = 20, days = 0): Promise<TopItem[]> {
    if (!supabase) return [];

    try {
        let q = supabase
            .from("query_events")
            .select("codigo_parada")
            .not("codigo_parada", "is", null);

        if (days > 0) {
            const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
            q = q.gte("ts", cutoff);
        }

        const { data, error } = await q.limit(50_000);
        if (error || !data) return [];

        const counts = new Map<string, number>();
        for (const row of data) {
            const k = row.codigo_parada as string;
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }

        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([key, count]) => ({ key, count }));
    } catch (e) {
        console.error("[analytics] Error en getTopParadas:", (e as Error).message);
        return [];
    }
}


/**
 * Top N líneas más consultadas.
 */
export async function getTopLineas(limit = 20, days = 0): Promise<TopItem[]> {
    if (!supabase) return [];

    let q = supabase
        .from("query_events")
        .select("linea")
        .not("linea", "is", null);

    if (days > 0) {
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        q = q.gte("ts", cutoff);
    }

    const { data, error } = await q.limit(10_000);
    if (error || !data) return [];

    const counts = new Map<string, number>();
    for (const row of data) {
        const k = row.linea as string;
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, count]) => ({ key, count }));
}

/**
 * Datos para el heatmap temporal (hora × día de semana).
 */
export async function getHeatmapData(days = 30): Promise<HeatmapCell[]> {
    if (!supabase) return [];

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data, error } = await supabase
        .from("query_events")
        .select("ts")
        .gte("ts", cutoff)
        .limit(50_000);

    if (error || !data) return [];

    // Aggregate client-side into hour × dow matrix
    const matrix = new Map<string, number>();
    for (const row of data) {
        const d = new Date(row.ts as string);
        const hour = d.getHours();
        const dow = d.getDay(); // 0=Sun
        const key = `${hour}:${dow}`;
        matrix.set(key, (matrix.get(key) ?? 0) + 1);
    }

    const result: HeatmapCell[] = [];
    for (const [key, count] of matrix) {
        const [hour, dow] = key.split(":").map(Number);
        result.push({ hour: hour!, dow: dow!, count });
    }
    return result;
}

/**
 * Paradas con coordenadas + sus counts de consultas.
 */
export async function getParadaGeoData(days = 0): Promise<ParadaGeoPoint[]> {
    if (!supabase) return [];

    // 1. Get all parada coordinates
    const { data: geoData, error: geoErr } = await supabase
        .from("parada_geo")
        .select("codigo, nombre, lat, lng");

    if (geoErr || !geoData || geoData.length === 0) return [];

    // 2. Get counts per parada
    const topParadas = await getTopParadas(1000, days);
    const countMap = new Map(topParadas.map((p) => [p.key, p.count]));

    // 3. Merge
    return geoData
        .filter((g) => g.lat && g.lng)
        .map((g) => ({
            codigo: g.codigo as string,
            nombre: g.nombre as string | null,
            lat: g.lat as number,
            lng: g.lng as number,
            count: countMap.get(g.codigo as string) ?? 0,
        }))
        .filter((p) => p.count > 0)
        .sort((a, b) => b.count - a.count);
}

/**
 * Guardar coordenadas de paradas (upsert).
 */
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

    const { error } = await supabase
        .from("parada_geo")
        .upsert(rows, { onConflict: "codigo" });

    if (error) {
        console.error("[analytics] Error guardando parada_geo:", error.message);
    } else {
        console.log(`[analytics] ${rows.length} coordenadas de paradas guardadas`);
    }
}

/**
 * Estadísticas generales para el endpoint /stats/analytics/data.
 */
export async function getAnalyticsSnapshot(days = 0) {
    const [topParadas, topLineas, heatmap, paradaGeo] = await Promise.all([
        getTopParadas(20, days),
        getTopLineas(20, days),
        getHeatmapData(days || 30),
        getParadaGeoData(days),
    ]);

    // Total events count
    let totalEvents = 0;
    if (supabase) {
        const { count } = await supabase
            .from("query_events")
            .select("*", { count: "exact", head: true });
        totalEvents = count ?? 0;
    }

    return {
        totalEvents,
        topParadas,
        topLineas,
        heatmap,
        paradaGeo,
        bufferSize: buffer.length,
        supabaseConnected: supabase !== null,
    };
}
