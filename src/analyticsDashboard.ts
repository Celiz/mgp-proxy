/**
 * Dashboard de Analytics — mapa de calor geográfico + temporal + rankings.
 * Servido en /stats/analytics. Datos via /stats/analytics/data.
 */
export const analyticsDashboardHtml = /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bondi Proxy — Analytics</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"><\/script>
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
    --orange: #fb923c;
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

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 80% 60% at 20% 10%, rgba(129,140,248,0.08) 0%, transparent 60%),
      radial-gradient(ellipse 60% 50% at 80% 80%, rgba(251,191,36,0.06) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
  }

  .container {
    position: relative;
    z-index: 1;
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 20px 48px;
  }

  /* Header */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
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
    background: linear-gradient(135deg, var(--orange), var(--yellow));
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    box-shadow: 0 0 20px rgba(251,191,36,0.25);
  }

  .logo h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }
  .logo h1 span { color: var(--text-dim); font-weight: 500; }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .back-link {
    color: var(--accent);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    opacity: 0.8;
    transition: opacity 0.2s;
  }
  .back-link:hover { opacity: 1; }

  /* Filter pills */
  .filter-pills {
    display: flex;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px;
  }

  .pill {
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    background: transparent;
    color: var(--text-dim);
    transition: all 0.2s;
  }

  .pill:hover { color: var(--text); background: rgba(255,255,255,0.05); }
  .pill.active { color: var(--text); background: rgba(129,140,248,0.2); }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    backdrop-filter: blur(12px);
    transition: background 0.2s, border-color 0.2s;
    margin-bottom: 20px;
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
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .card-title .icon { font-size: 14px; }

  /* Grid layouts */
  .grid-2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 20px;
    margin-bottom: 20px;
  }
  .grid-2 .card { margin-bottom: 0; }

  .grid-4 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 20px;
  }
  .grid-4 .card { margin-bottom: 0; }

  .big-number {
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -1.5px;
    line-height: 1;
  }
  .big-label {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 4px;
  }

  .color-green { color: var(--green); }
  .color-accent { color: var(--accent); }
  .color-yellow { color: var(--yellow); }
  .color-cyan { color: var(--cyan); }
  .color-orange { color: var(--orange); }

  /* Map */
  #map {
    height: 420px;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .leaflet-container { background: #0d1117; }

  /* Heatmap grid */
  .heatmap-grid {
    display: grid;
    grid-template-columns: 40px repeat(7, 1fr);
    gap: 3px;
    font-size: 11px;
  }

  .heatmap-label {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    font-weight: 500;
    font-size: 10px;
  }

  .heatmap-cell {
    aspect-ratio: 1;
    border-radius: 4px;
    min-height: 16px;
    transition: background 0.3s;
    cursor: pointer;
    position: relative;
  }

  .heatmap-cell:hover { outline: 1px solid var(--text-dim); }

  .heatmap-header {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    padding: 4px 0;
  }

  .heatmap-tooltip {
    position: fixed;
    background: rgba(0,0,0,0.9);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 11px;
    pointer-events: none;
    z-index: 1000;
    display: none;
    white-space: nowrap;
  }

  /* Bar chart */
  .bar-chart { margin-top: 8px; }

  .bar-item {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    font-size: 13px;
  }

  .bar-rank {
    min-width: 24px;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-dim);
    text-align: center;
  }
  .bar-rank.top-3 { color: var(--yellow); }

  .bar-label {
    min-width: 120px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: 'Inter', monospace;
    font-size: 13px;
    font-weight: 500;
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
    transition: width 0.5s ease;
  }

  .bar-fill.parada { background: linear-gradient(90deg, var(--green), #6ee7b7); }
  .bar-fill.linea  { background: linear-gradient(90deg, var(--accent), #a78bfa); }

  .bar-count {
    min-width: 50px;
    text-align: right;
    font-weight: 600;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }

  .empty-state {
    text-align: center;
    padding: 32px;
    color: var(--text-dim);
    font-size: 13px;
  }

  .loading {
    text-align: center;
    padding: 40px;
    color: var(--text-dim);
  }

  .loading::after {
    content: '';
    display: inline-block;
    width: 18px;
    height: 18px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-left: 8px;
    vertical-align: middle;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

  /* Responsive */
  @media (max-width: 640px) {
    .container { padding: 16px 12px 32px; }
    .grid-2 { grid-template-columns: 1fr; }
    .grid-4 { grid-template-columns: repeat(2, 1fr); }
    #map { height: 300px; }
    .big-number { font-size: 24px; }
    .bar-label { min-width: 80px; }
    .heatmap-grid { gap: 2px; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">
      <div class="logo-icon">📊</div>
      <h1>Analytics <span>— paradas y líneas</span></h1>
    </div>
    <div class="header-controls">
      <a href="/stats" class="back-link">← Dashboard principal</a>
      <div class="filter-pills">
        <button class="pill" data-days="1">24h</button>
        <button class="pill" data-days="7">7 días</button>
        <button class="pill active" data-days="30">30 días</button>
        <button class="pill" data-days="0">Todo</button>
      </div>
    </div>
  </header>

  <!-- Summary cards -->
  <div class="grid-4" id="summary-cards">
    <div class="card">
      <div class="card-title"><span class="icon">📍</span> Total consultas</div>
      <div class="big-number color-accent" id="s-total">—</div>
      <div class="big-label">eventos registrados</div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🚏</span> Paradas únicas</div>
      <div class="big-number color-green" id="s-paradas">—</div>
      <div class="big-label">paradas distintas</div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🚌</span> Líneas únicas</div>
      <div class="big-number color-yellow" id="s-lineas">—</div>
      <div class="big-label">líneas distintas</div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🗺️</span> Con coordenadas</div>
      <div class="big-number color-cyan" id="s-geo">—</div>
      <div class="big-label">paradas en el mapa</div>
    </div>
  </div>

  <!-- Map -->
  <div class="card">
    <div class="card-title"><span class="icon">🔥</span> Mapa de calor — paradas más consultadas</div>
    <div id="map"></div>
  </div>

  <!-- Heatmap temporal + Rankings -->
  <div class="grid-2">
    <div class="card">
      <div class="card-title"><span class="icon">🕐</span> Actividad por hora y día</div>
      <div id="time-heatmap" class="loading">Cargando</div>
    </div>
    <div class="card">
      <div class="card-title"><span class="icon">🏆</span> Top paradas</div>
      <div id="top-paradas" class="loading">Cargando</div>
    </div>
  </div>

  <div class="card">
    <div class="card-title"><span class="icon">🚌</span> Top líneas consultadas</div>
    <div id="top-lineas" class="loading">Cargando</div>
  </div>
</div>

<div class="heatmap-tooltip" id="hm-tooltip"></div>

<script>
// ── State ──────────────────────────────────────────────────
let currentDays = 30;
let map = null;
let heatLayer = null;
let markersLayer = null;

// ── Map Init ───────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [-38.0055, -57.5426], // Mar del Plata
    zoom: 13,
    zoomControl: true,
    attributionControl: false,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
  }).addTo(map);

  L.control.attribution({
    prefix: false,
    position: 'bottomright'
  }).addAttribution('© <a href="https://carto.com/">CARTO</a>').addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function updateMap(paradaGeo) {
  if (!map) return;

  // Clear previous
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  markersLayer.clearLayers();

  if (!paradaGeo || paradaGeo.length === 0) return;

  // Heat layer
  const maxCount = Math.max(...paradaGeo.map(p => p.count));
  const heatPoints = paradaGeo.map(p => [
    p.lat, p.lng, p.count / maxCount
  ]);

  heatLayer = L.heatLayer(heatPoints, {
    radius: 25,
    blur: 20,
    maxZoom: 16,
    max: 1,
    gradient: {
      0.2: '#1a1a2e',
      0.4: '#16213e',
      0.5: '#0f3460',
      0.6: '#818cf8',
      0.7: '#fbbf24',
      0.85: '#fb923c',
      1.0: '#f87171'
    }
  }).addTo(map);

  // Markers for top paradas
  const topN = paradaGeo.slice(0, 30);
  for (const p of topN) {
    const size = Math.max(6, Math.min(20, (p.count / maxCount) * 20));
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: size,
      fillColor: '#818cf8',
      fillOpacity: 0.7,
      color: '#e4e8f1',
      weight: 1,
    });

    marker.bindPopup(
      '<div style="font-family:Inter,sans-serif;font-size:13px;line-height:1.5">' +
        '<strong style="font-size:15px">' + (p.nombre || 'Parada ' + p.codigo) + '</strong><br>' +
        '<span style="color:#6b7280">Código: ' + p.codigo + '</span><br>' +
        '<span style="color:#818cf8;font-weight:700;font-size:16px">' + p.count.toLocaleString() + '</span> consultas' +
      '</div>',
      { className: 'dark-popup' }
    );

    marker.addTo(markersLayer);
  }

  // Fit bounds if we have points
  if (paradaGeo.length > 0) {
    const bounds = L.latLngBounds(paradaGeo.map(p => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
  }
}

// ── Time Heatmap ───────────────────────────────────────────
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function renderTimeHeatmap(cells) {
  const container = document.getElementById('time-heatmap');

  if (!cells || cells.length === 0) {
    container.innerHTML = '<div class="empty-state">Sin datos de actividad aún</div>';
    return;
  }

  // Build matrix[hour][dow]
  const matrix = {};
  let maxVal = 0;
  for (const c of cells) {
    const key = c.hour + ':' + c.dow;
    matrix[key] = c.count;
    if (c.count > maxVal) maxVal = c.count;
  }

  let html = '<div class="heatmap-grid">';
  
  // Header row
  html += '<div></div>'; // empty top-left corner
  for (let d = 0; d < 7; d++) {
    html += '<div class="heatmap-header">' + DAYS[d] + '</div>';
  }

  // Rows: each hour
  for (let h = 0; h < 24; h++) {
    html += '<div class="heatmap-label">' + String(h).padStart(2, '0') + '</div>';
    for (let d = 0; d < 7; d++) {
      const count = matrix[h + ':' + d] || 0;
      const intensity = maxVal > 0 ? count / maxVal : 0;
      const bg = intensityColor(intensity);
      html += '<div class="heatmap-cell" style="background:' + bg + '" ' +
        'data-hour="' + h + '" data-dow="' + d + '" data-count="' + count + '"></div>';
    }
  }

  html += '</div>';
  container.innerHTML = html;

  // Tooltip
  const tooltip = document.getElementById('hm-tooltip');
  container.addEventListener('mousemove', (e) => {
    const cell = e.target.closest('.heatmap-cell');
    if (!cell) { tooltip.style.display = 'none'; return; }
    const hour = cell.dataset.hour;
    const dow = cell.dataset.dow;
    const count = cell.dataset.count;
    tooltip.textContent = DAYS[dow] + ' ' + String(hour).padStart(2,'0') + ':00 — ' + Number(count).toLocaleString() + ' consultas';
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top = (e.clientY - 30) + 'px';
  });
  container.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

function intensityColor(t) {
  if (t === 0) return 'rgba(255,255,255,0.03)';
  // Interpolate from dark blue → purple → orange → red
  if (t < 0.25) return 'rgba(129, 140, 248, ' + (0.15 + t * 1.4) + ')';
  if (t < 0.5)  return 'rgba(167, 139, 250, ' + (0.3 + t * 0.8) + ')';
  if (t < 0.75) return 'rgba(251, 191, 36, ' + (0.4 + t * 0.5) + ')';
  return 'rgba(248, 113, 113, ' + (0.6 + t * 0.4) + ')';
}

// ── Bar Charts ─────────────────────────────────────────────
function renderBars(containerId, items, cssClass) {
  const el = document.getElementById(containerId);
  if (!items || !items.length) {
    el.innerHTML = '<div class="empty-state">Sin datos aún</div>';
    return;
  }
  const mx = Math.max(...items.map(i => i.count));
  el.innerHTML = items.map((item, idx) => {
    const pct = mx > 0 ? (item.count / mx) * 100 : 0;
    const rankClass = idx < 3 ? ' top-3' : '';
    return '<div class="bar-item">' +
      '<span class="bar-rank' + rankClass + '">#' + (idx + 1) + '</span>' +
      '<span class="bar-label" title="' + item.key + '">' + item.key + '</span>' +
      '<div class="bar-track"><div class="bar-fill ' + cssClass + '" style="width:' + pct + '%"></div></div>' +
      '<span class="bar-count">' + item.count.toLocaleString() + '</span>' +
    '</div>';
  }).join('');
}

// ── Data Fetch ─────────────────────────────────────────────
async function refresh() {
  try {
    const res = await fetch('/stats/analytics/data?days=' + currentDays);
    const d = await res.json();

    // Summary
    document.getElementById('s-total').textContent = (d.totalEvents || 0).toLocaleString();
    document.getElementById('s-paradas').textContent = (d.topParadas?.length || 0).toLocaleString();
    document.getElementById('s-lineas').textContent = (d.topLineas?.length || 0).toLocaleString();
    document.getElementById('s-geo').textContent = (d.paradaGeo?.length || 0).toLocaleString();

    // Map
    updateMap(d.paradaGeo);

    // Time heatmap
    renderTimeHeatmap(d.heatmap);

    // Rankings
    renderBars('top-paradas', d.topParadas, 'parada');
    renderBars('top-lineas', d.topLineas, 'linea');

  } catch (e) {
    console.error('Analytics refresh failed:', e);
  }
}

// ── Filter Pills ───────────────────────────────────────────
document.querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    currentDays = parseInt(pill.dataset.days);
    refresh();
  });
});

// ── Init ───────────────────────────────────────────────────
initMap();
refresh();
// Auto-refresh every 60s (analytics doesn't need to be as fast as the main dashboard)
setInterval(refresh, 60_000);
<\/script>
</body>
</html>`;
