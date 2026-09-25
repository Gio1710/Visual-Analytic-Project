(() => {
  "use strict";

  const BASE = Date.UTC(2035, 0, 1);
  const DAY = 1440;
  const GAP_MIN = 12 * 60;
  const SSE = "SouthSeafood Express Corp";
  const fromISO = (s) => (Date.parse(`${s}T00:00:00Z`) - BASE) / 60000;
  const toDate = (min) => new Date(BASE + min * 60000);
  const fromDate = (d) => (d.getTime() - BASE) / 60000;
  const PERIOD = [fromISO("2035-02-01"), fromISO("2035-12-01") - 1];

  const fmtInt = d3.format(",");
  const fmtH = (minutes) => `${fmtInt(Math.round(minutes / 60))} h`;
  const isoDay = d3.utcFormat("%Y-%m-%d");
  const fmtDay = d3.utcFormat("%-d %b %Y");
  const fmtShort = d3.utcFormat("%-d %b");
  const KIND_LABEL = { preserve: "Ecological preserve", fishing: "Fishing ground", island: "Island", city: "Port city", buoy: "Navigation buoy", other: "Area" };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const state = { company: -1, vessel: -1, zone: -1, view: "rank", topN: 10, range: null, metric: "preserve" };
  let D, L, V, COMP, P, SSE_IDX, isPreserve, preserveIdx, companyVessels, fleet, stats, geo;

  const $ = (sel) => document.querySelector(sel);
  const app = $("#app");
  const tooltip = $("#tooltip");

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  function showTip(event, html) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const pad = 14;
    const { width, height } = tooltip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + width > window.innerWidth - 8) x = event.clientX - width - pad;
    if (y + height > window.innerHeight - 8) y = event.clientY - height - pad;
    tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
  const hideTip = () => { tooltip.hidden = true; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- Data ----------
  Promise.all([d3.json("data/oceanus.json"), d3.json("data/geography.geojson")])
    .then(([data, geography]) => init(data, geography))
    .catch((err) => {
      console.error(err);
      $("#error-msg").textContent = err.message || String(err);
      $("#error").hidden = false;
    });

  function init(data, geography) {
    D = data;
    geo = geography;
    L = D.locations;
    V = D.vessels;
    COMP = D.companies;
    P = {
      off: D.pings.offsets,
      loc: Int16Array.from(D.pings.loc),
      t: Int32Array.from(D.pings.time),
      dw: Int32Array.from(D.pings.dwell),
    };
    SSE_IDX = COMP.indexOf(SSE);
    isPreserve = L.map((l) => l.kind === "preserve");
    preserveIdx = L.map((_, i) => i).filter((i) => isPreserve[i]);
    companyVessels = COMP.map(() => []);
    V.forEach((v, i) => { if (v.company >= 0) companyVessels[v.company].push(i); });
    fleet = V.map((_, i) => i).filter((i) => V[i].company >= 0);

    const options = $("#search-options");
    COMP.forEach((c) => options.append(h("option", { value: c, label: "Company" })));
    fleet.forEach((vi) => options.append(h("option", { value: V[vi].name, label: `Vessel · ${COMP[V[vi].company]}` })));

    aggregate();
    wireControls();
    app.dataset.state = "ready";
    renderMap();
    update({ animate: false });

    const ro = new ResizeObserver(debounce(() => { renderMap(); update({ animate: false }); }, 150));
    ro.observe($("#map"));
    ro.observe($("#timeline"));

    // Relief colours are baked into the drawing, so redraw when the theme flips.
    const redraw = () => { renderMap(); update({ animate: false }); };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
    new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  function debounce(fn, ms) {
    let id;
    return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
  }

  // Walks every ping once per date range; everything else reads from these totals.
  function aggregate() {
    const [r0, r1] = state.range || [-Infinity, Infinity];
    const nL = L.length;
    const comp = COMP.map(() => ({ pings: 0, minutes: 0, gaps: 0, active: 0 }));
    const zc = new Float64Array(COMP.length * nL);
    const zcp = new Int32Array(COMP.length * nL);
    const zone = L.map(() => ({ pings: 0, minutes: 0 }));
    const ves = V.map(() => ({ pings: 0, minutes: 0, gaps: 0, total: 0 }));

    for (let vi = 0; vi < V.length; vi++) {
      const c = V[vi].company;
      const s = ves[vi];
      let prevEnd = null;
      for (let k = P.off[vi]; k < P.off[vi + 1]; k++) {
        const t = P.t[k];
        if (t < r0 || t > r1) continue;
        const li = P.loc[k];
        const dw = P.dw[k];
        s.total++;
        if (prevEnd !== null && t - prevEnd > GAP_MIN) s.gaps++;
        prevEnd = prevEnd === null ? t + dw : Math.max(prevEnd, t + dw);
        if (c < 0) continue;
        zone[li].pings++;
        zone[li].minutes += dw;
        zc[c * nL + li] += dw;
        zcp[c * nL + li]++;
        if (isPreserve[li]) {
          s.pings++;
          s.minutes += dw;
          comp[c].pings++;
          comp[c].minutes += dw;
        }
      }
      if (c >= 0) {
        comp[c].gaps += s.gaps;
        if (s.total) comp[c].active++;
      }
    }
    const ranking = COMP.map((_, i) => i).filter((i) => comp[i].minutes > 0)
      .sort((a, b) => comp[b].minutes - comp[a].minutes);
    stats = { comp, zc, zcp, zone, ves, ranking };
  }

  function scopeCompanies() {
    if (state.company >= 0) return [state.company];
    const top = stats.ranking.slice(0, state.topN);
    if (SSE_IDX >= 0 && !top.includes(SSE_IDX)) top.push(SSE_IDX);
    return top;
  }

  function scopeVessels() {
    if (state.vessel >= 0) return [state.vessel];
    if (state.company >= 0) return companyVessels[state.company];
    return fleet;
  }

  const trackColor = (vi) => (V[vi].company === SSE_IDX ? "var(--sse)"
    : stats.ves[vi].pings > 0 ? "var(--suspect)" : "var(--track)");
  const companyColor = (ci) => (ci === SSE_IDX ? "var(--sse)" : "var(--suspect)");

  // ---------- Update pipeline ----------
  function update({ reaggregate = false, animate = true } = {}) {
    if (reaggregate) aggregate();
    renderKpis();
    renderTracks();
    renderRegionState();
    renderSide(animate);
    renderTimeline();
    renderFlows();
    syncControls();
  }

  function setRange(range) {
    state.range = range;
    update({ reaggregate: true, animate: false });
  }

  function selectCompany(ci) {
    Object.assign(state, { company: ci, vessel: -1, zone: -1, view: ci >= 0 ? "company" : "rank" });
    update();
  }
  function selectVessel(vi) {
    Object.assign(state, { vessel: vi, company: V[vi].company, zone: -1, view: "vessel" });
    update();
  }
  function openZone(li) {
    Object.assign(state, { zone: li, view: "zone" });
    update();
  }
  function back({ animate = true } = {}) {
    if (state.view === "zone") {
      state.zone = -1;
      state.view = state.vessel >= 0 ? "vessel" : state.company >= 0 ? "company" : "rank";
    } else if (state.view === "vessel") {
      state.vessel = -1;
      state.view = "company";
    } else if (state.view === "company") {
      state.company = -1;
      state.view = "rank";
    } else return;
    update({ animate });
  }

  // ---------- KPIs ----------
  function renderKpis() {
    let active = 0, pings = 0, minutes = 0, gaps = 0;
    for (const vi of scopeVessels()) {
      const s = stats.ves[vi];
      if (s.total) active++;
      pings += s.pings;
      minutes += s.minutes;
      gaps += s.gaps;
    }
    const scope = $("#kpi-scope");
    const name = state.vessel >= 0 ? V[state.vessel].name : state.company >= 0 ? COMP[state.company] : "All fishing companies";
    scope.textContent = name;
    scope.title = name;
    scope.classList.toggle("is-sse", state.company === SSE_IDX);
    if (state.range) {
      scope.append(h("span", { class: "kpi-delta", text: `${fmtShort(toDate(state.range[0]))} – ${fmtShort(toDate(state.range[1]))}` }));
    }
    $("#kpi-vessels").textContent = fmtInt(active);
    $("#kpi-pings").textContent = fmtInt(pings);
    $("#kpi-hours").textContent = fmtInt(Math.round(minutes / 60));
    $("#kpi-gaps").textContent = fmtInt(gaps);
  }

  // ---------- Map ----------
  const map = {};

  function buildProjection(w, hgt) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    const visit = (c) => {
      if (typeof c[0] === "number") {
        minLon = Math.min(minLon, c[0]); maxLon = Math.max(maxLon, c[0]);
        minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
      } else c.forEach(visit);
    };
    geo.features.forEach((f) => visit(f.geometry.coordinates));
    const cos = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const pad = 14;
    const dx = (maxLon - minLon) * cos;
    const dy = maxLat - minLat;
    const k = Math.min((w - pad * 2) / dx, (hgt - pad * 2) / dy);
    const ox = (w - dx * k) / 2;
    const oy = (hgt - dy * k) / 2;
    return {
      bounds: [minLon, maxLon, minLat, maxLat],
      pxPerKm: k / 111.2,
      point: (lon, lat) => [ox + (lon - minLon) * cos * k, oy + (maxLat - lat) * k],
      invert: (x, y) => [minLon + (x - ox) / (cos * k), maxLat - (y - oy) / k],
    };
  }

  // ---------- Procedural relief: bathymetry + island terrain ----------
  function hash2(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const u = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
    const v = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
    const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y) {
    let f = 0, amp = 0.5, fr = 1;
    for (let o = 0; o < 4; o++) { f += amp * vnoise(x * fr, y * fr); fr *= 2; amp *= 0.5; }
    return f / 0.9375;
  }

  function boxBlur(src, gw, gh, r) {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    const n = 2 * r + 1;
    for (let y = 0; y < gh; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * gw + Math.min(gw - 1, Math.max(0, x))];
      for (let x = 0; x < gw; x++) {
        tmp[y * gw + x] = acc / n;
        acc += src[y * gw + Math.min(gw - 1, x + r + 1)] - src[y * gw + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < gw; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(gh - 1, Math.max(0, y)) * gw + x];
      for (let y = 0; y < gh; y++) {
        out[y * gw + x] = acc / n;
        acc += tmp[Math.min(gh - 1, y + r + 1) * gw + x] - tmp[Math.max(0, y - r) * gw + x];
      }
    }
    return out;
  }

  // Two-pass chamfer distance (in cells) to the nearest cell whose mask side equals `target`.
  function chamfer(mask, gw, gh, target) {
    const d = new Float32Array(gw * gh);
    for (let i = 0; i < d.length; i++) d[i] = (mask[i] >= 0.5) === target ? 0 : 1e9;
    const b = Math.SQRT2;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      let v = d[i];
      if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - gw] + 1);
        if (x > 0) v = Math.min(v, d[i - gw - 1] + b);
        if (x < gw - 1) v = Math.min(v, d[i - gw + 1] + b);
      }
      d[i] = v;
    }
    for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x;
      let v = d[i];
      if (!v) continue;
      if (x < gw - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < gh - 1) {
        v = Math.min(v, d[i + gw] + 1);
        if (x < gw - 1) v = Math.min(v, d[i + gw + 1] + b);
        if (x > 0) v = Math.min(v, d[i + gw - 1] + b);
      }
      d[i] = v;
    }
    return d;
  }

  const DEPTHS = [5, 10, 20, 50, 100, 150];
  const HEIGHTS = [20, 60, 120, 200, 300];

  function buildRelief(proj, w, hgt) {
    const cell = 4;
    const x0 = -w * 0.5, y0 = -hgt * 0.5;
    const gw = Math.ceil((2 * w) / cell), gh = Math.ceil((2 * hgt) / cell);
    const toGrid = d3.geoTransform({
      point(x, y) { const p = proj.point(x, y); this.stream.point((p[0] - x0) / cell, (p[1] - y0) / cell); },
    });
    const raster = (features) => {
      const cv = document.createElement("canvas");
      cv.width = gw; cv.height = gh;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      d3.geoPath(toGrid, ctx)({ type: "FeatureCollection", features });
      ctx.fill();
      const px = ctx.getImageData(0, 0, gw, gh).data;
      const out = new Float32Array(gw * gh);
      for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] / 255;
      return out;
    };
    const land = raster(geo.features.filter((f) => kindOf(f) === "island"));
    const shoal = boxBlur(raster(geo.features.filter((f) => ["fishing", "preserve"].includes(kindOf(f)))), gw, gh, 6);
    const toSea = chamfer(land, gw, gh, false);
    const toLand = chamfer(land, gw, gh, true);
    const kmPerCell = cell / proj.pxPerKm;

    const depth = new Float64Array(gw * gh);
    const elev = new Float64Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const [lon, lat] = proj.invert(x0 + (x + 0.5) * cell, y0 + (y + 0.5) * cell);
      if (land[i] >= 0.5) {
        const km = toSea[i] * kmPerCell;
        elev[i] = 420 * (1 - Math.exp(-km / 7)) * (0.45 + 1.1 * fbm(lon * 9 + 40, lat * 9));
        depth[i] = -1;
      } else {
        const km = toLand[i] * kmPerCell;
        const base = 2 + 190 * (1 - Math.exp(-km / 26));
        depth[i] = base * (0.72 + 0.56 * fbm(lon * 3.2, lat * 3.2)) * (1 - 0.62 * shoal[i]);
        elev[i] = -1;
      }
    }
    const gridPath = d3.geoPath(d3.geoTransform({
      point(x, y) { this.stream.point(x0 + x * cell, y0 + y * cell); },
    }));
    const contours = d3.contours().size([gw, gh]);
    const seaBands = contours.thresholds(DEPTHS)(depth).map((c) => ({ value: c.value, d: gridPath(c) }));
    const landBands = contours.thresholds(HEIGHTS)(elev).map((c) => ({ value: c.value, d: gridPath(c) }));

    const soundings = [];
    const spacing = 38;
    for (let py = spacing / 2; py < hgt; py += spacing) {
      for (let px = spacing / 2; px < w; px += spacing) {
        const jx = px + (hash2(px, py) - 0.5) * spacing * 0.7;
        const jy = py + (hash2(py, px) - 0.5) * spacing * 0.7;
        const gx = Math.floor((jx - x0) / cell), gy = Math.floor((jy - y0) / cell);
        const dv = depth[gy * gw + gx];
        if (dv > 3 && hash2(gx, gy) < 0.55) soundings.push({ x: jx, y: jy, depth: Math.round(dv), kind: "sounding" });
      }
    }
    return { seaBands, landBands, soundings };
  }

  function dm(v, pos, neg, digits = 1) {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = +((a - d) * 60).toFixed(digits);
    if (m >= 60) { d += 1; m = 0; }
    const mm = digits ? m.toFixed(digits).padStart(digits + 3, "0") : String(m).padStart(2, "0");
    return `${d}°${mm}′${v >= 0 ? pos : neg}`;
  }

  function renderMap() {
    const host = $("#map");
    d3.select(host).select("svg").remove();
    const w = host.clientWidth;
    const hgt = host.clientHeight;
    if (!w || !hgt) return;
    const proj = buildProjection(w, hgt);
    map.proj = proj;
    map.w = w;
    map.h = hgt;
    const path = d3.geoPath(d3.geoTransform({
      point(x, y) { const p = proj.point(x, y); this.stream.point(p[0], p[1]); },
    }));

    const svg = d3.select(host).insert("svg", ":first-child")
      .attr("viewBox", `0 0 ${w} ${hgt}`)
      .attr("role", "img")
      .attr("aria-label", "Chart of Oceanus with vessel tracks");
    map.svg = svg;

    const defs = svg.append("defs");
    const hatch = defs.append("pattern").attr("id", "hatch").attr("patternUnits", "userSpaceOnUse")
      .attr("width", 6).attr("height", 6).attr("patternTransform", "rotate(45)");
    hatch.append("rect").attr("width", 6).attr("height", 6).style("fill", "var(--sse)").style("fill-opacity", 0.06);
    hatch.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6)
      .style("stroke", "var(--sse)").style("stroke-width", 1.2).style("stroke-opacity", 0.45);

    const world = svg.append("g").attr("class", "world");
    map.world = world;

    const css = getComputedStyle(document.documentElement);
    const tok = (name) => css.getPropertyValue(name).trim();
    const seaRamp = d3.interpolateRgb(tok("--sea-shallow"), tok("--sea"));
    const landRamp = d3.interpolateRgb(tok("--land"), tok("--land-high"));
    const relief = buildRelief(proj, w, hgt);
    const reliefG = world.append("g").attr("class", "relief").attr("aria-hidden", "true");
    reliefG.append("rect").attr("x", -w).attr("y", -hgt).attr("width", w * 3).attr("height", hgt * 3)
      .style("fill", "var(--sea-shallow)");
    reliefG.append("g").selectAll("path").data(relief.seaBands).join("path")
      .attr("class", "depth-band").attr("d", (b) => b.d)
      .style("fill", (b, i) => seaRamp((i + 1) / DEPTHS.length));
    reliefG.append("g").selectAll("path").data(relief.seaBands).join("path")
      .attr("class", (b) => `isobath${b.value >= 50 ? " major" : ""}`).attr("d", (b) => b.d);

    const [minLon, maxLon, minLat, maxLat] = proj.bounds;
    const step = 0.5;
    const lons = d3.range(Math.floor(minLon / step) * step - 2, maxLon + 2, step);
    const lats = d3.range(Math.floor(minLat / step) * step - 2, maxLat + 2, step);
    const gratPath = [
      ...lons.map((lon) => { const a = proj.point(lon, minLat - 3); const b = proj.point(lon, maxLat + 3); return `M${a}L${b}`; }),
      ...lats.map((lat) => { const a = proj.point(minLon - 4, lat); const b = proj.point(maxLon + 4, lat); return `M${a}L${b}`; }),
    ].join("");
    world.append("path").attr("class", "graticule").attr("d", gratPath);

    world.append("g").attr("aria-hidden", "true").selectAll("path")
      .data(geo.features.filter((f) => kindOf(f) === "island"))
      .join("path").attr("class", "surf").attr("d", path);

    world.append("g").selectAll("path")
      .data(geo.features.filter((f) => f.geometry.type !== "Point"))
      .join("path")
      .attr("class", (f) => `region ${kindOf(f)}`)
      .attr("d", path)
      .on("pointermove", (e, f) => regionTip(e, f))
      .on("pointerleave", hideTip)
      .on("click", (e, f) => {
        const li = locIndex(f.properties.Name);
        if (li >= 0 && (L[li].kind === "preserve" || L[li].kind === "fishing")) openZone(li);
      });
    map.regions = world.selectAll(".region");

    const terrain = world.append("g").attr("class", "terrain").attr("aria-hidden", "true");
    terrain.append("g").selectAll("path").data(relief.landBands).join("path")
      .attr("class", "land-band").attr("d", (b) => b.d)
      .style("fill", (b, i) => landRamp((i + 1) / HEIGHTS.length));
    terrain.append("g").selectAll("path").data(relief.landBands).join("path")
      .attr("class", "land-line").attr("d", (b) => b.d);

    map.tracks = world.append("g").attr("class", "tracks");

    const overlay = svg.append("g").attr("class", "overlay");
    map.boatLayer = overlay.append("g").attr("class", "boats");
    map.soundings = overlay.append("g").attr("aria-hidden", "true").selectAll("text").data(relief.soundings).join("text")
      .attr("class", "map-label sounding").attr("text-anchor", "middle").attr("dy", "0.35em")
      .text((d) => d.depth);
    map.gratLabels = overlay.append("g");
    map.gratLabels.selectAll("text.lon").data(lons).join("text")
      .attr("class", "grat-label lon").attr("text-anchor", "middle").text((d) => dm(d, "E", "W", 0));
    map.gratLabels.selectAll("text.lat").data(lats).join("text")
      .attr("class", "grat-label lat").attr("dy", "-0.35em").text((d) => dm(d, "N", "S", 0));

    const places = L.map((l, i) => ({ ...l, i })).filter((l) => l.kind === "city" || l.kind === "buoy");
    map.places = overlay.append("g").selectAll("g").data(places).join("g").attr("class", (d) => `place ${d.kind}`);
    map.places.append("circle").attr("class", (d) => `place-dot ${d.kind}`).attr("r", (d) => (d.kind === "city" ? 3.5 : 2));
    map.places.append("text").attr("class", (d) => `map-label ${d.kind === "buoy" ? "buoy" : ""}`)
      .attr("x", 6).attr("dy", "0.35em").text((d) => d.name);

    const areaLabels = L.map((l, i) => ({ ...l, i })).filter((l) => ["preserve", "fishing", "island"].includes(l.kind));
    map.areaLabels = overlay.append("g").selectAll("text").data(areaLabels).join("text")
      .attr("class", (d) => `map-label ${d.kind === "island" ? "" : "water"} ${d.kind}`)
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .text((d) => d.name);

    map.locPt = L.map((l) => proj.point(l.lon, l.lat));

    map.zoom = d3.zoom()
      .scaleExtent([1, 14])
      .translateExtent([[-w * 0.5, -hgt * 0.5], [w * 1.5, hgt * 1.5]])
      .on("zoom", (e) => {
        map.t = e.transform;
        world.attr("transform", e.transform);
        positionOverlay();
      });
    map.t = d3.zoomIdentity;
    svg.call(map.zoom);
    positionOverlay();

    svg.on("pointermove.readout", (e) => {
      const [x, y] = map.t.invert(d3.pointer(e));
      const [lon, lat] = proj.invert(x, y);
      $("#readout").textContent = `${dm(lat, "N", "S")}  ${dm(lon, "E", "W")}`;
    });
  }

  function positionOverlay() {
    const t = map.t;
    const lonPx = t.k * (map.proj.point(1, 0)[0] - map.proj.point(0.5, 0)[0]);
    const latPx = t.k * (map.proj.point(0, 0)[1] - map.proj.point(0, 0.5)[1]);
    const lonEvery = Math.ceil(78 / lonPx);
    const latEvery = Math.ceil(30 / latPx);
    map.gratLabels.selectAll("text.lon")
      .attr("x", (d) => t.applyX(map.proj.point(d, 0)[0]))
      .attr("y", 14)
      .attr("display", (d, i) => {
        const x = t.applyX(map.proj.point(d, 0)[0]);
        return i % lonEvery || x < 90 || x > map.w - 60 ? "none" : null;
      });
    map.gratLabels.selectAll("text.lat")
      .attr("x", 6)
      .attr("y", (d) => t.applyY(map.proj.point(0, d)[1]))
      .attr("display", (d, i) => {
        const y = t.applyY(map.proj.point(0, d)[1]);
        return i % latEvery || y < 30 || y > map.h - 36 ? "none" : null;
      });
    map.places.attr("transform", (d) => `translate(${t.apply(map.proj.point(d.lon, d.lat))})`);
    map.areaLabels.attr("transform", (d) => `translate(${t.apply(map.proj.point(d.lon, d.lat))})`);
    map.soundings.attr("transform", (d) => `translate(${t.apply([d.x, d.y])})`);
    positionBoats();
    declutter();
  }

  // Greedy label placement: higher-priority labels claim space first, overlapping ones hide.
  const LABEL_PRIORITY = { preserve: 0, city: 1, fishing: 2, island: 3, buoy: 4, sounding: 5 };
  function declutter() {
    const labels = [
      ...map.areaLabels.nodes(),
      ...map.places.select("text").nodes(),
      ...map.soundings.nodes(),
    ].sort((a, b) => LABEL_PRIORITY[a.__data__.kind] - LABEL_PRIORITY[b.__data__.kind]);
    const placed = [];
    for (const el of labels) {
      if ((el.__data__.kind === "buoy" && map.t.k < 1.8) || (el.__data__.kind === "sounding" && map.t.k < 1.6)) {
        el.setAttribute("display", "none");
        continue;
      }
      el.removeAttribute("display");
      const b = el.getBoundingClientRect();
      const hit = placed.some((p) => b.left < p.right + 2 && b.right > p.left - 2 && b.top < p.bottom && b.bottom > p.top);
      if (hit) el.setAttribute("display", "none");
      else placed.push(b);
    }
  }

  const kindOf = (f) => ({ "Ecological Preserve": "preserve", "Fishing Ground": "fishing", Island: "island" }[f.properties["*Kind"]] || "other");
  const locIndex = (name) => L.findIndex((l) => l.name === name);

  function regionTip(e, f) {
    const li = locIndex(f.properties.Name);
    const l = L[li];
    if (!l) return;
    const z = stats.zone[li];
    let html = `<b>${esc(l.name)}</b><br>${KIND_LABEL[l.kind]}`;
    if (z.pings) html += `<br><span class="tt-num">${fmtH(z.minutes)}</span> fleet dwell · <span class="tt-num">${fmtInt(z.pings)}</span> pings`;
    if (l.fish) html += `<br>${l.fish.map(esc).join(", ")}`;
    showTip(e, html);
  }

  function hash(n) {
    let x = (n + 1) * 2654435761;
    x ^= x >>> 13;
    return (x >>> 0) / 4294967295;
  }

  function renderTracks() {
    if (!map.tracks) return;
    const g = map.tracks;
    g.selectAll("*").remove();
    const [r0, r1] = state.range || [-Infinity, Infinity];
    const vessels = state.company >= 0 ? companyVessels[state.company]
      : scopeCompanies().flatMap((ci) => companyVessels[ci]);
    const ordered = [...vessels].sort((a, b) => (V[a].company === SSE_IDX) - (V[b].company === SSE_IDX));
    const spread = Math.min(map.w, map.h) * 0.012;
    const boats = [];

    for (const vi of ordered) {
      const jx = (hash(vi) - 0.5) * spread;
      const jy = (hash(vi + 999) - 0.5) * spread;
      const segs = [];
      const gaps = [];
      const times = [], xs = [], ys = [];
      let seg = [];
      let prevLoc = -1, prevEnd = null, prevPt = null;
      for (let k = P.off[vi]; k < P.off[vi + 1]; k++) {
        const t = P.t[k];
        if (t < r0 || t > r1) continue;
        const li = P.loc[k];
        const base = map.locPt[li];
        const pt = [base[0] + jx, base[1] + jy];
        if (times.length && t < times[times.length - 1]) times[times.length - 1] = t;
        times.push(t, t + P.dw[k]);
        xs.push(pt[0], pt[0]);
        ys.push(pt[1], pt[1]);
        if (prevEnd !== null && t - prevEnd > GAP_MIN) {
          if (seg.length > 1) segs.push(seg);
          if (prevPt && li !== prevLoc) gaps.push({ a: prevPt, b: pt, minutes: t - prevEnd, at: prevEnd });
          seg = [pt];
        } else if (li !== prevLoc) seg.push(pt);
        prevLoc = li;
        prevPt = pt;
        prevEnd = prevEnd === null ? t + P.dw[k] : Math.max(prevEnd, t + P.dw[k]);
      }
      if (seg.length > 1) segs.push(seg);
      if (times.length) {
        const n = xs.length - 1;
        let j = n;
        while (j > 0 && xs[j] === xs[n] && ys[j] === ys[n]) j--;
        const heading = j < n && (xs[j] !== xs[n] || ys[j] !== ys[n])
          ? Math.atan2(ys[n] - ys[j], xs[n] - xs[j]) * 180 / Math.PI + 90
          : hash(vi + 7) * 360;
        boats.push({ vi, times, xs, ys, x: xs[n], y: ys[n], heading, visible: true, s: 0.75 + Math.min(V[vi].length || 40, 120) / 160 });
      }
      if (!segs.length && !gaps.length) continue;

      const isSse = V[vi].company === SSE_IDX;
      const suspect = stats.ves[vi].pings > 0;
      g.selectAll(null).data(gaps).join("path")
        .attr("class", "track gap")
        .attr("data-v", vi)
        .attr("d", (d) => `M${d.a}L${d.b}`)
        .on("pointermove", (e, d) => showTip(e, `<b>Transponder dark</b><br>${esc(V[vi].name)}<br><span class="tt-num">${fmtInt(Math.round(d.minutes / 60))} h</span> from ${fmtDay(toDate(d.at))}`))
        .on("pointerleave", hideTip);
      g.append("path")
        .attr("class", "track")
        .attr("data-v", vi)
        .attr("d", segs.map((s) => `M${s.join("L")}`).join(""))
        .style("stroke", trackColor(vi))
        .style("stroke-width", isSse ? 2.2 : suspect ? 1.2 : 1)
        .style("stroke-opacity", isSse ? 0.9 : suspect ? 0.5 : 0.35)
        .on("pointerenter", () => focusTrack(vi))
        .on("pointermove", (e) => {
          const s = stats.ves[vi];
          showTip(e, `<b>${esc(V[vi].name)}</b><br>${esc(COMP[V[vi].company] || "No company")}<br><span class="tt-num">${fmtH(s.minutes)}</span> in preserves · <span class="tt-num">${s.gaps}</span> gaps`);
        })
        .on("pointerleave", () => { hideTip(); focusTrack(state.vessel); })
        .on("click", (e) => { e.stopPropagation(); selectVessel(vi); });
    }
    renderBoats(boats);
    focusTrack(state.vessel);
  }

  // Top-down fishing-vessel silhouette, bow pointing up, ~20 px long at scale 1.
  const HULL = "M0,-10C2.6,-7 3.6,-3.5 3.6,1L3.6,8.2Q3.6,9.5 2.3,9.5L-2.3,9.5Q-3.6,9.5 -3.6,8.2L-3.6,1C-3.6,-3.5 -2.6,-7 0,-10Z";
  const CABIN = "M-2.1,1.8h4.2v4.4h-4.2z";

  function renderBoats(boats) {
    stopReplay();
    map.boatData = boats.sort((a, b) => (V[a.vi].company === SSE_IDX) - (V[b.vi].company === SSE_IDX));
    map.boatSel = map.boatLayer.selectAll("g.boat").data(map.boatData, (d) => d.vi).join((enter) => {
      const g = enter.append("g").attr("class", "boat");
      g.append("path").attr("class", "hull").attr("d", HULL);
      g.append("path").attr("class", "cabin").attr("d", CABIN);
      return g;
    });
    map.boatSel.select(".hull").style("fill", (d) => trackColor(d.vi));
    map.boatSel
      .on("pointerenter", (e, d) => focusTrack(d.vi))
      .on("pointermove", (e, d) => {
        const s = stats.ves[d.vi];
        const v = V[d.vi];
        showTip(e, `<b>${esc(v.name)}</b><br>${esc(COMP[v.company] || "No company")}<br>${v.length ?? "–"} m · ${v.tonnage ?? "–"} t<br><span class="tt-num">${fmtH(s.minutes)}</span> in preserves`);
      })
      .on("pointerleave", () => { hideTip(); focusTrack(state.vessel); })
      .on("click", (e, d) => { e.stopPropagation(); selectVessel(d.vi); });
    positionBoats();
  }

  function positionBoats() {
    if (!map.boatSel) return;
    const t = map.t;
    const zoomScale = Math.min(1.6, 0.85 + t.k * 0.15);
    map.boatSel
      .attr("display", (d) => (d.visible ? null : "none"))
      .attr("transform", (d) => `translate(${t.apply([d.x, d.y])}) rotate(${d.heading}) scale(${d.s * zoomScale})`)
      .classed("is-dim", (d) => state.vessel >= 0 && d.vi !== state.vessel);
  }

  // ---------- Replay: move every boat along its pings through the selected period ----------
  const replay = { raf: 0, playing: false };
  const fmtStamp = d3.utcFormat("%-d %b %Y · %H:%M");

  function placeBoatsAt(T) {
    for (const b of map.boatData) {
      const n = b.times.length;
      if (T < b.times[0]) { b.visible = false; continue; }
      b.visible = true;
      const i = Math.min(d3.bisectRight(b.times, T) - 1, n - 1);
      if (i >= n - 1) { b.x = b.xs[n - 1]; b.y = b.ys[n - 1]; continue; }
      const span = b.times[i + 1] - b.times[i];
      const f = span > 0 ? (T - b.times[i]) / span : 1;
      const dx = b.xs[i + 1] - b.xs[i];
      const dy = b.ys[i + 1] - b.ys[i];
      b.x = b.xs[i] + dx * f;
      b.y = b.ys[i] + dy * f;
      if (dx || dy) b.heading = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    }
    positionBoats();
  }

  function startReplay() {
    if (!map.boatData || !map.boatData.length) return;
    const [r0, r1] = state.range || PERIOD;
    const duration = 16000;
    const start = performance.now();
    replay.playing = true;
    $("#replay").setAttribute("aria-pressed", "true");
    $("#replay-label").textContent = "Stop";
    map.tracks.classed("is-replaying", true);
    const step = (now) => {
      if (!replay.playing) return;
      const p = Math.min((now - start) / duration, 1);
      const T = r0 + (r1 - r0) * p;
      placeBoatsAt(T);
      $("#replay-time").textContent = fmtStamp(toDate(T));
      if (p < 1) replay.raf = requestAnimationFrame(step);
      else stopReplay();
    };
    replay.raf = requestAnimationFrame(step);
  }

  function stopReplay() {
    if (!replay.playing) return;
    replay.playing = false;
    cancelAnimationFrame(replay.raf);
    $("#replay").setAttribute("aria-pressed", "false");
    $("#replay-label").textContent = "Replay";
    $("#replay-time").textContent = "";
    map.tracks.classed("is-replaying", false);
    placeBoatsAt(Infinity);
  }

  function focusTrack(vi) {
    if (!map.tracks) return;
    map.tracks.classed("has-focus", vi >= 0);
    map.tracks.selectAll(".track").classed("is-focus", function () { return +this.dataset.v === vi; });
    if (vi >= 0) map.tracks.selectAll(".track.is-focus").raise();
  }

  function renderRegionState() {
    if (!map.regions) return;
    map.regions.classed("is-selected", (f) => state.zone >= 0 && f.properties.Name === L[state.zone].name);
  }

  function zoomBy(k) {
    map.svg.transition().duration(reduceMotion.matches ? 0 : 220).ease(d3.easeCubicOut).call(map.zoom.scaleBy, k);
  }
  function zoomFit() {
    map.svg.transition().duration(reduceMotion.matches ? 0 : 260).ease(d3.easeCubicOut).call(map.zoom.transform, d3.zoomIdentity);
  }

  // ---------- Side panel ----------
  function renderSide(animate) {
    const host = $("#side-view");
    const content = state.view === "vessel" ? vesselView()
      : state.view === "company" ? companyView()
        : state.view === "zone" ? zoneView() : rankView();
    host.replaceChildren(...content);
    if (animate && !reduceMotion.matches) {
      host.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }],
        { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    }
  }

  function rankList(items, onPick) {
    const max = d3.max(items, (d) => d.value) || 1;
    return h("ol", { class: "rank" }, items.map((d, i) => h("li", {},
      h("button", { type: "button", class: `rank-item${d.sse ? " is-sse" : ""}`, onclick: () => onPick(d.id) },
        h("span", { class: "rank-n", text: d.n ?? i + 1 }),
        h("span", { class: "rank-name", text: d.name, title: d.name }),
        h("span", { class: "rank-val", text: d.label }),
        h("span", { class: "rank-bar" }, h("i", { style: `transform: scaleX(${Math.max(d.value / max, 0.01)})` }))))));
  }

  function statGrid(rows) {
    return h("dl", { class: "stat-grid" }, rows.map(([k, v]) => h("div", { class: "stat" }, h("dt", { text: k }), h("dd", { text: v }))));
  }

  function head({ eyebrow, meta, title, sse, backLabel }) {
    return h("div", { class: "side-head" },
      backLabel ? h("button", { type: "button", class: "back", onclick: () => back() }, `← ${backLabel}`) : null,
      h("div", { class: "side-eyebrow" }, h("span", { text: eyebrow }), meta ? h("span", { text: meta }) : null),
      h("h2", { class: `side-title${sse ? " is-sse" : ""}`, text: title }));
  }

  function rankView() {
    const items = stats.ranking.map((ci) => ({ id: ci, name: COMP[ci], value: stats.comp[ci].minutes, label: fmtH(stats.comp[ci].minutes), sse: ci === SSE_IDX }));
    const body = [];
    if (SSE_IDX >= 0 && !stats.ranking.includes(SSE_IDX)) {
      body.push(h("p", { class: "side-note" }, h("strong", { text: SSE }), " logged no dwell time inside preserves in this period. Its tracks stay on the chart in red."));
    }
    body.push(items.length ? rankList(items, selectCompany) : h("div", { class: "empty", text: "No preserve activity in this period." }));
    return [
      head({ eyebrow: "By hours inside preserves", meta: `${items.length} companies`, title: "Suspect companies" }),
      h("div", { class: "side-body" }, body),
    ];
  }

  function companyView() {
    const ci = state.company;
    const c = stats.comp[ci];
    const rank = stats.ranking.indexOf(ci);
    const vessels = companyVessels[ci].map((vi) => ({ id: vi, name: V[vi].name, value: stats.ves[vi].minutes, label: fmtH(stats.ves[vi].minutes), sse: ci === SSE_IDX }))
      .sort((a, b) => b.value - a.value);
    const zones = preserveIdx.map((li) => ({ li, m: stats.zc[ci * L.length + li] })).filter((z) => z.m > 0).sort((a, b) => b.m - a.m);
    return [
      head({ eyebrow: "Company", meta: rank >= 0 ? `Rank ${rank + 1} of ${stats.ranking.length}` : "Not ranked", title: COMP[ci], sse: ci === SSE_IDX, backLabel: "All suspects" }),
      h("div", { class: "side-body" },
        statGrid([["Vessels", fmtInt(companyVessels[ci].length)], ["Hours in preserves", fmtInt(Math.round(c.minutes / 60))], ["Pings in preserves", fmtInt(c.pings)], ["Transponder gaps", fmtInt(c.gaps)]]),
        h("p", { class: "section-label", text: "Time by preserve" }),
        zones.length
          ? h("div", { class: "chips" }, zones.map((z) => h("button", { type: "button", class: "chip", onclick: () => openZone(z.li), text: `${L[z.li].name} · ${fmtH(z.m)}` })))
          : h("p", { class: "side-note", text: "No dwell time inside preserves in this period." }),
        h("p", { class: "section-label", text: "Vessels" }),
        rankList(vessels.map((v, i) => ({ ...v, n: i + 1 })), selectVessel)),
    ];
  }

  function visitsOf(vi) {
    const [r0, r1] = state.range || [-Infinity, Infinity];
    const visits = [];
    let cur = null;
    for (let k = P.off[vi]; k < P.off[vi + 1]; k++) {
      const t = P.t[k];
      if (t < r0 || t > r1) continue;
      const li = P.loc[k];
      if (!isPreserve[li]) { cur = null; continue; }
      if (cur && cur.li === li) cur.minutes += P.dw[k];
      else visits.push(cur = { li, start: t, minutes: P.dw[k] });
    }
    return visits.reverse();
  }

  function vesselView() {
    const vi = state.vessel;
    const v = V[vi];
    const s = stats.ves[vi];
    const visits = visitsOf(vi);
    const shown = visits.slice(0, 60);
    return [
      head({ eyebrow: `${v.type.replace(/\./g, " · ").replace(/([a-z])([A-Z])/g, "$1 $2")}${v.flag ? ` · ${v.flag}` : ""}`, title: v.name, sse: v.company === SSE_IDX, backLabel: COMP[v.company] }),
      h("div", { class: "side-body" },
        statGrid([["Hours in preserves", fmtInt(Math.round(s.minutes / 60))], ["Preserve visits", fmtInt(visits.length)], ["Transponder gaps", fmtInt(s.gaps)], ["Tonnage · length", `${v.tonnage ?? "–"} t · ${v.length ?? "–"} m`]]),
        h("p", { class: "section-label", text: visits.length > shown.length ? `Latest preserve visits · ${shown.length} of ${visits.length}` : "Preserve visits" }),
        shown.length
          ? h("ul", { class: "visits" }, shown.map((d) => h("li", {},
            h("span", {}, h("span", { class: "when", text: fmtDay(toDate(d.start)) }), ` · ${L[d.li].name}`),
            h("span", { class: "when", text: fmtH(d.minutes) }))))
          : h("p", { class: "side-note", text: "No visits to preserves in this period." }),
        s.gaps ? h("p", { class: "side-note", text: "Dashed lines on the chart mark stretches of more than 12 hours between the end of one ping and the next, when the transponder went quiet." }) : null),
    ];
  }

  // Stylised side-view illustrations of the ten Oceanus species (fish face right, 64×32 box).
  const FISH = {
    Beauvoir: { c: "#c9a13f", h: 0.62, tail: "fork", mark: "bars" },
    Birdseye: { c: "#8d9ea9", h: 0.42, tail: "fork", eye: 3 },
    Cod: { c: "#86794f", h: 0.44, tail: "round", mark: "spots", barbel: true },
    Harland: { c: "#6f8a6c", h: 0.4, tail: "fork", mark: "spots" },
    Helenaa: { c: "#5a7ea6", h: 0.34, tail: "fork", dorsal: 1.7 },
    Offidiaa: { c: "#6e6a8c", h: 0.22, tail: "eel" },
    Salmon: { c: "#c78782", h: 0.4, tail: "notch", mark: "spots" },
    Sockfish: { c: "#9a5a45", h: 0.5, tail: "round" },
    Tuna: { c: "#3f5d7c", h: 0.46, tail: "fork", finlets: true },
    Wrasse: { c: "#3e8c7d", h: 0.52, tail: "round", mark: "stripes" },
  };
  let fishId = 0;
  function fishSvg(name) {
    const f = FISH[name];
    if (!f) return "";
    const id = `fish-${++fishId}`;
    const cy = 16, nose = 61, tb = f.tail === "eel" ? 8 : 15;
    const bh = 15 * f.h;
    const body = `M${nose},${cy}C${nose - 5},${cy - bh * 0.95} ${tb + 16},${cy - bh * 1.05} ${tb},${cy - bh * 0.3}L${tb},${cy + bh * 0.3}C${tb + 16},${cy + bh * 1.05} ${nose - 5},${cy + bh * 0.95} ${nose},${cy}Z`;
    const tails = {
      fork: `M${tb + 2},${cy}L3,${cy - bh * 1.15}Q9,${cy} 3,${cy + bh * 1.15}Z`,
      notch: `M${tb + 2},${cy}L4,${cy - bh * 0.95}L8,${cy}L4,${cy + bh * 0.95}Z`,
      round: `M${tb + 2},${cy - 2}C1,${cy - bh * 1.2} 1,${cy + bh * 1.2} ${tb + 2},${cy + 2}Z`,
      eel: `M${tb + 2},${cy - 1.5}Q2,${cy} ${tb + 2},${cy + 1.5}Z`,
    };
    const dorsal = f.tail === "eel"
      ? `M${tb + 4},${cy - bh * 0.7}Q${(tb + nose) / 2},${cy - bh * 1.5} ${nose - 10},${cy - bh * 0.8}Z`
      : `M${tb + 14},${cy - bh * 0.92}L${tb + 22},${cy - bh * (f.dorsal || 1.45)}L${tb + 30},${cy - bh * 0.98}Z`;
    let marks = "";
    if (f.mark === "bars") marks = [26, 34, 42].map((x) => `<rect x="${x}" y="0" width="3" height="32" fill="#000" opacity="0.18"/>`).join("");
    if (f.mark === "stripes") marks = [cy - bh * 0.35, cy + bh * 0.15].map((y) => `<rect x="0" y="${y}" width="64" height="2" fill="#fff" opacity="0.35"/>`).join("");
    if (f.mark === "spots") marks = [[28, cy - bh * 0.5], [36, cy - bh * 0.3], [44, cy - bh * 0.55], [32, cy + 1], [22, cy - bh * 0.2]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.3" fill="#000" opacity="0.28"/>`).join("");
    const finlets = f.finlets ? [18, 21, 24].map((x) => `<path d="M${x},${cy - bh * 0.42}l1.5,-2l1.5,2Z M${x},${cy + bh * 0.42}l1.5,2l1.5,-2Z" fill="${f.c}"/>`).join("") : "";
    const barbel = f.barbel ? `<path d="M${nose - 3},${cy + bh * 0.45}q1,3 -1,5" fill="none" stroke="${f.c}" stroke-width="0.8"/>` : "";
    const er = f.eye || 1.9;
    return `<svg viewBox="0 0 64 32" aria-hidden="true"><defs><linearGradient id="${id}-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${d3.color(f.c).darker(0.6)}"/><stop offset="0.55" stop-color="${f.c}"/><stop offset="1" stop-color="${d3.interpolateRgb(f.c, "#f3efe4")(0.75)}"/></linearGradient><clipPath id="${id}-c"><path d="${body}"/></clipPath></defs>`
      + `<path d="${tails[f.tail]}" fill="${d3.color(f.c).darker(0.3)}"/><path d="${dorsal}" fill="${d3.color(f.c).darker(0.4)}"/>${finlets}`
      + `<path d="${body}" fill="url(#${id}-g)"/><g clip-path="url(#${id}-c)">${marks}</g>`
      + `<path d="M${nose - 13},${cy - bh * 0.6}q3,${bh * 0.6} 0,${bh * 1.2}" fill="none" stroke="#000" stroke-opacity="0.25" stroke-width="0.8"/>`
      + `<path d="M${nose - 16},${cy + bh * 0.2}l-5,3l5,0.5Z" fill="${d3.color(f.c).darker(0.5)}" opacity="0.7"/>${barbel}`
      + `<circle cx="${nose - 6}" cy="${cy - bh * 0.28}" r="${er}" fill="#f4f2ea"/><circle cx="${nose - 5.6}" cy="${cy - bh * 0.28}" r="${er * 0.55}" fill="#14233a"/></svg>`;
  }

  function speciesGrid(names) {
    return h("div", { class: "species" }, names.map((n) => {
      const item = h("div", { class: "species-item" });
      item.innerHTML = fishSvg(n);
      item.append(h("span", { text: n }));
      return item;
    }));
  }

  function zoneView() {
    const li = state.zone;
    const l = L[li];
    const z = stats.zone[li];
    const companies = COMP.map((name, ci) => ({ id: ci, name, value: stats.zc[ci * L.length + li], sse: ci === SSE_IDX }))
      .filter((d) => d.value > 0).sort((a, b) => b.value - a.value)
      .map((d) => ({ ...d, label: fmtH(d.value) }));
    return [
      head({ eyebrow: KIND_LABEL[l.kind], title: l.name, backLabel: "Back" }),
      h("div", { class: "side-body" },
        statGrid([["Fleet hours here", fmtInt(Math.round(z.minutes / 60))], ["Pings", fmtInt(z.pings)], ["Companies present", fmtInt(companies.length)], ["Species", fmtInt(l.fish ? l.fish.length : 0)]]),
        l.kind === "preserve" ? h("p", { class: "side-note", text: "Protected area. Every hour a fishing vessel spends here counts towards its company's suspicion score." }) : null,
        l.fish ? [h("p", { class: "section-label", text: "Species recorded here" }), speciesGrid(l.fish)] : null,
        h("p", { class: "section-label", text: "Companies by hours here" }),
        companies.length ? rankList(companies, selectCompany) : h("p", { class: "side-note", text: "No fishing-fleet pings here in this period." })),
    ];
  }

  // ---------- Timeline ----------
  function weeklySeries() {
    const start = d3.utcMonday.floor(toDate(PERIOD[0]));
    const weeks = d3.utcMonday.range(start, toDate(PERIOD[1]));
    const bins = new Float64Array(weeks.length);
    const idx = (min) => Math.floor((BASE + min * 60000 - start.getTime()) / (7 * 864e5));
    if (state.metric === "cargo") {
      D.cargo.day.forEach((day, i) => {
        const b = idx(day * DAY);
        if (b >= 0 && b < bins.length) bins[b] += D.cargo.qty[i];
      });
    } else {
      for (const vi of scopeVessels()) {
        for (let k = P.off[vi]; k < P.off[vi + 1]; k++) {
          if (!isPreserve[P.loc[k]]) continue;
          const b = idx(P.t[k]);
          if (b >= 0 && b < bins.length) bins[b] += P.dw[k] / 60;
        }
      }
    }
    return weeks.map((date, i) => ({ date, value: bins[i] }));
  }

  function renderTimeline() {
    const host = $("#timeline");
    d3.select(host).select("svg").remove();
    const w = host.clientWidth;
    const hgt = host.clientHeight;
    if (!w || !hgt) return;
    const m = { top: 12, right: 16, bottom: 22, left: 46 };
    const iw = w - m.left - m.right;
    const ih = hgt - m.top - m.bottom;
    if (iw < 50 || ih < 40) return;

    const data = weeklySeries();
    const cargo = state.metric === "cargo";
    const color = cargo ? "var(--accent)"
      : state.company === SSE_IDX ? "var(--sse)"
        : state.company >= 0 ? "var(--suspect)" : "var(--accent)";
    const unit = cargo ? "t landed" : "h in preserves";
    $(".timeline-panel .hint").textContent = cargo && state.company >= 0
      ? "Cargo records aren't linked to vessels, so this shows the whole fleet. Drag to filter by date."
      : "Drag across the chart to filter every view by date.";

    const x = d3.scaleUtc().domain([toDate(PERIOD[0]), toDate(PERIOD[1])]).range([0, iw]);
    const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.value) || 1]).nice(4).range([ih, 0]);

    const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${hgt}`)
      .attr("role", "img").attr("aria-label", `Weekly ${unit}`);
    const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);

    g.append("g").selectAll("line").data(y.ticks(4)).join("line")
      .attr("class", "grid-line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`)
      .call(d3.axisBottom(x).ticks(d3.utcMonth.every(iw < 420 ? 2 : 1)).tickFormat(d3.utcFormat("%b")).tickSizeOuter(0));
    g.append("g").attr("class", "axis")
      .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("~s")).tickSize(0).tickPadding(6))
      .call((a) => a.select(".domain").remove());

    const mid = (d) => x(d3.utcDay.offset(d.date, 3.5));
    g.append("path").datum(data).attr("class", "area").style("fill", color)
      .attr("d", d3.area().x(mid).y0(ih).y1((d) => y(d.value)).curve(d3.curveMonotoneX));
    g.append("path").datum(data).attr("class", "area-line").style("stroke", color)
      .attr("d", d3.line().x(mid).y((d) => y(d.value)).curve(d3.curveMonotoneX));

    const focus = g.append("g").attr("display", "none").attr("pointer-events", "none");
    focus.append("line").attr("class", "focus-line").attr("y1", 0).attr("y2", ih);
    const dot = focus.append("circle").attr("class", "focus-dot").attr("r", 3.5).style("stroke", color);

    const brush = d3.brushX().extent([[0, 0], [iw, ih]]).on("end", (e) => {
      if (!e.sourceEvent) return;
      if (!e.selection) { setRange(null); return; }
      const [a, b] = e.selection.map((px) => d3.utcDay.round(x.invert(px)));
      if (b - a < 864e5) { setRange(null); return; }
      setRange([fromDate(a), fromDate(b) - 1]);
    });
    const bg = g.append("g").attr("class", "brush").call(brush);
    if (state.range) bg.call(brush.move, [x(toDate(state.range[0])), x(toDate(state.range[1] + 1))]);

    const bisect = d3.bisector((d) => d.date).center;
    bg.on("pointermove.focus", (e) => {
      const [px] = d3.pointer(e, g.node());
      const d = data[bisect(data, d3.utcDay.offset(x.invert(px), -3.5))];
      if (!d) return;
      focus.attr("display", null).attr("transform", `translate(${mid(d)},0)`);
      dot.attr("cy", y(d.value));
      showTip(e, `Week of ${fmtDay(d.date)}<br><span class="tt-num">${fmtInt(Math.round(d.value))}</span> ${unit}`);
    }).on("pointerleave.focus", () => { focus.attr("display", "none"); hideTip(); });
  }

  // ---------- Flows ----------
  function renderFlows() {
    const host = $("#flows");
    d3.select(host).selectAll("svg, .empty").remove();
    const w = host.clientWidth;
    const hgt = host.clientHeight;
    if (!w || !hgt) return;
    const nL = L.length;
    const companies = scopeCompanies().filter((ci) => stats.comp[ci].minutes > 0);
    const zones = preserveIdx;
    const links = [];
    companies.forEach((ci) => zones.forEach((li) => {
      const v = stats.zc[ci * nL + li];
      if (v > 0) links.push({ ci, li, v, pings: stats.zcp[ci * nL + li] });
    }));
    $("#flows-meta").textContent = state.company >= 0 ? "hours inside each preserve"
      : `top ${state.topN}${SSE_IDX >= 0 && !stats.ranking.slice(0, state.topN).includes(SSE_IDX) ? " + SouthSeafood" : ""} · hours`;
    if (!links.length) {
      host.append(h("div", { class: "empty", text: "No preserve activity for this selection and period." }));
      return;
    }

    const narrow = w < 420;
    const m = { top: 12, bottom: 12, left: narrow ? 108 : 150, right: narrow ? 104 : 132 };
    const nodeW = 7;
    const x0 = m.left;
    const x1 = w - m.right;
    const ih = hgt - m.top - m.bottom;
    const total = d3.sum(links, (d) => d.v);
    const leftGap = Math.min(6, (ih * 0.35) / Math.max(companies.length - 1, 1));
    const rightGap = 14;
    const ky = Math.min((ih - leftGap * (companies.length - 1)) / total, (ih - rightGap * (zones.length - 1)) / total);

    const cTot = new Map(companies.map((ci) => [ci, d3.sum(links.filter((l) => l.ci === ci), (l) => l.v)]));
    const zTot = new Map(zones.map((li) => [li, d3.sum(links.filter((l) => l.li === li), (l) => l.v)]));
    const leftH = d3.sum(companies, (ci) => Math.max(cTot.get(ci) * ky, 1.5)) + leftGap * (companies.length - 1);
    const rightH = d3.sum(zones, (li) => zTot.get(li) * ky) + rightGap * (zones.length - 1);

    const cNode = new Map();
    let yy = m.top + (ih - leftH) / 2;
    companies.forEach((ci) => {
      const hh = Math.max(cTot.get(ci) * ky, 1.5);
      cNode.set(ci, { y: yy, h: hh, off: 0 });
      yy += hh + leftGap;
    });
    const zNode = new Map();
    yy = m.top + (ih - rightH) / 2;
    zones.forEach((li) => {
      const hh = zTot.get(li) * ky;
      zNode.set(li, { y: yy, h: hh, off: 0 });
      yy += hh + rightGap;
    });
    links.forEach((l) => {
      const s = cNode.get(l.ci);
      const t = zNode.get(l.li);
      l.w = l.v * ky;
      l.sy = s.y + s.off + l.w / 2;
      l.ty = t.y + t.off + l.w / 2;
      s.off += l.w;
      t.off += l.w;
    });

    const svg = d3.select(host).append("svg").attr("class", "flows-svg").attr("viewBox", `0 0 ${w} ${hgt}`)
      .attr("role", "img").attr("aria-label", "Hours each company spent in each preserve");
    const cx = (x0 + nodeW + x1) / 2;
    const link = svg.append("g").selectAll("path").data(links).join("path")
      .attr("class", "flow-link")
      .attr("d", (l) => `M${x0 + nodeW},${l.sy}C${cx},${l.sy} ${cx},${l.ty} ${x1},${l.ty}`)
      .style("stroke", (l) => companyColor(l.ci))
      .style("stroke-width", (l) => Math.max(l.w, 1))
      .on("pointerenter", (e, l) => focusFlows((d) => d === l))
      .on("pointermove", (e, l) => showTip(e, `<b>${esc(COMP[l.ci])}</b> → ${esc(L[l.li].name)}<br><span class="tt-num">${fmtH(l.v)}</span> · <span class="tt-num">${fmtInt(l.pings)}</span> pings`))
      .on("pointerleave", () => { hideTip(); focusFlows(null); })
      .on("click", (e, l) => selectCompany(l.ci));

    const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const cG = svg.append("g").selectAll("g").data(companies).join("g").attr("class", "flow-node flow-hit")
      .on("pointerenter", (e, ci) => focusFlows((l) => l.ci === ci))
      .on("pointermove", (e, ci) => showTip(e, `<b>${esc(COMP[ci])}</b><br><span class="tt-num">${fmtH(cTot.get(ci))}</span> in preserves`))
      .on("pointerleave", () => { hideTip(); focusFlows(null); })
      .on("click", (e, ci) => selectCompany(ci));
    cG.append("rect").attr("x", x0).attr("y", (ci) => cNode.get(ci).y).attr("width", nodeW)
      .attr("height", (ci) => cNode.get(ci).h).style("fill", companyColor);
    cG.append("text").attr("class", "flow-label").attr("x", x0 - 8).attr("y", (ci) => cNode.get(ci).y + cNode.get(ci).h / 2)
      .attr("dy", "0.35em").attr("text-anchor", "end")
      .style("fill", (ci) => (ci === SSE_IDX ? "var(--sse)" : null))
      .text((ci) => trunc(COMP[ci], narrow ? 15 : 22));

    const zG = svg.append("g").selectAll("g").data(zones.filter((li) => zTot.get(li) > 0)).join("g").attr("class", "flow-node flow-hit")
      .on("pointerenter", (e, li) => focusFlows((l) => l.li === li))
      .on("pointerleave", () => focusFlows(null))
      .on("click", (e, li) => openZone(li));
    zG.append("rect").attr("x", x1).attr("y", (li) => zNode.get(li).y).attr("width", nodeW)
      .attr("height", (li) => zNode.get(li).h).style("fill", "var(--sse)").style("fill-opacity", 0.85);
    zG.append("text").attr("class", "flow-label zone").attr("x", x1 + nodeW + 8)
      .attr("y", (li) => zNode.get(li).y + zNode.get(li).h / 2).attr("dy", "-0.15em").text((li) => L[li].name);
    zG.append("text").attr("class", "flow-value").attr("x", x1 + nodeW + 8)
      .attr("y", (li) => zNode.get(li).y + zNode.get(li).h / 2).attr("dy", "1.1em").text((li) => fmtH(zTot.get(li)));

    function focusFlows(pred) {
      const p = pred || (state.zone >= 0 && isPreserve[state.zone] ? (l) => l.li === state.zone : null);
      svg.classed("has-focus", !!p);
      link.classed("is-focus", (l) => !!p && p(l));
    }
    focusFlows(null);
  }

  // ---------- Controls ----------
  function syncControls() {
    const search = $("#search");
    if (document.activeElement !== search) {
      search.value = state.vessel >= 0 ? V[state.vessel].name : state.company >= 0 ? COMP[state.company] : "";
    }
    $("#start-date").value = state.range ? isoDay(toDate(state.range[0])) : "";
    $("#end-date").value = state.range ? isoDay(toDate(state.range[1])) : "";
    document.querySelectorAll("#topn button").forEach((b) => b.setAttribute("aria-checked", String(+b.dataset.value === state.topN)));
    document.querySelectorAll("#metric button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === state.metric)));
    $("#topn").style.opacity = state.company >= 0 ? 0.5 : 1;
  }

  function runSearch(q) {
    const s = q.trim().toLowerCase();
    if (!s) {
      if (state.company >= 0 || state.vessel >= 0) selectCompany(-1);
      return;
    }
    const ci = COMP.findIndex((c) => c.toLowerCase() === s);
    if (ci >= 0) return selectCompany(ci);
    const vi = fleet.find((i) => V[i].name.toLowerCase() === s);
    if (vi !== undefined) return selectVessel(vi);
    const partial = COMP.findIndex((c) => c.toLowerCase().includes(s));
    if (partial >= 0) return selectCompany(partial);
    const pv = fleet.find((i) => V[i].name.toLowerCase().includes(s));
    if (pv !== undefined) selectVessel(pv);
  }

  function wireControls() {
    const search = $("#search");
    search.addEventListener("change", () => runSearch(search.value));
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSearch(search.value);
      if (e.key === "Escape") search.blur();
    });

    document.querySelectorAll("#topn button").forEach((b) => b.addEventListener("click", () => {
      state.topN = +b.dataset.value;
      update({ animate: false });
    }));
    document.querySelectorAll("#metric button").forEach((b) => b.addEventListener("click", () => {
      state.metric = b.dataset.value;
      syncControls();
      renderTimeline();
    }));

    const onDate = () => {
      const s = $("#start-date").value;
      const e = $("#end-date").value;
      if (!s && !e) return setRange(null);
      if (!s || !e) return;
      const a = fromISO(s);
      const b = fromISO(e) + DAY - 1;
      setRange(a <= b ? [a, b] : [fromISO(e), fromISO(s) + DAY - 1]);
    };
    $("#start-date").addEventListener("change", onDate);
    $("#end-date").addEventListener("change", onDate);

    $("#reset").addEventListener("click", () => {
      Object.assign(state, { company: -1, vessel: -1, zone: -1, view: "rank", topN: 10, range: null });
      zoomFit();
      update({ reaggregate: true });
    });

    $("#zoom-in").addEventListener("click", () => zoomBy(1.6));
    $("#zoom-out").addEventListener("click", () => zoomBy(1 / 1.6));
    $("#zoom-fit").addEventListener("click", zoomFit);
    $("#replay").addEventListener("click", () => (replay.playing ? stopReplay() : startReplay()));

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        search.focus();
        search.select();
      } else if (e.key === "Escape" && !typing) {
        back({ animate: false });
      }
    });
  }
})();
