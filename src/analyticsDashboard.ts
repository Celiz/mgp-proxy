export const analyticsDashboardHtml = /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bondi Proxy — Analytics</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

  :root {
    --bg: #121212;
    --card-bg: #1c1c1c;
    --border: #2a2a2a;
    --text: #ffffff;
    --text-dim: #9ca3af;
    --accent: #e5e5e5;
    --blue: #3b82f6;
    --blue-dim: rgba(59, 130, 246, 0.15);
    --green: #22c55e;
    --green-dim: rgba(34, 197, 94, 0.15);
    --red: #ef4444;
    --red-dim: rgba(239, 68, 68, 0.15);
    --radius: 12px;
  }

  body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  /* Bento Grid */
  .bento-container {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 16px;
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 20px 48px;
  }

  .col-span-3 { grid-column: span 3; }
  .col-span-4 { grid-column: span 4; }
  .col-span-8 { grid-column: span 8; }
  .col-span-12 { grid-column: span 12; }
  .row-span-2 { grid-row: span 2; }

  @media (max-width: 1024px) {
    .bento-container { display: flex; flex-direction: column; }
    .row-span-2 { height: auto; }
  }

  /* Header */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .logo-icon {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--text);
    color: var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
  }

  .logo-text {
    display: flex;
    flex-direction: column;
  }

  .logo h1 {
    font-size: 16px;
    font-weight: 700;
    line-height: 1.2;
  }
  .logo span { 
    color: var(--text-dim); 
    font-size: 13px; 
    font-weight: 400; 
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 24px;
  }

  .back-link {
    color: var(--text-dim);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    transition: color 0.2s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .back-link:hover { color: var(--text); }

  /* Filter pills */
  .filter-pills {
    display: flex;
    gap: 4px;
    background: transparent;
  }

  .pill {
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    background: transparent;
    color: var(--text-dim);
    transition: all 0.2s;
  }

  .pill:hover { color: var(--text); }
  .pill.active { color: var(--text); background: #333333; }

  /* Cards */
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Scroller card for Paradas */
  .scrollable-card {
    max-height: 400px;
    overflow-y: auto;
  }
  
  /* custom scrollbar */
  .scrollable-card::-webkit-scrollbar { width: 6px; }
  .scrollable-card::-webkit-scrollbar-track { background: transparent; }
  .scrollable-card::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

  .card-header-flex {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
  }

  .card-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: rgba(255,255,255,0.05);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    color: var(--text-dim);
    border: 1px solid rgba(255,255,255,0.1);
  }

  .card-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 8px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .card-badge.up { background: var(--green-dim); color: var(--green); }
  .card-badge.down { background: var(--red-dim); color: var(--red); }
  
  .card-title {
    font-size: 13px;
    color: var(--text-dim);
    margin-bottom: 4px;
  }
  
  .card-title-main {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
  }
  .card-title-main .subtitle {
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 400;
    margin-left: auto;
  }

  .big-number {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 4px;
  }
  .big-label {
    font-size: 12px;
    color: var(--text-dim);
  }

  /* Map */
  .map-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 400px;
  }
  #map {
    flex: 1;
    border-radius: 8px;
    overflow: hidden;
    background: #e5e5e5;
  }

  .leaflet-container { background: #f0f0f0; }

  /* Heatmap grid */
  .heatmap-container {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  
  .heatmap-grid {
    display: grid;
    /* Use minmax to prevent overflow, forcing cells to shrink if needed */
    grid-template-columns: 28px repeat(24, minmax(0, 1fr));
    gap: 2px;
  }

  .heatmap-label {
    display: flex;
    align-items: center;
    color: var(--text-dim);
    font-size: 10px;
  }
  .heatmap-label.center { justify-content: center; }
  .heatmap-label.right { justify-content: flex-end; padding-right: 6px; }

  .heatmap-cell {
    aspect-ratio: 1;
    border-radius: 2px;
    background: #2a2a2a;
    transition: transform 0.1s;
    position: relative;
    cursor: pointer;
  }
  .heatmap-cell:hover { transform: scale(1.3); z-index: 10; border: 1px solid var(--text-dim); }

  .heatmap-header-row {
    display: grid;
    grid-template-columns: 28px repeat(24, minmax(0, 1fr));
    margin-bottom: 4px;
  }
  
  .heatmap-legend {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .heatmap-legend-boxes {
    display: flex;
    gap: 2px;
  }
  .heatmap-legend-box {
    width: 12px;
    height: 12px;
    border-radius: 2px;
  }

  /* Bar chart items */
  .list-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .list-rank {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-dim);
    width: 16px;
    text-align: right;
  }

  .list-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    /* Fix: align to start so it doesn't center in flex */
    align-items: flex-start;
    text-align: left;
    min-width: 0;
  }

  .list-name {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
  }
  
  .list-sub {
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
    margin-top: 2px;
  }

  .list-progress-bg {
    width: 100%;
    height: 4px;
    background: rgba(255,255,255,0.05);
    border-radius: 2px;
    margin-top: 6px;
    overflow: hidden;
  }
  
  .list-progress-fill {
    height: 100%;
    background: var(--text);
    border-radius: 2px;
  }
  .list-progress-fill.blue { background: var(--blue); }

  .list-count {
    font-size: 13px;
    font-weight: 700;
    text-align: right;
    width: 30px;
  }

  /* Grid 3 for Lines */
  .grid-3-list {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    column-gap: 32px;
    row-gap: 16px;
  }

  .linea-badge {
    background: #333333;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text);
  }

  .empty-state { text-align: center; padding: 32px; color: var(--text-dim); font-size: 13px; }
  .loading { text-align: center; padding: 40px; color: var(--text-dim); }

  /* Tooltip */
  .heatmap-tooltip {
    position: fixed;
    background: #2a2a2a;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 11px;
    pointer-events: none;
    z-index: 1000;
    display: none;
    white-space: nowrap;
  }

</style>
</head>
<body>
<div class="bento-container">
  
  <header class="col-span-12">
    <div class="logo">
      <div class="logo-icon">🌐</div>
      <div class="logo-text">
        <h1>Analíticas</h1>
        <span>Demanda de arribos (próximos colectivos)</span>
      </div>
    </div>
    <div class="header-controls">
      <a href="/stats" class="back-link">← Dashboard principal</a>
      
      <select id="linea-filter" class="pill" style="background:var(--card-bg); color:var(--text); border:1px solid var(--border); outline:none; height: 32px;">
        <option value="">Todas las líneas</option>
        <option value="501">501</option>
        <option value="511">511</option>
        <option value="512">512</option>
        <option value="521">521</option>
        <option value="522">522</option>
        <option value="523">523</option>
        <option value="525">525</option>
        <option value="531">531</option>
        <option value="532">532</option>
        <option value="533">533</option>
        <option value="541">541</option>
        <option value="542">542</option>
        <option value="543">543</option>
        <option value="551">551</option>
        <option value="552">552</option>
        <option value="553">553</option>
        <option value="554">554</option>
        <option value="555">555</option>
        <option value="562">562</option>
        <option value="563">563</option>
        <option value="571">571</option>
        <option value="573">573</option>
        <option value="581">581</option>
        <option value="591">591</option>
        <option value="593">593</option>
        <option value="593C">593C</option>
        <option value="717">717</option>
        <option value="BATAN">BATAN</option>
        <option value="221 COSTA AZUL">221 COSTA AZUL</option>
      </select>

      <div class="filter-pills">
        <button class="pill" data-days="1">24 horas</button>
        <button class="pill" data-days="7">7 días</button>
        <button class="pill active" data-days="30">30 días</button>
        <button class="pill" data-days="0">Todo</button>
      </div>
    </div>
  </header>

  <!-- Summary cards (métricas reales; sin tendencias inventadas) -->
  <div class="card col-span-3">
    <div class="card-header-flex">
      <div class="card-icon">📉</div>
    </div>
    <div class="card-title">Consultas de arribos</div>
    <div class="big-number" id="s-total">—</div>
    <div class="big-label">solo RecuperarProximosArribosW</div>
  </div>
  
  <div class="card col-span-3">
    <div class="card-header-flex">
      <div class="card-icon">📍</div>
    </div>
    <div class="card-title">Paradas únicas</div>
    <div class="big-number" id="s-paradas">—</div>
    <div class="big-label">paradas distintas con arribos</div>
  </div>
  
  <div class="card col-span-3">
    <div class="card-header-flex">
      <div class="card-icon">🚌</div>
    </div>
    <div class="card-title">Líneas únicas</div>
    <div class="big-number" id="s-lineas">—</div>
    <div class="big-label">líneas distintas pedidas</div>
  </div>
  
  <div class="card col-span-3">
    <div class="card-header-flex">
      <div class="card-icon">🧭</div>
    </div>
    <div class="card-title">Con ubicación</div>
    <div class="big-number" id="s-geo">—/—</div>
    <div class="big-label" id="s-geo-label">% de paradas ubicadas en el mapa</div>
  </div>

  <!-- Row 2: Map (left, span 2 rows) + Heatmap (right) -->
  <div class="card col-span-8 row-span-2">
    <div class="card-title-main">
      <span style="color:var(--text-dim)">📍</span> Mapa de demanda de arribos
      <span class="subtitle">Tamaño = consultas de próximos arribos. Tocá un círculo para el detalle</span>
    </div>
    <div class="map-container">
      <div id="map"></div>
    </div>
  </div>

  <div class="card col-span-4">
    <div class="card-title-main">
      <span style="color:var(--text-dim)">🕐</span> Actividad por hora y día
      <div style="margin-left:auto; text-align:right; line-height:1.2;">
        <div style="font-size:10px; color:var(--text-dim);">Hora pico</div>
        <div style="font-size:11px; font-weight:600;" id="peak-hour">—</div>
      </div>
    </div>
    <div id="time-heatmap" class="loading">Cargando...</div>
  </div>
  
  <!-- Row 3: Top Paradas (right side, under Heatmap) -->
  <div class="card col-span-4 scrollable-card">
    <div class="card-title-main" style="position: sticky; top: 0; background: var(--card-bg); z-index: 5; padding-bottom: 8px;">
      <span style="color:var(--text-dim)">📍</span> Paradas más consultadas
      <span class="subtitle" id="top-paradas-count">Top 50</span>
    </div>
    <div id="top-paradas" class="list-container loading">Cargando...</div>
  </div>

  <!-- Row 4: Top Lineas (Full width) -->
  <div class="card col-span-12">
    <div class="card-title-main">
      <span style="color:var(--text-dim)">🚌</span> Líneas más consultadas
      <span class="subtitle" id="top-lineas-count">Top 15</span>
    </div>
    <!-- Note the grid-3-list class below handles the 3 column layout -->
    <div id="top-lineas" class="grid-3-list loading">Cargando...</div>
  </div>
</div>

<div class="heatmap-tooltip" id="hm-tooltip"></div>

<script>
// ── State ──────────────────────────────────────────────────
let currentDays = 30;
let currentLinea = "";
let map = null;
let markersLayer = null;

// ── Map Init ───────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [-38.0055, -57.5426],
    zoom: 12,
    zoomControl: true,
    attributionControl: false,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
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
  markersLayer.clearLayers();
  if (!paradaGeo || paradaGeo.length === 0) return;

  const maxCount = Math.max(...paradaGeo.map(p => p.count));

  for (const p of paradaGeo) {
    const size = Math.max(5, Math.min(25, (p.count / maxCount) * 25));
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: size,
      fillColor: '#3b82f6',
      fillOpacity: 0.5,
      color: '#2563eb',
      weight: 1,
    });

    const lineasText = p.lineas && p.lineas.length > 0 
      ? '<div style="margin-top:6px; padding-top:6px; border-top: 1px solid #e5e5e5; font-size:11px; color:#4b5563;">' +
        '<strong>Líneas pedidas en esta parada:</strong><br>' + 
        p.lineas.map(l => '<span style="display:inline-block; margin-right:8px; margin-top:4px;"><span style="background:#f3f4f6; padding:2px 4px; border-radius:4px; font-weight:600; color:#111;">' + l.linea + '</span> (' + l.count + ')</span>').join('') + 
        '</div>'
      : '<div style="margin-top:6px; padding-top:6px; border-top: 1px solid #e5e5e5; font-size:11px; color:#9ca3af;">Sin desglose de líneas</div>';

    marker.bindPopup(
      '<div style="font-family:Inter,sans-serif;font-size:12px;line-height:1.4;color:#111;min-width:180px;">' +
        '<div style="font-size:14px; font-weight:700; margin-bottom: 2px;">' + (p.nombre || 'Parada ' + p.codigo) + '</div>' +
        '<div style="color:#6b7280; font-size:11px; margin-bottom: 4px;">Código: ' + p.codigo + '</div>' +
        '<div style="font-size:13px; margin-bottom: 4px;"><strong style="color:#3b82f6; font-size:15px;">' + p.count.toLocaleString() + '</strong> consultas de arribos</div>' +
        lineasText +
      '</div>'
    );

    marker.addTo(markersLayer);
  }

  if (paradaGeo.length > 0) {
    const bounds = L.latLngBounds(paradaGeo.map(p => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  }
  
  // Fix for the grey tiles bug in Flex/Grid layouts
  setTimeout(() => {
    map.invalidateSize();
  }, 100);
}

// ── Time Heatmap ───────────────────────────────────────────
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const HOURS_HEADER = [0,3,6,9,12,15,18,21];

function renderTimeHeatmap(cells) {
  const container = document.getElementById('time-heatmap');

  if (!cells || cells.length === 0) {
    container.innerHTML = '<div class="empty-state">Sin datos de actividad aún</div>';
    document.getElementById('peak-hour').textContent = '—';
    return;
  }

  const matrix = {};
  let maxVal = 0;
  let peakKey = '';
  
  for (const c of cells) {
    const key = c.dow + ':' + c.hour;
    matrix[key] = c.count;
    if (c.count > maxVal) {
      maxVal = c.count;
      peakKey = key;
    }
  }

  if (peakKey) {
    const [d, h] = peakKey.split(':');
    document.getElementById('peak-hour').textContent = DAYS[d] + ' • ' + String(h).padStart(2,'0') + ':00';
  } else {
    document.getElementById('peak-hour').textContent = '—';
  }

  let html = '<div class="heatmap-container">';
  
  html += '<div class="heatmap-header-row">';
  html += '<div></div>'; 
  for (let h = 0; h < 24; h++) {
    if (HOURS_HEADER.includes(h)) {
      html += '<div class="heatmap-label center">' + String(h).padStart(2, '0') + '</div>';
    } else {
      html += '<div></div>';
    }
  }
  html += '</div>';

  html += '<div class="heatmap-grid">';
  for (let d = 0; d < 7; d++) {
    html += '<div class="heatmap-label right">' + DAYS[d] + '</div>';
    for (let h = 0; h < 24; h++) {
      const count = matrix[d + ':' + h] || 0;
      // Usar escala logarítmica para que los outliers (pruebas masivas) no oculten el tráfico normal
      const intensity = maxVal > 0 && count > 0 ? Math.log(count + 1) / Math.log(maxVal + 1) : 0;
      const bg = intensityColor(intensity);
      html += '<div class="heatmap-cell" style="background:' + bg + '" ' +
        'data-hour="' + h + '" data-dow="' + d + '" data-count="' + count + '"></div>';
    }
  }
  html += '</div>';

  html += '<div class="heatmap-legend">';
  html += '<span>Menos</span>';
  html += '<div class="heatmap-legend-boxes">';
  html += '<div class="heatmap-legend-box" style="background:#2a2a2a"></div>';
  html += '<div class="heatmap-legend-box" style="background:#52525b"></div>';
  html += '<div class="heatmap-legend-box" style="background:#9ca3af"></div>';
  html += '<div class="heatmap-legend-box" style="background:#e5e5e5"></div>';
  html += '<div class="heatmap-legend-box" style="background:#ffffff"></div>';
  html += '</div>';
  html += '<span>Más consultas</span>';
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;

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
  if (t === 0) return '#2a2a2a';
  if (t < 0.25) return '#52525b';
  if (t < 0.5)  return '#71717a';
  if (t < 0.75) return '#a1a1aa';
  if (t < 0.9)  return '#d4d4d8';
  return '#ffffff';
}

// ── Render Lists ───────────────────────────────────────────
function renderParadas(items) {
  const el = document.getElementById('top-paradas');
  if (!items || !items.length) {
    el.innerHTML = '<div class="empty-state">Sin datos aún</div>';
    return;
  }
  
  const mx = Math.max(...items.map(i => i.count));
  
  let html = '';
  // Muestra hasta 50 para que el usuario pueda scrollear dentro del contenedor
  items.slice(0, 50).forEach((item, idx) => {
    const pct = mx > 0 ? (item.count / mx) * 100 : 0;
    const name = item.nombre || item.key;
    const codeHint = item.nombre && item.nombre !== item.key ? item.key : '';
    const lineasSub = item.lineas && item.lineas.length > 0
      ? item.lineas.map(l => l.linea + ' (' + l.count + ')').join(', ')
      : 'Sin línea en el request';
    const subtitle = codeHint ? codeHint + ' · ' + lineasSub : lineasSub;
    
    html += '<div class="list-item">';
    html += '  <div class="list-rank">' + (idx + 1) + '</div>';
    html += '  <div class="list-info">';
    html += '    <div class="list-name" title="' + name + '">' + name + '</div>';
    html += '    <div class="list-sub">' + subtitle + '</div>';
    html += '    <div class="list-progress-bg"><div class="list-progress-fill" style="width:' + pct + '%"></div></div>';
    html += '  </div>';
    html += '  <div class="list-count">' + item.count.toLocaleString() + '</div>';
    html += '</div>';
  });
  
  el.innerHTML = html;
}

function renderLineas(items) {
  const el = document.getElementById('top-lineas');
  if (!items || !items.length) {
    el.innerHTML = '<div class="empty-state">Sin datos aún</div>';
    return;
  }

  const mx = Math.max(...items.map(i => i.count));
  
  let html = '';
  items.slice(0, 15).forEach((item, idx) => {
    const pct = mx > 0 ? (item.count / mx) * 100 : 0;
    const code = item.key;
    
    html += '<div class="list-item">';
    html += '  <div class="list-rank">' + (idx + 1) + '</div>';
    html += '  <div class="linea-badge">' + code + '</div>';
    html += '  <div class="list-info">';
    html += '    <div class="list-name" title="Línea ' + code + '">Línea ' + code + '</div>';
    html += '    <div class="list-sub">consultas de arribos</div>';
    html += '    <div class="list-progress-bg"><div class="list-progress-fill blue" style="width:' + pct + '%"></div></div>';
    html += '  </div>';
    html += '  <div class="list-count">' + item.count.toLocaleString() + '</div>';
    html += '</div>';
  });
  
  el.innerHTML = html;
}

// ── Data Fetch ─────────────────────────────────────────────
async function refresh() {
  try {
    let url = '/stats/analytics/data?days=' + currentDays;
    if (currentLinea) {
      url += '&linea=' + encodeURIComponent(currentLinea);
    }
    const res = await fetch(url);
    const d = await res.json();

    if (d.supabaseConnected === false) {
      document.getElementById('s-total').textContent = '—';
      document.getElementById('top-paradas').innerHTML = '<div class="empty-state">Supabase no configurado</div>';
      document.getElementById('top-lineas').innerHTML = '<div class="empty-state">Supabase no configurado</div>';
      document.getElementById('time-heatmap').innerHTML = '<div class="empty-state">Supabase no configurado</div>';
      return;
    }

    const total = d.totalEvents || 0;
    document.getElementById('s-total').textContent = total.toLocaleString();
    
    const paradasCount = d.uniqueParadas ?? d.topParadas?.length ?? 0;
    document.getElementById('s-paradas').textContent = paradasCount.toLocaleString();
    
    const lineasCount = d.uniqueLineas ?? d.topLineas?.length ?? 0;
    document.getElementById('s-lineas').textContent = lineasCount.toLocaleString();
    
    const geoCount = d.paradaGeo?.length || 0;
    document.getElementById('s-geo').textContent = geoCount + '/' + paradasCount;
    if (paradasCount > 0) {
      const pct = d.geoCoverage ?? Math.round((geoCount / paradasCount) * 100);
      document.getElementById('s-geo-label').textContent = pct + '% de paradas ubicadas en el mapa';
    }

    updateMap(d.paradaGeo);
    renderTimeHeatmap(d.heatmap);
    renderParadas(d.topParadas);
    renderLineas(d.topLineas);

  } catch (e) {
    console.error('Analytics refresh failed:', e);
  }
}

// ── Filter Pills ───────────────────────────────────────────
document.querySelectorAll('.pill[data-days]').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill[data-days]').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    currentDays = parseInt(pill.dataset.days);
    refresh();
  });
});

document.getElementById('linea-filter').addEventListener('change', (e) => {
  currentLinea = e.target.value;
  refresh();
});

// ── Init ───────────────────────────────────────────────────
initMap();
refresh();
setInterval(refresh, 60_000);

// Auto-resize map on window resize (fixes Leaflet grey tiles bug in flex containers)
window.addEventListener('resize', () => {
  if (map) map.invalidateSize();
});
<\/script>
</body>
</html>`;
