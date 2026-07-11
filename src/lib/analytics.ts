/**
 * Analytics de producto — demanda real de arribos.
 *
 * Solo persiste consultas de próximos arribos (RecuperarProximosArribosW).
 * Catálogo, banderas y metadata no se trackean: inflan tops sin medir interés.
 *
 * Buffer en memoria → batch a Supabase. Si Supabase no está configurado,
 * el proxy sigue igual sin analytics persistente.
 */

import fs from "fs";
import path from "path";
import { supabase } from "./supabase.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 50;

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

// ---------------------------------------------------------------------------
// Parada identity (Codigo MGP ↔ Identificador P…)
// ---------------------------------------------------------------------------

/** codigo_or_id → canonical id (preferimos Identificador tipo P3608). */
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

/** Normaliza id de parada a canónico cuando hay alias conocido. */
export function normalizeParadaId(codigo: string | null | undefined): string | null {
    if (codigo == null || codigo === "") return null;
    const raw = String(codigo).trim();
    if (!raw) return null;
    const map = loadParadaCanonicalMap();
    return map.get(raw) ?? raw;
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

let buffer: QueryEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Registra una consulta de producto. Fire-and-forget.
 * Ignora acciones que no son demanda de arribos.
 */
export function trackQuery(
    accion: string,
    codigoParada?: string | null,
    linea?: string | null,
): void {
    if (!supabase) return;
    if (accion !== PRODUCT_ACCION) return;

    const parada = normalizeParadaId(codigoParada);
    const lineaNorm = linea?.trim() || null;
    // Sin parada ni línea no aporta al ranking de demanda
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
            if (buffer.length < 500) {
                buffer.push(...batch);
            }
        }
    } catch (e) {
        console.error("[analytics] Flush exception:", (e as Error).message);
    }
}

if (supabase) {
    flushTimer = setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS);

    // Solo flush: el exit lo maneja index.ts (evita doble process.exit)
    const onShutdown = () => {
        console.log("[analytics] Flushing buffer antes de cerrar...");
        void flushBuffer();
    };
    process.on("SIGTERM", onShutdown);
    process.on("SIGINT", onShutdown);
}

// ---------------------------------------------------------------------------
// Fetch + aggregate
// ---------------------------------------------------------------------------

type RawEvent = {
    id?: number;
    ts?: string;
    accion?: string;
    codigo_parada?: string | null;
    linea?: string | null;
};

/**
 * Trae eventos de producto (arribos). Filtra ruido histórico de otras acciones.
 */
async function fetchProductEvents(days: number, lineaFilter: string | undefined): Promise<RawEvent[]> {
    if (!supabase) return [];
    let allData: RawEvent[] = [];
    let from = 0;
    const step = 1000;

    while (true) {
        let q = supabase
            .from("query_events")
            .select("id, ts, accion, codigo_parada, linea")
            .eq("accion", PRODUCT_ACCION)
            .order("id", { ascending: false })
            .range(from, from + step - 1);

        if (days > 0) {
            const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
            q = q.gte("ts", cutoff);
        }
        if (lineaFilter) {
            q = q.eq("linea", lineaFilter);
        }

        const { data, error } = await q;
        if (error) {
            console.error("[analytics] Error fetchProductEvents:", error.message);
            break;
        }
        if (!data || data.length === 0) break;

        allData = allData.concat(data as RawEvent[]);
        if (data.length < step) break;
        from += step;
    }
    return allData;
}

function aggregateTopParadas(data: RawEvent[], limit: number): TopItem[] {
    const counts = new Map<string, { count: number; lineas: Map<string, number> }>();

    for (const row of data) {
        const k = normalizeParadaId(row.codigo_parada);
        if (!k) continue;
        const l = row.linea?.trim() || null;
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
        const hour = d.getHours();
        const dow = d.getDay();
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
 * Nombres/coords desde parada_geo, con lookup por canónico + alias.
 */
async function loadParadaGeoByCodigos(codigos: string[]): Promise<Map<string, { codigo: string; nombre: string | null; lat: number; lng: number }>> {
    const out = new Map<string, { codigo: string; nombre: string | null; lat: number; lng: number }>();
    if (!supabase || codigos.length === 0) return out;

    // Incluir aliases inversos para matchear filas viejas en geo (Codigo vs P…)
    const canonMap = loadParadaCanonicalMap();
    const lookupKeys = new Set<string>(codigos);
    for (const [alias, canon] of canonMap) {
        if (codigos.includes(canon) || codigos.includes(alias)) {
            lookupKeys.add(alias);
            lookupKeys.add(canon);
        }
    }

    const keys = [...lookupKeys];
    const chunkSize = 500;
    for (let i = 0; i < keys.length; i += chunkSize) {
        const chunk = keys.slice(i, i + chunkSize);
        const { data, error } = await supabase
            .from("parada_geo")
            .select("codigo, nombre, lat, lng")
            .in("codigo", chunk);

        if (error) {
            console.error("[analytics] Error parada_geo:", error.message);
            continue;
        }
        for (const g of data ?? []) {
            const codigo = g.codigo as string;
            const canon = normalizeParadaId(codigo) ?? codigo;
            const row = {
                codigo: canon,
                nombre: (g.nombre as string | null) ?? null,
                lat: g.lat as number,
                lng: g.lng as number,
            };
            // Index por canónico y por el código tal cual en geo
            out.set(canon, row);
            out.set(codigo, row);
        }
    }
    return out;
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
 * Snapshot para /stats/analytics/data.
 * Solo cuenta RecuperarProximosArribosW (demanda de arribos).
 */
export async function getAnalyticsSnapshot(days = 0, lineaFilter?: string) {
    if (!supabase) {
        return {
            totalEvents: 0,
            topParadas: [] as TopItem[],
            topLineas: [] as TopItem[],
            heatmap: [] as HeatmapCell[],
            paradaGeo: [] as ParadaGeoPoint[],
            bufferSize: buffer.length,
            supabaseConnected: false,
            metric: PRODUCT_ACCION,
            note: "Solo se cuentan consultas de próximos arribos",
        };
    }

    const rawData = await fetchProductEvents(days, lineaFilter);
    const topParadasRaw = aggregateTopParadas(rawData, 10_000);
    const topLineas = aggregateTopLineas(rawData, 50);
    const heatmap = aggregateHeatmap(rawData);

    // Una sola carga de geo para nombres + mapa
    const geoMap = await loadParadaGeoByCodigos(topParadasRaw.map((p) => p.key));
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
    paradaGeo.sort((a, b) => b.count - a.count);

    return {
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
    };
}

// Re-exports útiles para tests / scripts
export { flushBuffer as flushAnalyticsBuffer };
