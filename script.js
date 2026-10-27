/* ==========================================================
   MARTIAN MAP — EVA HUD  ·  script.js
   Offline-first HUD + navigation for astronauts on Mars.
   Vanilla JS · Leaflet.js · localStorage · data.json
   ========================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  if (typeof L === 'undefined') {
    const f = $('fatal');
    if (f) f.hidden = false;
    return;
  }

  /* ----------------------------------------------------------
     Constants & defaults
     ---------------------------------------------------------- */
  const STORAGE_KEY = 'mars-eva-hud/state/v1';
  const DATA_CACHE_KEY = 'mars-eva-hud/data/v1';
  const DATA_URL = 'data.json';

  const DEG = Math.PI / 180;
  const MAX_ZOOM = 13;
  const MAX_HISTORY = 600;
  const LOG_STEP_KM = 0.02;
  const SLOPE_STEP_KM = 0.05;
  const TICK_MS = 250;
  const SAVE_EVERY_MS = 2000;
  const HR_SAMPLES = 60;
  const SIM_SPEEDS = [1, 30, 120, 600];

  const EVA_DEFAULTS = {
    walkSpeedKmH: 3,
    o2RestPctPerH: 6,
    o2WalkPctPerH: 12,
    slopeSpeedFactor: 0.6,
    slopeO2Factor: 1.25,
    reservePct: 15,
    returnSafetyFactor: 1.25,
    radiationDetourMarginKm: 0.15,
    rechargeRadiusKm: 0.1,
    ambientDoseUSvH: 27,
  };
  const SUIT_DEFAULTS = { nominalPsi: 4.3, restHr: 70, walkHr: 108 };

  // Minimal dataset used only if data.json cannot be fetched (e.g. file:// protocol) and nothing is cached.
  const FALLBACK_DATA = {
    meta: { name: 'Built-in minimal dataset' },
    mission: { marsRadiusKm: 3389.5 },
    base: { id: 'hab-01', name: 'Base Habitat — Jezero Alpha', lat: 18.38, lng: 77.58, description: 'Surface habitat and airlock.' },
    pois: [
      { id: 'poi-landing', name: 'Octavia E. Butler Landing Site', type: 'landmark', lat: 18.4446, lng: 77.4509, description: 'Approximate Perseverance landing location.' },
      { id: 'sci-clay', name: 'Phyllosilicate Outcrop', type: 'science', lat: 18.32, lng: 77.43, description: 'Clay-bearing exposure.', target: { priority: 'HIGH', sample: 'Clay scrapings', instrument: 'NIR spectrometer' } },
    ],
    radiationZones: [
      { id: 'rz-alpha', name: 'Solar Particle Hotspot ALPHA', center: [18.41, 77.5], radiusKm: 1.8, doseUSvH: 180, level: 'HIGH', description: 'Poor shielding.' },
    ],
    slopeZones: [
      { id: 'sz-dune', name: 'Central Dune Ridge', slopeDeg: 20, difficulty: 'STEEP', latlngs: [[18.375, 77.51], [18.4, 77.535], [18.395, 77.55], [18.37, 77.53]], description: 'Loose sand.' },
    ],
  };

  /* ----------------------------------------------------------
     Runtime state
     ---------------------------------------------------------- */
  let data = null;      // normalised dataset
  let base = null;      // base habitat
  let R = 3389.5;       // Mars radius (km)
  let EVA = EVA_DEFAULTS;
  let SUIT = SUIT_DEFAULTS;
  let proj = null;      // local km projector centred on the base
  let radZones = [];    // radiation zones with km-space centres
  let slopeZones = [];
  let dataSource = 'data.json';

  let map = null;
  const groups = {
    base: L.layerGroup(),
    radiation: L.layerGroup(),
    slope: L.layerGroup(),
    safe: L.layerGroup(),
    trail: L.layerGroup(),
  };
  const routeGroup = L.layerGroup();
  let astroMarker = null;
  let trailLine = null;
  let safePoly = null;

  const state = {
    suit: { oxygen: 100, pressure: 4.3, heartRate: 70 },
    pos: { lat: 0, lng: 0 },
    elapsedH: 0,
    history: [],
    simSpeed: 120,
    layers: { base: true, radiation: true, slope: true, safe: true, trail: true },
    basemap: null,
    route: null,
    traverse: null,
    hrTrend: [],
    lastLogKm: null,
    lastR: -1,
    alerts: new Map(),
    alertSig: '',
    lastTickAt: 0,
    lastSaveAt: 0,
    lastSparkAt: 0,
  };

  /* ----------------------------------------------------------
     Small helpers
     ---------------------------------------------------------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pad2 = (n) => String(n).padStart(2, '0');
  const setText = (id, text) => { const n = $(id); if (n && n.textContent !== text) n.textContent = text; };

  function fmtDuration(h) {
    if (!isNum(h)) return '—';
    const m = Math.round(h * 60);
    return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
  }
  function fmtClock(h) {
    const s = Math.floor(h * 3600);
    return `T+${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
  }
  function fmtCoord(lat, lng) {
    return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
  }

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    kids.forEach((k) => n.append(k));
    return n;
  }

  function setChip(id, level, text) {
    const n = $(id);
    if (!n) return;
    n.className = `chip ${level}`;
    n.textContent = text;
  }
  function setLevel(node, level) {
    node.classList.remove('ok', 'warn', 'crit', 'blue');
    node.classList.add(level);
  }

  function toast(msg, level = 'info', ms = 4200) {
    const box = $('toasts');
    if (!box) return;
    const t = el('div', { class: `toast ${level}`, text: msg });
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => t.remove(), ms);
  }

  /* ----------------------------------------------------------
     Geodesy (flat local projection around the Base Hab)
     ---------------------------------------------------------- */
  function makeProjector(lat0, lng0, radiusKm) {
    const kLat = radiusKm * DEG;
    const kLng = radiusKm * DEG * Math.cos(lat0 * DEG);
    return {
      toKm: (lat, lng) => [(lng - lng0) * kLng, (lat - lat0) * kLat],
      toLatLng: (p) => [lat0 + p[1] / kLat, lng0 + p[0] / kLng],
    };
  }

  function haversineKm(a, b) {
    const dLat = (b[0] - a[0]) * DEG;
    const dLng = (b[1] - a[1]) * DEG;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function pointInPoly(pt, poly) {
    const y = pt[0], x = pt[1];
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function closestOnSegment(p, q, c) {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((c[0] - p[0]) * dx + (c[1] - p[1]) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const pt = [p[0] + dx * t, p[1] + dy * t];
    return { t, pt, d: dist2(pt, c) };
  }

  function circlePts(centerLL, rKm, n = 72) {
    const c = proj.toKm(centerLL[0], centerLL[1]);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(proj.toLatLng([c[0] + Math.cos(a) * rKm, c[1] + Math.sin(a) * rKm]));
    }
    return pts;
  }

  function terrainAt(lat, lng) {
    const km = proj.toKm(lat, lng);
    let rad = null;
    let slope = null;
    for (const z of radZones) {
      if (dist2(km, z.c) <= z.radiusKm && (!rad || z.doseUSvH > rad.doseUSvH)) rad = z;
    }
    for (const s of slopeZones) {
      if (pointInPoly([lat, lng], s.latlngs) && (!slope || s.slopeDeg > slope.slopeDeg)) slope = s;
    }
    return { rad, slope };
  }

  /* ----------------------------------------------------------
     Suit / consumption model
     ---------------------------------------------------------- */
  const flatPctPerKm = () => EVA.o2WalkPctPerH / EVA.walkSpeedKmH;

  function stepCost(onSlope) {
    const speed = EVA.walkSpeedKmH * (onSlope ? EVA.slopeSpeedFactor : 1);
    const rate = EVA.o2WalkPctPerH * (onSlope ? EVA.slopeO2Factor : 1);
    return { speed, rate, perKm: rate / speed };
  }

  // Integrates distance, time and oxygen along a polyline given in local km coordinates.
  function evaluatePath(ptsKm) {
    let lengthKm = 0, slopeKm = 0, hours = 0, o2 = 0;
    for (let i = 0; i < ptsKm.length - 1; i++) {
      const a = ptsKm[i], b = ptsKm[i + 1];
      const seg = dist2(a, b);
      if (seg === 0) continue;
      const n = Math.max(1, Math.ceil(seg / SLOPE_STEP_KM));
      const sub = seg / n;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const ll = proj.toLatLng([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        const onSlope = !!terrainAt(ll[0], ll[1]).slope;
        const c = stepCost(onSlope);
        hours += sub / c.speed;
        o2 += sub * c.perKm;
        if (onSlope) slopeKm += sub;
      }
      lengthKm += seg;
    }
    return { lengthKm, slopeKm, hours, o2 };
  }

  /* ----------------------------------------------------------
     Pathfinding: straight line with radiation-zone detours
     ---------------------------------------------------------- */
  function planRoute(aKm, bKm) {
    const zones = radZones.map((z) => ({ c: z.c, r: z.radiusKm + EVA.radiationDetourMarginKm }));
    let pts = [aKm, bKm];
    for (let pass = 0; pass < 12 && pts.length < 200; pass++) {
      let changed = false;
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        let hit = null, hitT = Infinity;
        for (const z of zones) {
          // Start/end points that already lie inside a zone are tolerated (user's choice).
          if (dist2(p, z.c) < z.r || dist2(q, z.c) < z.r) continue;
          const cs = closestOnSegment(p, q, z.c);
          if (cs.d < z.r && cs.t < hitT) { hit = { z, pt: cs.pt }; hitT = cs.t; }
        }
        if (hit) {
          let nx = hit.pt[0] - hit.z.c[0];
          let ny = hit.pt[1] - hit.z.c[1];
          let nl = Math.hypot(nx, ny);
          if (nl < 1e-6) {
            const dx = q[0] - p[0], dy = q[1] - p[1];
            const l = Math.hypot(dx, dy) || 1;
            nx = -dy / l; ny = dx / l; nl = 1;
          }
          out.push([hit.z.c[0] + (nx / nl) * hit.z.r * 1.2, hit.z.c[1] + (ny / nl) * hit.z.r * 1.2]);
          changed = true;
        }
        out.push(q);
      }
      pts = out;
      if (!changed) break;
    }
    return pts;
  }

  /* ----------------------------------------------------------
     Persistence (localStorage)
     ---------------------------------------------------------- */
  const store = {
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        return o && o.v === 1 ? o : null;
      } catch (e) { return null; }
    },
    save(obj) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); return true; } catch (e) { return false; }
    },
  };

  function persist() {
    store.save({
      v: 1,
      savedAt: Date.now(),
      suit: state.suit,
      pos: state.pos,
      elapsedH: state.elapsedH,
      history: state.history,
      simSpeed: state.simSpeed,
      layers: state.layers,
      basemap: state.basemap,
    });
  }

  function restore() {
    const s = store.load();
    if (!s) return false;
    if (s.suit && isNum(s.suit.oxygen)) {
      state.suit.oxygen = clamp(s.suit.oxygen, 0, 100);
      if (isNum(s.suit.pressure)) state.suit.pressure = clamp(s.suit.pressure, 2.5, 5);
      if (isNum(s.suit.heartRate)) state.suit.heartRate = clamp(s.suit.heartRate, 45, 190);
    }
    if (s.pos && isNum(s.pos.lat) && isNum(s.pos.lng) && haversineKm([base.lat, base.lng], [s.pos.lat, s.pos.lng]) < 500) {
      state.pos = { lat: s.pos.lat, lng: s.pos.lng };
    }
    if (isNum(s.elapsedH) && s.elapsedH >= 0) state.elapsedH = s.elapsedH;
    if (Array.isArray(s.history)) {
      state.history = s.history
        .filter((h) => h && isNum(h.lat) && isNum(h.lng))
        .slice(-MAX_HISTORY);
    }
    if (SIM_SPEEDS.includes(s.simSpeed)) state.simSpeed = s.simSpeed;
    if (s.layers && typeof s.layers === 'object') {
      for (const k of Object.keys(state.layers)) if (typeof s.layers[k] === 'boolean') state.layers[k] = s.layers[k];
    }
    if (typeof s.basemap === 'string') state.basemap = s.basemap;
    return true;
  }

  /* ----------------------------------------------------------
     Data loading (fetch → cache → built-in fallback)
     ---------------------------------------------------------- */
  function validRaw(d) {
    return d && d.base && isNum(d.base.lat) && isNum(d.base.lng);
  }

  async function loadData() {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!validRaw(json)) throw new Error('data.json is missing a valid "base"');
      try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(json)); } catch (e) { /* storage full or disabled */ }
      return { raw: json, source: 'data.json' };
    } catch (err) {
      console.warn('[EVA-HUD] Could not fetch data.json:', err);
      try {
        const cached = JSON.parse(localStorage.getItem(DATA_CACHE_KEY) || 'null');
        if (validRaw(cached)) return { raw: cached, source: 'local cache' };
      } catch (e) { /* ignore */ }
      return { raw: FALLBACK_DATA, source: 'built-in fallback' };
    }
  }

  function normalize(raw) {
    const m = raw.mission || {};
    const hasPoint = (p) => p && isNum(p.lat) && isNum(p.lng);
    return {
      meta: raw.meta || {},
      mission: {
        marsRadiusKm: isNum(m.marsRadiusKm) ? m.marsRadiusKm : 3389.5,
        eva: { ...EVA_DEFAULTS, ...(m.eva || {}) },
        suit: { ...SUIT_DEFAULTS, ...(m.suit || {}) },
      },
      base: raw.base,
      pois: (Array.isArray(raw.pois) ? raw.pois : []).filter(hasPoint),
      radiationZones: (Array.isArray(raw.radiationZones) ? raw.radiationZones : [])
        .filter((z) => Array.isArray(z.center) && z.center.length === 2 && isNum(z.center[0]) && isNum(z.center[1]) && z.radiusKm > 0),
      slopeZones: (Array.isArray(raw.slopeZones) ? raw.slopeZones : [])
        .filter((z) => Array.isArray(z.latlngs) && z.latlngs.length >= 3),
    };
  }

  /* ----------------------------------------------------------
     Offline procedural Mars basemap (works with zero network)
     ---------------------------------------------------------- */
  function hash2(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  const ProceduralMars = L.GridLayer.extend({
    createTile(coords) {
      const SIZE = 256, LOW = 128;
      const tile = L.DomUtil.create('canvas', 'leaflet-tile');
      tile.width = SIZE; tile.height = SIZE;
      const ctx = tile.getContext('2d');

      const kmPerDeg = 3389.5 * DEG;
      const kmPerPx = (kmPerDeg * 180) / (256 * Math.pow(2, coords.z));
      const octaves = [[400, 0.3], [120, 0.25], [40, 0.2], [12, 0.12], [3.2, 0.08], [0.9, 0.05]]
        .filter((o, i) => i === 0 || o[0] / kmPerPx >= 4);
      const wsum = octaves.reduce((s, o) => s + o[1], 0);
      const height = (x, y) => {
        let s = 0;
        for (const [sz, w] of octaves) s += vnoise(x / sz, y / sz) * w;
        return s / wsum;
      };

      const img = ctx.createImageData(LOW, LOW);
      const step = SIZE / LOW;
      for (let py = 0; py < LOW; py++) {
        for (let px = 0; px < LOW; px++) {
          const xKm = (coords.x * SIZE + px * step) * kmPerPx;
          const yKm = (coords.y * SIZE + py * step) * kmPerPx;
          const h = height(xKm, yKm);
          const h2 = height(xKm + kmPerPx * 3, yKm + kmPerPx * 3);
          const shade = clamp((h - h2) * 9, -0.35, 0.35);
          const t = clamp((h - 0.25) / 0.5, 0, 1);
          const i = (py * LOW + px) * 4;
          img.data[i] = clamp((70 + t * 150) * (1 + shade), 0, 255);
          img.data[i + 1] = clamp((34 + t * 95) * (1 + shade), 0, 255);
          img.data[i + 2] = clamp((24 + t * 62) * (1 + shade), 0, 255);
          img.data[i + 3] = 255;
        }
      }
      const lowCanvas = document.createElement('canvas');
      lowCanvas.width = LOW; lowCanvas.height = LOW;
      lowCanvas.getContext('2d').putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(lowCanvas, 0, 0, SIZE, SIZE);

      ctx.strokeStyle = 'rgba(0, 255, 204, 0.10)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
      return tile;
    },
  });

  const TILE_SOURCES = [
    {
      id: 'openplanetary',
      label: 'OpenPlanetary · Mars shaded relief (online)',
      create: () => L.tileLayer('https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/celestia_mars-shaded-16k_global/{z}/{x}/{y}.png', {
        tms: true, noWrap: true, maxNativeZoom: 5, maxZoom: MAX_ZOOM,
        attribution: 'Mars basemap © OpenPlanetary · NASA/MOLA',
      }),
    },
    {
      id: 'trek',
      label: 'NASA Trek · Viking MDIM 2.1 (online)',
      create: () => L.tileLayer('https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg', {
        noWrap: true, maxNativeZoom: 7, maxZoom: MAX_ZOOM,
        attribution: 'NASA/JPL · Viking MDIM 2.1 · NASA Trek',
      }),
    },
    {
      id: 'offline',
      label: 'Offline procedural terrain (no network)',
      create: () => new ProceduralMars({
        tileSize: 256, noWrap: true, maxZoom: MAX_ZOOM,
        attribution: 'Offline procedural terrain · not to scale',
      }),
    },
  ];

  let tileLayer = null;

  function setBasemap(id) {
    const idx = Math.max(0, TILE_SOURCES.findIndex((s) => s.id === id));
    const src = TILE_SOURCES[idx];
    if (tileLayer) map.removeLayer(tileLayer);

    const stats = { loaded: 0, errors: 0, switched: false };
    tileLayer = src.create();
    tileLayer.on('tileload', () => { stats.loaded++; });
    tileLayer.on('tileerror', () => {
      stats.errors++;
      // Remote server unreachable → fail over to the next source, ending on the offline layer.
      if (!stats.loaded && stats.errors >= 6 && !stats.switched && src.id !== 'offline') {
        stats.switched = true;
        const next = TILE_SOURCES[Math.min(idx + 1, TILE_SOURCES.length - 1)];
        toast(`Tile server unreachable — switching to ${next.label.split(' (')[0]}`, 'warn');
        setBasemap(next.id);
      }
    });
    tileLayer.addTo(map);
    state.basemap = src.id;
    const sel = $('basemap');
    if (sel) sel.value = src.id;
  }

  /* ----------------------------------------------------------
     Map construction
     ---------------------------------------------------------- */
  const MarsScale = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd(m) {
      const box = L.DomUtil.create('div', 'mars-scale');
      this._bar = L.DomUtil.create('div', 'mars-scale-bar', box);
      this._lbl = L.DomUtil.create('span', 'mars-scale-lbl', box);
      m.on('zoomend moveend', this._upd, this);
      this._upd();
      return box;
    },
    onRemove(m) { m.off('zoomend moveend', this._upd, this); },
    _upd() {
      const m = this._map;
      if (!m) return;
      const kmPerPx = (180 / (256 * Math.pow(2, m.getZoom()))) * R * DEG;
      const nice = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
      let pick = nice[0];
      for (const n of nice) if (n / kmPerPx <= 110) pick = n;
      this._bar.style.width = `${Math.max(8, Math.round(pick / kmPerPx))}px`;
      this._lbl.textContent = pick < 1 ? `${Math.round(pick * 1000)} m` : `${pick} km`;
    },
  });

  function divIcon(cls, size, extra = '') {
    return L.divIcon({
      className: 'mk-wrap',
      html: `<div class="mk ${cls} ${extra}"><span></span></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function initMap() {
    map = L.map('map', {
      crs: L.CRS.EPSG4326,
      zoomControl: false,
      minZoom: 3,
      maxZoom: MAX_ZOOM,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    new MarsScale().addTo(map);
    map.setView([base.lat, base.lng], 10);

    routeGroup.addTo(map);

    const ro = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    ro.observe($('map'));
  }

  function fitInitialView() {
    const pts = [[base.lat, base.lng], [state.pos.lat, state.pos.lng]];
    data.pois.forEach((p) => pts.push([p.lat, p.lng]));
    const wide = window.innerWidth > 860;
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: wide ? [360, 90] : [30, 30],
      paddingBottomRight: wide ? [360, 40] : [30, 30],
      maxZoom: 11,
    });
  }

  /* ----------------------------------------------------------
     Rendering of dataset features
     ---------------------------------------------------------- */
  function buildPopup(item, kindLabel) {
    const d = haversineKm([base.lat, base.lng], [item.lat, item.lng]);
    const wrap = el('div', { class: 'pop' },
      el('div', { class: 'pop-type', text: kindLabel.toUpperCase() }),
      el('h3', { text: item.name }),
      el('p', { text: item.description || '' }),
      el('div', { class: 'pop-meta', text: `${fmtCoord(item.lat, item.lng)} · ${d.toFixed(1)} km from Hab` }),
    );
    if (item.target) {
      wrap.append(el('div', { class: 'pop-sci' },
        el('span', { text: `PRIORITY: ${item.target.priority || '—'}` }),
        el('span', { text: `SAMPLE: ${item.target.sample || '—'}` }),
        el('span', { text: `TOOL: ${item.target.instrument || '—'}` }),
      ));
    }
    wrap.append(el('button', {
      class: 'btn btn-sm', type: 'button', text: '⌖ SET AS DESTINATION',
      onclick: () => { map.closePopup(); setDestination([item.lat, item.lng], item.name); },
    }));
    return wrap;
  }

  function renderStatic() {
    // Base Habitat
    const bm = L.marker([base.lat, base.lng], { icon: divIcon('mk-base', 34), title: base.name, zIndexOffset: 500 });
    bm.bindTooltip(base.name, { direction: 'top', offset: [0, -16], className: 'hud-tip' });
    bm.bindPopup(() => buildPopup(base, 'Base habitat'));
    groups.base.addLayer(bm);

    // POIs: waypoints, landmarks and science targets
    const kinds = { waypoint: 'Waypoint', landmark: 'Landmark', science: 'Science target' };
    data.pois.forEach((p) => {
      const type = kinds[p.type] ? p.type : 'waypoint';
      const m = L.marker([p.lat, p.lng], { icon: divIcon(`mk-poi mk-${type}`, 24), title: p.name });
      m.bindTooltip(p.name, { direction: 'top', offset: [0, -10], className: 'hud-tip' });
      m.bindPopup(() => buildPopup(p, kinds[type]));
      groups.base.addLayer(m);
    });

    // Radiation hazard zones (true-km circles on Mars)
    radZones.forEach((z) => {
      const poly = L.polygon(circlePts(z.center, z.radiusKm), {
        color: '#ff3b4f', weight: 1.6, fillColor: '#ff3b4f', fillOpacity: 0.18,
      });
      poly.bindTooltip(`☢ ${z.name} · ${z.doseUSvH} µSv/h · ${z.level || 'HAZARD'}`, { sticky: true, className: 'hud-tip' });
      groups.radiation.addLayer(poly);
    });

    // Steep slope / rough terrain polygons
    slopeZones.forEach((z) => {
      const poly = L.polygon(z.latlngs, {
        color: '#ffb020', weight: 1.6, dashArray: '6 4', fillColor: '#ffb020', fillOpacity: 0.14,
      });
      poly.bindTooltip(`▲ ${z.name} · ${z.slopeDeg}° · ${z.difficulty || 'ROUGH'}`, { sticky: true, className: 'hud-tip' });
      groups.slope.addLayer(poly);
    });

    // Safe return radius ring (updated every tick)
    safePoly = L.polygon(circlePts([base.lat, base.lng], 0.01), {
      color: '#00ffcc', weight: 1.6, className: 'safe-ring', fillColor: '#00ffcc', fillOpacity: 0.04, interactive: false,
    });
    groups.safe.addLayer(safePoly);

    // Movement trail
    trailLine = L.polyline([], { color: '#2f9bff', weight: 2.5, opacity: 0.9, interactive: false });
    groups.trail.addLayer(trailLine);
    rebuildTrail();

    // Astronaut marker lives directly on the map so it is always visible
    astroMarker = L.marker([state.pos.lat, state.pos.lng], {
      icon: divIcon('mk-astro', 30), zIndexOffset: 1000, interactive: false, keyboard: false,
    }).addTo(map);

    applyLayerVisibility();
  }

  function rebuildTrail() {
    trailLine.setLatLngs(state.history.map((h) => [h.lat, h.lng]));
  }

  function applyLayerVisibility() {
    for (const [key, group] of Object.entries(groups)) {
      const on = !!state.layers[key];
      if (on && !map.hasLayer(group)) map.addLayer(group);
      if (!on && map.hasLayer(group)) map.removeLayer(group);
    }
    document.querySelectorAll('.toggle[data-layer]').forEach((b) => {
      b.setAttribute('aria-pressed', String(!!state.layers[b.dataset.layer]));
    });
  }

  /* ----------------------------------------------------------
     Routing UI
     ---------------------------------------------------------- */
  function setDestination(latlng, label) {
    if (state.traverse) { toast('Traverse in progress — abort it before planning a new route.', 'warn'); return; }
    if (state.suit.oxygen <= 0) { toast('Suit failure: no oxygen. Reset the EVA session.', 'crit'); return; }

    const aKm = proj.toKm(state.pos.lat, state.pos.lng);
    const bKm = proj.toKm(latlng[0], latlng[1]);
    if (dist2(aKm, bKm) < 0.01) { toast('Target is already at your position.', 'info'); return; }

    const ptsKm = planRoute(aKm, bKm);
    const metrics = evaluatePath(ptsKm);
    const backKm = planRoute(bKm, [0, 0]);
    const back = evaluatePath(backKm);
    const terr = terrainAt(latlng[0], latlng[1]);

    state.route = {
      ptsKm,
      target: latlng,
      label: label || null,
      metrics,
      backO2: dist2(bKm, [0, 0]) < 0.01 ? 0 : back.o2,
      straightKm: dist2(aKm, bKm),
      baseDistKm: haversineKm([base.lat, base.lng], latlng),
      destRad: terr.rad,
      destSlope: terr.slope,
      isReturn: false,
    };
    drawRoute();
    updatePlanner();
    updateButtons();
  }

  function drawRoute() {
    routeGroup.clearLayers();
    const r = state.route;
    if (!r) return;
    const ll = r.ptsKm.map((p) => proj.toLatLng(p));
    routeGroup.addLayer(L.polyline(ll, { color: '#2f9bff', weight: 3, opacity: 0.95, className: 'route-line', interactive: false }));
    for (let i = 1; i < ll.length - 1; i++) {
      routeGroup.addLayer(L.circleMarker(ll[i], { radius: 3.5, color: '#2f9bff', weight: 1.5, fillColor: '#0b0d17', fillOpacity: 1, interactive: false }));
    }
    routeGroup.addLayer(L.marker(r.target, {
      icon: divIcon('mk-target', 28, r.destRad ? 'danger' : ''), interactive: false, keyboard: false,
    }));
  }

  function clearRoute() {
    state.route = null;
    routeGroup.clearLayers();
    updatePlanner();
    updateButtons();
  }

  function updatePlanner() {
    const r = state.route;
    const ids = ['p-target', 'p-basedist', 'p-len', 'p-slope', 'p-eta', 'p-out', 'p-back', 'p-arr', 'p-home'];
    const warn = $('p-warn');
    if (!r) {
      ids.forEach((id) => { setText(id, '—'); $(id).className = ''; });
      setChip('p-status', 'info', 'NO ROUTE');
      warn.className = 'note';
      warn.textContent = 'Click anywhere on the map to plan a route from your position.';
      return;
    }

    const m = r.metrics;
    const tr = state.traverse;
    const frac = tr ? clamp(tr.done / tr.total, 0, 1) : 0;
    const outRem = m.o2 * (1 - frac);
    const arrival = state.suit.oxygen - outRem;
    const home = arrival - r.backO2;
    const reserve = EVA.reservePct;

    let level = 'ok', verdict = 'GO';
    if (r.destRad) { level = 'crit'; verdict = 'HAZARD'; }
    else if (home < reserve) { level = 'crit'; verdict = 'NO-GO'; }
    else if (home < reserve + 10) { level = 'warn'; verdict = 'MARGINAL'; }
    if (tr) { verdict = 'ACTIVE'; level = home < reserve ? 'crit' : 'info'; }

    setText('p-target', r.label ? r.label : fmtCoord(r.target[0], r.target[1]));
    setText('p-basedist', `${r.baseDistKm.toFixed(2)} km`);
    const detour = m.lengthKm - r.straightKm;
    setText('p-len', `${m.lengthKm.toFixed(2)} km${detour > 0.05 ? ` (+${detour.toFixed(2)} detour)` : ''}`);
    setText('p-slope', `${m.slopeKm.toFixed(2)} km`);
    setText('p-eta', fmtDuration(m.hours * (1 - frac)));
    setText('p-out', `−${outRem.toFixed(1)} %`);
    setText('p-back', r.backO2 > 0 ? `−${r.backO2.toFixed(1)} %` : '—');
    setText('p-arr', `${Math.max(0, arrival).toFixed(1)} %`);
    setText('p-home', r.backO2 > 0 ? `${Math.max(0, home).toFixed(1)} %` : '—');
    $('p-arr').className = arrival < reserve ? 'crit' : arrival < reserve + 10 ? 'warn' : 'good';
    $('p-home').className = r.backO2 > 0 ? (home < reserve ? 'crit' : home < reserve + 10 ? 'warn' : 'good') : '';
    $('p-slope').className = m.slopeKm > 0 ? 'warn' : '';
    setChip('p-status', level, verdict);

    const notes = [];
    let noteLevel = 'good';
    if (r.destRad) { notes.push(`Destination lies inside ${r.destRad.name} (${r.destRad.doseUSvH} µSv/h).`); noteLevel = 'crit'; }
    if (!tr && home < reserve && !r.destRad) { notes.push(`Round trip leaves ${Math.max(0, home).toFixed(1)}% O₂, below the ${reserve}% reserve.`); noteLevel = 'crit'; }
    else if (!tr && home < reserve + 10 && !r.destRad) { notes.push('Thin oxygen margin on the round trip.'); if (noteLevel !== 'crit') noteLevel = 'warn'; }
    if (detour > 0.05) notes.push(`Route bends ${detour.toFixed(2)} km around radiation zones.`);
    if (r.destSlope) { notes.push(`Destination is on ${r.destSlope.name} (${r.destSlope.slopeDeg}°).`); if (noteLevel === 'good') noteLevel = 'warn'; }
    if (!notes.length) notes.push(tr ? 'Traverse under way.' : 'Route clear. Oxygen margin sufficient for a round trip.');
    warn.className = `note ${noteLevel}`;
    warn.textContent = notes.join(' ');
  }

  /* ----------------------------------------------------------
     Traverse simulation
     ---------------------------------------------------------- */
  function startTraverse(ptsKm, label) {
    const cum = [0];
    for (let i = 1; i < ptsKm.length; i++) cum.push(cum[i - 1] + dist2(ptsKm[i - 1], ptsKm[i]));
    const total = cum[cum.length - 1];
    if (total < 0.005) { toast('Already at destination.', 'info'); return; }
    state.traverse = { pts: ptsKm, cum, total, done: 0, seg: 0, label };
    updatePlanner();
    updateButtons();
    toast(`Traverse engaged → ${label || 'target'} (${total.toFixed(2)} km)`, 'info');
  }

  function pointAlong(tr, d) {
    let i = tr.seg;
    while (i < tr.pts.length - 2 && d > tr.cum[i + 1]) i++;
    tr.seg = i;
    const segLen = tr.cum[i + 1] - tr.cum[i];
    const t = segLen > 0 ? clamp((d - tr.cum[i]) / segLen, 0, 1) : 1;
    const a = tr.pts[i], b = tr.pts[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  function engageTraverse() {
    if (!state.route || state.traverse) return;
    startTraverse(state.route.ptsKm, state.route.label || 'target');
  }

  function returnToBase() {
    if (state.traverse) { toast('Abort the current traverse first.', 'warn'); return; }
    if (state.suit.oxygen <= 0) return;
    setDestination([base.lat, base.lng], 'Base Habitat');
    if (state.route) {
      state.route.isReturn = true;
      state.route.backO2 = 0;
      updatePlanner();
      engageTraverse();
    }
  }

  function abortTraverse() {
    if (!state.traverse) return;
    state.traverse = null;
    clearRoute();
    toast('Traverse aborted. Holding position.', 'warn');
  }

  function distToBaseKm() {
    return haversineKm([base.lat, base.lng], [state.pos.lat, state.pos.lng]);
  }
  const atBase = () => distToBaseKm() <= EVA.rechargeRadiusKm;

  function recharge() {
    if (!atBase() || state.traverse) return;
    state.suit.oxygen = 100;
    toast('Oxygen tanks recharged to 100%.', 'good');
    persist();
  }

  function logPosition(force = false) {
    const km = proj.toKm(state.pos.lat, state.pos.lng);
    if (!force && state.lastLogKm && dist2(km, state.lastLogKm) < LOG_STEP_KM) return;
    state.lastLogKm = km;
    state.history.push({ t: +state.elapsedH.toFixed(4), lat: +state.pos.lat.toFixed(6), lng: +state.pos.lng.toFixed(6), o2: +state.suit.oxygen.toFixed(1) });
    if (state.history.length > MAX_HISTORY) {
      state.history.splice(0, state.history.length - MAX_HISTORY);
      rebuildTrail();
    } else {
      trailLine.addLatLng([state.pos.lat, state.pos.lng]);
    }
    setText('log-count', `${state.history.length} pts`);
  }

  /* ----------------------------------------------------------
     Alerts
     ---------------------------------------------------------- */
  function setAlert(id, level, msg) {
    if (!level) state.alerts.delete(id);
    else state.alerts.set(id, { level, msg });
  }

  function renderAlerts() {
    const order = { crit: 0, warn: 1, info: 2 };
    const list = [...state.alerts.values()].sort((a, b) => order[a.level] - order[b.level]);
    const sig = JSON.stringify(list);
    if (sig === state.alertSig) return;
    state.alertSig = sig;
    const box = $('alerts');
    box.replaceChildren(...list.map((a) => el('div', { class: `alert ${a.level}`, text: `${a.level === 'crit' ? '⚠ ' : '▲ '}${a.msg}` })));
  }

  /* ----------------------------------------------------------
     Simulation tick
     ---------------------------------------------------------- */
  function tick() {
    const now = performance.now();
    const dtReal = clamp((now - state.lastTickAt) / 1000, 0, 1);
    state.lastTickAt = now;
    const simH = (dtReal * state.simSpeed) / 3600;
    state.elapsedH += simH;

    const s = state.suit;
    const dead = s.oxygen <= 0;
    const terr = terrainAt(state.pos.lat, state.pos.lng);
    const moving = !!state.traverse && !dead;
    const idleAtBase = !moving && atBase();

    // Oxygen burn
    let rate = 0;
    if (!dead && !idleAtBase) {
      rate = moving ? EVA.o2WalkPctPerH * (terr.slope ? EVA.slopeO2Factor : 1) : EVA.o2RestPctPerH;
      s.oxygen = Math.max(0, s.oxygen - rate * simH);
    }

    // Movement along the active route
    if (moving) {
      const tr = state.traverse;
      const speed = EVA.walkSpeedKmH * (terr.slope ? EVA.slopeSpeedFactor : 1);
      tr.done = Math.min(tr.total, tr.done + speed * simH);
      const ll = proj.toLatLng(pointAlong(tr, tr.done));
      state.pos = { lat: ll[0], lng: ll[1] };
      astroMarker.setLatLng(ll);
      logPosition();
      if (tr.done >= tr.total) {
        const label = tr.label || 'destination';
        state.traverse = null;
        routeGroup.clearLayers();
        state.route = null;
        logPosition(true);
        toast(`Arrived at ${label} · O₂ ${s.oxygen.toFixed(1)}%`, 'good');
        updateButtons();
      }
    }
    if (s.oxygen <= 0 && state.traverse) {
      state.traverse = null;
      toast('Oxygen depleted — traverse halted.', 'crit');
      updateButtons();
    }

    stepVitals(dtReal, { moving, terr, dead: s.oxygen <= 0 });

    const ctx = { terr: terrainAt(state.pos.lat, state.pos.lng), rate, moving: !!state.traverse, idleAtBase: !state.traverse && atBase() };
    updateHud(ctx);
    updatePlanner();
    updateButtons();

    if (now - state.lastSaveAt > SAVE_EVERY_MS) { state.lastSaveAt = now; persist(); }
  }

  function stepVitals(dtReal, c) {
    const s = state.suit;
    let hrT = SUIT.restHr;
    if (c.moving) hrT = SUIT.walkHr;
    if (c.terr.slope) hrT += 20;
    if (c.terr.rad) hrT += 8;
    if (s.oxygen <= EVA.reservePct + 15) hrT += 10;
    if (c.dead) hrT = 150;
    s.heartRate = clamp(s.heartRate + (hrT - s.heartRate) * Math.min(1, dtReal * 0.6) + (Math.random() - 0.5) * 2.2, 45, 190);

    let pT = SUIT.nominalPsi;
    if (c.dead) pT = 3.2;
    else if (s.oxygen < 10) pT = 4.12;
    s.pressure = clamp(s.pressure + (pT - s.pressure) * Math.min(1, dtReal * 0.5) + (Math.random() - 0.5) * 0.012, 2.5, 5);
  }

  /* ----------------------------------------------------------
     HUD rendering
     ---------------------------------------------------------- */
  function updateHud(c) {
    const s = state.suit;
    const reserve = EVA.reservePct;
    const dead = s.oxygen <= 0;

    // Oxygen
    setText('o2-val', s.oxygen.toFixed(1));
    $('o2-fill').style.width = `${s.oxygen}%`;
    $('o2-bar').setAttribute('aria-valuenow', s.oxygen.toFixed(1));
    const o2Level = s.oxygen <= reserve ? 'crit' : s.oxygen <= reserve + 15 ? 'warn' : 'ok';
    setLevel($('o2-bar'), o2Level);
    $('o2-val').className = o2Level === 'ok' ? '' : o2Level;
    setText('o2-burn', `BURN ${c.rate.toFixed(1)} %/h`);
    setText('o2-end', `ENDURANCE ${fmtDuration(s.oxygen / EVA.o2WalkPctPerH)} @WALK`);

    // Pressure
    setText('psi-val', s.pressure.toFixed(2));
    const psiLevel = s.pressure < 4.0 ? 'crit' : s.pressure < 4.2 ? 'warn' : 'blue';
    $('psi-fill').style.width = `${clamp(((s.pressure - 3) / 2) * 100, 0, 100)}%`;
    $('psi-bar').setAttribute('aria-valuenow', s.pressure.toFixed(2));
    setLevel($('psi-bar'), psiLevel);
    $('psi-val').className = psiLevel === 'blue' ? 'blue' : psiLevel;
    setText('psi-state', psiLevel === 'crit' ? 'LOW PRESSURE' : psiLevel === 'warn' ? 'DRIFTING' : 'STABLE');

    // Heart rate
    const hr = Math.round(s.heartRate);
    setText('hr-val', String(hr));
    $('hr-icon').style.setProperty('--beat', `${(60 / Math.max(40, hr)).toFixed(2)}s`);
    const hrLevel = hr >= 150 ? 'crit' : hr >= 120 ? 'warn' : '';
    $('hr-val').className = hrLevel;
    setText('hr-state', hr >= 150 ? 'CRITICAL' : hr >= 120 ? 'ELEVATED' : hr >= 90 ? 'ACTIVE' : 'RESTING');
    const dose = c.terr.rad ? c.terr.rad.doseUSvH : EVA.ambientDoseUSvH;
    setText('rad-val', `RAD ${dose} µSv/h`);

    const nowMs = performance.now();
    if (nowMs - state.lastSparkAt > 1000) {
      state.lastSparkAt = nowMs;
      state.hrTrend.push(s.heartRate);
      if (state.hrTrend.length > HR_SAMPLES) state.hrTrend.shift();
      drawSpark();
    }

    // Safe return radius (max distance from Hab that still allows a return with reserve intact)
    const perKm = flatPctPerKm() * EVA.returnSafetyFactor;
    const radiusKm = Math.max(0, (s.oxygen - reserve) / perKm);
    const d = distToBaseKm();
    const margin = radiusKm - d;
    setText('srr-val', radiusKm.toFixed(1));
    let srrLevel = 'ok', srrText = 'NOMINAL';
    if (dead) { srrLevel = 'crit'; srrText = 'NO O₂'; }
    else if (c.idleAtBase) { srrLevel = 'ok'; srrText = 'AT HAB'; }
    else if (margin < 0) { srrLevel = 'crit'; srrText = 'OUT OF RANGE'; }
    else if (margin < 2) { srrLevel = 'warn'; srrText = 'CAUTION'; }
    setChip('srr-status', srrLevel, srrText);
    setText('srr-detail', `Hab ${d.toFixed(2)} km · margin ${margin >= 0 ? '+' : ''}${margin.toFixed(1)} km`);
    if (Math.abs(radiusKm - state.lastR) > 0.02) {
      state.lastR = radiusKm;
      safePoly.setLatLngs(circlePts([base.lat, base.lng], Math.max(0.01, radiusKm)));
    }

    // Navigation info
    setText('pos-val', fmtCoord(state.pos.lat, state.pos.lng));
    setText('dist-val', `${d.toFixed(2)} km`);
    const tv = $('terrain-val');
    if (c.terr.rad) { setText('terrain-val', `☢ ${c.terr.rad.name}`); tv.className = 'crit'; }
    else if (c.terr.slope) { setText('terrain-val', `▲ ${c.terr.slope.name} · ${c.terr.slope.slopeDeg}°`); tv.className = 'warn'; }
    else { setText('terrain-val', 'FLAT · TRAFFICABLE'); tv.className = 'good'; }

    // Clock
    setText('met', fmtClock(state.elapsedH));

    // Alerts
    setAlert('o2', dead ? 'crit' : s.oxygen <= reserve ? 'crit' : s.oxygen <= reserve + 15 ? 'warn' : null,
      dead ? 'OXYGEN DEPLETED — SUIT FAILURE' : s.oxygen <= reserve ? `OXYGEN BELOW ${reserve}% RESERVE — RETURN TO HAB` : 'LOW OXYGEN — PLAN RETURN');
    setAlert('range', !dead && !c.idleAtBase && margin < 0 ? 'crit' : null, 'BEYOND SAFE RETURN RADIUS');
    setAlert('rad', c.terr.rad ? 'crit' : null, c.terr.rad ? `RADIATION ZONE: ${c.terr.rad.name} · ${c.terr.rad.doseUSvH} µSv/h` : '');
    setAlert('slope', c.terr.slope ? 'warn' : null, c.terr.slope ? `${c.terr.slope.difficulty || 'ROUGH'} TERRAIN: ${c.terr.slope.name} · ${c.terr.slope.slopeDeg}°` : '');
    setAlert('psi', psiLevel === 'crit' ? 'crit' : null, 'SUIT PRESSURE LOW');
    renderAlerts();

    // Suit state chip
    let chipLevel = 'ok', chipText = 'NOMINAL';
    const hasCrit = [...state.alerts.values()].some((a) => a.level === 'crit');
    const hasWarn = [...state.alerts.values()].some((a) => a.level === 'warn');
    if (dead) { chipLevel = 'crit'; chipText = 'SUIT FAILURE'; }
    else if (hasCrit) { chipLevel = 'crit'; chipText = 'CRITICAL'; }
    else if (hasWarn) { chipLevel = 'warn'; chipText = 'CAUTION'; }
    else if (c.idleAtBase) { chipLevel = 'ok'; chipText = 'HAB LINK'; }
    else if (c.moving) { chipLevel = 'info'; chipText = 'EVA ACTIVE'; }
    setChip('suit-state', chipLevel, chipText);
  }

  function drawSpark() {
    const c = $('hr-spark');
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const arr = state.hrTrend;
    if (arr.length < 2) return;
    const dpr = w / 240;
    ctx.beginPath();
    arr.forEach((v, i) => {
      const x = (i / (HR_SAMPLES - 1)) * w;
      const y = h - ((clamp(v, 50, 180) - 50) / 130) * (h - 6 * dpr) - 3 * dpr;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = arr[arr.length - 1] >= 150 ? '#ff3b4f' : arr[arr.length - 1] >= 120 ? '#ffb020' : '#00ffcc';
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function updateButtons() {
    const dead = state.suit.oxygen <= 0;
    const tr = !!state.traverse;
    $('btn-go').disabled = !state.route || tr || dead;
    $('btn-abort').disabled = !tr;
    $('btn-clear').disabled = !state.route || tr;
    $('btn-return').disabled = tr || dead || atBase();
    $('btn-recharge').disabled = tr || !atBase() || state.suit.oxygen >= 100;
  }

  /* ----------------------------------------------------------
     Session management
     ---------------------------------------------------------- */
  function resetSession() {
    state.traverse = null;
    state.route = null;
    routeGroup.clearLayers();
    state.suit = { oxygen: 100, pressure: SUIT.nominalPsi, heartRate: SUIT.restHr };
    state.pos = { lat: base.lat, lng: base.lng };
    state.elapsedH = 0;
    state.history = [];
    state.hrTrend = [];
    state.lastLogKm = null;
    state.lastR = -1;
    state.alerts.clear();
    state.alertSig = '';
    astroMarker.setLatLng([state.pos.lat, state.pos.lng]);
    logPosition(true);
    rebuildTrail();
    persist();
    updatePlanner();
    toast('EVA session reset. Suit restored at the Base Habitat.', 'good');
  }

  function clearLog() {
    state.history = [];
    state.lastLogKm = null;
    rebuildTrail();
    logPosition(true);
    persist();
    toast('Movement log cleared.', 'info');
  }

  /* ----------------------------------------------------------
     UI wiring
     ---------------------------------------------------------- */
  function updateLinkChip() {
    if (navigator.onLine) setChip('link-chip', 'ok', 'ONLINE');
    else setChip('link-chip', 'warn', 'OFFLINE');
  }

  function wireUi() {
    document.querySelectorAll('.toggle[data-layer]').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.layer;
        state.layers[k] = !state.layers[k];
        applyLayerVisibility();
        persist();
      });
    });

    const sel = $('basemap');
    TILE_SOURCES.forEach((s) => sel.append(el('option', { value: s.id, text: s.label })));
    sel.value = state.basemap;
    sel.addEventListener('change', () => { setBasemap(sel.value); persist(); });

    const speed = $('sim-speed');
    speed.value = String(state.simSpeed);
    speed.addEventListener('change', () => { state.simSpeed = Number(speed.value) || 120; persist(); });

    $('btn-center-hab').addEventListener('click', () => map.flyTo([base.lat, base.lng], Math.max(map.getZoom(), 10), { duration: 0.8 }));
    $('btn-locate').addEventListener('click', () => map.flyTo([state.pos.lat, state.pos.lng], Math.max(map.getZoom(), 11), { duration: 0.8 }));

    $('btn-go').addEventListener('click', engageTraverse);
    $('btn-return').addEventListener('click', returnToBase);
    $('btn-abort').addEventListener('click', abortTraverse);
    $('btn-clear').addEventListener('click', clearRoute);
    $('btn-recharge').addEventListener('click', recharge);
    $('btn-clear-log').addEventListener('click', clearLog);
    $('btn-reset').addEventListener('click', () => {
      if (window.confirm('Reset the EVA session? Suit state, position and movement log will be cleared.')) resetSession();
    });

    const hud = $('hud');
    const tog = $('hud-toggle');
    tog.addEventListener('click', () => {
      const collapsed = hud.classList.toggle('collapsed');
      tog.setAttribute('aria-expanded', String(!collapsed));
      tog.textContent = collapsed ? '▴ HUD PANELS' : '▾ HUD PANELS';
      setTimeout(() => map.invalidateSize({ pan: false }), 50);
    });

    // Map interaction
    map.on('click', (e) => setDestination([e.latlng.lat, e.latlng.lng], null));
    let cursorQueued = false;
    map.on('mousemove', (e) => {
      if (cursorQueued) return;
      cursorQueued = true;
      requestAnimationFrame(() => {
        cursorQueued = false;
        setText('cursor', fmtCoord(e.latlng.lat, e.latlng.lng));
      });
    });
    map.on('mouseout', () => setText('cursor', '—'));

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (state.traverse) abortTraverse();
      else if (state.route) clearRoute();
    });

    window.addEventListener('online', () => { updateLinkChip(); toast('Link restored.', 'good'); });
    window.addEventListener('offline', () => { updateLinkChip(); toast('Link lost — running fully offline from local data.', 'warn'); });
    window.addEventListener('beforeunload', persist);
    document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });

    // Hi-DPI heart-rate sparkline canvas
    const spark = $('hr-spark');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    spark.width = 240 * dpr;
    spark.height = 36 * dpr;

    updateLinkChip();
    setText('data-src', dataSource.toUpperCase());
    setText('log-count', `${state.history.length} pts`);
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */
  async function boot() {
    const loaded = await loadData();
    dataSource = loaded.source;
    data = normalize(loaded.raw);
    base = data.base;
    R = data.mission.marsRadiusKm;
    EVA = data.mission.eva;
    SUIT = data.mission.suit;
    proj = makeProjector(base.lat, base.lng, R);
    radZones = data.radiationZones.map((z) => ({ ...z, c: proj.toKm(z.center[0], z.center[1]) }));
    slopeZones = data.slopeZones;

    state.pos = { lat: base.lat, lng: base.lng };
    state.suit = { oxygen: 100, pressure: SUIT.nominalPsi, heartRate: SUIT.restHr };
    const restored = restore();

    initMap();
    renderStatic();
    if (!state.history.length) logPosition(true);
    else {
      const last = state.history[state.history.length - 1];
      state.lastLogKm = proj.toKm(last.lat, last.lng);
    }

    const startMap = navigator.onLine ? (state.basemap || TILE_SOURCES[0].id) : 'offline';
    setBasemap(startMap);
    fitInitialView();
    wireUi();

    state.lastTickAt = performance.now();
    tick();
    setInterval(tick, TICK_MS);

    if (loaded.source !== 'data.json') {
      toast(loaded.source === 'local cache'
        ? 'data.json unavailable — using locally cached copy.'
        : 'data.json could not be fetched (opened via file://?). Using a minimal built-in dataset — serve the folder over HTTP for the full one.', 'warn', 7000);
    } else if (restored) {
      toast('Previous EVA session restored from local storage.', 'info');
    }
  }

  boot().catch((err) => {
    console.error('[EVA-HUD] Boot failure', err);
    toast(`Startup error: ${err.message}`, 'crit', 10000);
  });
})();
