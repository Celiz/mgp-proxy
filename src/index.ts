import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { enqueueMgp, getMgpQueueStats } from "./lib/mgpQueue.js";
import {
    recordAccion,
    recordCache,
    recordError,
    recordRequest,
    snapshot,
} from "./stats.js";
import { dashboardHtml } from "./dashboard.js";

// ── Global error handlers: el proceso NUNCA debe morir ──────────────────
process.on("uncaughtException", (err) => {
    console.error("[bondi-proxy] ⚠️  uncaughtException (proceso sigue vivo):", err);
});
process.on("unhandledRejection", (reason) => {
    console.error("[bondi-proxy] ⚠️  unhandledRejection (proceso sigue vivo):", reason);
});

// 1. Minimal environment for proxy-only mode (No DB required)
const envSchema = z.object({
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default("0.0.0.0"),
    MGP_RSA_PUBKEY: z.string().min(1, "Falta la llave pública de MGP"),
    MGP_SHARED_KEY: z.string().min(1, "Falta la llave compartida de MGP"),
    ALLOWED_ORIGINS: z
        .string()
        .optional()
        .transform((s) => (s ? s.split(",").map((o) => o.trim()).filter(Boolean) : [])),
});

const envParsed = envSchema.safeParse(process.env);
if (!envParsed.success) {
    console.error("❌ Variables de entorno inválidas para el proxy:");
    for (const issue of envParsed.error.issues) {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
}
const env = envParsed.data;

// 2. Setup Hono App
const app = new Hono();

app.use(logger());
app.use(secureHeaders());

app.use(async (c, next) => {
    const start = performance.now();
    await next();
    // No registrar requests internos del dashboard
    if (c.req.path.startsWith("/stats")) return;
    const durationMs = Math.round(performance.now() - start);
    recordRequest({
        at: Date.now(),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
        ip: c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for"),
        ua: c.req.header("user-agent"),
    });
});

app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next();
    const isAllowed = env.ALLOWED_ORIGINS.length === 0 || env.ALLOWED_ORIGINS.includes(origin);
    const corsMiddleware = cors({
        origin: isAllowed ? origin : "",
        credentials: true,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
    });
    return corsMiddleware(c, next);
});

// 3. Cache Setup
type CacheEntry = { at: number; payload: unknown; status: number };
const PROXY_CACHE_MAX = 5_000;
const proxyCache = new Map<string, CacheEntry>();

function proxyCacheSet(key: string, entry: CacheEntry): void {
    proxyCache.set(key, entry);
    if (proxyCache.size > PROXY_CACHE_MAX) {
        const overflow = proxyCache.size - PROXY_CACHE_MAX;
        let removed = 0;
        for (const k of proxyCache.keys()) {
            if (removed >= overflow) break;
            proxyCache.delete(k);
            removed++;
        }
    }
}

function normalizeKey(body: string): string {
    return new URLSearchParams(body).toString();
}

async function readProxyBody(c: import("hono").Context): Promise<string | null> {
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    if (ct.includes("application/x-www-form-urlencoded")) {
        return c.req.text();
    }
    if (ct.includes("multipart/form-data")) {
        const fd = await c.req.formData();
        const params = new URLSearchParams();
        for (const [k, v] of fd.entries()) {
            if (typeof v === "string") params.append(k, v);
        }
        return params.toString();
    }
    return null;
}

const SEMI_STATIC_ACCIONES = new Set([
    "RecuperarLineasW",
    "RecuperarBanderasW",
    "RecuperarBanderasAsociadasAParada",
    "RecuperarParadasBanderasW",
]);

function getTtls(accion: string): { fresh: number; stale: number } {
    if (SEMI_STATIC_ACCIONES.has(accion)) {
        return { fresh: 86_400_000, stale: 604_800_000 };
    }
    return { fresh: 15_000, stale: 60_000 };
}

// 4. Proxy Endpoints
app.post("/", async (c) => {
    const body = await readProxyBody(c);
    if (body === null) {
        return c.json({ error: "unsupported_content_type", got: c.req.header("content-type") }, 415);
    }
    if (!body) return c.json({ error: "empty_body" }, 400);

    const key = normalizeKey(body);
    const now = Date.now();
    const cached = proxyCache.get(key);
    const accion = new URLSearchParams(body).get("accion") ?? "(desconocida)";
    const { fresh: freshTtl, stale: staleTtl } = getTtls(accion);
    recordAccion(accion);

    if (cached && now - cached.at < freshTtl) {
        recordCache("HIT");
        c.header("X-Cache", "HIT");
        return c.json(cached.payload as Record<string, unknown>);
    }

    try {
        const data = await enqueueMgp(body, { priority: "high" });
        proxyCacheSet(key, { at: now, payload: data, status: 200 });
        recordCache("MISS");
        c.header("X-Cache", "MISS");
        return c.json(data as Record<string, unknown>);
    } catch (e) {
        const message = (e as Error).message;
        if (cached && now - cached.at < staleTtl) {
            recordCache("STALE");
            c.header("X-Cache", "STALE");
            c.header("X-Stale-Reason", message.slice(0, 120));
            return c.json(cached.payload as Record<string, unknown>);
        }
        recordError("POST /", 502, message);
        return c.json({ error: "mgp_unavailable", message }, 502);
    }
});

app.get("/mgp/:accion", async (c) => {
    const accion = c.req.param("accion");
    const params: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams.entries()) {
        params[k] = v;
    }
    const body = new URLSearchParams({ accion, ...params }).toString();
    const key = body;
    const now = Date.now();
    const cached = proxyCache.get(key);
    const { fresh: freshTtl, stale: staleTtl } = getTtls(accion);
    const isSemiStatic = SEMI_STATIC_ACCIONES.has(accion);
    const sMaxAge = isSemiStatic ? 21_600 : 30;
    const browserMaxAge = isSemiStatic ? 3_600 : 15;
    recordAccion(accion);

    c.header("Access-Control-Allow-Origin", "*");

    if (cached && now - cached.at < freshTtl) {
        recordCache("HIT");
        c.header("X-Cache", "HIT");
        c.header("Cache-Control", `public, max-age=${browserMaxAge}, s-maxage=${sMaxAge}`);
        return c.json(cached.payload as Record<string, unknown>);
    }

    try {
        const data = await enqueueMgp(body, { priority: "high" });
        proxyCacheSet(key, { at: now, payload: data, status: 200 });
        recordCache("MISS");
        c.header("X-Cache", "MISS");
        c.header("Cache-Control", `public, max-age=${browserMaxAge}, s-maxage=${sMaxAge}`);
        return c.json(data as Record<string, unknown>);
    } catch (e) {
        const message = (e as Error).message;
        if (cached && now - cached.at < staleTtl) {
            recordCache("STALE");
            c.header("X-Cache", "STALE");
            c.header("X-Stale-Reason", message.slice(0, 120));
            c.header("Cache-Control", `public, max-age=${browserMaxAge}, s-maxage=${sMaxAge}`);
            return c.json(cached.payload as Record<string, unknown>);
        }
        recordError(`GET /mgp/${accion}`, 502, message);
        return c.json({ error: "mgp_unavailable", message }, 502);
    }
});

// 5. Stats Dashboard + API
app.get("/stats", (c) => {
    return c.html(dashboardHtml);
});

app.get("/stats/data", (c) => {
    return c.json({ ...snapshot(), queue: getMgpQueueStats() });
});

// 6. Start Server
console.log(`[bondi-proxy] Iniciando en puerto ${env.PORT} con Node.js 🚀`);
serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST });
