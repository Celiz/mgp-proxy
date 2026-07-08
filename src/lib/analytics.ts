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
import fs from "fs";
import path from "path";

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
let ramalesMap: Map<string, Set<string>> | null = null;

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

export type TopItem = { key: string; count: number; lineas?: { linea: string; count: number }[]; linea?: string; ramal?: string; nombre?: string };
export type HeatmapCell = { hour: number; dow: number; count: number };
export type ParadaGeoPoint = {
    codigo: string;
    nombre: string | null;
    lat: number;
    lng: number;
    count: number;
    lineas?: { linea: string; count: number }[];
    ramales?: string[];
};

/**
 * Top N paradas más consultadas.
 * @param days - filtrar últimos N días (0 = todo)
 */
export async function getTopParadas(limit = 20, days = 0, lineaFilter?: string): Promise<TopItem[]> {
    if (!supabase) return [];

    try {
        let q = supabase
            .from("query_events")
            .select("codigo_parada, linea")
            .not("codigo_parada", "is", null);

        if (days > 0) {
            const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
            q = q.gte("ts", cutoff);
        }

        if (lineaFilter) {
            q = q.eq("linea", lineaFilter);
        }

        const { data, error } = await q.limit(50_000);
        if (error || !data) return [];

        const counts = new Map<string, { count: number; lineas: Map<string, number> }>();
        for (const row of data) {
            const k = row.codigo_parada as string;
            const l = row.linea as string | null;
            if (!counts.has(k)) {
                counts.set(k, { count: 0, lineas: new Map() });
            }
            const info = counts.get(k)!;
            info.count++;
            if (l) {
                info.lineas.set(l, (info.lineas.get(l) ?? 0) + 1);
            }
        }

        return [...counts.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, limit)
            .map(([key, info]) => {
                const topLineas = [...info.lineas.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([linea, count]) => ({ linea, count }));
                return { key, count: info.count, lineas: topLineas };
            });
    } catch (e) {
        console.error("[analytics] Error en getTopParadas:", (e as Error).message);
        return [];
    }
}


/**
 * Top N líneas más consultadas.
 */
export async function getTopLineas(limit = 20, days = 0, lineaFilter?: string): Promise<TopItem[]> {
    if (!supabase) return [];

    let q = supabase
        .from("query_events")
        .select("linea, codigo_parada")
        .not("linea", "is", null);

    if (days > 0) {
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        q = q.gte("ts", cutoff);
    }

    if (lineaFilter) {
        q = q.eq("linea", lineaFilter);
    }

    const { data, error } = await q.limit(10_000);
    if (error || !data) return [];

    // Lazy load ramales si no se hizo aún
    if (!ramalesMap) {
        ramalesMap = new Map();
        try {
            const dir = path.join(process.cwd(), "src/data/static/linea");
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    if (!f.endsWith(".json")) continue;
                    const fileData = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
                    const lineaNum = fileData.meta?.Descripcion;
                    if (!lineaNum || !fileData.paradasByCalleInterseccion) continue;
                    for (const arr of Object.values(fileData.paradasByCalleInterseccion)) {
                        for (const p of arr as any[]) {
                            if (p.Identificador && p.AbreviaturaBandera) {
                                if (!ramalesMap.has(p.Identificador)) {
                                    ramalesMap.set(p.Identificador, new Set());
                                }
                                // Guardamos "linea|ramal"
                                ramalesMap.get(p.Identificador)!.add(`${lineaNum}|${p.AbreviaturaBandera}`);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error("[analytics] Error cargando ramales", e);
        }
    }

    const counts = new Map<string, { count: number, ramales: Map<string, number> }>();
    for (const row of data) {
        const lineaStr = row.linea as string;
        const parada = row.codigo_parada as string | null;
        
        let ramalesEnParada: string[] = [];
        if (parada && ramalesMap && ramalesMap.has(parada)) {
            const list = Array.from(ramalesMap.get(parada)!);
            ramalesEnParada = list.filter(x => x.startsWith(lineaStr + '|')).map(x => x.split('|')[1]);
        }
        
        const lineInfo = counts.get(lineaStr) || { count: 0, ramales: new Map<string, number>() };
        lineInfo.count++; // 1 query to the line
        
        if (ramalesEnParada.length > 0) {
            for (const r of ramalesEnParada) {
                lineInfo.ramales.set(r, (lineInfo.ramales.get(r) || 0) + 1);
            }
        }
        counts.set(lineaStr, lineInfo);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([key, info]) => {
            const topRamales = [...info.ramales.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([ramal, count]) => ({ ramal, count }));
            return { 
                key, 
                count: info.count, 
                linea: key, 
                ramales: topRamales
            };
        });
}

/**
 * Datos para el heatmap temporal (hora × día de semana).
 */
export async function getHeatmapData(days = 30, lineaFilter?: string): Promise<HeatmapCell[]> {
    if (!supabase) return [];

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    let q = supabase
        .from("query_events")
        .select("ts")
        .gte("ts", cutoff);

    if (lineaFilter) {
        q = q.eq("linea", lineaFilter);
    }

    const { data, error } = await q.limit(50_000);

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
export async function getParadaGeoData(days = 0, lineaFilter?: string): Promise<ParadaGeoPoint[]> {
    if (!supabase) return [];

    // 1. Get counts per parada first to limit our geo query (asking for 10000 to cover virtually all queried stops)
    const topParadas = await getTopParadas(10000, days, lineaFilter);
    if (topParadas.length === 0) return [];
    
    const paradaMap = new Map(topParadas.map((p) => [p.key, p]));
    const codigosTop = Array.from(paradaMap.keys());

    // 2. Get parada coordinates ONLY for the top ones (in chunks of 1000 to avoid Supabase limits)
    let geoData: any[] = [];
    const chunkSize = 1000;
    
    for (let i = 0; i < codigosTop.length; i += chunkSize) {
        const chunk = codigosTop.slice(i, i + chunkSize);
        const { data, error } = await supabase
            .from("parada_geo")
            .select("codigo, nombre, lat, lng")
            .in("codigo", chunk);
            
        if (!error && data) {
            geoData = geoData.concat(data);
        }
    }

    if (geoData.length === 0) return [];

    // Carga de mapa de ramales (lazy)
    if (!ramalesMap) {
        ramalesMap = new Map();
        try {
            const dir = path.join(process.cwd(), "src/data/static/linea");
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    if (!f.endsWith(".json")) continue;
                    const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
                    if (data.paradasByCalleInterseccion) {
                        for (const arr of Object.values(data.paradasByCalleInterseccion)) {
                            for (const p of arr as any[]) {
                                if (p.Identificador && p.AbreviaturaBandera) {
                                    if (!ramalesMap.has(p.Identificador)) {
                                        ramalesMap.set(p.Identificador, new Set());
                                    }
                                // Guardar como "linea|ramal"
                                const lineaNum = data.meta?.Descripcion || p.AbreviaturaBandera.split(" ")[0];
                                ramalesMap.get(p.Identificador)!.add(`${lineaNum}|${p.AbreviaturaBandera}`);
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error("[analytics] Error cargando ramales", e);
        }
    }
    return geoData
        .filter((g) => g.lat && g.lng)
        .map((g) => {
            const pData = paradaMap.get(g.codigo as string);
            return {
                codigo: g.codigo as string,
                nombre: g.nombre as string | null,
                lat: g.lat as number,
                lng: g.lng as number,
                count: pData?.count ?? 0,
                lineas: pData?.lineas ?? [],
                ramales: Array.from(ramalesMap?.get(g.codigo as string) ?? []).map(x => x.split('|')[1] || x),
            };
        })
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
export async function getAnalyticsSnapshot(days = 0, lineaFilter?: string) {
    const [topParadas, topLineas, heatmap, paradaGeo] = await Promise.all([
        getTopParadas(20, days, lineaFilter),
        getTopLineas(20, days, lineaFilter),
        getHeatmapData(days || 30, lineaFilter),
        getParadaGeoData(days, lineaFilter),
    ]);

    // Total events count
    let totalEvents = 0;
    if (supabase) {
        let q = supabase.from("query_events").select("*", { count: "exact", head: true });
        if (lineaFilter) {
            q = q.eq("linea", lineaFilter);
        }
        const { count } = await q;
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
