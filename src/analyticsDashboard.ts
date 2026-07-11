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
    --bg:#121212; --card-bg:#1c1c1c; --border:#2a2a2a; --text:#fff; --text-dim:#9ca3af;
    --blue:#3b82f6; --green:#22c55e; --green-dim:rgba(34,197,94,.15);
    --red:#ef4444; --red-dim:rgba(239,68,68,.15); --yellow:#eab308; --radius:12px;
  }
  body { font-family:Inter,system-ui,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; line-height:1.5; -webkit-font-smoothing:antialiased; }
  .bento-container { display:grid; grid-template-columns:repeat(12,1fr); gap:16px; max-width:1400px; margin:0 auto; padding:24px 20px 48px; }
  .col-span-3{grid-column:span 3}.col-span-4{grid-column:span 4}.col-span-6{grid-column:span 6}.col-span-8{grid-column:span 8}.col-span-12{grid-column:span 12}
  .row-span-2{grid-row:span 2}
  @media(max-width:1024px){ .bento-container{display:flex;flex-direction:column} .row-span-2{height:auto} }
  header{display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:8px;flex-wrap:wrap;gap:12px}
  .logo{display:flex;align-items:center;gap:12px}
  .logo-icon{width:36px;height:36px;border-radius:50%;background:var(--text);color:var(--bg);display:flex;align-items:center;justify-content:center;font-size:16px}
  .logo h1{font-size:16px;font-weight:700;line-height:1.2}
  .logo span{color:var(--text-dim);font-size:13px}
  .header-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .back-link{color:var(--text-dim);text-decoration:none;font-size:13px;font-weight:500}
  .back-link:hover{color:var(--text)}
  .filter-pills{display:flex;gap:4px}
  .pill{padding:6px 12px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;border:none;background:transparent;color:var(--text-dim)}
  .pill:hover{color:var(--text)}.pill.active{color:var(--text);background:#333}
  .btn{padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--card-bg);color:var(--text)}
  .btn:hover{border-color:#555}
  .card{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:20px;display:flex;flex-direction:column;overflow:hidden}
  .scrollable-card{max-height:400px;overflow-y:auto}
  .scrollable-card::-webkit-scrollbar{width:6px}
  .scrollable-card::-webkit-scrollbar-thumb{background:#333;border-radius:3px}
  .card-header-flex{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
  .card-icon{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;font-size:16px;border:1px solid rgba(255,255,255,.1)}
  .card-badge{font-size:11px;font-weight:600;padding:4px 8px;border-radius:12px}
  .card-badge.up{background:var(--green-dim);color:var(--green)}
  .card-badge.down{background:var(--red-dim);color:var(--red)}
  .card-badge.flat{background:rgba(255,255,255,.08);color:var(--text-dim)}
  .card-title{font-size:13px;color:var(--text-dim);margin-bottom:4px}
  .card-title-main{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .card-title-main .subtitle{font-size:12px;color:var(--text-dim);font-weight:400;margin-left:auto}
  .big-number{font-size:28px;font-weight:700;line-height:1.2;margin-bottom:4px}
  .big-label{font-size:12px;color:var(--text-dim)}
  .map-container{flex:1;display:flex;flex-direction:column;min-height:400px}
  #map{flex:1;border-radius:8px;overflow:hidden;background:#e5e5e5;min-height:360px}
  .hour-slider-wrap{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:12px;color:var(--text-dim)}
  .hour-slider-wrap input{flex:1}
  .heatmap-grid{display:grid;grid-template-columns:28px repeat(24,minmax(0,1fr));gap:2px}
  .heatmap-header-row{display:grid;grid-template-columns:28px repeat(24,minmax(0,1fr));margin-bottom:4px}
  .heatmap-label{display:flex;align-items:center;color:var(--text-dim);font-size:10px}
  .heatmap-label.center{justify-content:center}.heatmap-label.right{justify-content:flex-end;padding-right:6px}
  .heatmap-cell{aspect-ratio:1;border-radius:2px;background:#2a2a2a;cursor:pointer}
  .heatmap-legend{display:flex;align-items:center;gap:8px;margin-top:16px;font-size:11px;color:var(--text-dim)}
  .heatmap-legend-boxes{display:flex;gap:2px}
  .heatmap-legend-box{width:12px;height:12px;border-radius:2px}
  .list-container{display:flex;flex-direction:column;gap:14px}
  .list-item{display:flex;align-items:center;gap:12px}
  .list-rank{font-size:12px;font-weight:700;color:var(--text-dim);width:16px;text-align:right}
  .list-info{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start}
  .list-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%}
  .list-sub{font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;margin-top:2px}
  .list-progress-bg{width:100%;height:4px;background:rgba(255,255,255,.05);border-radius:2px;margin-top:6px;overflow:hidden}
  .list-progress-fill{height:100%;background:var(--text);border-radius:2px}
  .list-progress-fill.blue{background:var(--blue)}
  .list-count{font-size:13px;font-weight:700;text-align:right;min-width:36px}
  .grid-3-list{display:grid;grid-template-columns:repeat(3,1fr);column-gap:32px;row-gap:16px}
  @media(max-width:900px){.grid-3-list{grid-template-columns:1fr}}
  .linea-badge{background:#333;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}
  .funnel{display:flex;flex-direction:column;gap:10px}
  .funnel-row{display:grid;grid-template-columns:140px 1fr 56px;gap:10px;align-items:center;font-size:12px}
  .funnel-bar{height:10px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden}
  .funnel-fill{height:100%;background:var(--blue);border-radius:4px}
  .mix{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .mix span{font-size:11px;padding:4px 8px;border-radius:8px;background:rgba(255,255,255,.06);color:var(--text-dim)}
  .empty-state{text-align:center;padding:32px;color:var(--text-dim);font-size:13px}
  .loading{text-align:center;padding:40px;color:var(--text-dim)}
  .heatmap-tooltip{position:fixed;background:#2a2a2a;border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:11px;pointer-events:none;z-index:1000;display:none;white-space:nowrap}
  .meta-line{font-size:11px;color:var(--text-dim);margin-top:8px}
  select.pill{background:var(--card-bg);color:var(--text);border:1px solid var(--border);outline:none;height:32px}
</style>
</head>
<body>
<div class="bento-container">
  <header class="col-span-12">
    <div class="logo">
      <div class="logo-icon">🌐</div>
      <div>
        <h1>Analíticas</h1>
        <span>Demanda de arribos · funnel · comparación · TZ AR</span>
      </div>
    </div>
    <div class="header-controls">
      <a href="/stats" class="back-link">← Ops</a>
      <button class="btn" id="btn-export" title="Exportar CSV">⬇ CSV</button>
      <select id="linea-filter" class="pill">
        <option value="">Todas las líneas</option>
        <option>501</option><option>511</option><option>512</option><option>521</option><option>522</option>
        <option>523</option><option>525</option><option>531</option><option>532</option><option>533</option>
        <option>541</option><option>542</option><option>543</option><option>551</option><option>552</option>
        <option>553</option><option>554</option><option>555</option><option>562</option><option>563</option>
        <option>571</option><option>573</option><option>581</option><option>591</option><option>593</option>
        <option>593C</option><option>717</option><option>BATAN</option><option value="221 COSTA AZUL">221 COSTA AZUL</option>
      </select>
      <div class="filter-pills">
        <button class="pill" data-days="1">24h</button>
        <button class="pill" data-days="7">7d</button>
        <button class="pill active" data-days="30">30d</button>
        <button class="pill" data-days="0">Todo</button>
      </div>
    </div>
  </header>

  <div class="card col-span-3">
    <div class="card-header-flex">
      <div class="card-icon">📉</div>
      <div class="card-badge flat" id="b-total">—</div>
    </div>
    <div class="card-title">Consultas de arribos</div>
    <div class="big-number" id="s-total">—</div>
    <div class="big-label" id="s-total-sub">vs período anterior</div>
  </div>
  <div class="card col-span-3">
    <div class="card-header-flex"><div class="card-icon">👤</div></div>
    <div class="card-title">Clientes únicos (aprox.)</div>
    <div class="big-number" id="s-clients">—</div>
    <div class="big-label" id="s-clients-note">hash IP/UA o X-Client-Id</div>
  </div>
  <div class="card col-span-3">
    <div class="card-header-flex"><div class="card-icon">📍</div></div>
    <div class="card-title">Paradas · Líneas</div>
    <div class="big-number" id="s-pl">—</div>
    <div class="big-label" id="s-geo-label">cobertura geo</div>
  </div>
  <div class="card col-span-3">
    <div class="card-header-flex"><div class="card-icon">⚡</div></div>
    <div class="card-title">Latencia arribos</div>
    <div class="big-number" id="s-lat">—</div>
    <div class="big-label" id="s-lat-sub">p50 / p95</div>
  </div>

  <div class="card col-span-4">
    <div class="card-title-main">🗄️ Cache (arribos) <span class="subtitle" id="cache-sub">hit / miss / stale</span></div>
    <div class="big-number" id="s-cache-hit">—</div>
    <div class="big-label">hit rate sobre consultas de producto</div>
    <div class="mix" id="cache-mix"></div>
  </div>
  <div class="card col-span-8">
    <div class="card-title-main">🧭 Funnel de búsqueda <span class="subtitle">pasos hacia arribos</span></div>
    <div class="funnel" id="funnel">Cargando...</div>
  </div>

  <div class="card col-span-8 row-span-2">
    <div class="card-title-main">
      <span>📍</span> Mapa de demanda
      <span class="subtitle">slider = hora del día (AR)</span>
    </div>
    <div class="map-container">
      <div id="map"></div>
      <div class="hour-slider-wrap">
        <span>Todo el día</span>
        <input type="range" id="hour-filter" min="-1" max="23" value="-1" />
        <strong id="hour-label">Todas</strong>
      </div>
    </div>
  </div>

  <div class="card col-span-4">
    <div class="card-title-main">
      <span>🕐</span> Actividad (TZ AR)
      <div style="margin-left:auto;text-align:right;line-height:1.2">
        <div style="font-size:10px;color:var(--text-dim)">Hora pico</div>
        <div style="font-size:11px;font-weight:600" id="peak-hour">—</div>
      </div>
    </div>
    <div id="time-heatmap" class="loading">Cargando...</div>
  </div>

  <div class="card col-span-4 scrollable-card">
    <div class="card-title-main" style="position:sticky;top:0;background:var(--card-bg);z-index:5">
      <span>📍</span> Top paradas <span class="subtitle">con Δ%</span>
    </div>
    <div id="top-paradas" class="list-container loading">Cargando...</div>
  </div>

  <div class="card col-span-6">
    <div class="card-title-main"><span>🚀</span> Líneas emergentes <span class="subtitle">suben ≥25%</span></div>
    <div id="emerging" class="list-container loading">Cargando...</div>
  </div>
  <div class="card col-span-6">
    <div class="card-title-main"><span>👻</span> Paradas huérfanas <span class="subtitle">sin geo / nombre pobre</span></div>
    <div id="orphans" class="list-container loading">Cargando...</div>
  </div>

  <div class="card col-span-12">
    <div class="card-title-main"><span>🚌</span> Líneas más consultadas <span class="subtitle" id="top-lineas-count">Top 15</span></div>
    <div id="top-lineas" class="grid-3-list loading">Cargando...</div>
  </div>

  <div class="card col-span-12">
    <div class="card-title-main"><span>🚩</span> Ramales (si el cliente los manda) <span class="subtitle">requiere param bandera/ramal</span></div>
    <div id="top-ramales" class="grid-3-list loading">Cargando...</div>
    <div class="meta-line" id="meta-line">—</div>
  </div>
</div>
<div class="heatmap-tooltip" id="hm-tooltip"></div>

<script>
let currentDays = 30;
let currentLinea = "";
let map = null;
let markersLayer = null;
let lastData = null;
let hourFilter = -1;

function setBadge(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  if (pct == null || Number.isNaN(pct)) {
    el.className = 'card-badge flat';
    el.textContent = '—';
    return;
  }
  el.className = 'card-badge ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat');
  el.textContent = (pct > 0 ? '+' : '') + pct + '%';
}

function initMap() {
  map = L.map('map', { center: [-38.0055, -57.5426], zoom: 12, zoomControl: true, attributionControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
  L.control.attribution({ prefix: false, position: 'bottomright' }).addAttribution('© CARTO').addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function countForHour(p) {
  if (hourFilter < 0) return p.count;
  const arr = p.byHour || [];
  return arr[hourFilter] || 0;
}

function updateMap(paradaGeo) {
  if (!map) return;
  markersLayer.clearLayers();
  if (!paradaGeo || !paradaGeo.length) return;

  const points = paradaGeo.map(p => ({ ...p, show: countForHour(p) })).filter(p => p.show > 0);
  if (!points.length) return;
  const maxCount = Math.max(...points.map(p => p.show));

  for (const p of points) {
    const size = Math.max(5, Math.min(25, (p.show / maxCount) * 25));
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: size, fillColor: '#3b82f6', fillOpacity: 0.5, color: '#2563eb', weight: 1
    });
    const lineasText = p.lineas && p.lineas.length
      ? '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e5e5;font-size:11px;color:#4b5563"><strong>Líneas:</strong><br>' +
        p.lineas.map(l => '<span style="display:inline-block;margin:4px 8px 0 0"><span style="background:#f3f4f6;padding:2px 4px;border-radius:4px;font-weight:600;color:#111">' + l.linea + '</span> (' + l.count + ')</span>').join('') + '</div>'
      : '';
    marker.bindPopup(
      '<div style="font-family:Inter,sans-serif;font-size:12px;color:#111;min-width:180px">' +
      '<div style="font-size:14px;font-weight:700">' + (p.nombre || 'Parada ' + p.codigo) + '</div>' +
      '<div style="color:#6b7280;font-size:11px;margin-bottom:4px">Código: ' + p.codigo + '</div>' +
      '<div><strong style="color:#3b82f6;font-size:15px">' + p.show.toLocaleString() + '</strong> consultas' +
      (hourFilter >= 0 ? ' @ ' + String(hourFilter).padStart(2,'0') + 'h' : '') + '</div>' +
      lineasText + '</div>'
    );
    marker.addTo(markersLayer);
  }
  const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  setTimeout(() => map.invalidateSize(), 100);
}

const DAYS = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const HOURS_HEADER = [0,3,6,9,12,15,18,21];

function intensityColor(t) {
  if (t === 0) return '#2a2a2a';
  if (t < 0.25) return '#52525b';
  if (t < 0.5) return '#71717a';
  if (t < 0.75) return '#a1a1aa';
  if (t < 0.9) return '#d4d4d8';
  return '#ffffff';
}

function renderTimeHeatmap(cells) {
  const container = document.getElementById('time-heatmap');
  if (!cells || !cells.length) {
    container.innerHTML = '<div class="empty-state">Sin datos</div>';
    document.getElementById('peak-hour').textContent = '—';
    return;
  }
  const matrix = {};
  let maxVal = 0, peakKey = '';
  for (const c of cells) {
    const key = c.dow + ':' + c.hour;
    matrix[key] = c.count;
    if (c.count > maxVal) { maxVal = c.count; peakKey = key; }
  }
  if (peakKey) {
    const [d,h] = peakKey.split(':');
    document.getElementById('peak-hour').textContent = DAYS[d] + ' · ' + String(h).padStart(2,'0') + ':00';
  }
  let html = '<div class="heatmap-header-row"><div></div>';
  for (let h = 0; h < 24; h++) {
    html += HOURS_HEADER.includes(h)
      ? '<div class="heatmap-label center">' + String(h).padStart(2,'0') + '</div>'
      : '<div></div>';
  }
  html += '</div><div class="heatmap-grid">';
  for (let d = 0; d < 7; d++) {
    html += '<div class="heatmap-label right">' + DAYS[d] + '</div>';
    for (let h = 0; h < 24; h++) {
      const count = matrix[d + ':' + h] || 0;
      const intensity = maxVal > 0 && count > 0 ? Math.log(count + 1) / Math.log(maxVal + 1) : 0;
      html += '<div class="heatmap-cell" style="background:' + intensityColor(intensity) + '" data-hour="' + h + '" data-dow="' + d + '" data-count="' + count + '"></div>';
    }
  }
  html += '</div><div class="heatmap-legend"><span>Menos</span><div class="heatmap-legend-boxes">';
  for (const c of ['#2a2a2a','#52525b','#9ca3af','#e5e5e5','#fff']) {
    html += '<div class="heatmap-legend-box" style="background:' + c + '"></div>';
  }
  html += '</div><span>Más</span></div>';
  container.innerHTML = html;
  const tooltip = document.getElementById('hm-tooltip');
  container.onmousemove = (e) => {
    const cell = e.target.closest('.heatmap-cell');
    if (!cell) { tooltip.style.display = 'none'; return; }
    tooltip.textContent = DAYS[cell.dataset.dow] + ' ' + String(cell.dataset.hour).padStart(2,'0') + ':00 — ' + Number(cell.dataset.count).toLocaleString();
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top = (e.clientY - 30) + 'px';
  };
  container.onmouseleave = () => { tooltip.style.display = 'none'; };
}

function deltaSub(pct) {
  if (pct == null) return '';
  const sign = pct > 0 ? '+' : '';
  return ' · Δ ' + sign + pct + '%';
}

function renderList(elId, items, opts) {
  const el = document.getElementById(elId);
  if (!items || !items.length) { el.innerHTML = '<div class="empty-state">Sin datos</div>'; return; }
  const mx = Math.max(...items.map(i => i.count));
  let html = '';
  items.slice(0, opts.limit || 20).forEach((item, idx) => {
    const pct = mx > 0 ? (item.count / mx) * 100 : 0;
    const name = item.nombre || item.key;
    const sub = opts.sub ? opts.sub(item) : (item.lineas ? item.lineas.map(l => l.linea).join(', ') : '');
    html += '<div class="list-item"><div class="list-rank">' + (idx+1) + '</div><div class="list-info">';
    html += '<div class="list-name" title="' + name + '">' + name + '</div>';
    html += '<div class="list-sub">' + sub + deltaSub(item.changePct) + '</div>';
    html += '<div class="list-progress-bg"><div class="list-progress-fill' + (opts.blue ? ' blue' : '') + '" style="width:' + pct + '%"></div></div>';
    html += '</div><div class="list-count">' + item.count.toLocaleString() + '</div></div>';
  });
  el.innerHTML = html;
}

function renderLineas(items) {
  const el = document.getElementById('top-lineas');
  if (!items || !items.length) { el.innerHTML = '<div class="empty-state">Sin datos</div>'; return; }
  const mx = Math.max(...items.map(i => i.count));
  let html = '';
  items.slice(0, 15).forEach((item, idx) => {
    const pct = mx > 0 ? (item.count / mx) * 100 : 0;
    html += '<div class="list-item"><div class="list-rank">' + (idx+1) + '</div><div class="linea-badge">' + item.key + '</div><div class="list-info">';
    html += '<div class="list-name">Línea ' + item.key + '</div>';
    html += '<div class="list-sub">arribos' + deltaSub(item.changePct) + '</div>';
    html += '<div class="list-progress-bg"><div class="list-progress-fill blue" style="width:' + pct + '%"></div></div>';
    html += '</div><div class="list-count">' + item.count.toLocaleString() + '</div></div>';
  });
  el.innerHTML = html;
}

function renderFunnel(steps) {
  const el = document.getElementById('funnel');
  if (!steps || !steps.length) { el.innerHTML = '<div class="empty-state">Sin datos de funnel</div>'; return; }
  const mx = Math.max(...steps.map(s => s.count), 1);
  el.innerHTML = steps.map(s => {
    const pct = (s.count / mx) * 100;
    return '<div class="funnel-row"><div>' + s.label + '</div><div class="funnel-bar"><div class="funnel-fill" style="width:' + pct + '%"></div></div><div style="text-align:right;font-weight:600">' + s.count.toLocaleString() + '</div></div>';
  }).join('');
}

function renderCache(mix) {
  const total = (mix.hit||0)+(mix.miss||0)+(mix.stale||0)+(mix.unknown||0);
  const hitRate = total > 0 ? ((mix.hit||0)/total*100).toFixed(1) : '—';
  document.getElementById('s-cache-hit').textContent = hitRate === '—' ? '—' : hitRate + '%';
  document.getElementById('cache-mix').innerHTML =
    '<span>HIT ' + (mix.hit||0).toLocaleString() + '</span>' +
    '<span>MISS ' + (mix.miss||0).toLocaleString() + '</span>' +
    '<span>STALE ' + (mix.stale||0).toLocaleString() + '</span>' +
    '<span>n/a ' + (mix.unknown||0).toLocaleString() + '</span>';
}

function exportCsv(d) {
  const rows = [['tipo','key','count','changePct','extra']];
  for (const p of (d.topParadas||[])) rows.push(['parada', p.key, p.count, p.changePct ?? '', (p.nombre||'').replace(/,/g,';')]);
  for (const l of (d.topLineas||[])) rows.push(['linea', l.key, l.count, l.changePct ?? '', '']);
  for (const e of (d.emergingLineas||[])) rows.push(['emergente', e.key, e.count, e.changePct ?? '', '']);
  for (const o of (d.orphanParadas||[])) rows.push(['huerfana', o.key, o.count, '', '']);
  for (const r of (d.topRamales||[])) rows.push(['ramal', r.key, r.count, '', '']);
  const csv = rows.map(r => r.join(',')).join('\\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bondi-analytics-' + currentDays + 'd.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function refresh() {
  try {
    let url = '/stats/analytics/data?days=' + currentDays;
    if (currentLinea) url += '&linea=' + encodeURIComponent(currentLinea);
    const res = await fetch(url);
    const d = await res.json();
    lastData = d;

    if (d.supabaseConnected === false) {
      document.getElementById('s-total').textContent = '—';
      document.getElementById('funnel').innerHTML = '<div class="empty-state">Supabase no configurado</div>';
      return;
    }

    document.getElementById('s-total').textContent = (d.totalEvents||0).toLocaleString();
    setBadge('b-total', d.changePct);
    document.getElementById('s-total-sub').textContent =
      'prev ' + (d.prevTotalEvents||0).toLocaleString() + ' · ' + (d.cached ? 'cache' : (d.durationMs||0) + 'ms');

    document.getElementById('s-clients').textContent = (d.uniques?.clientsApprox ?? 0).toLocaleString();
    document.getElementById('s-clients-note').textContent = d.uniques?.note || '';

    const pc = d.uniqueParadas ?? d.topParadas?.length ?? 0;
    const lc = d.uniqueLineas ?? d.topLineas?.length ?? 0;
    document.getElementById('s-pl').textContent = pc.toLocaleString() + ' · ' + lc.toLocaleString();
    document.getElementById('s-geo-label').textContent = (d.geoCoverage ?? 0) + '% con ubicación · ' + (d.paradaGeo?.length||0) + ' en mapa';

    const p50 = d.latency?.p50, p95 = d.latency?.p95;
    document.getElementById('s-lat').textContent = p50 != null ? p50 + 'ms' : '—';
    document.getElementById('s-lat-sub').textContent =
      (p50 != null ? 'p50 ' + p50 + 'ms' : 'p50 —') + ' / ' + (p95 != null ? 'p95 ' + p95 + 'ms' : 'p95 —') +
      ' · n=' + (d.latency?.samples||0);

    renderCache(d.cacheMix || {});
    renderFunnel(d.funnel || []);
    updateMap(d.paradaGeo || []);
    renderTimeHeatmap(d.heatmap || []);
    renderList('top-paradas', d.topParadas, {
      limit: 50,
      sub: (item) => {
        const lines = item.lineas && item.lineas.length ? item.lineas.map(l => l.linea).join(', ') : 'sin línea';
        return (item.nombre && item.nombre !== item.key ? item.key + ' · ' : '') + lines;
      }
    });
    renderLineas(d.topLineas);
    renderList('emerging', d.emergingLineas, { limit: 10, blue: true, sub: () => 'crecimiento vs período anterior' });
    renderList('orphans', d.orphanParadas, { limit: 20, sub: (i) => i.key + ' · falta geo' });
    renderList('top-ramales', d.topRamales, { limit: 15, blue: true, sub: () => 'consultas con ramal' });

    document.getElementById('meta-line').textContent =
      (d.note || '') + ' · schema v2: ' + (d.schemaExtended ? 'sí' : 'no (local fallback)') +
      ' · TZ ' + (d.tz || 'AR');
  } catch (e) {
    console.error('Analytics refresh failed:', e);
  }
}

document.querySelectorAll('.pill[data-days]').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill[data-days]').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    currentDays = parseInt(pill.dataset.days, 10);
    refresh();
  });
});
document.getElementById('linea-filter').addEventListener('change', (e) => {
  currentLinea = e.target.value;
  refresh();
});
document.getElementById('hour-filter').addEventListener('input', (e) => {
  hourFilter = parseInt(e.target.value, 10);
  document.getElementById('hour-label').textContent =
    hourFilter < 0 ? 'Todas' : String(hourFilter).padStart(2,'0') + ':00';
  if (lastData) updateMap(lastData.paradaGeo || []);
});
document.getElementById('btn-export').addEventListener('click', () => {
  if (lastData) exportCsv(lastData);
});
window.addEventListener('resize', () => { if (map) map.invalidateSize(); });

initMap();
refresh();
setInterval(refresh, 60_000);
<\/script>
</body>
</html>`;
