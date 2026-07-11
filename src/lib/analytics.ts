/**
 * Analytics de producto — demanda de arribos + funnel + insights.
 *
 * Persistencia Supabase (query_events): accion, codigo_parada, linea [, extras si hay migration].
 * Agregados locales (src/data/analytics-local.json): uniques, cache, latencias, rollups diarios, ramales.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { supabase } from "./supabase.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_THRESHOLD = 50;
const PAGE_SIZE = 1000;
const SNAPSHOT_CACHE_TTL_MS = 90_000;
const GEO_CACHE_TTL_MS = 10 * 60_000;
const DEDUPE_WINDOW_MS = 3 * 60_000;
const LOCAL_FILE = path.join(process.cwd(), "src/data/analytics-local.json");
const RETENTION_DAYS = 90;
const TZ = "America/Argentina/Buenos_Aires";

export const PRODUCT_ACCION = "RecuperarProximosArribosW";

/** Acciones del funnel de búsqueda de parada (orden aproximado). */
export const FUNNEL_STEPS: { key: string; label: string; acciones: string[] }[] = [
    {
        key: "lineas",
        label: "Catálogo / líneas",
        acciones: ["RecuperarLineasW", "RecuperarLineaPorCuandoLlega"],
    },
    {
        key: "calles",
        label: "Calles por línea",
        acciones: ["RecuperarCallesPrincipalPorLinea"],
    },
    {
        key: "intersecciones",
        label: "Intersecciones",
        acciones: ["RecuperarInterseccionPorLineaYCalle"],
    },
    {
        key: "paradas",
        label: "Paradas en calle",
        acciones: [
            "RecuperarParadasConBanderaPorLineaCalleEInterseccion",
            "RecuperarParadasConBanderaYDestinoPorLinea",
            "RecuperarParadasBanderasW",
        ],
    },
    {
        key: "banderas",
        label: "Banderas en parada",
        acciones: ["RecuperarBanderasAsociadasAParada", "RecuperarBanderasW"],
    },
    {
        key: "arribos",
        label: "Próximos arribos",
        acciones: [PRODUCT_ACCION],
    },
];

const TRACKED_ACCIONES = new Set(FUNNEL_STEPS.flatMap((s) => s.acciones));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CacheStatus = "HIT" | "MISS" | "STALE" | "UNKNOWN";

export type TrackPayload = {
    accion: string;
    codigoParada?: string | null;
    linea?: string | null;
    ramal?: string | null;
    clientHash?: string | null;
    cache?: CacheStatus;
    durationMs?: number | null;
};

type DbEvent = {
    accion: string;
    codigo_parada: string | null;
    linea: string | null;
    ramal?: string | null;
    client_hash?: string | null;
    cache_status?: string | null;
    duration_ms?: number | null;
};

export type TopItem = {
    key: string;
    count: number;
    lineas?: { linea: string; count: number }[];
    linea?: string;
    nombre?: string | null;
    changePct?: number | null;
};

export type HeatmapCell = { hour: number; dow: number; count: number };

export type ParadaGeoPoint = {
    codigo: string;
    nombre: string | null;
    lat: number;
    lng: number;
    count: number;
    lineas?: { linea: string; count: number }[];
    /** counts by hour 0-23 (TZ AR) for map time filter */
    byHour?: number[];
};

export type AnalyticsSnapshot = {
    totalEvents: number;
    prevTotalEvents: number;
    changePct: number | null;
    topParadas: TopItem[];
    topLineas: TopItem[];
    emergingLineas: TopItem[];
    orphanParadas: TopItem[];
    heatmap: HeatmapCell[];
    paradaGeo: ParadaGeoPoint[];
    funnel: { key: string; label: string; count: number }[];
    uniques: {
        clientsApprox: number;
        note: string;
    };
    cacheMix: { hit: number; miss: number; stale: number; unknown: number };
    latency: { p50: number | null; p95: number | null; samples: number };
    topRamales: { key: string; count: number }[];
    bufferSize: number;
    supabaseConnected: boolean;
    metric: string;
    note: string;
    uniqueParadas: number;
    uniqueLineas: number;
    geoCoverage: number;
    durationMs: number;
    cached: boolean;
    schemaExtended: boolean;
    tz: string;
};

// ---------------------------------------------------------------------------
// Parada identity + names
// ---------------------------------------------------------------------------

let paradaCanonical: Map<string, string> | null = null;
let paradaNames: Map<string, string> | null = null;

function cleanStreetLabel(label: string): string {
    return String(label)
        .replace(/\s*-\s*MAR DEL PLATA/i, "")
        .replace(/\s*-\s*BARRIO\s+.+$/i, "")
        .trim();
}

function loadParadaMaps(): { canonical: Map<string, string>; names: Map<string, string> } {
    if (paradaCanonical && paradaNames) {
        return { canonical: paradaCanonical, names: paradaNames };
    }
    paradaCanonical = new Map();
    paradaNames = new Map();
    try {
        const dir = path.join(process.cwd(), "src/data/static/linea");
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
            // 1) Mapa global código calle → nombre (las keys de paradas son "calle\tintersección")
            const streetByCode = new Map<string, string>();
            type LineFile = {
                calles?: Array<{ value: string; label: string }>;
                paradasByCalleInterseccion?: Record<
                    string,
                    Array<{
                        Codigo?: string;
                        Identificador?: string;
                        Descripcion?: string;
                        AbreviaturaBandera?: string;
                    }>
                >;
            };
            const parsed: LineFile[] = [];
            for (const f of files) {
                const fileData = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as LineFile;
                parsed.push(fileData);
                for (const c of fileData.calles ?? []) {
                    if (c.value && c.label) streetByCode.set(String(c.value), c.label);
                }
            }

            // 2) Alias Codigo↔Identificador + nombres legibles
            for (const fileData of parsed) {
                for (const [calleKey, arr] of Object.entries(fileData.paradasByCalleInterseccion ?? {})) {
                    // keys: "5429\t5484" (calle principal + intersección)
                    const parts = String(calleKey).split("\t").filter(Boolean);
                    const streetLabels = parts
                        .map((code) => streetByCode.get(code))
                        .filter((l): l is string => !!l)
                        .map(cleanStreetLabel)
                        .filter(Boolean);
                    const intersectionLabel =
                        streetLabels.length >= 2
                            ? streetLabels.join(" y ")
                            : streetLabels[0] ?? null;

                    for (const p of arr) {
                        if (!p.Identificador) continue;
                        const id = String(p.Identificador);
                        paradaCanonical.set(id, id);
                        if (p.Codigo != null && p.Codigo !== "") {
                            paradaCanonical.set(String(p.Codigo), id);
                        }
                        const ramal = p.AbreviaturaBandera ? ` · ${p.AbreviaturaBandera}` : "";
                        const base =
                            intersectionLabel ??
                            (p.Descripcion ? `Parada ${p.Descripcion}` : id);
                        const name = `${base}${ramal}`;
                        if (!paradaNames.has(id) || name.length > (paradaNames.get(id)?.length ?? 0)) {
                            paradaNames.set(id, name);
                        }
                        if (p.Codigo) paradaNames.set(String(p.Codigo), name);
                    }
                }
            }
        }
    } catch (e) {
        console.error("[analytics] Error cargando mapas de paradas:", (e as Error).message);
    }
    return { canonical: paradaCanonical, names: paradaNames };
}

export function normalizeParadaId(codigo: string | null | undefined): string | null {
    if (codigo == null || codigo === "") return null;
    const raw = String(codigo).trim();
    if (!raw) return null;
    return loadParadaMaps().canonical.get(raw) ?? raw;
}

export function paradaDisplayName(codigo: string): string | null {
    const maps = loadParadaMaps();
    const canon = maps.canonical.get(codigo) ?? codigo;
    return maps.names.get(canon) ?? maps.names.get(codigo) ?? null;
}

/** Hash estable y no reversible de identificador de cliente (privacidad). */
export function hashClient(parts: Array<string | null | undefined>): string | null {
    const raw = parts.filter(Boolean).join("|");
    if (!raw) return null;
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Local rich store (uniques, cache, latency, daily, ramales)
// ---------------------------------------------------------------------------

type LocalStore = {
    version: 1;
    /** day (YYYY-MM-DD AR) → linea → count */
    dailyLinea: Record<string, Record<string, number>>;
    /** day → parada → count */
    dailyParada: Record<string, Record<string, number>>;
    /** day → client_hash set as object */
    dailyClients: Record<string, Record<string, 1>>;
    cache: { hit: number; miss: number; stale: number; unknown: number };
    /** ring of recent durations (arribos) */
    durations: number[];
    ramales: Record<string, number>;
    /** dedupe keys recently seen: key → ts */
    // not persisted — live only
};

let local: LocalStore = {
    version: 1,
    dailyLinea: {},
    dailyParada: {},
    dailyClients: {},
    cache: { hit: 0, miss: 0, stale: 0, unknown: 0 },
    durations: [],
    ramales: {},
};

let localDirty = false;
const liveDedupe = new Map<string, number>();

function dayKeyAR(ts = Date.now()): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date(ts));
}

function loadLocal(): void {
    try {
        if (fs.existsSync(LOCAL_FILE)) {
            const raw = JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8"));
            local = {
                version: 1,
                dailyLinea: raw.dailyLinea ?? {},
                dailyParada: raw.dailyParada ?? {},
                dailyClients: raw.dailyClients ?? {},
                cache: raw.cache ?? { hit: 0, miss: 0, stale: 0, unknown: 0 },
                durations: Array.isArray(raw.durations) ? raw.durations.slice(-2000) : [],
                ramales: raw.ramales ?? {},
            };
            pruneLocalRetention();
            console.log("[analytics] Local store loaded");
        }
    } catch (e) {
        console.error("[analytics] Error loading local store:", (e as Error).message);
    }
}

function pruneLocalRetention(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const cutoffDay = dayKeyAR(cutoff);
    for (const bag of [local.dailyLinea, local.dailyParada, local.dailyClients]) {
        for (const d of Object.keys(bag)) {
            if (d < cutoffDay) delete bag[d];
        }
    }
}

async function saveLocal(): Promise<void> {
    if (!localDirty) return;
    try {
        pruneLocalRetention();
        await fs.promises.writeFile(LOCAL_FILE, JSON.stringify(local), "utf8");
        localDirty = false;
    } catch (e) {
        console.error("[analytics] Error saving local store:", (e as Error).message);
    }
}

function bumpNested(root: Record<string, Record<string, number>>, day: string, key: string): void {
    if (!root[day]) root[day] = {};
    root[day]![key] = (root[day]![key] ?? 0) + 1;
}

function recordLocalRich(p: {
    parada: string | null;
    linea: string | null;
    ramal: string | null;
    clientHash: string | null;
    cache: CacheStatus;
    durationMs: number | null;
    isArribo: boolean;
}): void {
    if (!p.isArribo) return;
    const day = dayKeyAR();
    if (p.linea) bumpNested(local.dailyLinea, day, p.linea);
    if (p.parada) bumpNested(local.dailyParada, day, p.parada);
    if (p.clientHash) {
        if (!local.dailyClients[day]) local.dailyClients[day] = {};
        local.dailyClients[day]![p.clientHash] = 1;
    }
    if (p.cache === "HIT") local.cache.hit++;
    else if (p.cache === "MISS") local.cache.miss++;
    else if (p.cache === "STALE") local.cache.stale++;
    else local.cache.unknown++;

    if (p.durationMs != null && p.durationMs >= 0) {
        local.durations.push(p.durationMs);
        if (local.durations.length > 2000) local.durations.shift();
    }
    if (p.ramal && p.linea) {
        const k = `${p.linea} · ${p.ramal}`;
        local.ramales[k] = (local.ramales[k] ?? 0) + 1;
    }
    localDirty = true;
}

function percentile(sorted: number[], p: number): number | null {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx]!;
}

function clientsInDays(days: number): number {
    const set = new Set<string>();
    const keys = Object.keys(local.dailyClients).sort();
    const from = days > 0 ? dayKeyAR(Date.now() - days * 86_400_000) : "";
    for (const d of keys) {
        if (days > 0 && d < from) continue;
        for (const c of Object.keys(local.dailyClients[d] ?? {})) set.add(c);
    }
    return set.size;
}

// ---------------------------------------------------------------------------
// Schema probe + buffer
// ---------------------------------------------------------------------------

let schemaExtended: boolean | null = null;
let buffer: DbEvent[] = [];

async function probeSchema(): Promise<boolean> {
    if (!supabase) return false;
    if (schemaExtended != null) return schemaExtended;
    const { error } = await supabase.from("query_events").insert({
        accion: PRODUCT_ACCION,
        codigo_parada: "__schema_probe__",
        linea: null,
        ramal: null,
        client_hash: "probe",
        cache_status: "HIT",
        duration_ms: 0,
    });
    if (error) {
        schemaExtended = false;
        console.log("[analytics] Schema básico (sin columnas v2). Corré src/sql/analytics_v2.sql para habilitar extras.");
    } else {
        schemaExtended = true;
        await supabase.from("query_events").delete().eq("codigo_parada", "__schema_probe__");
        console.log("[analytics] Schema v2 extendido ✅");
    }
    return schemaExtended;
}

/**
 * Registra evento de analytics. Dedupe arribos por client+parada+línea (3 min).
 */
export function trackQuery(payload: TrackPayload | string, codigoParada?: string | null, linea?: string | null): void {
    // Back-compat: trackQuery(accion, parada, linea)
    const p: TrackPayload =
        typeof payload === "string"
            ? { accion: payload, codigoParada, linea }
            : payload;

    if (!TRACKED_ACCIONES.has(p.accion) && p.accion !== PRODUCT_ACCION) {
        // solo funnel + arribos
        return;
    }

    const parada = normalizeParadaId(p.codigoParada);
    const lineaNorm = p.linea?.trim() || null;
    const ramal = p.ramal?.trim() || null;
    const clientHash = p.clientHash ?? null;
    const cache = p.cache ?? "UNKNOWN";
    const durationMs = p.durationMs ?? null;
    const isArribo = p.accion === PRODUCT_ACCION;

    if (isArribo) {
        // Dedupe: no spamear Supabase con el mismo poll
        const dedupeKey = `${clientHash ?? "anon"}|${parada ?? ""}|${lineaNorm ?? ""}`;
        const now = Date.now();
        const prev = liveDedupe.get(dedupeKey);
        if (prev && now - prev < DEDUPE_WINDOW_MS) {
            // igual contamos localmente? no — dedupe total para no inflar
            return;
        }
        liveDedupe.set(dedupeKey, now);
        // limpia dedupe viejo ocasionalmente
        if (liveDedupe.size > 20_000) {
            for (const [k, t] of liveDedupe) {
                if (now - t > DEDUPE_WINDOW_MS) liveDedupe.delete(k);
            }
        }
        recordLocalRich({ parada, linea: lineaNorm, ramal, clientHash, cache, durationMs, isArribo: true });
    }

    if (!supabase) return;
    if (isArribo && !parada && !lineaNorm) return;

    // Siempre guardamos extras en el buffer; al flush se strippean si el schema es básico.
    // (Evita perder ramal/client/cache en eventos previos a probeSchema.)
    buffer.push({
        accion: p.accion,
        codigo_parada: parada,
        linea: lineaNorm,
        ramal,
        client_hash: clientHash,
        cache_status: cache,
        duration_ms: durationMs,
    });
    if (buffer.length >= FLUSH_THRESHOLD) void flushBuffer();
}

async function flushBuffer(): Promise<void> {
    if (!supabase || buffer.length === 0) return;
    await probeSchema();

    const batch = buffer;
    buffer = [];

    // Si schema no extendido, strip extras
    const rows = schemaExtended
        ? batch
        : batch.map((r) => ({
              accion: r.accion,
              codigo_parada: r.codigo_parada,
              linea: r.linea,
          }));

    try {
        const { error } = await supabase.from("query_events").insert(rows);
        if (error) {
            console.error("[analytics] Error insertando batch:", error.message);
            if (buffer.length < 500) buffer.push(...batch);
        } else {
            snapshotCache.clear();
        }
    } catch (e) {
        console.error("[analytics] Flush exception:", (e as Error).message);
    }
    await saveLocal();
}

if (true) {
    loadLocal();
    if (supabase) {
        void probeSchema();
        setInterval(() => void flushBuffer(), FLUSH_INTERVAL_MS);
        setInterval(() => void saveLocal(), 60_000);
        const onShutdown = () => {
            void flushBuffer();
            void saveLocal();
        };
        process.on("SIGTERM", onShutdown);
        process.on("SIGINT", onShutdown);
    }
}

// ---------------------------------------------------------------------------
// Fetch + aggregate (Supabase)
// ---------------------------------------------------------------------------

type RawEvent = {
    ts?: string;
    accion?: string;
    codigo_parada?: string | null;
    linea?: string | null;
    ramal?: string | null;
    client_hash?: string | null;
    cache_status?: string | null;
    duration_ms?: number | null;
};

const snapshotCache = new Map<string, { at: number; data: AnalyticsSnapshot }>();

type GeoRow = { codigo: string; nombre: string | null; lat: number; lng: number };
let geoCache: { at: number; byCodigo: Map<string, GeoRow> } | null = null;

function partsInAR(ts: string | Date): { hour: number; dow: number; day: string } {
    const d = typeof ts === "string" ? new Date(ts) : ts;
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        hour: "numeric",
        hour12: false,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hourRaw = Number(get("hour"));
    // hour12:false can still give 24 in some engines
    const hour = hourRaw === 24 ? 0 : hourRaw;
    const wd = get("weekday");
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = `${get("year")}-${get("month")}-${get("day")}`;
    return { hour, dow: dowMap[wd] ?? d.getUTCDay(), day };
}

/** Counts por acción sin bajar filas (funnel rápido). */
async function countAcciones(days: number, acciones: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!supabase) return out;
    await Promise.all(
        acciones.map(async (accion) => {
            let q = supabase!
                .from("query_events")
                .select("*", { count: "exact", head: true })
                .eq("accion", accion);
            if (days > 0) {
                q = q.gte("ts", new Date(Date.now() - days * 86_400_000).toISOString());
            }
            const { count } = await q;
            out.set(accion, count ?? 0);
        }),
    );
    return out;
}

async function fetchEvents(
    days: number,
    lineaFilter: string | undefined,
    acciones: string[] | null,
): Promise<RawEvent[]> {
    if (!supabase) return [];

    let countQ = supabase.from("query_events").select("*", { count: "exact", head: true });
    if (acciones?.length === 1) countQ = countQ.eq("accion", acciones[0]!);
    else if (acciones && acciones.length > 1) countQ = countQ.in("accion", acciones);
    if (days > 0) countQ = countQ.gte("ts", new Date(Date.now() - days * 86_400_000).toISOString());
    if (lineaFilter) countQ = countQ.eq("linea", lineaFilter);

    const { count, error: countErr } = await countQ;
    if (countErr) {
        console.error("[analytics] count error:", countErr.message);
        return [];
    }
    if (!count) return [];

    const select = schemaExtended
        ? "ts, accion, codigo_parada, linea, ramal, client_hash, cache_status, duration_ms"
        : "ts, accion, codigo_parada, linea";

    // ORDER BY estable: sin orden, .range() puede repetir/omitir filas entre páginas
    const pages = Math.ceil(count / PAGE_SIZE);
    const results = await Promise.all(
        Array.from({ length: pages }, (_, i) => {
            let q = supabase!.from("query_events").select(select).order("ts", { ascending: true });
            if (acciones?.length === 1) q = q.eq("accion", acciones[0]!);
            else if (acciones && acciones.length > 1) q = q.in("accion", acciones);
            if (days > 0) q = q.gte("ts", new Date(Date.now() - days * 86_400_000).toISOString());
            if (lineaFilter) q = q.eq("linea", lineaFilter);
            const from = i * PAGE_SIZE;
            return q.range(from, from + PAGE_SIZE - 1);
        }),
    );

    const all: RawEvent[] = [];
    for (const r of results) {
        if (r.error) {
            // fallback si select extendido falla
            if (schemaExtended && r.error.message.includes("column")) {
                schemaExtended = false;
            }
            console.error("[analytics] page error:", r.error.message);
            continue;
        }
        if (r.data?.length) all.push(...(r.data as unknown as RawEvent[]));
    }
    return all;
}

async function loadAllParadaGeo(): Promise<Map<string, GeoRow>> {
    if (!supabase) return new Map();
    if (geoCache && Date.now() - geoCache.at < GEO_CACHE_TTL_MS) return geoCache.byCodigo;

    const byCodigo = new Map<string, GeoRow>();
    let from = 0;
    while (true) {
        const { data, error } = await supabase
            .from("parada_geo")
            .select("codigo, nombre, lat, lng")
            .range(from, from + PAGE_SIZE - 1);
        if (error || !data?.length) break;
        for (const g of data) {
            const codigo = g.codigo as string;
            const canon = normalizeParadaId(codigo) ?? codigo;
            const geoName = (g.nombre as string | null) ?? null;
            const staticName = paradaDisplayName(canon);
            const nombre =
                geoName && geoName !== codigo && geoName !== canon
                    ? geoName
                    : staticName;
            const row: GeoRow = { codigo: canon, nombre, lat: g.lat as number, lng: g.lng as number };
            byCodigo.set(codigo, row);
            byCodigo.set(canon, row);
        }
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }
    geoCache = { at: Date.now(), byCodigo };
    return byCodigo;
}

function aggregateArribos(data: RawEvent[]) {
    const paradaCounts = new Map<string, { count: number; lineas: Map<string, number>; byHour: number[] }>();
    const lineaCounts = new Map<string, number>();
    const heatmap = new Map<string, number>();
    const clientSet = new Set<string>();
    const cacheMix = { hit: 0, miss: 0, stale: 0, unknown: 0 };
    const durations: number[] = [];
    const ramales = new Map<string, number>();

    for (const row of data) {
        if (row.accion && row.accion !== PRODUCT_ACCION) continue;

        const k = normalizeParadaId(row.codigo_parada);
        const l = row.linea?.trim() || null;
        const { hour, dow } = row.ts ? partsInAR(row.ts) : { hour: 0, dow: 0 };
        heatmap.set(`${hour}:${dow}`, (heatmap.get(`${hour}:${dow}`) ?? 0) + 1);

        if (k) {
            let info = paradaCounts.get(k);
            if (!info) {
                info = { count: 0, lineas: new Map(), byHour: Array(24).fill(0) };
                paradaCounts.set(k, info);
            }
            info.count++;
            info.byHour[hour] = (info.byHour[hour] ?? 0) + 1;
            if (l) info.lineas.set(l, (info.lineas.get(l) ?? 0) + 1);
        }
        if (l) lineaCounts.set(l, (lineaCounts.get(l) ?? 0) + 1);

        if (row.client_hash) clientSet.add(row.client_hash);
        const cs = (row.cache_status ?? "").toUpperCase();
        if (cs === "HIT") cacheMix.hit++;
        else if (cs === "MISS") cacheMix.miss++;
        else if (cs === "STALE") cacheMix.stale++;
        else cacheMix.unknown++;

        if (typeof row.duration_ms === "number") durations.push(row.duration_ms);
        if (row.ramal && l) {
            const rk = `${l} · ${row.ramal}`;
            ramales.set(rk, (ramales.get(rk) ?? 0) + 1);
        }
    }

    const topParadas: TopItem[] = [...paradaCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([key, info]) => ({
            key,
            count: info.count,
            lineas: [...info.lineas.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([linea, count]) => ({ linea, count })),
            nombre: paradaDisplayName(key),
        }));

    const topLineas: TopItem[] = [...lineaCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({ key, count, linea: key }));

    const heat: HeatmapCell[] = [...heatmap.entries()].map(([key, count]) => {
        const [hour, dow] = key.split(":").map(Number);
        return { hour: hour!, dow: dow!, count };
    });

    return {
        topParadas,
        topLineas,
        heatmap: heat,
        paradaByHour: paradaCounts,
        clientSet,
        cacheMix,
        durations,
        ramales,
        total: data.filter((r) => !r.accion || r.accion === PRODUCT_ACCION).length,
    };
}

function changePct(curr: number, prev: number): number | null {
    if (prev <= 0) return curr > 0 ? 100 : null;
    return Math.round(((curr - prev) / prev) * 1000) / 10;
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
    if (error) console.error("[analytics] Error parada_geo:", error.message);
    else {
        geoCache = null;
        console.log(`[analytics] ${rows.length} coords guardadas`);
    }
}

export async function getAnalyticsSnapshot(days = 0, lineaFilter?: string): Promise<AnalyticsSnapshot> {
    const empty = (extra: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot => ({
        totalEvents: 0,
        prevTotalEvents: 0,
        changePct: null,
        topParadas: [],
        topLineas: [],
        emergingLineas: [],
        orphanParadas: [],
        heatmap: [],
        paradaGeo: [],
        funnel: FUNNEL_STEPS.map((s) => ({ key: s.key, label: s.label, count: 0 })),
        uniques: { clientsApprox: 0, note: "Sin datos de cliente aún" },
        cacheMix: { hit: 0, miss: 0, stale: 0, unknown: 0 },
        latency: { p50: null, p95: null, samples: 0 },
        topRamales: [],
        bufferSize: buffer.length,
        supabaseConnected: !!supabase,
        metric: PRODUCT_ACCION,
        note: "Demanda de arribos + funnel (dedupe 3min por cliente)",
        uniqueParadas: 0,
        uniqueLineas: 0,
        geoCoverage: 0,
        durationMs: 0,
        cached: false,
        schemaExtended: !!schemaExtended,
        tz: TZ,
        ...extra,
    });

    if (!supabase) return empty({ supabaseConnected: false });

    const cacheKey = `${days}|${lineaFilter ?? ""}|v2`;
    const hit = snapshotCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SNAPSHOT_CACHE_TTL_MS) {
        return { ...hit.data, bufferSize: buffer.length, cached: true, durationMs: 0 };
    }

    const t0 = Date.now();
    await probeSchema();

    // Una sola ventana de arribos (2 períodos) + funnel en paralelo
    const windowDays = days > 0 ? days : 30;
    const windowMs = windowDays * 86_400_000;
    const fetchDays = days > 0 ? days * 2 : 60;
    const allAcciones = [...TRACKED_ACCIONES];

    const [arribosRaw, funnelCounts, geoMap] = await Promise.all([
        fetchEvents(fetchDays, lineaFilter, [PRODUCT_ACCION]),
        countAcciones(windowDays, allAcciones),
        loadAllParadaGeo(),
    ]);

    const cutoffCurr = Date.now() - windowMs;
    const cutoffPrev = cutoffCurr - windowMs;
    const currRaw = arribosRaw.filter((r) => {
        if (!r.ts) return days === 0; // sin ts: solo en "todo"
        const t = new Date(r.ts).getTime();
        return days > 0 ? t >= cutoffCurr : true;
    });
    // Si days=0 ("todo"), comparación vs últimos 30d previos al tramo actual de 30d
    const currForCompare =
        days > 0
            ? currRaw
            : arribosRaw.filter((r) => r.ts && new Date(r.ts).getTime() >= cutoffCurr);
    const prevOnly = arribosRaw.filter((r) => {
        if (!r.ts) return false;
        const t = new Date(r.ts).getTime();
        return t >= cutoffPrev && t < cutoffCurr;
    });

    const curr = aggregateArribos(days > 0 ? currRaw : arribosRaw);
    const prev = aggregateArribos(prevOnly);
    const currCompare = days > 0 ? curr : aggregateArribos(currForCompare);

    // change % on tops (período comparable)
    const prevParadaMap = new Map(prev.topParadas.map((p) => [p.key, p.count]));
    const prevLineaMap = new Map(prev.topLineas.map((p) => [p.key, p.count]));
    const compareCounts = days > 0 ? curr : currCompare;
    const cmpParadaMap = new Map(compareCounts.topParadas.map((p) => [p.key, p.count]));
    const cmpLineaMap = new Map(compareCounts.topLineas.map((p) => [p.key, p.count]));

    const topParadas = curr.topParadas.slice(0, 500).map((p) => {
        const cmp = cmpParadaMap.get(p.key) ?? p.count;
        return {
            ...p,
            nombre: p.nombre ?? paradaDisplayName(p.key) ?? geoMap.get(p.key)?.nombre ?? null,
            changePct: changePct(days > 0 ? p.count : cmp, prevParadaMap.get(p.key) ?? 0),
        };
    });

    const topLineas = curr.topLineas.slice(0, 50).map((p) => {
        const cmp = cmpLineaMap.get(p.key) ?? p.count;
        return {
            ...p,
            changePct: changePct(days > 0 ? p.count : cmp, prevLineaMap.get(p.key) ?? 0),
        };
    });

    // Emerging: growth real (no 100% por prev=0 con poca historia)
    const emergingLineas = topLineas
        .filter((l) => (l.changePct ?? 0) >= 25 && l.count >= 10 && (prevLineaMap.get(l.key) ?? 0) > 0)
        .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
        .slice(0, 10);

    // Orphans: no geo
    const orphanParadas = topParadas
        .filter((p) => {
            const g = geoMap.get(p.key);
            return !g || !g.lat || !g.lng;
        })
        .slice(0, 30);

    // Funnel (counts en DB, sin bajar filas)
    const funnel = FUNNEL_STEPS.map((s) => ({
        key: s.key,
        label: s.label,
        count: s.acciones.reduce((n, a) => n + (funnelCounts.get(a) ?? 0), 0),
    }));

    // Geo points + byHour
    const seen = new Set<string>();
    const paradaGeo: ParadaGeoPoint[] = [];
    for (const p of topParadas) {
        const g = geoMap.get(p.key);
        if (!g?.lat || !g?.lng) continue;
        if (seen.has(g.codigo)) continue;
        seen.add(g.codigo);
        const hourInfo = curr.paradaByHour.get(p.key);
        paradaGeo.push({
            codigo: g.codigo,
            nombre: p.nombre ?? g.nombre,
            lat: g.lat,
            lng: g.lng,
            count: p.count,
            lineas: p.lineas ?? [],
            byHour: hourInfo?.byHour ?? Array(24).fill(0),
        });
    }

    // Uniques: prefer DB client_hash, fallback local store
    const dbClients = curr.clientSet.size;
    const localClients = clientsInDays(days > 0 ? days : 30);
    const clientsApprox = Math.max(dbClients, localClients);

    // Cache / latency: merge DB + local
    const cacheMix = {
        hit: curr.cacheMix.hit + (schemaExtended ? 0 : local.cache.hit),
        miss: curr.cacheMix.miss + (schemaExtended ? 0 : local.cache.miss),
        stale: curr.cacheMix.stale + (schemaExtended ? 0 : local.cache.stale),
        unknown: curr.cacheMix.unknown + (schemaExtended ? 0 : local.cache.unknown),
    };
    // if DB has real cache data, prefer pure curr
    const cacheTotal = curr.cacheMix.hit + curr.cacheMix.miss + curr.cacheMix.stale;
    const finalCache = cacheTotal > 0 ? curr.cacheMix : local.cache;

    const durSrc =
        curr.durations.length > 0 ? [...curr.durations].sort((a, b) => a - b) : [...local.durations].sort((a, b) => a - b);

    const ramalSrc =
        curr.ramales.size > 0
            ? [...curr.ramales.entries()]
            : Object.entries(local.ramales);
    const topRamales = ramalSrc
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([key, count]) => ({ key, count }));

    const totalEvents = days > 0 ? currRaw.length : curr.total || arribosRaw.length;
    const prevTotalEvents = prev.total;
    const totalForDelta = days > 0 ? totalEvents : currCompare.total;
    const durationMs = Date.now() - t0;

    const data: AnalyticsSnapshot = {
        totalEvents,
        prevTotalEvents,
        changePct: changePct(totalForDelta, prevTotalEvents),
        topParadas,
        topLineas,
        emergingLineas,
        orphanParadas,
        heatmap: curr.heatmap,
        paradaGeo,
        funnel,
        uniques: {
            clientsApprox,
            note: dbClients > 0
                ? "Clientes únicos (hash) en el período"
                : localClients > 0
                  ? "Aprox. desde store local del proxy (post-deploy)"
                  : "Aún sin client_id/hash — el app puede mandar X-Client-Id",
        },
        cacheMix: finalCache,
        latency: {
            p50: percentile(durSrc, 50),
            p95: percentile(durSrc, 95),
            samples: durSrc.length,
        },
        topRamales,
        bufferSize: buffer.length,
        supabaseConnected: true,
        metric: PRODUCT_ACCION,
        note: "Arribos con dedupe 3min · funnel · comparación vs período anterior · TZ " + TZ,
        uniqueParadas: topParadas.length,
        uniqueLineas: topLineas.length,
        geoCoverage: topParadas.length > 0 ? Math.round((paradaGeo.length / Math.min(topParadas.length, 500)) * 100) : 0,
        durationMs,
        cached: false,
        schemaExtended: !!schemaExtended,
        tz: TZ,
    };

    // fix geoCoverage denom
    data.geoCoverage =
        topParadas.length > 0 ? Math.round((paradaGeo.length / topParadas.length) * 100) : 0;

    snapshotCache.set(cacheKey, { at: Date.now(), data });
    console.log(`[analytics] snapshot days=${days} in ${durationMs}ms (events=${totalEvents})`);
    return data;
}

export { flushBuffer as flushAnalyticsBuffer };
