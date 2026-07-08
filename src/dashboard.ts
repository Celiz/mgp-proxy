/**
 * Dashboard HTML embebido para /stats.
 * Se exporta como string para servir directamente desde Hono.
 * Auto-refresh cada 5 segundos vía fetch a /stats/data.
 */
export const dashboardHtml = /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bondi Proxy — Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

  :root {
    --bg: #0b0e14;
    --surface: rgba(255,255,255,0.04);
    --surface-hover: rgba(255,255,255,0.07);
    --border: rgba(255,255,255,0.06);
    --text: #e4e8f1;
    --text-dim: #6b7280;
    --accent: #818cf8;
    --accent-glow: rgba(129,140,248,0.25);
    --green: #34d399;
    --green-dim: rgba(52,211,153,0.15);
    --red: #f87171;
    --red-dim: rgba(248,113,113,0.15);
    --yellow: #fbbf24;
    --yellow-dim: rgba(251,191,36,0.15);
    --cyan: #22d3ee;
    --radius: 16px;
    --radius-sm: 10px;
  }

  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  /* Subtle animated gradient background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 80% 60% at 20% 10%, rgba(129,140,248,0.08) 0%, transparent 60%),
      radial-gradient(ellipse 60% 50% at 80% 80%, rgba(52,211,153,0.06) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }

  .container {
    position: relative;
    z-index: 1;
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 20px 48px;
  }

  /* Header */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 32px;
    flex-wrap: wrap;
    gap: 12px;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .logo-icon {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    box-shadow: 0 0 20px var(--accent-glow);
  }

  .logo h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }

  .logo h1 span { color: var(--text-dim); font-weight: 500; }

  .header-meta {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 13px;
    color: var(--text-dim);
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 8px var(--green);
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
  }

  /* Grid */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .grid-2 {
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    backdrop-filter: blur(12px);
    transition: background 0.2s, border-color 0.2s;
  }

  .card:hover {
    background: var(--surface-hover);
    border-color: rgba(255,255,255,0.1);
  }

  .card-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .card-title .icon { font-size: 14px; }

  .big-number {
    font-size: 36px;
    font-weight: 800;
    letter-spacing: -1.5px;
    line-height: 1;
    margin-bottom: 4px;
  }

  .big-label {
    font-size: 12px;
    color: var(--text-dim);
  }

  .color-green { color: var(--green); }
  .color-red { color: var(--red); }
  .color-yellow { color: var(--yellow); }
  .color-accent { color: var(--accent); }
  .color-cyan { color: var(--cyan); }

  /* Stat rows */
  .stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }

  .stat-row:last-child { border-bottom: none; }

  .stat-key {
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .stat-val {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* Badge */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 99px;
    font-size: 12px;
    font-weight: 600;
  }

  .badge-green { background: var(--green-dim); color: var(--green); }
  .badge-red { background: var(--red-dim); color: var(--red); }
  .badge-yellow { background: var(--yellow-dim); color: var(--yellow); }

  /* Bar chart */
  .bar-chart { margin-top: 8px; }

  .bar-item {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    font-size: 13px;
  }

  .bar-label {
    min-width: 150px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-dim);
    font-family: 'Inter', monospace;
    font-size: 12px;
  }

  .bar-track {
    flex: 1;
    height: 6px;
    background: rgba(255,255,255,0.05);
    border-radius: 3px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--accent), #a78bfa);
    transition: width 0.5s ease;
  }

  .bar-count {
    min-width: 36px;
    text-align: right;
    font-weight: 600;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  /* Progress ring for cache */
  .ring-container {
    display: flex;
    align-items: center;
    gap: 24px;
    margin-top: 8px;
  }

  .ring-svg {
    width: 80px;
    height: 80px;
    transform: rotate(-90deg);
  }

  .ring-bg {
    fill: none;
    stroke: rgba(255,255,255,0.06);
    stroke-width: 6;
  }

  .ring-fg {
    fill: none;
    stroke-width: 6;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.6s ease;
  }

  .ring-legend {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ring-legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  .ring-dot {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }

  /* Error log */
  .error-list { max-height: 300px; overflow-y: auto; }

  .error-item {
    padding: 10px 12px;
    margin-bottom: 6px;
    background: rgba(248,113,113,0.05);
    border: 1px solid rgba(248,113,113,0.1);
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-family: 'Inter', monospace;
  }

  .error-item .error-time {
    color: var(--text-dim);
    margin-bottom: 2px;
  }

  .error-item .error-path {
    color: var(--yellow);
    font-weight: 600;
  }

  .error-item .error-msg {
    color: var(--red);
    word-break: break-all;
  }

  /* Recent requests */
  .req-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .req-table th {
    text-align: left;
    padding: 8px 10px;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border);
  }

  .req-table td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }

  .req-table tr:hover td { background: rgba(255,255,255,0.02); }

  .status-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 99px;
    font-weight: 600;
    font-size: 11px;
  }

  .status-2xx { background: var(--green-dim); color: var(--green); }
  .status-3xx { background: var(--yellow-dim); color: var(--yellow); }
  .status-4xx { background: var(--red-dim); color: var(--red); }
  .status-5xx { background: rgba(239,68,68,0.2); color: #ef4444; }

  .duration-bar {
    display: inline-block;
    height: 4px;
    border-radius: 2px;
    background: var(--accent);
    min-width: 2px;
    vertical-align: middle;
    margin-right: 6px;
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

  .empty-state {
    text-align: center;
    padding: 24px;
    color: var(--text-dim);
    font-size: 13px;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .container { padding: 16px 12px 32px; }
    .grid { grid-template-columns: 1fr; }
    .grid-2 { grid-template-columns: 1fr; }
    .big-number { font-size: 28px; }
    header { margin-bottom: 20px; }
    .bar-label { min-width: 100px; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">
      <div class="logo-icon">🚌</div>
      <h1>Bondi Proxy <span>— dashboard</span></h1>
    </div>
    <div class="header-meta">
      <a href="/stats/analytics" style="color:var(--accent);text-decoration:none;font-weight:600;font-size:13px;opacity:0.85;transition:opacity 0.2s" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.85'">📊 Analytics</a>
      <span>·</span>
      <div class="live-dot"></div>
      <span id="uptime">—</span>
      <span>·</span>
      <span id="refreshed">—</span>
    </div>
  </header>

  <!-- Row 1: Key metrics -->
  <div class="grid" id="top-cards">
    <div class="card">
      <div class="card-title"><span class="icon">📊</span> Total requests</div>
      <div class="big-number" id="m-total">—</div>
      <div class="big-label" id="m-rps">— req/min últimos 60s</div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🔗</span> MGP upstream</div>
      <div class="big-number color-green" id="m-mgp-ok">—</div>
      <div class="big-label" id="m-mgp-err">— errores</div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">⚡</span> Circuit breaker</div>
      <div id="m-breaker">—</div>
      <div class="big-label" id="m-breaker-info">—</div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">💾</span> Memoria</div>
      <div class="big-number color-cyan" id="m-mem">—</div>
      <div class="big-label" id="m-mem-detail">—</div>
    </div>
  </div>

  <!-- Row 2: Cache + Traffic windows -->
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title"><span class="icon">🗄️</span> Cache</div>
      <div class="ring-container" id="cache-ring">
        <!-- filled by JS -->
      </div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">📈</span> Tráfico</div>
      <div id="traffic-windows">
        <div class="stat-row"><span class="stat-key">Último 1 min</span><span class="stat-val" id="tw-1m">—</span></div>
        <div class="stat-row"><span class="stat-key">Últimos 5 min</span><span class="stat-val" id="tw-5m">—</span></div>
        <div class="stat-row"><span class="stat-key">Últimos 15 min</span><span class="stat-val" id="tw-15m">—</span></div>
        <div class="stat-row"><span class="stat-key">MGP tasa éxito</span><span class="stat-val" id="tw-mgp-rate">—</span></div>
        <div class="stat-row"><span class="stat-key">Rate limited (429)</span><span class="stat-val" id="tw-429">—</span></div>
        <div class="stat-row"><span class="stat-key">Tokens disponibles</span><span class="stat-val" id="tw-tokens">—</span></div>
      </div>
    </div>
  </div>

  <!-- Row 3: Top acciones + Top paths -->
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title"><span class="icon">🎯</span> Top acciones</div>
      <div class="bar-chart" id="top-acciones"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🛤️</span> Top paths</div>
      <div class="bar-chart" id="top-paths"></div>
    </div>
  </div>

  <!-- Row 3b: Top paradas -->
  <div class="card" style="margin-bottom:24px">
    <div class="card-title"><span class="icon">📍</span> Top paradas consultadas</div>
    <div class="bar-chart" id="top-paradas"></div>
  </div>

  <!-- Row 4: Errors -->
  <div class="card" style="margin-bottom:24px">
    <div class="card-title"><span class="icon">🚨</span> Últimos errores</div>
    <div class="error-list" id="error-list">
      <div class="empty-state">Sin errores 🎉</div>
    </div>
  </div>

  <!-- Row 5: Recent requests -->
  <div class="card">
    <div class="card-title"><span class="icon">📋</span> Últimos requests</div>
    <div style="overflow-x:auto">
      <table class="req-table">
        <thead>
          <tr>
            <th>Hora</th>
            <th>Método</th>
            <th>Path</th>
            <th>Status</th>
            <th>Duración</th>
          </tr>
        </thead>
        <tbody id="req-tbody">
          <tr><td colspan="5" class="empty-state">Sin requests aún</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<script>
const CIRC = 2 * Math.PI * 34;

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  parts.push(s + 's');
  return parts.join(' ');
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('es-AR', { hour12: false });
}

function fmtTimeAgo(ts) {
  if (!ts) return '';
  const ago = Math.round((Date.now() - ts) / 1000);
  if (ago < 60) return 'hace ' + ago + 's';
  if (ago < 3600) return 'hace ' + Math.floor(ago / 60) + 'm';
  return 'hace ' + Math.floor(ago / 3600) + 'h';
}

function statusClass(s) {
  if (s < 300) return 'status-2xx';
  if (s < 400) return 'status-3xx';
  if (s < 500) return 'status-4xx';
  return 'status-5xx';
}

function renderBars(containerId, items, maxVal) {
  const el = document.getElementById(containerId);
  if (!items || !items.length) { el.innerHTML = '<div class="empty-state">Sin datos</div>'; return; }
  const mx = maxVal || Math.max(...items.map(i => i.count));
  el.innerHTML = items.map(i => {
    const pct = mx > 0 ? (i.count / mx) * 100 : 0;
    return '<div class="bar-item">' +
      '<span class="bar-label" title="' + i.key + '">' + i.key + '</span>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="bar-count">' + i.count.toLocaleString() + '</span>' +
    '</div>';
  }).join('');
}

function renderCacheRing(hit, miss, stale) {
  const total = hit + miss + stale;
  const hitPct = total > 0 ? (hit / total * 100).toFixed(1) : 0;
  const hitRatio = total > 0 ? hit / total : 0;
  const missRatio = total > 0 ? miss / total : 0;

  const hitOffset = CIRC * (1 - hitRatio);
  const missOffset = CIRC * (1 - missRatio);

  document.getElementById('cache-ring').innerHTML =
    '<svg class="ring-svg" viewBox="0 0 80 80">' +
      '<circle class="ring-bg" cx="40" cy="40" r="34"/>' +
      '<circle class="ring-fg" cx="40" cy="40" r="34" stroke="#34d399" stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + hitOffset + '"/>' +
    '</svg>' +
    '<div class="ring-legend">' +
      '<div style="font-size:24px;font-weight:800;letter-spacing:-1px">' + hitPct + '% <span style="font-size:13px;font-weight:500;color:var(--text-dim)">hit rate</span></div>' +
      '<div class="ring-legend-item"><div class="ring-dot" style="background:var(--green)"></div>HIT <span class="stat-val">' + hit.toLocaleString() + '</span></div>' +
      '<div class="ring-legend-item"><div class="ring-dot" style="background:var(--accent)"></div>MISS <span class="stat-val">' + miss.toLocaleString() + '</span></div>' +
      '<div class="ring-legend-item"><div class="ring-dot" style="background:var(--yellow)"></div>STALE <span class="stat-val">' + stale.toLocaleString() + '</span></div>' +
    '</div>';
}

function renderErrors(errors) {
  const el = document.getElementById('error-list');
  if (!errors || !errors.length) { el.innerHTML = '<div class="empty-state">Sin errores 🎉</div>'; return; }
  el.innerHTML = errors.slice(0, 20).map(e =>
    '<div class="error-item">' +
      '<div class="error-time">' + fmtTime(e.at) + ' · ' + fmtTimeAgo(e.at) + '</div>' +
      '<div><span class="error-path">' + e.path + '</span> <span class="status-pill ' + statusClass(e.status) + '">' + e.status + '</span></div>' +
      (e.message ? '<div class="error-msg">' + e.message + '</div>' : '') +
    '</div>'
  ).join('');
}

function renderRequests(reqs) {
  const tbody = document.getElementById('req-tbody');
  if (!reqs || !reqs.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Sin requests aún</td></tr>'; return; }
  const maxDur = Math.max(...reqs.map(r => r.durationMs), 1);
  tbody.innerHTML = reqs.slice(0, 25).map(r => {
    const barW = Math.max(2, Math.min(60, (r.durationMs / maxDur) * 60));
    return '<tr>' +
      '<td style="color:var(--text-dim);white-space:nowrap">' + fmtTime(r.at) + '</td>' +
      '<td><strong>' + r.method + '</strong></td>' +
      '<td style="font-family:monospace;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + r.path + '">' + r.path + '</td>' +
      '<td><span class="status-pill ' + statusClass(r.status) + '">' + r.status + '</span></td>' +
      '<td style="white-space:nowrap"><span class="duration-bar" style="width:' + barW + 'px"></span>' + r.durationMs + 'ms</td>' +
    '</tr>';
  }).join('');
}

async function refresh() {
  try {
    const res = await fetch('/stats/data');
    const d = await res.json();

    // Uptime
    document.getElementById('uptime').textContent = '⏱ ' + formatUptime(d.uptimeSec);
    document.getElementById('refreshed').textContent = 'actualizado ' + new Date().toLocaleTimeString('es-AR', { hour12: false });

    // Top cards
    document.getElementById('m-total').textContent = d.requests.total.toLocaleString();
    document.getElementById('m-rps').textContent = d.requests.last1m.count + ' req · ' + d.requests.last1m.errors + ' err (último 1m)';

    document.getElementById('m-mgp-ok').textContent = d.mgp.ok.toLocaleString();
    const mgpErrTotal = d.mgp.rateLimited + d.mgp.otherErrors;
    document.getElementById('m-mgp-err').textContent = mgpErrTotal + ' errores · último ok ' + fmtTimeAgo(d.mgp.lastSuccessAt);

    // Breaker
    const bState = d.queue.breakerState;
    const bBadge = bState === 'closed'
      ? '<span class="badge badge-green">● CLOSED</span>'
      : bState === 'open'
        ? '<span class="badge badge-red">● OPEN</span>'
        : '<span class="badge badge-yellow">● HALF-OPEN</span>';
    document.getElementById('m-breaker').innerHTML = bBadge;
    const bInfo = bState === 'open'
      ? 'reabre ' + fmtTime(d.queue.breakerOpenUntil) + ' · errores: ' + d.queue.consecutiveErrors
      : 'errores consec: ' + d.queue.consecutiveErrors + ' · backoff: x' + d.queue.backoffMultiplier;
    document.getElementById('m-breaker-info').textContent = bInfo;

    // Memory
    const rss = d.memory.rss || 0;
    const heap = d.memory.heapUsed || 0;
    document.getElementById('m-mem').textContent = fmtBytes(rss);
    document.getElementById('m-mem-detail').textContent = 'heap: ' + fmtBytes(heap) + ' / ' + fmtBytes(d.memory.heapTotal || 0);

    // Cache ring
    renderCacheRing(d.cache.hit, d.cache.miss, d.cache.stale);

    // Traffic windows
    document.getElementById('tw-1m').textContent = d.requests.last1m.count + ' req / ' + d.requests.last1m.errors + ' err';
    document.getElementById('tw-5m').textContent = d.requests.last5m.count + ' req / ' + d.requests.last5m.errors + ' err';
    document.getElementById('tw-15m').textContent = d.requests.last15m.count + ' req / ' + d.requests.last15m.errors + ' err';
    const mgpRate = d.mgp.total > 0 ? ((d.mgp.ok / d.mgp.total) * 100).toFixed(1) + '%' : '—';
    document.getElementById('tw-mgp-rate').textContent = mgpRate;
    document.getElementById('tw-429').textContent = d.mgp.rateLimited.toLocaleString();
    document.getElementById('tw-tokens').textContent = d.queue.tokensAvailable + ' / ' + d.queue.rateBurst;

    // Bar charts
    renderBars('top-acciones', d.requests.topAcciones);
    renderBars('top-paths', d.requests.topPaths);
    renderBars('top-paradas', d.requests.topParadas);

    // Errors
    renderErrors(d.errors);

    // Recent requests
    renderRequests(d.recentRequests);

  } catch (e) {
    console.error('refresh failed:', e);
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
