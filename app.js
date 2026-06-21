/* RH Agent Monitor — static GitHub Pages build. Re-fetches the snapshot
   state.json (pushed every ~15 min by the Mac during market hours) and renders.
   Read-only. Ages and market-hours are recomputed against the live browser clock
   so freshness stays honest between pushes. */

const POLL_MS = 60000;
const STATE_URL = "./state.json";
const $ = (id) => document.getElementById(id);

let state = null;
let equityRange = "today";
let feedFilter = "all";
const openEntries = new Set(); // journal ts values the user has expanded

// ── time helpers (everything displayed in ET, the bot's clock) ──────────────
const ET = "America/New_York";
function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
}
function fmtDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function etDayKey(ts) {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: ET });
}
function ago(sec) {
  if (sec == null) return "—";
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
const money = (v) => (v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (v, d = 4) => (v == null ? "" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d }));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tickInterval = () => state?.cadence?.tickIntervalMin ?? 45;

// ── top pills ────────────────────────────────────────────────────────────────
function renderTop() {
  const b = state.bot;
  const pill = $("bot-pill");
  if (!b.running) { pill.innerHTML = `<span class="dot"></span>BOT STOPPED`; pill.className = "pill bad"; }
  else if (b.stale) { pill.innerHTML = `<span class="dot"></span>BOT STALE · pid ${b.pid}`; pill.className = "pill warn"; }
  else { pill.innerHTML = `<span class="dot"></span>BOT RUNNING · pid ${b.pid}`; pill.className = "pill ok"; }

  $("market-pill").textContent = b.marketOpen ? "MARKET OPEN" : "MARKET CLOSED";
  $("market-pill").className = "pill " + (b.marketOpen ? "ok" : "dim");

  const lt = $("tick-pill");
  lt.textContent = `last write ${ago(b.lastWriteAgeSec)} ago`;
  lt.className = "pill " + (b.stale ? "warn" : "dim");
}

// ── sparkline (tiny SVG for the portfolio card) ─────────────────────────────
function sparkline(values, up) {
  if (!values || values.length < 2) return "";
  const W = 78, H = 26, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const X = (i) => (i / (values.length - 1)) * W;
  const Y = (v) => H - 2 - ((v - min) / span) * (H - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const c = up ? "var(--green)" : "var(--red)";
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${d} L${W},${H} L0,${H} Z" fill="${c}" opacity="0.12"/>
    <path d="${d}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

// ── stat cards ───────────────────────────────────────────────────────────────
function renderStats() {
  const eq = state.equity;
  const last = eq[eq.length - 1];
  const today = etDayKey(state.now);
  const todayPts = eq.filter((p) => etDayKey(p.ts) === today);
  const dayBase = todayPts[0]?.portfolio_value;
  const pv = last?.portfolio_value;
  const dayDelta = pv != null && dayBase != null ? pv - dayBase : null;
  const core = last?.sleeve_values?.core ?? 0;
  const sat = last?.sleeve_values?.satellite ?? 0;
  const cash = pv != null ? pv - core - sat : null;
  const regime = state.latestTick?.regime ?? state.regimeCache;
  const sparkVals = (todayPts.length >= 2 ? todayPts : eq).map((p) => p.portfolio_value).filter((v) => v != null);
  const up = dayDelta == null ? null : dayDelta >= 0;

  const cards = [
    {
      label: "Portfolio", value: money(pv),
      accent: up == null ? "var(--blue)" : up ? "var(--green)" : "var(--red)",
      cls: up == null ? "" : up ? "up" : "down",
      subCls: up == null ? "" : up ? "up" : "down",
      sub: dayDelta == null ? "no snapshots today"
        : `${dayDelta >= 0 ? "▲ +" : "▼ "}${dayDelta.toFixed(2)} (${((dayDelta / dayBase) * 100).toFixed(2)}%) today`,
      spark: sparkline(sparkVals, up !== false),
    },
    { label: "Core Sleeve", value: money(core), accent: "var(--blue)", sub: pv ? `${((core / pv) * 100).toFixed(0)}% of portfolio` : "" },
    { label: "Satellite Sleeve", value: money(sat), accent: "var(--purple)", sub: pv ? `${((sat / pv) * 100).toFixed(0)}% of portfolio` : (sat ? "" : "no open satellite") },
    { label: "Cash", value: money(cash), accent: "var(--muted)", sub: pv && cash != null ? `${((cash / pv) * 100).toFixed(0)}% of portfolio` : "" },
    {
      label: "Regime", value: regime?.state ? regime.state.toUpperCase().replace(/_/g, "-") : "—",
      accent: regime?.state === "risk_on" ? "var(--green)" : regime?.state === "risk_off" ? "var(--red)" : "var(--yellow)",
      cls: regime?.state ?? "",
      sub: regime ? `VIX ${regime.vix ?? "?"} · SPY ${regime.spy_vs_200dma ?? "?"} 200-DMA (${regime.spy_200dma ?? "?"})` : "",
    },
    { label: "SPY", value: last?.spy_price ? money(last.spy_price) : "—", accent: "var(--cyan)", sub: `as of ${fmtTime(last?.ts)}` },
  ];
  $("stats").innerHTML = cards.map((c) => `
    <div class="stat" style="--accent:${c.accent}">
      <div class="label">${c.label}</div>
      <div class="value ${c.cls ?? ""}">${c.value}</div>
      <div class="sub ${c.subCls ?? ""}">${esc(c.sub)}</div>
      ${c.spark ?? ""}
    </div>`).join("");
}

// ── allocation bar ──────────────────────────────────────────────────────────
function renderAlloc() {
  const last = state.equity[state.equity.length - 1];
  const pv = last?.portfolio_value;
  if (!pv) { $("alloc").innerHTML = `<div class="empty">No equity snapshot yet.</div>`; $("alloc-meta").textContent = ""; return; }
  const core = last.sleeve_values?.core ?? 0;
  const sat = last.sleeve_values?.satellite ?? 0;
  const cash = Math.max(pv - core - sat, 0);
  const seg = (v) => `${(v / pv) * 100}%`;
  $("alloc-meta").textContent = `as of ${fmtTime(last.ts)}`;
  $("alloc").innerHTML = `
    <div class="alloc-bar">
      <span class="core" style="width:${seg(core)}"></span>
      <span class="sat" style="width:${seg(sat)}"></span>
      <span class="cash" style="width:${seg(cash)}"></span>
    </div>
    <div class="alloc-legend">
      ${[["core", "Core", core], ["sat", "Satellite", sat], ["cash", "Cash", cash]].map(([k, lbl, v]) => `
        <div class="item"><span class="swatch ${k}"></span>
          <span class="lbl">${lbl}</span>
          <span class="amt">${money(v)}</span>
          <span class="pct">${((v / pv) * 100).toFixed(0)}%</span>
        </div>`).join("")}
    </div>`;
}

// ── equity chart (hand-rolled SVG, no deps) ─────────────────────────────────
let chartPts = []; // [{x,y,ts,v}] in svg-viewBox coords, for hover
let equitySig = ""; // signature of the last rendered series — skip rebuilds when unchanged
const CHART_W = 780, CHART_H = 248, PADL = 56, PADR = 12, PADT = 14, PADB = 24;

function renderEquity(force = false) {
  const el = $("equity-chart");
  let pts = state.equity.filter((p) => p.portfolio_value != null);
  if (equityRange === "today") {
    const today = etDayKey(state.now);
    pts = pts.filter((p) => etDayKey(p.ts) === today);
  } else if (equityRange === "7d") {
    const cutoff = Date.now() - 7 * 86400 * 1000;
    pts = pts.filter((p) => new Date(p.ts).getTime() >= cutoff);
  }

  // Only rebuild the SVG when the series actually changes. Idle 5s polls keep
  // the existing DOM (so hover/crosshair survive); the draw animation then
  // plays only on real new data, never on every refresh.
  const sig = equityRange + "|" + pts.length + "|" + (pts[pts.length - 1]?.ts ?? "");
  if (!force && sig === equitySig) return;
  const animate = sig !== equitySig;
  equitySig = sig;

  if (pts.length < 2) {
    chartPts = [];
    el.innerHTML = `<div class="empty">Not enough equity snapshots ${equityRange === "today" ? "today" : "in range"} to chart (${pts.length} point${pts.length === 1 ? "" : "s"}).</div>`;
    return;
  }
  const xs = pts.map((p) => new Date(p.ts).getTime());
  const ys = pts.map((p) => p.portfolio_value);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  const yPad = Math.max((yMax - yMin) * 0.15, 0.25);
  yMin -= yPad; yMax += yPad;
  const X = (t) => PADL + ((t - xMin) / (xMax - xMin || 1)) * (CHART_W - PADL - PADR);
  const Y = (v) => PADT + (1 - (v - yMin) / (yMax - yMin || 1)) * (CHART_H - PADT - PADB);

  chartPts = pts.map((p, i) => ({ x: X(xs[i]), y: Y(ys[i]), ts: p.ts, v: p.portfolio_value }));
  const line = chartPts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const up = ys[ys.length - 1] >= ys[0];
  const color = up ? "var(--green)" : "var(--red)";
  const area = `${line} L${chartPts[chartPts.length - 1].x.toFixed(1)},${(CHART_H - PADB).toFixed(1)} L${chartPts[0].x.toFixed(1)},${(CHART_H - PADB).toFixed(1)} Z`;

  let grid = "", labels = "";
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const v = yMin + ((yMax - yMin) * i) / gridLines;
    const y = Y(v).toFixed(1);
    grid += `<line x1="${PADL}" y1="${y}" x2="${CHART_W - PADR}" y2="${y}" stroke="var(--border-soft)" stroke-dasharray="3,5"/>`;
    labels += `<text class="axis" x="${PADL - 8}" y="${+y + 3}" text-anchor="end">${v.toFixed(2)}</text>`;
  }
  // Day-open baseline (first point) so intraday up/down is visually obvious.
  const baseY = Y(ys[0]).toFixed(1);
  const baseline = `<line class="baseline" x1="${PADL}" y1="${baseY}" x2="${CHART_W - PADR}" y2="${baseY}"/>`;
  const tLabels = [xMin, (xMin + xMax) / 2, xMax].map((t, i) =>
    `<text class="axis" x="${X(t).toFixed(1)}" y="${CHART_H - 7}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}">${fmtTime(t)}${equityRange !== "today" ? " " + new Date(t).toLocaleDateString("en-US", { timeZone: ET, month: "numeric", day: "numeric" }) : ""}</text>`).join("");
  const lastP = chartPts[chartPts.length - 1];

  el.innerHTML = `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none">
    <defs><linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}${labels}${baseline}${tLabels}
    <path class="eq-area" d="${area}" fill="url(#eqfill)"/>
    <path class="eq-line" d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle class="eq-last" cx="${lastP.x.toFixed(1)}" cy="${lastP.y.toFixed(1)}" r="3.5" fill="${color}"/>
    <line id="cross" x1="0" y1="${PADT}" x2="0" y2="${CHART_H - PADB}" stroke="var(--text-2)" stroke-width="1" opacity="0"/>
    <circle id="cross-dot" r="3.5" fill="${color}" stroke="var(--bg)" stroke-width="1.5" opacity="0"/>
  </svg>
  <div class="chart-tip" id="chart-tip"></div>`;
  attachChartHover(el);
  if (animate) animateDraw(el);
}

// Draw the equity line on like a pen stroke (left→right), fading the fill in
// behind it. Uses the exact path length so the timing is consistent across
// data shapes. No-op when the user prefers reduced motion.
function animateDraw(container) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const line = container.querySelector(".eq-line");
  const area = container.querySelector(".eq-area");
  if (line) {
    const len = line.getTotalLength();
    line.style.strokeDasharray = len;
    line.style.strokeDashoffset = len;
    void line.getBoundingClientRect(); // force a reflow so the transition runs
    line.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.45,.05,.2,1)";
    requestAnimationFrame(() => { line.style.strokeDashoffset = "0"; });
  }
  if (area) {
    area.style.opacity = "0";
    area.style.transition = "opacity .9s ease .15s";
    requestAnimationFrame(() => { area.style.opacity = "1"; });
  }
}

function attachChartHover(container) {
  const svg = container.querySelector("svg");
  const tip = container.querySelector("#chart-tip");
  const cross = container.querySelector("#cross");
  const dot = container.querySelector("#cross-dot");
  if (!svg) return;
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * CHART_W;
    // nearest point by svg-x
    let best = chartPts[0], bd = Infinity;
    for (const p of chartPts) { const d = Math.abs(p.x - vx); if (d < bd) { bd = d; best = p; } }
    if (!best) return;
    cross.setAttribute("x1", best.x); cross.setAttribute("x2", best.x); cross.setAttribute("opacity", "0.5");
    dot.setAttribute("cx", best.x); dot.setAttribute("cy", best.y); dot.setAttribute("opacity", "1");
    const px = (best.x / CHART_W) * rect.width;
    const py = (best.y / CHART_H) * rect.height;
    tip.style.left = px + "px"; tip.style.top = py + "px"; tip.style.opacity = "1";
    tip.innerHTML = `<div class="tip-v">${money(best.v)}</div><div class="tip-t">${fmtDateTime(best.ts)}</div>`;
  };
  const onLeave = () => { tip.style.opacity = "0"; cross.setAttribute("opacity", "0"); dot.setAttribute("opacity", "0"); };
  container.addEventListener("mousemove", onMove);
  container.addEventListener("mouseleave", onLeave);
}

// ── decision feed ────────────────────────────────────────────────────────────
// Returns presentation metadata for one journal entry.
function entryMeta(e) {
  const t = e.type;
  if (t === "error")                 return { group: "problem", rail: "var(--red)",    badge: "ERROR",     icon: "⚠", title: "", gist: e.message };
  if (t === "parse_failure")         return { group: "problem", rail: "var(--yellow)", badge: "PARSE",     icon: "", title: e.failure_class, gist: e.preview };
  if (t === "seed_parse_failure")    return { group: "discovery", rail: "var(--yellow)", badge: "SEED?",   icon: "🌱", title: "seed parse failed", gist: e.preview };
  if (t === "reddit_vet_parse_failure") return { group: "discovery", rail: "var(--yellow)", badge: "REDDIT?", icon: "", title: "reddit vet parse failed", gist: e.preview };
  if (t === "hint_vet_parse_failure") return { group: "discovery", rail: "var(--yellow)", badge: "HINT?",   icon: "", title: "hint vet parse failed", gist: e.preview };
  if (t === "seed")                  return { group: "discovery", rail: "var(--cyan)",   badge: "SEED",     icon: "🌱", title: "catalyst seed", gist: `+${e.added ?? 0} / −${e.removed ?? 0} · watchlist ${e.watchlist_size ?? "?"}${(e.edgar_hints ?? 0) || (e.reddit_hints ?? 0) ? ` · hints ${e.reddit_hints ?? 0}r/${e.edgar_hints ?? 0}e` : ""}` };
  if (t === "reddit_vet")            return { group: "discovery", rail: "var(--purple)", badge: "REDDIT",   icon: "", title: "reddit vet", gist: `${e.hints ?? 0} hint(s) · +${e.added ?? 0} / −${e.removed ?? 0}` };
  if (t === "hint_vet")              return { group: "discovery", rail: "var(--purple)", badge: "HINT VET", icon: "", title: "afternoon hint vet", gist: `${e.hints ?? 0} hint(s) (${e.reddit ?? 0}r/${e.edgar ?? 0}e) · +${e.added ?? 0} / −${e.removed ?? 0}` };
  if (t === "gate_block")            return { group: "trade",   rail: "var(--orange)", badge: "GATE",      icon: "", title: e.ticker, gist: e.reason };
  if (t === "confirmation")          return { group: "trade",   rail: "var(--blue)",   badge: "CONFIRM",   icon: "", title: e.ticker, gist: `${e.agree ? "✓ agree" : "✗ disagree"}${e.verdict ? " · " + e.verdict : ""}` };
  if (t === "placement")             return { group: "trade",   rail: "var(--green)",  badge: "PLACED",    icon: "", title: e.ticker, gist: e.filled ? `filled ${num(e.fill_qty)} @ ${num(e.fill_price, 2)}` : "order sent" };
  if (t === "account_drift")         return { group: "problem", rail: "var(--yellow)", badge: "DRIFT",     icon: "", title: "account id drift", gist: `${e.reported} vs cached ${e.cached}` };
  if (e.decision) {
    const d = e.decision;
    const rail = d === "BUY" ? "var(--green)" : d === "HOLD" ? "var(--border)" : d === "TRIM" ? "var(--orange)" : "var(--red)";
    return { group: d === "HOLD" ? "hold" : "trade", rail, badge: d, icon: "", title: e.ticker, gist: e.thesis };
  }
  return { group: "other", rail: "var(--border)", badge: "·", icon: "", title: "", gist: "" };
}

function inFilter(group) {
  if (feedFilter === "all") return true;
  if (feedFilter === "trades") return group === "trade";
  if (feedFilter === "discovery") return group === "discovery";
  if (feedFilter === "problems") return group === "problem";
  return true;
}

function renderFeed() {
  const feed = $("feed");
  const entries = [...state.journal].reverse().filter((e) => inFilter(entryMeta(e).group));
  if (!entries.length) { feed.innerHTML = `<div class="empty">Nothing to show for this filter.</div>`; return; }

  feed.innerHTML = entries.map((e) => {
    const m = entryMeta(e);
    const key = esc(e.ts);
    const badge = `<span class="badge ${m.badge.replace("?", "")}">${m.icon ? m.icon + " " : ""}${esc(m.badge)}</span>`;
    const title = m.title ? `<span class="tkr">${esc(m.title)}</span>` : "";
    const body = bodyFor(e, m);
    return `
      <div class="entry ${openEntries.has(e.ts) ? "open" : ""}" data-key="${key}" style="--rail:${m.rail}">
        <div class="entry-head" onclick="toggleEntry('${key}')">
          ${badge} ${title}
          ${e.trigger ? `<span class="trig">${esc(e.trigger)}</span>` : ""}
          ${e.dry_run ? `<span class="trig">dry-run</span>` : ""}
          <span class="when">${fmtDateTime(e.ts)}</span>
          ${m.gist ? `<span class="gist">${esc(m.gist)}</span>` : ""}
          <span class="caret">▶</span>
        </div>
        <div class="entry-body">${body}</div>
      </div>`;
  }).join("");
}

function kv(k, v, mono = false) {
  return v == null || v === "" ? "" : `<div class="kv"><div class="k">${k}</div><div class="v ${mono ? "mono" : ""}">${esc(v)}</div></div>`;
}

function bodyFor(e, m) {
  if (e.decision) return tickBody(e);
  if (e.type === "confirmation") return [
    kv("Verdict", e.verdict), kv("Agree", e.agree ? "yes" : "no"),
    kv("Bull", e.bull), kv("Bear", e.bear), kv("Reason", e.reason),
  ].join("") || `<div class="empty">No detail recorded.</div>`;
  if (e.type === "placement") return [
    kv("Filled", e.filled ? "yes" : "no", true),
    kv("Fill", e.fill_price != null ? `${num(e.fill_qty)} @ ${num(e.fill_price, 2)}` : null, true),
    kv("Entry / Stop", `${num(e.entry, 2) || "—"} / ${num(e.stop, 2) || "—"}`, true),
    kv("Order", `${e.order_kind ?? "?"} · ${e.stop_type ?? "?"} stop`, true),
    e.ref_id ? kv("Ref", e.ref_id, true) : "",
    e.fallback ? kv("Note", "fill block missing — recorded proposed entry/qty (fallback)") : "",
  ].join("");
  if (e.type === "gate_block") return kv("Blocked by", e.reason, true) || `<div class="empty">No reason recorded.</div>`;
  if (e.type === "account_drift") return [kv("Reported", e.reported, true), kv("Cached", e.cached, true)].join("");
  if (e.type === "seed") return [
    kv("Added", e.added), kv("Removed", e.removed), kv("Watchlist size", e.watchlist_size),
  ].join("");
  if (e.type === "reddit_vet") return [
    kv("Reddit hints", e.hints), kv("Added", e.added), kv("Removed", e.removed), kv("Watchlist size", e.watchlist_size),
  ].join("");
  if (e.type === "hint_vet") return [
    kv("Hints", e.hints), kv("Reddit", e.reddit), kv("EDGAR", e.edgar), kv("Added", e.added), kv("Removed", e.removed), kv("Watchlist size", e.watchlist_size),
  ].join("");
  // problem-shaped (error / parse failures)
  return [
    kv("Message", e.message, true),
    kv("Class", e.failure_class, true),
    kv("Reply preview", e.preview, true),
    e.reply_len != null ? kv("Reply length", `${e.reply_len} chars`, true) : "",
  ].join("") || `<div class="empty">No further detail recorded.</div>`;
}

function tickBody(e) {
  let nums = "";
  const numPairs = [
    ["entry", e.entry], ["stop", e.stop], ["target", e.target], ["qty", e.qty],
    ["risk %", e.risk_pct], ["portfolio", e.portfolio_value], ["SPY", e.spy_price],
  ].filter(([, v]) => v != null);
  if (numPairs.length) nums = `<div class="numline">${numPairs.map(([k, v]) => `<span><b>${k}</b>${typeof v === "number" ? num(v) : esc(v)}</span>`).join("")}</div>`;

  let funnel = "";
  const f = e.funnel;
  if (f && (f.considered > 0 || f.passed?.length)) {
    const rej = Object.entries(f.rejected ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(" · ");
    funnel = kv("Funnel", `considered ${f.considered} · passed [${(f.passed ?? []).join(", ") || "none"}]${rej ? " · rejected — " + rej : ""}`, true);
  }
  let wl = "";
  if (e.watchlist_add?.length || e.watchlist_remove?.length) {
    wl = kv("Watchlist", `${e.watchlist_add?.length ? "+" + e.watchlist_add.join(", +") : ""} ${e.watchlist_remove?.length ? "−" + e.watchlist_remove.join(", −") : ""}`.trim(), true);
  }
  return [
    kv("Thesis", e.thesis),
    kv("Catalyst", e.catalyst),
    kv("Bull case", e.bull),
    kv("Bear case", e.bear),
    nums,
    e.regime ? kv("Regime", `${e.regime.state} · VIX ${e.regime.vix} · SPY ${e.regime.spy_vs_200dma} 200-DMA (${e.regime.spy_200dma})`, true) : "",
    funnel,
    wl,
  ].join("");
}

window.toggleEntry = (key) => {
  if (openEntries.has(key)) openEntries.delete(key); else openEntries.add(key);
  document.querySelector(`.entry[data-key="${CSS.escape(key)}"]`)?.classList.toggle("open");
};

// ── alerts (last 24h problems) ──────────────────────────────────────────────
function renderAlerts() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const probTypes = new Set(["error", "parse_failure", "seed_parse_failure", "reddit_vet_parse_failure", "hint_vet_parse_failure", "account_drift"]);
  const problems = state.journal
    .filter((e) => probTypes.has(e.type) && new Date(e.ts).getTime() > cutoff)
    .reverse().slice(0, 8);
  if (!state.bot.running) {
    problems.unshift({ synthetic: true, ts: state.now, type: "error", message: "No scheduler.js process found — the bot is not running." });
  } else if (state.bot.stale) {
    problems.unshift({ synthetic: true, ts: state.now, type: "error", message: `Market is open but last journal write was ${ago(state.bot.lastWriteAgeSec)} ago (tick cadence is ~${tickInterval()}m).` });
  }
  $("alerts").innerHTML = problems.length
    ? problems.map((p) => `
        <div class="alert ${p.type !== "error" ? "parse" : ""}">
          <div class="when">${p.synthetic ? "now" : fmtDateTime(p.ts)}${p.trigger ? " · " + esc(p.trigger) : ""}${p.failure_class ? " · " + esc(p.failure_class) : ""}${p.type && p.type !== "error" && p.type !== "parse_failure" ? " · " + esc(p.type) : ""}</div>
          <div class="msg">${esc(p.message ?? p.preview ?? (p.reported ? `account ${p.reported} vs ${p.cached}` : "(no detail)"))}</div>
        </div>`).join("")
    : `<div class="all-clear">✓ No errors or parse failures in the last 24h.</div>`;
}

// ── positions ────────────────────────────────────────────────────────────────
// The scheduler writes positions with symbol/entry/current_price/current_value/
// days_held/thesis_intact (NOT ticker/avg_cost/unrealized_pnl). Map accordingly
// and derive unrealized P&L from entry vs current price.
function renderPositions() {
  const pos = state.latestTick?.positions ?? [];
  $("positions-meta").textContent = state.latestTick ? `tick ${fmtTime(state.latestTick.ts)}` : "";
  if (!pos.length) {
    $("positions").innerHTML = `<div class="empty">No open positions as of the last tick.</div>`;
    return;
  }
  $("positions").innerHTML = `<table>
    <tr><th>Sym</th><th>Sleeve</th><th class="num">Qty</th><th class="num">Entry</th><th class="num">Last</th><th class="num">P&L</th></tr>
    ${pos.map((p) => {
      const sym = p.symbol ?? p.ticker ?? "?";
      const entry = p.entry ?? p.avg_cost;
      const lastPx = p.current_price;
      const pnlPct = (entry != null && lastPx != null && entry) ? ((lastPx - entry) / entry) * 100 : null;
      const pnlDollar = (entry != null && lastPx != null && p.qty != null) ? (lastPx - entry) * p.qty : (p.unrealized_pnl ?? null);
      const cls = pnlPct == null ? "" : pnlPct > 0 ? "pos" : pnlPct < 0 ? "neg" : "";
      const sleeve = p.sleeve ?? "";
      const sub = [
        p.days_held != null ? `${p.days_held}d held` : "",
        p.thesis_intact === false ? `<span class="thesis-broken">⚠ thesis broken</span>` : p.thesis_intact === true ? `<span class="thesis-ok">✓ thesis intact</span>` : "",
        p.stop ? `stop: ${esc(p.stop)}` : "",
      ].filter(Boolean).join(" · ");
      return `<tr class="pos-row">
        <td><b>${esc(sym)}</b></td>
        <td><span class="sleeve-tag ${esc(sleeve)}">${esc(sleeve || "—")}</span></td>
        <td class="num">${num(p.qty)}</td>
        <td class="num">${num(entry, 2)}</td>
        <td class="num">${num(lastPx, 2)}</td>
        <td class="num ${cls}">${pnlPct == null ? "—" : `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`}${pnlDollar != null ? `<br><span style="font-size:10px;color:var(--muted)">${pnlDollar >= 0 ? "+" : ""}${num(pnlDollar, 2)}</span>` : ""}</td>
      </tr>
      ${sub ? `<tr class="pos-sub"><td colspan="6">${sub}</td></tr>` : ""}`;
    }).join("")}
  </table>`;
}

// ── reddit signals ──────────────────────────────────────────────────────────
function renderReddit() {
  const card = $("reddit-card");
  const r = state.reddit;
  if (!r) { card.hidden = true; return; }
  card.hidden = false;
  $("reddit-meta").textContent = r.updatedTs ? `updated ${fmtTime(r.updatedTs)}` : "";
  const hints = r.hints ?? [];
  const pm = r.pm?.hints ?? [];
  let html = hints.length
    ? `<div class="tickers">${hints.map((h) => `<span class="tk">${esc(typeof h === "string" ? h : h.ticker ?? h.symbol ?? "?")}</span>`).join("")}</div>
       <div class="reddit-note">AM mention-spike hints directing the WebSearch vet (a hint is never a trigger).</div>`
    : `<div class="empty">No active Reddit hints this cycle.</div>`;
  if (pm.length) {
    html += `<div class="reddit-pm">
      <div class="reddit-note">Observe-only PM scan${r.pm?.ts ? ` (${fmtTime(r.pm.ts)})` : ""} — does not feed the vet:</div>
      <div class="tickers" style="margin-top:8px">${pm.map((h) => `<span class="tk">${esc(typeof h === "string" ? h : h.ticker ?? h.symbol ?? "?")}</span>`).join("")}</div>
    </div>`;
  }
  $("reddit").innerHTML = html;
}

// ── btc sleeve (optional, hidden until built) ───────────────────────────────
function renderBtc() {
  const card = $("btc-card");
  const b = state.btc;
  if (!b) { card.hidden = true; return; }
  card.hidden = false;
  const rows = [];
  if (b.regime) for (const [k, v] of Object.entries(b.regime)) rows.push([k, typeof v === "object" ? JSON.stringify(v) : v]);
  $("btc").innerHTML = rows.length
    ? rows.map(([k, v]) => `<div class="btc-row"><span class="k">${esc(k)}</span><span>${esc(v)}</span></div>`).join("")
    : `<div class="empty">BTC sleeve files present but empty.</div>`;
}

// ── funnel aggregate (today) ────────────────────────────────────────────────
function renderFunnel() {
  const today = etDayKey(state.now);
  const ticks = state.journal.filter((e) => e.funnel && etDayKey(e.ts) === today);
  if (!ticks.length) { $("funnel").innerHTML = `<div class="empty">No funnel telemetry recorded today.</div>`; return; }
  let considered = 0; const rejected = {}; const passed = new Set();
  for (const t of ticks) {
    considered += t.funnel.considered ?? 0;
    for (const [k, n] of Object.entries(t.funnel.rejected ?? {})) rejected[k] = (rejected[k] ?? 0) + n;
    for (const p of t.funnel.passed ?? []) passed.add(p);
  }
  const rows = Object.entries(rejected).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(([, n]) => n), 1);
  $("funnel").innerHTML = `
    <div class="fun-top"><span><b>considered</b>${considered}</span><span><b>passed</b>${passed.size ? [...passed].join(", ") : "0"}</span><span><b>ticks</b>${ticks.length}</span></div>
    ${rows.length ? rows.map(([k, n]) => `
      <div class="fun-row"><span class="name">${esc(k)}</span><span class="bar"><i style="width:${(n / max) * 100}%"></i></span><span class="n">${n}</span></div>`).join("")
      : `<div class="empty">No rejections recorded today.</div>`}`;
}

// ── ledger + watchlist ──────────────────────────────────────────────────────
function renderLedger() {
  const rows = [...state.ledger].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 12);
  $("ledger").innerHTML = rows.length ? `<table>
    <tr><th>When</th><th>Side</th><th>Tkr</th><th class="num">Qty</th><th class="num">Price</th></tr>
    ${rows.map((e) => `<tr>
      <td>${fmtDateTime(e.ts)}</td>
      <td class="${e.side === "buy" ? "pos" : "neg"}">${esc(e.side)}</td>
      <td><b>${esc(e.ticker)}</b></td>
      <td class="num">${num(e.qty)}</td>
      <td class="num">${num(e.price, 2)}</td>
    </tr>`).join("")}
  </table>` : `<div class="empty">Ledger is empty.</div>`;
}

function renderWatchlist() {
  const wl = state.watchlist;
  $("watchlist-meta").textContent = wl.length ? `${wl.length} name${wl.length === 1 ? "" : "s"}` : "";
  $("watchlist").innerHTML = wl.length ? `<table>
    <tr><th>Tkr</th><th>Src</th><th>Added</th><th>Catalyst</th></tr>
    ${wl.map((w) => `<tr>
      <td><b>${esc(w.ticker)}</b>${w.status === "entered" ? ` <span class="chip entered">entered</span>` : ""}</td>
      <td>${w.source ? `<span class="chip ${esc(w.source)}">${esc(w.source)}</span>` : "—"}</td>
      <td>${fmtDateTime(w.added_ts ?? w.ts)}</td>
      <td>${esc(w.catalyst ?? w.reason ?? w.notes ?? w.note ?? "")}</td>
    </tr>`).join("")}
  </table>` : `<div class="empty">Watchlist is empty.</div>`;
}

// ── controls ─────────────────────────────────────────────────────────────────
$("equity-range").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  equityRange = b.dataset.range;
  for (const x of $("equity-range").children) x.classList.toggle("active", x === b);
  if (state) renderEquity();
});
$("feed-filter").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  feedFilter = b.dataset.f;
  for (const x of $("feed-filter").children) x.classList.toggle("active", x === b);
  if (state) renderFeed();
});

// The snapshot was generated on the Mac at state.generatedTs; recompute every
// wall-clock-derived field against the *browser's* clock so the phone shows true
// freshness/market-state even though the file itself only changes every ~15 min.
function relive(s) {
  const liveNow = new Date();
  s.now = liveNow.toISOString();
  const b = s.bot || (s.bot = {});
  if (b.lastWriteTs) {
    b.lastWriteAgeSec = Math.round((liveNow - new Date(b.lastWriteTs)) / 1000);
  }
  b.marketOpen = isMarketHoursLive(liveNow);
  const staleAfter = (s.cadence?.staleAfterMin ?? 55) * 60;
  b.stale = b.marketOpen && b.lastWriteAgeSec != null && b.lastWriteAgeSec > staleAfter;
  s.snapshotAgeSec = s.generatedTs ? Math.round((liveNow - new Date(s.generatedTs)) / 1000) : null;
  return s;
}
// 9:30–16:00 ET, Mon–Fri — same gate the bot uses, evaluated in the browser.
function isMarketHoursLive(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const day = get("weekday");
  if (day === "Sat" || day === "Sun") return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// ── poll loop ────────────────────────────────────────────────────────────────
// Re-fetches the static snapshot each minute (cache-busted so the phone always
// pulls the newest push, not a stale CDN copy). Feed re-renders only when the
// journal actually changes, so expanded cards and scroll position survive.
let feedSig = "";
async function refresh() {
  try {
    const res = await fetch(`${STATE_URL}?t=${Date.now()}`, { cache: "no-store" });
    state = relive(await res.json());
    renderTop(); renderStats(); renderAlloc(); renderEquity(); renderAlerts();
    renderPositions(); renderReddit(); renderBtc(); renderFunnel(); renderLedger(); renderWatchlist();
    const sig = state.journal.length + ":" + (state.journal[state.journal.length - 1]?.ts ?? "") + ":" + feedFilter;
    if (sig !== feedSig) { feedSig = sig; renderFeed(); }
    const snapAge = state.snapshotAgeSec != null ? ` · snapshot ${ago(state.snapshotAgeSec)} old` : "";
    $("refresh-pill").textContent = `updated ${fmtTime(state.generatedTs ?? state.now)}${snapAge}`;
    $("refresh-pill").className = "pill " + (state.snapshotAgeSec != null && state.snapshotAgeSec > 30 * 60 ? "warn" : "dim");
    $("datadir").textContent = state.dataDir;
  } catch (err) {
    $("refresh-pill").textContent = "snapshot unreachable";
    $("refresh-pill").className = "pill bad";
  }
}

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
