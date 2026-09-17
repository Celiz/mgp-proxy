import { createServer } from "node:http";
import { publicEncrypt, constants, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4000);
const APP_BASE = "https://appsl.mardelplata.gob.ar/apps/app_cuando_llegaV670";
const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.231205.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "X-Requested-With": "ar.gob.mardelplata.cuandollega",
  "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
};
const PUB = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA80+5G8FVXDbfJG97ApvPlz2nc8n+
fHTcpL4hvksmjGeRqHFXDmJOw0/B4bHsVFe/2L1dA4ZjbgxG1NufQRtVuE2NMTe3P3XbKONW
Qsbx0+LgyM1XgOJ1nccOJB7CYy+S4kd4fsAryDBppCV61HXQxdY7Qrt/l9A4b7V73zAD3mOf
IWhkAuL62si7dQQ9pLljFuMdm0H3Gxg5ynyeaWNxXYl+4BxFr2hrxKK9/KlIODO3C/yCMjdf
SktsmuKfU0NAIL/Y4QCUMRnYw0A2/BL5Q/zwt8qTWZDxRx8qUuTw8NLRTVcjiubRKeZkwrUf
cyHpRwqDOoqFSaLKIMMA6Tq1EwIDAQAB
-----END PUBLIC KEY-----`;
const SHARED = "c43fkd$dkfa!djc34";
const REAUTH_MS = 100_000;

let session = null;
let pending = null;

function extractCookie(setCookies, name) {
  const re = new RegExp(`${name}=([^;]+)`);
  for (const c of setCookies) {
    const m = c.match(re);
    if (m) return m[1];
  }
}

async function authenticate() {
  // Get PHPSESSID via appWS (bootstrap / often has no Set-Cookie)
  const boot = await fetch(`${APP_BASE}/appWS.php`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: "accion=_",
    redirect: "manual",
  });
  const setCookies = boot.headers.getSetCookie?.() ?? [];
  const phpsessid = extractCookie(setCookies, "PHPSESSID");
  if (!phpsessid) throw new Error("no PHPSESSID");
  const epoch = Math.floor(Date.now() / 1000);
  const token = publicEncrypt(
    { key: PUB, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(`9!1;${epoch};${phpsessid};#95`),
  ).toString("base64");
  const reg = await fetch(`${APP_BASE}/registro.php`, {
    method: "POST",
    headers: {
      ...HEADERS,
      Cookie: `PHPSESSID=${phpsessid}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${APP_BASE}/`,
    },
    body: new URLSearchParams({
      dispositivo: "Android:Pixel 8:14",
      uuid: randomUUID(),
      token,
      clave: SHARED,
    }),
  });
  if (!reg.ok) throw new Error(`registro ${reg.status}`);
  return { phpsessid, authedAt: Date.now() };
}

async function getSession() {
  if (session && Date.now() - session.authedAt < REAUTH_MS) return session;
  if (pending) return pending;
  pending = authenticate()
    .then((s) => {
      session = s;
      return s;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

async function callAppWS(body) {
  let s = await getSession();
  const doCall = async (sess) => {
    const res = await fetch(`${APP_BASE}/appWS.php`, {
      method: "POST",
      headers: {
        ...HEADERS,
        Cookie: `PHPSESSID=${sess.phpsessid}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${APP_BASE}/`,
      },
      body,
    });
    const text = await res.text();
    return { status: res.status, text };
  };
  let { status, text } = await doCall(s);
  if (status === 429 || status === 503) {
    const err = new Error(`mgp_${status}`);
    err.status = status;
    throw err;
  }
  const unauth =
    !text.trim() ||
    text.trimStart().startsWith("<") ||
    status >= 400 ||
    (() => {
      try {
        return JSON.parse(text).CodigoEstado === -211;
      } catch {
        return false;
      }
    })();
  if (unauth) {
    session = null;
    s = await getSession();
    ({ status, text } = await doCall(s));
  }
  if (status >= 400) throw new Error(`appWS ${status}`);
  return JSON.parse(text);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/health" || url.pathname === "/") {
      return sendJson(res, 200, { ok: true, transport: "v670", ts: new Date().toISOString() });
    }
    // GET /mgp/:accion?...
    const mgpMatch = url.pathname.match(/^\/mgp\/([^/]+)\/?$/);
    if (req.method === "GET" && mgpMatch) {
      const params = new URLSearchParams(url.search);
      params.set("accion", decodeURIComponent(mgpMatch[1]));
      const data = await callAppWS(params.toString());
      return sendJson(res, 200, data);
    }
    // POST / with form body
    if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/mgp")) {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: "empty_body" });
      const data = await callAppWS(body);
      return sendJson(res, 200, data);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("[proxy]", e.message);
    sendJson(res, 502, { error: "mgp_unavailable", message: e.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[bondi-v670-proxy] http://0.0.0.0:${PORT}`);
});
