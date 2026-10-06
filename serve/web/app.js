// serve/web/app.js - the Strata web app: Chat, Monitor, About. No framework, no network beyond this server.
// The Monitor tab rebuilds PR #22's dashboard idea (code-martin) on the server's own /metrics.
// Every text a person reads goes through t() (i18n.js, loaded first): English is the key, zh-CN its translation.
"use strict";

const $ = (id) => document.getElementById(id);
const SPRITE = "web/sprite.svg";
const icon = (name, cls = "st-icon") => `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#i-${name}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString(undefined, {maximumFractionDigits: d, minimumFractionDigits: d}));
const kfmt = (n) => (n == null ? "–" : n >= 1000 ? `${fmt(n / 1000, n >= 10000 ? 0 : 1)}k` : fmt(n));
// a context size: 32768 -> "32K" (powers of two), else like kfmt
const ctxfmt = (n) => (n && n % 1024 === 0 ? `${fmt(n / 1024)}K` : kfmt(n));
const gb = (b, d = 1) => (b == null ? "–" : fmt(b / 1073741824, d));   // memory: binary GB, as Windows shows it

const store = {
  get(k, d) { try { const v = localStorage.getItem("strata." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  // false when the browser refused it (full storage); private mode keeps it in memory only
  set(k, v) { try { localStorage.setItem("strata." + k, JSON.stringify(v)); return true; } catch (e) { return e.name !== "QuotaExceededError"; } },
  del(k) { try { localStorage.removeItem("strata." + k); } catch (e) { /* ignore */ } },
};

applyI18n();

// ------------------------------------------------------------------ toasts
function toast(kind, title, text = "", ms = 3500, action = null) {
  const names = {info: "info", success: "check", warn: "warning", error: "error"};
  const el = document.createElement("div");
  el.className = `st-toast st-toast--${kind}`;
  el.innerHTML = `${icon(names[kind] || "info")}<div><div class="st-toast__title"></div><div class="t-text"></div></div>`;
  el.querySelector(".st-toast__title").textContent = title;
  el.querySelector(".t-text").textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.className = "st-btn st-btn--secondary";
    b.style.height = "32px";
    b.style.marginLeft = "auto";
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {                                   // http on another host: no async clipboard
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  if (btn) {
    const use = btn.querySelector("use");
    use.setAttribute("href", `${SPRITE}#i-check`);
    setTimeout(() => use.setAttribute("href", `${SPRITE}#i-copy`), 1500);
  }
  toast("success", t("Copied to clipboard"), "", 1800);
}

// ------------------------------------------------------------------ theme, language and tabs
// the system's theme until the user picks one (only a click is saved)
function setTheme(theme, save) {
  document.documentElement.dataset.theme = theme;
  if (save) try { localStorage.setItem("strata.theme", theme); } catch (e) { /* ignore */ }
  $("theme-icon").setAttribute("href", `${SPRITE}#i-${theme === "dark" ? "sun" : "moon"}`);
  $("dark-toggle").setAttribute("aria-checked", String(theme === "dark"));
}
const flipTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
$("theme-btn").onclick = flipTheme;
$("dark-toggle").onclick = flipTheme;
setTheme(document.documentElement.dataset.theme || "light", false);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let saved = null;
  try { saved = localStorage.getItem("strata.theme"); } catch (err) { /* ignore */ }
  if (!saved) setTheme(e.matches ? "dark" : "light", false);
});

// the header button switches between the two languages; About > Settings lists them
function switchLang(lang) {
  if (busy) { toast("warn", t("Still writing"), t("Stop the answer first.")); return; }
  setLang(lang);
}
$("lang-text").textContent = LANG === "zh-CN" ? "EN" : "中";
$("lang-btn").onclick = () => switchLang(LANG === "zh-CN" ? "en" : "zh-CN");
$("lang-select").innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === LANG ? " selected" : ""}>${esc(v)}</option>`).join("");
$("lang-select").onchange = () => switchLang($("lang-select").value);

let tab = "chat";
function showTab(name) {
  tab = ["chat", "monitor", "about"].includes(name) ? name : "chat";
  for (const b of document.querySelectorAll(".st-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of ["chat", "monitor", "about"]) $(`view-${v}`).hidden = v !== tab;
  $("convs-btn").hidden = tab !== "chat";
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", tab === "chat" ? location.pathname : `#${tab}`);
  if (tab === "chat") $("input").focus();
  if (tab === "monitor") loadMcp();
  if (tab === "about") loadConfig();
  if (lastMetrics) render(lastMetrics);
}
for (const b of document.querySelectorAll(".st-tab")) b.onclick = () => showTab(b.dataset.tab);
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------------ server access
function headers(json = false) {
  const h = {};
  const key = store.get("apikey", "");
  if (key) h.Authorization = "Bearer " + key;
  if (json) h["Content-Type"] = "application/json";
  return h;
}
$("api-key").value = store.get("apikey", "");
$("api-key").onchange = () => { store.set("apikey", $("api-key").value.trim()); toast("success", t("API key saved"), t("Kept in this browser only.")); };

let health = {model: "strata", images: false, max_context: 0};
async function loadHealth() {
  try {
    health = await (await fetch("health")).json();
    $("attach-btn").title = health.images ? t("Attach a text file or a picture (or drop it here)")
                                          : t("Attach a text file (or drop it here)");
    $("chat-empty-sub").textContent = t("{model} runs on this PC. Nothing leaves it.", {model: health.model});
  } catch (e) {
    setTimeout(loadHealth, 2000);
  }
}

// ------------------------------------------------------------------ Monitor
const METRICS = [
  {key: "speed", label: "Speed", icon: "gauge", unit: "t/s", series: "tok_s"},
  {key: "gpu", label: "GPU load", icon: "gpu", unit: "%", series: "gpu_util", max: 100},
  {key: "vram", label: "VRAM", icon: "layers", unit: "GB", series: "gpu_mem_used"},
  {key: "temp", label: "GPU temp", icon: "thermometer", unit: "°C", series: "gpu_temp", tone: "warn"},
  {key: "power", label: "Power", icon: "bolt", unit: "W", series: "gpu_power"},
  {key: "pcie", label: "PCIe", icon: "link", unit: "", series: "gpu_pcie_rx_mb", tone: "info"},
  {key: "cpu", label: "CPU", icon: "cpu", unit: "%", series: "cpu", max: 100},
  {key: "disk", label: "Disk read", icon: "disk", unit: "MB/s", series: "disk_read_mb", tone: "info"},
];
$("metrics").innerHTML = METRICS.map((m) => `
  <div class="st-card metric-card"><div class="st-metric">
    <span class="st-metric__label">${icon(m.icon, "st-icon st-icon--sm")}${esc(t(m.label))}</span>
    ${m.key === "speed" ? `<div class="speed-values">
      <div><span class="st-metric__value" id="mv-speed">-</span><span class="st-metric__sub" id="ms-speed">${esc(t("Decode"))}</span></div>
      <div class="speed-prefill"><span class="st-metric__value" id="mv-prefill">-</span><span class="st-metric__sub" id="ms-prefill">${esc(t("Prefill"))}</span></div>
    </div>` : `<span class="st-metric__value" id="mv-${m.key}">–</span>
    <span class="st-metric__sub" id="ms-${m.key}"></span>`}
    <svg class="st-metric__spark" id="sp-${m.key}" viewBox="0 0 100 32" preserveAspectRatio="none"${m.tone ? ` data-tone="${m.tone}"` : ""}>
      <path class="area" fill="currentColor" opacity=".12"/><path class="line" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${m.key === "speed" ? `<g id="sp-prefill" class="speed-prefill"><path class="area" fill="currentColor" opacity=".12"/>
        <path class="line" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round" vector-effect="non-scaling-stroke"/></g>` : ""}</svg>
  </div></div>`).join("");

function spark(id, values, max) {
  const svg = $(id);
  const v = (values || []).map((x) => (x == null ? 0 : x));
  if (v.length < 2) { svg.querySelector(".line").setAttribute("d", ""); svg.querySelector(".area").setAttribute("d", ""); return; }
  const top = Math.max(max || 0, ...v, 1e-9);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 30 - (x / top) * 26]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("");
  svg.querySelector(".line").setAttribute("d", line);
  svg.querySelector(".area").setAttribute("d", `${line}L100,32L0,32Z`);
}
function setMetric(key, value, unit, sub) {
  $(`mv-${key}`).innerHTML = value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
  $(`ms-${key}`).textContent = sub || "";
}

let lastMetrics = null, metricsFailures = 0, keyWarned = false, mcpTick = 0;
let reqShowAll = false;   // the Monitor's request table: the last 12, or every one the server keeps (issue #35)
async function poll() {
  try {
    const r = await fetch(reqShowAll ? "metrics?requests=all" : "metrics", {headers: headers()});
    if (r.status === 401) {
      setPill("error", t("API key needed"));
      if (!keyWarned) { keyWarned = true; toast("warn", t("API key needed"), t("This server needs a key: add it under About > Settings."), 6000); }
    } else if (r.ok) {
      lastMetrics = await r.json();
      metricsFailures = 0;
      render(lastMetrics);
    } else {
      throw new Error(`HTTP ${r.status}`);
    }
  } catch (e) {
    if (++metricsFailures === 3) setPill("error", t("Server not reachable"));
  }
  if (tab === "monitor" && ++mcpTick % 10 === 0) loadMcp();       // server states change rarely: every 10 s
  setTimeout(poll, 1000);
}

function setPill(state, text) {
  $("pill").dataset.state = state === "error" ? "queued" : state;
  $("pill-text").textContent = text;
}

function render(m) {
  const live = m.live || {}, hw = m.hardware || {}, st = m.hardware_static || {}, eng = m.engine || {}, h = m.history || {};
  const last = (m.requests || [])[0];
  // the header pill
  if (live.state === "reading") {
    const pct = live.prompt_total ? Math.round((100 * live.prompt_read) / live.prompt_total) : null;
    setPill("reading", pct != null ? t("Reading prompt · {pct}%", {pct}) : t("Reading prompt"));
  } else if (live.state === "generating") {
    setPill("generating", t("Generating · {s} tok/s", {s: fmt(live.tok_s, 1)}));
  } else {
    setPill("idle", t("Idle"));
  }
  if (live.queued > 0) setPill("queued", t("{n} queued", {n: live.queued}));
  if (tab === "monitor") renderMonitor(live, hw, st, eng, h, last, m.requests || [], m.totals, m.requests_kept);
  if (tab === "monitor") renderConvCache(m.conversation_cache);
  if (tab === "about") renderAbout(eng, hw, st);
}

// #596: the conversation cache - the prompt's state the engine keeps between requests (always), and the whole
// conversations it parks in RAM when "--conversation-cache-mib N" is in the run config's args (opt-in)
function since(time) {
  if (!time) return "";
  const s = Math.max(0, Date.now() / 1000 - time);
  return s < 60 ? t("just now") : s < 3600 ? t("{n} min ago", {n: fmt(s / 60)}) : t("{n} h ago", {n: fmt(s / 3600, 1)});
}
function renderConvCache(c) {
  $("cc-card").hidden = !c;
  if (!c) return;                                  // an older server
  const pct = (a, b) => (b ? `${Math.min(100, (100 * a) / b)}%` : "0%");
  $("cc-bars").hidden = !c.enabled;
  if (c.enabled) {
    $("cc-slots-text").textContent = `${fmt(c.parked)} / ${fmt(c.slots)}`;
    $("cc-slots-bar").style.width = pct(c.parked, c.slots);
    const budget = c.budget_mib * 1048576;
    $("cc-mem-text").textContent = `${gb(c.bytes)} / ${gb(budget)} GB`;
    $("cc-mem-bar").style.width = pct(c.bytes, budget);
  }
  $("cc-sum").textContent = c.requests ? t("{a} of {b} requests reused part of their prompt", {a: fmt(c.requests_reused), b: fmt(c.requests)}) : "";
  const share = c.prompt_tokens ? t(" ({n}% of all prompt tokens)", {n: fmt((100 * c.reused_tokens) / c.prompt_tokens)}) : "";
  const event = c.last_event ? t("{what} {n} tokens, {when}", {what: t(c.last_event === "parked" ? "Parked" : "Restored"),
                                                                n: fmt(c.last_tokens), when: since(c.last_at)}) : null;
  facts($("cc-facts"), [
    [t("Last request"), c.last_prompt != null ? t("{a} of {b} prompt tokens reused", {a: fmt(c.last_reused || 0), b: fmt(c.last_prompt)}) : null],
    [t("Reused since start"), c.requests ? t("{n} tokens", {n: fmt(c.reused_tokens)}) + share : null],
    [t("Parked / restored"), c.enabled ? `${fmt(c.parks)} / ${fmt(c.restores)}${c.evictions ? t(" · {n} evicted", {n: fmt(c.evictions)}) : ""}` : null],
    [t("Last switch"), c.enabled ? event : null],
  ]);
  $("cc-note").textContent = c.enabled
    ? t("A request that continues a parked conversation gets its state back instead of reading it again; the oldest goes when the slots or the memory are full.")
    : t("The engine keeps the last conversation's state, so a follow-up reads only what is new. To keep several conversations (agents taking turns), add \"--conversation-cache-mib\", \"8192\" to the run config's args (docs/DETAILS.md).");
}

function renderTotals(tot) {
  if (!tot || !tot.requests) return "";
  const from = new Date(tot.since * 1000).toLocaleString([], {weekday: "short", hour: "2-digit", minute: "2-digit"});
  const read = tot.prompt_tokens - tot.reused;
  const pSpeed = tot.prompt_ms > 0 && read > 0 ? t(" at {s} tok/s", {s: fmt(read / (tot.prompt_ms / 1000))}) : "";
  const oSpeed = tot.decode_ms > 0 && tot.output_tokens > 0 ? t(" at {s} tok/s", {s: fmt(tot.output_tokens / (tot.decode_ms / 1000), 1)}) : "";
  return t("Since {t}: ", {t: from}) + t("{n} requests · ", {n: fmt(tot.requests)}) + t("{n} prompt tokens read", {n: fmt(read)}) +
         pSpeed + t(" ({n} reused) · ", {n: fmt(tot.reused)}) + t("{n} written", {n: fmt(tot.output_tokens)}) + oSpeed;
}
function renderMonitor(live, hw, st, eng, h, last, requests, totals, kept) {
  // model state
  const on = live.queued > 0 ? "queued" : live.state;
  for (const b of document.querySelectorAll("#state-badges .st-badge")) b.classList.toggle("on", b.dataset.s === on || b.dataset.s === live.state);
  const prog = $("state-progress");
  let label = t("Waiting for a request"), detail = "", pct = 0;
  if (live.state === "reading") {
    label = t("Reading prompt");
    prog.dataset.tone = "info";
    if (live.prompt_total) {
      pct = (100 * live.prompt_read) / live.prompt_total;
      detail = t("{a} / {b} tokens · {pct}%", {a: fmt(live.prompt_read), b: fmt(live.prompt_total), pct: fmt(pct)});
    } else {
      detail = t("{n} tokens", {n: fmt(live.prompt_tokens)});
    }
  } else if (live.state === "generating") {
    // the server's phase: thinking, answering, "writing a tool call: <name>", tool call complete
    const call = /^writing a tool call: (.*)$/.exec(live.phase || "");
    label = call ? t("Writing a tool call: {name}", {name: call[1]})
          : live.phase ? t(live.phase[0].toUpperCase() + live.phase.slice(1)) : t("Generating");
    delete prog.dataset.tone;
    pct = live.max_tokens ? Math.min(100, (100 * live.generated) / live.max_tokens) : 0;
    detail = t("{n} tokens · {s} tok/s", {n: fmt(live.generated), s: fmt(live.tok_s, 1)});
  } else if (last) {
    delete prog.dataset.tone;
    detail = last.decode_tok_s ? t("last: {n} tokens at {s} tok/s", {n: fmt(last.output_tokens), s: fmt(last.decode_tok_s, 1)})
                               : t("last: {n} tokens", {n: fmt(last.output_tokens)});
  }
  $("state-label").textContent = label;
  $("state-detail").textContent = detail;
  $("state-bar").style.width = `${pct}%`;

  // the eight cards
  const speed = live.state === "generating" ? live.tok_s : last ? last.decode_tok_s : null;
  setMetric("speed", speed == null ? null : fmt(speed, 1), "t/s",
            t(live.state === "generating" ? "Decode now" : last ? "Decode last request" : "Decode"));
  const prefill = live.state !== "idle" ? live.prefill_tok_s_mean
                : last && last.prompt_ms > 0 ? Math.max(0, last.prompt_tokens - (last.reused || 0)) / (last.prompt_ms / 1000) : null;
  setMetric("prefill", prefill == null ? null : fmt(prefill), "t/s",
            t(live.state === "reading" ? "Prefill now" : live.state === "generating" ? "Prefill this request" : last ? "Prefill last request" : "Prefill"));
  spark("sp-speed", h.tok_s);
  spark("sp-prefill", h.prefill_tok_s_mean);
  // a model split across several cards (issue #112): the cards show their total / mean / hottest, and each card's own
  const per = (f) => (hw.gpus || []).map((g) => `GPU ${g.index} ${f(g)}`).join(" · ");
  const multi = (hw.gpus || []).length > 1;
  setMetric("gpu", hw.gpu_util == null ? null : fmt(hw.gpu_util), "%",
            multi ? per((g) => (g.util == null ? "–" : `${fmt(g.util)}%`)) : st.gpu_name || "");
  spark("sp-gpu", h.gpu_util, 100);
  setMetric("vram", hw.gpu_mem_used == null ? null : gb(hw.gpu_mem_used), hw.gpu_mem_total ? `/ ${gb(hw.gpu_mem_total, 0)} GB` : "GB",
            multi ? per((g) => (g.mem_used == null ? "–" : `${gb(g.mem_used)} GB`))
                  : eng.expert_slots ? t("{n} experts cached", {n: fmt(eng.expert_slots)}) : "");
  spark("sp-vram", h.gpu_mem_used, hw.gpu_mem_total);
  setMetric("temp", hw.gpu_temp == null ? null : fmt(hw.gpu_temp), "°C",
            multi ? per((g) => (g.temp == null ? "–" : `${fmt(g.temp)}°`)) : "");
  spark("sp-temp", h.gpu_temp, 90);
  setMetric("power", hw.gpu_power == null ? null : fmt(hw.gpu_power), "W", hw.gpu_power_limit ? t("of {n} W limit", {n: fmt(hw.gpu_power_limit)}) : "");
  spark("sp-power", h.gpu_power, hw.gpu_power_limit);
  const gen = hw.gpu_pcie_gen_max || hw.gpu_pcie_gen;
  setMetric("pcie", gen ? `Gen${gen}` : null, hw.gpu_pcie_width ? `x${hw.gpu_pcie_width}` : "",
            hw.gpu_pcie_rx_mb == null ? "" : t("to GPU {n} MB/s", {n: fmt(hw.gpu_pcie_rx_mb, hw.gpu_pcie_rx_mb < 10 ? 1 : 0)}) +
            (hw.gpu_pcie_gen && gen && hw.gpu_pcie_gen < gen ? t(" · idle Gen{n}", {n: hw.gpu_pcie_gen}) : ""));
  spark("sp-pcie", h.gpu_pcie_rx_mb);
  setMetric("cpu", hw.cpu == null ? null : fmt(hw.cpu), "%", st.threads ? `${st.cores ? t("{c} cores · ", {c: st.cores}) : ""}${t("{n} threads", {n: st.threads})}` : "");
  spark("sp-cpu", h.cpu, 100);
  if (hw.disk_read_mb == null) {
    setMetric("disk", null, "", st.psutil ? "" : t("needs psutil (setup installs it)"));
  } else {
    const big = hw.disk_read_mb >= 1000;
    setMetric("disk", big ? fmt(hw.disk_read_mb / 1024, 2) : fmt(hw.disk_read_mb, hw.disk_read_mb < 10 ? 1 : 0), big ? "GB/s" : "MB/s",
              hw.disk_write_mb == null ? "" : t("write {n} MB/s", {n: fmt(hw.disk_write_mb, 1)}));
  }
  spark("sp-disk", h.disk_read_mb);

  // context fill: the running request, else the last one
  const ctx = eng.max_context || 0;
  let used = 0;
  if (live.state !== "idle") used = (live.prompt_tokens || 0) + (live.generated || 0);
  else if (last) used = (last.prompt_tokens || 0) + (last.output_tokens || 0);
  const frac = ctx ? Math.min(1, used / ctx) : 0;
  $("ctx-fill").setAttribute("stroke-dasharray", `${(235.6 * frac).toFixed(1)} 314.2`);
  $("ctx-fill").style.opacity = 235.6 * frac >= 3 ? "1" : "0";         // a near-zero arc would draw just its round cap
  $("ctx-pct").textContent = `${Math.round(frac * 100)}%`;
  $("ctx-sub").textContent = ctx ? `${kfmt(used)} / ${ctxfmt(ctx)}` : "–";
  const cacheBytes = (eng.expert_cache_mib || 0) * 1048576;
  $("slots-text").textContent = eng.expert_slots ? `${fmt(eng.expert_slots)} · ${gb(cacheBytes)} GB` : "–";
  $("slots-bar").style.width = hw.gpu_mem_total ? `${Math.min(100, (100 * cacheBytes) / hw.gpu_mem_total)}%` : "0%";
  $("ram-text").textContent = hw.ram_total ? `${gb(hw.ram_used)} / ${gb(hw.ram_total, 0)} GB` : "–";
  const ramPct = hw.ram_total ? (100 * hw.ram_used) / hw.ram_total : 0;
  $("ram-bar").style.width = `${ramPct}%`;
  if (ramPct > 92) $("ram-progress").dataset.tone = "danger"; else delete $("ram-progress").dataset.tone;
  $("temp-text").textContent = hw.gpu_temp == null ? "–" : `${fmt(hw.gpu_temp)} °C`;
  $("temp-bar").style.width = hw.gpu_temp == null ? "0%" : `${Math.min(100, hw.gpu_temp)}%`;

  // recent requests
  const body = $("req-body");
  if (!requests.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">${esc(t("No requests yet"))}</td></tr>`;
  } else {
    const badge = {stop: ["", "Done"], length: ["", "Max tokens|finish"], cancel: ["st-badge--queued", "Stopped"],
                   disconnect: ["st-badge--queued", "Closed"], error: ["st-badge--error", "Error"]};
    body.innerHTML = requests.slice(0, reqShowAll ? requests.length : 12).map((r) => {
      const [cls, text] = badge[r.finish] || ["", r.finish || "–"];
      const time = new Date(r.time * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
      const proj = r.projection == null ? "" : ` <span class="st-badge${r.projection ? " st-badge--reading" : ""}" title="${esc(t(`experimental speed projection ${r.projection ? "on" : "off"}`))}">${r.projection ? "ESP" : esc(t("stock"))}</span>`;
      // #588: the VRAM share; the PCIe share (--pcie-frac) beside it when there is one
      const hit = r.hit_rate == null ? "–" : `${(r.hit_rate * 100).toFixed(1)}%` +
        (r.pcie_share ? ` <span class="muted" title="${esc(t("routed experts the GPU read over PCIe (--pcie-frac) or another GPU computed"))}">+${(r.pcie_share * 100).toFixed(1)}% PCIe</span>` : "");
      return `<tr><td>${esc(time)}</td><td><span class="st-badge ${cls}">${esc(t(text))}</span>${proj}</td><td class="num">${fmt(r.prompt_tokens)}</td>
        <td class="num">${fmt(r.reused)}</td><td class="num">${fmt(r.output_tokens)}</td><td class="num">${fmt(r.decode_tok_s, 1)}</td>
        <td class="num">${hit}</td><td class="num">${fmt(r.duration_s, 1)} s</td></tr>`;
    }).join("");
  }
  const all = $("req-all");
  kept = kept == null ? requests.length : kept;
  all.hidden = kept <= 12;
  all.textContent = reqShowAll ? t("Show fewer") : t("Show all ({n})", {n: kept});
  $("req-wrap").classList.toggle("all", reqShowAll);
  $("req-totals").textContent = renderTotals(totals);
}

function facts(el, rows) {
  el.innerHTML = rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v, copy]) =>
    `<dt>${esc(k)}</dt><dd>${copy ? `<code>${esc(v)}</code><button class="st-btn st-btn--icon" data-copy="${esc(v)}" aria-label="${esc(t("Copy"))}">${icon("copy")}</button>` : esc(v)}</dd>`).join("");
}
// INFO cvec=project:4-44[:singleL] | add:A-B | 0
function projectionText(c) {
  if (!c || c === "0" || c === 0) return null;
  const [mode, range, single] = String(c).split(":");
  const [a, b] = (range || "").split("-");
  const layer = single ? single.replace("single", "") : "";
  return L(`${mode === "project" ? "Projection" : "Additive"} control vector on layers ${a}–${b}` +
           `${single ? ` (layer ${layer}'s direction)` : ""}. Per chat in Sampling. Its package ` +
           "describes the vector as a refusal-direction projection; measure the speed yourself",
           `${mode === "project" ? "投影" : "叠加"}控制向量，作用于第 ${a}–${b} 层${single ? `（使用第 ${layer} 层的方向）` : ""}。` +
           "可在每次对话的“生成参数”里开关。它的发布包把这个向量描述为“拒答方向投影”（会让模型更少拒绝请求）；速度请自己实测");
}
function renderAbout(eng, hw, st) {
  const kv = {int8: "8-bit", q4_0: "4-bit (Hadamard-rotated)", fp16: "16-bit"}[eng.kv];
  facts($("facts-engine"), [
    [t("Model"), eng.model],
    [t("Engine"), eng.version ? `v${eng.version}` : t("built from source")],
    [t("Context"), eng.max_context ? t("{n} tokens", {n: fmt(eng.max_context)}) : null],
    [t("KV cache"), eng.kv ? `${kv ? t(kv) : eng.kv}${eng.kv_resident ? t(", streamed: {n} positions per layer in VRAM, the rest in RAM", {n: fmt(eng.kv_resident)}) : t(", all in VRAM")}` : null],
    [t("Experts in VRAM"), eng.expert_slots ? `${fmt(eng.expert_slots)} (${gb((eng.expert_cache_mib || 0) * 1048576)} GB)` : null],
    [t("Speculation"), eng.spec ? t("MTP drafts up to {n} tokens", {n: Math.max(0, (eng.mtp_max || eng.spec) - 1)}) + (eng.lookup ? t(", prompt lookup on") : "") : null],
    [t("Images"), t(eng.images ? "on" : "off")],
    [t("Experimental speed projection"), projectionText(eng.cvec)],
  ]);
  facts($("facts-hw"), [
    [t("GPU"), st.gpu_name ? `${st.gpu_name}${hw.gpu_mem_total ? `, ${gb(hw.gpu_mem_total, 0)} GB` : ""}` : t("not readable (NVML)")],
    [t("CPU"), st.cpu_name ? `${st.cpu_name}${st.threads ? t(", {n} threads", {n: st.threads}) : ""}` : null],
    [t("RAM"), hw.ram_total ? `${gb(hw.ram_total, 0)} GB` : null],
  ]);
  const base = location.origin;
  facts($("facts-api"), [
    [t("OpenAI base URL"), `${base}/v1`, true],
    [t("Anthropic base URL"), base, true],
    [t("Model name"), eng.model, true],
  ]);
  renderClients(base, eng.model || health.model);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) copyText(b.dataset.copy, b);
});
$("req-all").addEventListener("click", () => { reqShowAll = !reqShowAll; if (lastMetrics) render(lastMetrics); });

// how other apps connect: a generic recipe and two that can be checked here (curl and Python's openai package)
let clientsFor = "";
function renderClients(base, model) {
  if (clientsFor === base + model) return;        // built once: the user may be selecting text in it
  clientsFor = base + model;
  const key = store.get("apikey", "") ? "<API key>" : "any";
  const curl = `curl ${base}/v1/chat/completions -H "Content-Type: application/json" ` +
    `-d '{"model": "${model}", "messages": [{"role": "user", "content": "${L("Hello", "你好")}"}]}'`;
  const py = `from openai import OpenAI\nclient = OpenAI(base_url="${base}/v1", api_key="${key}")\n` +
    `r = client.chat.completions.create(model="${model}", messages=[{"role": "user", "content": "${L("Hello", "你好")}"}])\n` +
    "print(r.choices[0].message.content)";
  const claude = `ANTHROPIC_BASE_URL=${base} ANTHROPIC_AUTH_TOKEN=${key} claude`;
  $("clients").innerHTML =
    `<p>${esc(L("Chat apps (Cherry Studio, Chatbox, LobeChat, Open WebUI ...), translators and coding plugins: add a provider " +
                "of the type \"OpenAI\" or \"OpenAI-compatible\", with these values. The menu names differ between apps.",
                "聊天客户端（Cherry Studio、Chatbox、LobeChat、Open WebUI 等）、翻译插件、编程插件：新增一个类型为" +
                "“OpenAI”或“OpenAI 兼容”的服务商，按下面填写。各个应用的菜单名称不一样，找“模型服务”“API 设置”一类的入口。"))}</p>` +
    `<dl class="facts"><dt>${esc(L("API address", "API 地址"))}</dt><dd><code>${esc(base)}/v1</code></dd>` +
    `<dt>${esc(L("API key", "API 密钥"))}</dt><dd>${esc(L("anything, unless the server was started with --api-key", "随便填，除非启动时设置了 --api-key"))}</dd>` +
    `<dt>${esc(L("Model", "模型"))}</dt><dd><code>${esc(model)}</code></dd></dl>` +
    `<p>${esc(L("Some apps want the address without /v1 and add it themselves: if the test fails, try both.",
                "有的应用要求地址不带 /v1（它自己会加）：如果连接测试失败，两种都试一下。"))}</p>` +
    codeBlock("curl", curl) + codeBlock("python", py) +
    `<p>${esc(L("Claude Code (Anthropic's API):", "Claude Code（使用 Anthropic 接口）："))}</p>` + codeBlock("bash", claude);
}
$("clients").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-code-copy]");
  if (cc) copyText(cc.closest(".st-code").querySelector("pre").textContent, cc);
});

// ------------------------------------------------------------------ MCP servers (GET /mcp)
// Tools from the MCP servers in the run config: the chat offers them to the model (opt-in per request,
// "strata_mcp": true, which only this page sends); the Monitor lists the servers and what they offer.
let mcpInfo = {servers: [], tools: 0}, mcpRetry = null;
async function loadMcp() {
  try {
    const r = await fetch("mcp", {headers: headers()});
    if (!r.ok) return;
    mcpInfo = await r.json();
  } catch (e) { return; /* an older server: no MCP */ }
  renderMcp();
  clearTimeout(mcpRetry);                          // right after the start, servers may still be starting (npx downloads)
  if ((mcpInfo.servers || []).some((s) => s.status === "starting")) mcpRetry = setTimeout(loadMcp, 3000);
}
const MCP_STATE = {ready: ["st-badge--generating", "Connected"], starting: ["st-badge--reading", "Starting"],
                   failed: ["st-badge--error", "Failed"], stopped: ["st-badge--queued", "Stopped"], idle: ["", "Waiting"]};
function renderMcp() {
  const servers = mcpInfo.servers || [];
  $("mcp-card").hidden = !servers.length;
  $("mcp-row").hidden = !servers.length;
  const ready = servers.filter((s) => s.status === "ready" || s.status === "stopped");
  $("mcp-sum").textContent = servers.length ? t("{n} tools · {a} of {b} servers connected", {n: fmt(mcpInfo.tools), a: ready.length, b: servers.length}) : "";
  $("mcp-row-sub").textContent = mcpInfo.tools ? t("{n} tools from {names}; the model calls them when it decides to", {n: fmt(mcpInfo.tools), names: ready.map((s) => s.name).join(", ")})
                                               : t("no server is connected yet (see the Monitor)");
  $("mcp-list").innerHTML = servers.map((s) => {
    const [cls, text] = MCP_STATE[s.status] || ["", s.status];
    const info = s.info && s.info.name ? ` · ${s.info.name}${s.info.version ? ` ${s.info.version}` : ""}` : "";
    return `<div class="mcp-server"><div class="mcp-server__head"><span class="st-badge ${cls}">${esc(t(text))}</span>` +
      `<strong>${esc(s.name)}</strong><span class="muted small">${esc(s.transport)} · ${esc(t("{n} tools", {n: fmt(s.tools.length)}))}${esc(info)}</span></div>` +
      (s.error ? `<div class="msg-error">${esc(s.error)}</div>` : "") +
      (s.tools.length ? `<div class="mcp-server__tools">${s.tools.map((x) => `<span class="chip" title="${esc(x.description || "")}">${esc(x.tool)}</span>`).join("")}</div>` : "") +
      `</div>`;
  }).join("");
}

// ------------------------------------------------------------------ Model settings (GET / POST /config, #564)
// A few documented keys of the run config (strata-<model>.json), for every client, from the next start on.  The
// server lists them, checks every value and keeps every other key of the file as it is.  The server's help texts are
// English; CFG_HELP has the other language's, by key.
const CFG_HELP = {"zh-CN": {
  "sampling.temperature": "请求没有指定温度时用的默认值（0 = 每次选最可能的词；没有 sampling 配置时默认就是 0）",
  "sampling.top_p": "请求没有指定 top_p 时用的默认值",
  "sampling.top_k": "请求没有指定 top_k 时用的默认值（1～64）",
  "sampling.min_p": "请求没有指定 min_p 时用的默认值",
  "reasoning_budget_tokens": "每个请求的思考最多用多少个 token（0 或留空 = 不限制）",
  "fit_max_tokens": "max_tokens 超出剩余上下文时自动缩短，而不是返回 400 错误",
  "anthropic_thinking": "Anthropic 接口的请求没有要求思考时：照模型默认思考（model），或者不思考（on_request）",
  "effort_position": "非默认思考强度的提示放在哪里：start（开头，默认），或 end（结尾，切换强度时能保留缓存）",
  "aliases": "服务还接受哪些模型名（用英文逗号分隔）",
  "idle_unload_s": "连续多少秒没有请求就卸载模型、释放显存（0 或留空 = 不卸载）",
  "lazy_load": "启动时先不加载模型，第一个请求到来时再加载（只支持文字）",
  "engine_silence_s": "引擎多久没有输出就结束这个请求（默认 300 秒，0 = 一直等）",
  "api_monitor": "在内存里保留最近 100 个请求的提示词和回答，供 /api-monitor 页面查看",
  "open_browser": "模型准备好后自动在浏览器里打开对话页面",
  "vram_reserve_mib": "给其他程序留多少 MiB 显存（引擎默认 700）",
}};
const cfgHelp = (k) => (CFG_HELP[LANG] && CFG_HELP[LANG][k.key]) || k.help;
let cfgKeys = [];
async function loadConfig() {
  let r;
  try { r = await fetch("config", {headers: headers()}); } catch (e) { return; }
  if (!r.ok) { $("cfg-card").hidden = true; return; }       // no run config, an older server, or no key yet
  const c = await r.json();
  cfgKeys = c.keys || [];
  $("cfg-file").textContent = c.file || "";
  $("cfg-form").innerHTML = cfgKeys.map((k, i) => {
    const id = `cfg-${i}`, v = k.value;
    let input;
    if (k.kind === "bool" || k.kind === "enum") {
      const opts = k.kind === "bool" ? [["true", t("on")], ["false", t("off")]] : k.choices.map((x) => [x, x]);
      const cur = v == null ? "" : String(v);
      input = `<select class="st-input" id="${id}"><option value=""${cur === "" ? " selected" : ""}>${esc(t("default"))}</option>` +
        opts.map(([val, text]) => `<option value="${esc(val)}"${cur === val ? " selected" : ""}>${esc(text)}</option>`).join("") + `</select>`;
    } else {
      const text = v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
      input = `<input class="st-input" id="${id}" ${k.kind === "number" ? 'type="number" step="any" min="0"' : 'type="text"'} ` +
        `value="${esc(text)}" placeholder="${esc(t("default"))}" autocomplete="off">`;
    }
    return `<label for="${id}" title="${esc(cfgHelp(k))}">${esc(cfgHelp(k))}<code>${esc(k.key)}</code></label>${input}`;
  }).join("");
  $("cfg-card").hidden = false;
}
function configValue(k, el) {
  const s = el.value.trim();
  if (s === "") return null;
  if (k.kind === "bool") return s === "true";
  if (k.kind === "number") return Number(s);
  return s;                                         // enum, or names (the server splits them at commas)
}
$("cfg-save").addEventListener("click", async () => {
  const set = {};
  cfgKeys.forEach((k, i) => {
    const v = configValue(k, $(`cfg-${i}`));
    const old = Array.isArray(k.value) ? k.value.join(", ") : k.value;
    if (JSON.stringify(v) !== JSON.stringify(old ?? null)) set[k.key] = v;
  });
  if (!Object.keys(set).length) { $("cfg-msg").textContent = t("Nothing changed."); return; }
  try {
    const r = await fetch("config", {method: "POST", headers: headers(true), body: JSON.stringify({set})});
    const b = await r.json();
    if (!r.ok) throw new Error((b.error || {}).message || `HTTP ${r.status}`);
    $("cfg-msg").textContent = b.changed.length
      ? t("Saved ({keys}); the earlier file is {file}.bak. Start the model again to use it.", {keys: b.changed.join(", "), file: b.file}) : t("Nothing changed.");
    loadConfig();
  } catch (e) {
    $("cfg-msg").textContent = "";
    toast("error", t("Not saved"), String(e.message || e), 6000);
  }
});

// ------------------------------------------------------------------ Command-line options (About)
// setup.py's options and the engine's (the run config's "args"), in the words of setup.py --help and docs/DETAILS.md.
// [option, English, Chinese]
const OPTS = [
  [L("Install and download", "安装和下载"), [
    ["--yes", "Accept the recommended answers, no questions", "全部使用推荐选项，不再逐个提问"],
    ["--setup", "Install another model or change settings instead of starting", "安装另一个模型或修改设置（不直接启动）"],
    ["--no-start", "Install only, do not start the model", "只安装，不启动模型"],
    ["--update", "Update the engine, Python packages and model settings without starting (UPDATE.bat / update.sh)",
     "更新引擎、Python 依赖和模型设置，但不启动（UPDATE.bat / update.sh 用的就是它）"],
    ["--check", "Only check this PC (GPU, driver, RAM, disk) and exit", "只检查这台电脑（显卡、驱动、内存、硬盘）然后退出"],
    ["--family qwen|swift|coder|unsloth", "Which model: the original, Swift 1.5 (shorter thinking), Coder (half the experts, 32 GB RAM) or Unsloth's",
     "选模型：原版 Qwen3.8-Flash-Next、Swift 1.5（思考更短）、Coder（只保留一半专家，32 GB 内存可用）或 Unsloth 版"],
    ["--model Q2_0|IQ3_S|…", "Which size (quantization); setup shows the size, RAM and real bits of each", "选大小（量化版本）；菜单会显示每个版本的大小、内存占用和专家的真实位数"],
    ["--source auto|modelscope|huggingface", "Where the model files come from: auto = ModelScope first, Hugging Face when ModelScope does not answer",
     "模型从哪里下载：auto（默认）= 先用 ModelScope（魔搭），连不上再用 Hugging Face"],
    ["--data-dir DIR", "Where the model files go (~70-120 GB); remembered", "模型等数据放在哪里（约 70～120 GB）；会记住"],
    ["--models-dir DIR", "Where only the GGUF files go", "只把 GGUF 文件放到另一个目录"],
    ["--gguf-dir DIR", "Use GGUF files you already have (a folder with every shard); nothing is downloaded", "使用已经下载好的 GGUF 文件（目录里要有全部分片），不再下载"],
    ["--inspect SOURCE", "Read a GGUF's headers only (file, folder, URL, ms:owner/repo, hf:owner/repo): what it is and whether Strata runs it",
     "只读文件头，不下载：查看一个 GGUF（文件、目录、网址、ms:作者/仓库、hf:作者/仓库）的真实量化，以及 Strata 能不能运行"],
    ["--build", "Compile the engine here instead of using the ready-made one", "在本机编译引擎，不用预编译版本"],
    ["--cuda 12|13|auto", "The CUDA toolkit of the engine; 12 also runs with an older driver", "引擎用哪个 CUDA 版本；12 可以配合较旧的驱动"],
    ["--calibrate", "Tune the engine's settings for this PC (about 5-10 minutes), then start", "在这台电脑上实测并调好引擎参数（约 5～10 分钟），然后启动"],
  ]],
  [L("Running", "运行设置"), [
    ["--context N", "Context length in tokens: how much text the model keeps in mind. Longer needs more memory",
     "上下文长度（token 数）：模型一次能记住多少内容。越长占用的内存越多"],
    ["--kv int8|q4_0|k8v4", "KV cache precision above 8K context: int8 (default), q4_0 (half the memory, a little less precise), k8v4 (8-bit K, 4-bit V)",
     "8K 以上上下文的 KV 缓存精度：int8（默认）；q4_0 省一半内存但精度略低；k8v4 = K 用 8 位、V 用 4 位"],
    ["--kv-streaming auto|on|off", "Keep most of a long context's KV cache in RAM so VRAM holds more experts", "长上下文时把大部分 KV 缓存放到内存，把显存留给专家"],
    ["--vision yes|no|gpu|cpu", "Let the model read images (yes = the encoder on the GPU)", "让模型能看图片（yes = 图片编码器放在显卡上）"],
    ["--vision-tokens N", "The most image tokens a picture becomes: more reads small text better and takes longer",
     "一张图片最多变成多少个 token：越多越能看清小字和图表，但处理更慢"],
    ["--low-ram auto|on|off", "Read the experts from the model file instead of copying them all into RAM (PCs with too little RAM)",
     "内存放不下全部专家时，直接从模型文件读取专家"],
    ["--resident-budget-gib N", "Unsloth sizes: how many GiB of experts stay in RAM; the rest is read from the SSD",
     "只用于 Unsloth 版本：多少 GiB 的专家常驻内存，其余从固态硬盘读取"],
    ["--vram-reserve-mib N", "VRAM in MiB left free for other programs (default 700)", "给其他程序留多少 MiB 显存（默认 700）"],
    ["--parallel N", "Up to N requests decode together (uses more VRAM); default one at a time", "最多同时处理 N 个请求（占用更多显存）；默认一次一个"],
    ["--draft-vocab cjk|en|…", "The draft layer's tokens: cjk (default) includes Chinese, Japanese and Korean", "草稿层的词表：cjk（默认）包含中日韩文字，中文用户保持默认即可"],
    ["--rope-scaling / --rope-scale", "Extend the context past the trained 262144 tokens (yarn by default)", "把上下文扩展到训练长度 262144 之外（默认用 yarn）"],
    ["--experimental-speed-projection on|off", "Experimental, off by default: a control vector its package describes as a refusal-direction projection",
     "实验功能，默认关闭：一个控制向量，其发布包把它描述为“拒答方向投影”"],
  ]],
  [L("Network and GPUs", "网络和显卡"), [
    ["--port N", "The server's port (8080 for a new install)", "服务端口（新安装默认 8080）"],
    ["--host 0.0.0.0", "Let other devices on your network connect (set --api-key too); default 127.0.0.1 = this PC only",
     "允许局域网里的其他设备访问（建议同时设置 --api-key）；默认 127.0.0.1 = 只允许本机"],
    ["--api-key KEY", "Clients must send this key", "客户端必须带上这个密钥才能访问"],
    ["--no-browser / --browser", "Do not (or again) open the chat page when the model is ready", "模型准备好后不打开（或重新打开）对话页面"],
    ["--gpu N", "Which GPU, numbered as nvidia-smi numbers them", "用哪张显卡（编号和 nvidia-smi 一致）"],
    ["--gpus 0,1|all", "Several GPUs share one model; the first is the main one", "多张显卡共同运行一个模型；第一张是主卡"],
    ["--layer-split N,…", "With --gpus: where each later GPU's layers start (default: from each GPU's free VRAM)", "配合 --gpus：后面每张卡从第几层开始（默认按各卡空闲显存自动分配）"],
    ["--backend cuda|hip|sycl", "NVIDIA (cuda, default), AMD (hip) or Intel Arc (sycl)", "NVIDIA（cuda，默认）、AMD（hip）或 Intel Arc（sycl）"],
  ]],
  [L("Engine options (the run config's \"args\")", "引擎参数（运行配置里的 \"args\"）"), [
    ["--expert-cache auto|N", "How many experts stay in VRAM; auto = as many as the free VRAM holds", "显存里放多少个专家；auto = 按剩余显存自动计算"],
    ["--spec N", "Speculative decoding: the MTP draft layer guesses up to N-1 tokens, the model checks them at once",
     "投机解码：MTP 草稿层先猜最多 N-1 个 token，大模型一次核对，猜对的直接采用（不改变输出质量）"],
    ["--spec-min-p F", "Stop guessing further when the draft is less sure than this", "草稿把握度低于这个值时就不再往下猜"],
    ["--max-context N", "The longest context the engine plans its memory for", "引擎按多长的上下文分配内存"],
    ["--kv-resident N", "KV streaming: positions per layer kept in VRAM, the rest in RAM", "KV 分流：每层多少个位置留在显存，其余放内存"],
    ["--adapt-every N", "Update the VRAM expert cache every N decode windows (engine default 4)", "每隔几个解码窗口更新一次显存里的专家（引擎默认 4）"],
    ["--adapt-swaps N", "The most experts swapped into VRAM per update (engine default 96)", "每次更新最多换入多少个专家（引擎默认 96）"],
    ["--adapt-decay F", "How fast old expert usage is forgotten; closer to 1 = longer memory (engine default 0.7)",
     "专家使用次数的衰减系数，越接近 1 记得越久（引擎默认 0.7）"],
    ["--pcie-frac F", "The share of RAM experts the GPU reads directly over PCIe (measured by the engine when omitted)",
     "让显卡通过 PCIe 直接读取内存中专家的比例（不填时引擎自动测量）"],
    ["--pool-workers N", "CPU threads computing the experts in RAM (default: the physical cores less the host's)", "在 CPU 上计算内存中专家的线程数（默认：物理核心数减去主线程占用）"],
    ["--conversation-cache-mib N", "Keep several conversations' state in this much RAM, for apps that take turns", "用这么多 MiB 内存保存多个对话的状态，适合多个应用轮流使用"],
  ]],
];
$("opts").innerHTML = OPTS.map(([group, rows]) =>
  `<details class="st-collapse"><summary><span>${esc(group)}</span>${icon("chevron", "st-icon st-icon--sm st-chev")}</summary>` +
  `<div class="st-collapse__body"><table class="opt-table"><thead><tr><th>${esc(t("Option"))}</th><th>${esc(t("What it does"))}</th></tr></thead><tbody>` +
  rows.map(([o, en, zh]) => `<tr><td><code>${esc(o)}</code></td><td>${esc(L(en, zh))}</td></tr>`).join("") +
  `</tbody></table></div></details>`).join("");

// ------------------------------------------------------------------ math (the LaTeX models write: $...$, $$...$$, \(...\), \[...\])
// Not a TeX engine: the common commands become text and HTML (×, ÷, fractions, powers, roots, Greek letters,
// \text{}), anything else shows its name.  Enough for the arithmetic and school math of a chat, with no library.
const TEX_SYM = {times: "×", div: "÷", cdot: "·", pm: "±", mp: "∓", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠",
  approx: "≈", equiv: "≡", sim: "∼", propto: "∝", infty: "∞", to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒",
  Leftarrow: "⇐", Leftrightarrow: "⇔", iff: "⇔", implies: "⇒", therefore: "∴", because: "∵", in: "∈", notin: "∉",
  subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅", forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨",
  sum: "∑", prod: "∏", int: "∫", partial: "∂", nabla: "∇", circ: "°", degree: "°", angle: "∠", perp: "⊥", parallel: "∥",
  triangle: "△", ldots: "…", cdots: "⋯", dots: "…", prime: "′", log: "log", ln: "ln", sin: "sin", cos: "cos", tan: "tan",
  lim: "lim", max: "max", min: "min", exp: "exp", alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω", quad: " ", qquad: "  ", ",": " ", ";": " ", " ": " ", "!": "",
  "{": "{", "}": "}", "%": "%", "$": "$", "#": "#", "&": "&", "_": "_", left: "", right: "", displaystyle: "",
  limits: "", big: "", Big: "", bigl: "", bigr: ""};
const TEX_TEXT = new Set(["text", "mathrm", "textrm", "textbf", "mathbf", "mathit", "operatorname", "mbox", "boxed"]);
// a {...} group (or one character) at i: [its TeX, the index after it]
function texArg(s, i) {
  while (s[i] === " ") i++;
  if (s[i] === "\\") {                                  // a command: ^\circ, \frac\pi2
    const m = /^\\([A-Za-z]+|[\s\S])/.exec(s.slice(i));
    return [m ? m[0] : "\\", i + (m ? m[0].length : 1)];
  }
  if (s[i] !== "{") return [s[i] || "", i + 1];
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return [s.slice(i + 1), s.length];
}
// TeX -> HTML; the input is raw text, and every character of it that reaches the page is escaped here
function tex(s) {
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "\\") {
      const m = /^\\([A-Za-z]+|[\s\S])/.exec(s.slice(i));
      const name = m ? m[1] : "";
      i += 1 + name.length;
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const [a, j] = texArg(s, i), [b, k] = texArg(s, j);
        out += `<span class="mfrac"><span>${tex(a)}</span><span>${tex(b)}</span></span>`;
        i = k;
      } else if (name === "sqrt") {
        const [a, j] = texArg(s, i);
        out += `√<span class="msqrt">${tex(a)}</span>`;
        i = j;
      } else if (TEX_TEXT.has(name)) {
        const [a, j] = texArg(s, i);
        out += name === "text" || name === "mbox" ? esc(a) : tex(a);
        i = j;
      } else if (name === "\\") {
        out += "<br>";                                  // a new line in an aligned block
      } else if (name in TEX_SYM) {
        out += esc(TEX_SYM[name]);
      } else {
        out += esc(name);
      }
    } else if (c === "^" || c === "_") {
      const [a, j] = texArg(s, i + 1), tag = c === "^" ? "sup" : "sub";
      out += `<${tag}>${tex(a)}</${tag}>`;
      i = j;
    } else if (c === "{" || c === "}" || c === "&") {
      i++;                                              // grouping and alignment only
    } else {
      out += esc(c);
      i++;
    }
  }
  return out;
}
const mathInline = (s) => `<span class="math">${tex(s)}</span>`;
const mathBlock = (s) => `<div class="math math--block">${tex(s.trim())}</div>`;

// ------------------------------------------------------------------ Markdown (escaped first, then formatted)
function inline(s) {
  const codes = [], maths = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  // inline math: \(...\), or $...$ with no space just inside the dollars and no digit after the closing one ($5 and $10 stay)
  s = s.replace(/\\\((.+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, a, b) => { maths.push(a || b); return `\u0001${maths.length - 1}\u0001`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="inline">${esc(codes[+i])}</code>`)
          .replace(/\u0001(\d+)\u0001/g, (_, i) => mathInline(maths[+i]));
}
function codeBlock(lang, code) {
  return `<div class="st-code"><div class="st-code__head"><span>${esc(lang || "code")}</span>` +
    `<button class="st-btn st-btn--icon" data-code-copy aria-label="${esc(t("Copy code"))}">${icon("copy")}</button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`;
}
function blocks(text) {
  const out = [], lines = text.split("\n");
  let para = [], list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) { flushPara(); flushList(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<${m[1].length <= 2 ? "h3" : "h4"}>${inline(m[2])}</${m[1].length <= 2 ? "h3" : "h4"}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let html = `<table><thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      i--;
      out.push(html + "</tbody></table>");
      continue;
    }
    if ((m = l.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = {tag, items: []}; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
    flushList();
    para.push(l);
  }
  flushPara(); flushList();
  return out.join("");
}
// the text between code blocks: display math ($$...$$, \[...\]) on its own, the rest as Markdown blocks
function prose(text) {
  let html = "", pos = 0;
  for (const m of text.matchAll(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g)) {
    html += blocks(text.slice(pos, m.index)) + mathBlock(m[1] || m[2]);
    pos = m.index + m[0].length;
  }
  return html + blocks(text.slice(pos));
}
function markdown(text) {
  let html = "", rest = text;
  for (;;) {
    const m = rest.match(/(^|\n)```([^\n`]*)\n/);
    if (!m) { html += prose(rest); break; }
    html += prose(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    const end = rest.match(/(^|\n)```[ \t]*(\n|$)/);
    if (!end) { html += codeBlock(m[2].trim(), rest); break; }         // still streaming
    html += codeBlock(m[2].trim(), rest.slice(0, end.index));
    rest = rest.slice(end.index + end[0].length);
  }
  return html;
}

// ------------------------------------------------------------------ Chat settings: sampling, thinking, system prompt
const DEFAULTS = {thinking: "high", temperature: 0.6, top_p: 0.95, top_k: 20, max: "", seed: "", show: true, esp: true, mcp: true,
                  role: "", system: ""};
// three starting points for the sliders; "balanced" is the default
const PRESETS = {precise: {temperature: 0, top_p: 0.95, top_k: 20}, balanced: {temperature: 0.6, top_p: 0.95, top_k: 20},
                 creative: {temperature: 1.0, top_p: 0.95, top_k: 40}};
// ready-made system prompts; "custom" is whatever the user wrote
const ROLES = [
  ["assistant", L("General assistant", "通用助手"),
   L("You are a helpful assistant. Answer clearly and to the point.", "你是一个乐于助人的助手。请用简体中文回答，条理清楚，重点突出。")],
  ["translator", L("Translator (Chinese ⇄ English)", "中英互译"),
   L("You are a professional translator. Translate Chinese into English and any other language into Simplified Chinese. Output only the translation.",
     "你是专业翻译。用户输入中文时翻译成英文，输入其他语言时翻译成简体中文。只输出译文，不要解释。")],
  ["coder", L("Coding assistant", "编程助手"),
   L("You are a senior programmer. Give complete, runnable code and explain the approach and pitfalls briefly.",
     "你是资深程序员。给出完整、可运行的代码，并用中文简要说明思路和需要注意的地方。")],
  ["editor", L("Writing editor", "写作润色"),
   L("You are an editor. Polish the user's text without changing its meaning: clear, correct and concise. List the main changes after it.",
     "你是中文写作编辑。在不改变原意的前提下润色用户的文字，使其通顺、准确、简洁，并在后面列出主要修改。")],
  ["summary", L("Summarizer", "总结要点"),
   L("Summarize what the user gives you: one sentence first, then the key points as a list.",
     "请总结用户提供的内容：先用一句话概括，再分条列出要点。")],
];
const roleName = (id) => (id === "custom" ? t("Custom") : (ROLES.find((r) => r[0] === id) || [])[1] || "");
let settings = {...DEFAULTS, ...store.get("sampling", {})};
const THINK_HELP = {none: "answers right away", low: "short", medium: "medium", high: "thorough (default)"};

function saveSettings() { store.set("sampling", settings); renderQuick(); }
// the composer's own controls: thinking depth and the active role
function renderQuick() {
  $("quick-thinking").value = settings.thinking;
  const sys = (settings.system || "").trim();
  $("role-chip").hidden = !sys;
  $("role-chip").textContent = sys ? t("Role: {name}", {name: roleName(settings.role) || t("Custom")}) : "";
  $("role-chip").title = sys;
}
$("quick-thinking").onchange = () => { settings.thinking = $("quick-thinking").value; saveSettings(); };
$("role-chip").onclick = () => openDrawer(true);

// ------------------------------------------------------------------ Conversations
// The chats live in this browser: strata.convs is the list ({id, title, created, updated, renamed}), strata.chat.<id>
// each one's messages, strata.conv the open one.  Pictures are kept by name only (they would fill the storage).
let convs = store.get("convs", null);
if (!Array.isArray(convs)) {                      // the single chat of an earlier version becomes the first one
  convs = [];
  const old = store.get("chat", []);
  if (Array.isArray(old) && old.length) {
    const id = newId(), time = old[old.length - 1].time || Date.now();
    convs.push({id, title: autoTitle(old), created: old[0].time || time, updated: time});
    if (store.set(`chat.${id}`, old) && store.set("convs", convs)) { store.del("chat"); store.set("conv", id); }
  }
}
let convId = store.get("conv", null);
if (!convs.some((c) => c.id === convId)) convId = convs.length ? [...convs].sort((a, b) => b.updated - a.updated)[0].id : newId();
let messages = store.get(`chat.${convId}`, []);
let attachments = [];                 // {name, url}
let busy = null;                      // {controller, msg}
let storageWarned = false;

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function autoTitle(list) {
  const first = (list || []).find((m) => m.role === "user" && (m.text || (m.files && m.files.length)));
  if (!first) return "";
  const text = (first.text || first.files[0].name).replace(/\s+/g, " ").trim();
  return text.length > 30 ? text.slice(0, 30) + "…" : text;
}
function saveChat() {
  let c = convs.find((x) => x.id === convId);
  if (!messages.length && !c) return;             // a new chat is listed from its first message on
  if (!c) { c = {id: convId, title: "", created: Date.now(), updated: Date.now()}; convs.push(c); }
  c.updated = Date.now();
  if (!c.renamed) c.title = autoTitle(messages) || c.title;
  const ok = store.set(`chat.${convId}`, messages.map((m) => ({...m, images: (m.images || []).map((i) => ({name: i.name})),
                                                                 files: (m.files || []).map((f) => ({name: f.name}))})))
             && store.set("convs", convs) && store.set("conv", convId);
  if (!ok && !storageWarned) {
    storageWarned = true;
    toast("error", t("The browser's storage is full"), t("This chat was not saved. Delete some old chats and try again."), 8000);
  }
  renderConvs();
}
function openConv(id) {
  if (busy) { toast("warn", t("Still writing"), t("Stop the answer first.")); return; }
  convId = id;
  messages = store.get(`chat.${id}`, []);
  store.set("conv", id);
  attachments = [];
  renderAttachments();
  renderChat();
  renderConvs();
  if (narrow()) showConvs(false);
  $("input").focus();
}
function newConv() {
  if (busy) { toast("warn", t("Still writing"), t("Stop the answer first.")); return; }
  if (!messages.length) { $("input").focus(); if (narrow()) showConvs(false); return; }
  openConv(newId());
}
function deleteConv(id) {
  if (busy && id === convId) { toast("warn", t("Still writing"), t("Stop the answer first.")); return; }
  const i = convs.findIndex((c) => c.id === id);
  if (i < 0) return;
  const [c] = convs.splice(i, 1), kept = store.get(`chat.${id}`, []);
  store.del(`chat.${id}`);
  store.set("convs", convs);
  if (id === convId) {
    const next = [...convs].sort((a, b) => b.updated - a.updated)[0];
    convId = next ? next.id : newId();
    messages = next ? store.get(`chat.${next.id}`, []) : [];
    store.set("conv", convId);
    renderChat();
  }
  renderConvs();
  toast("info", t("Chat deleted"), c.title || t("Untitled"), 6000, {label: t("Undo"), run: () => {
    convs.push(c);
    store.set(`chat.${id}`, kept);
    store.set("convs", convs);
    openConv(id);
  }});
}
function renameConv(id) {
  const c = convs.find((x) => x.id === id);
  if (!c) return;
  const name = prompt(t("Rename this chat"), c.title || "");
  if (name == null || !name.trim()) return;
  c.title = name.trim().slice(0, 80);
  c.renamed = true;
  store.set("convs", convs);
  renderConvs();
}
// the list: newest first, under Today / Yesterday / Previous 7 days / Older; the search looks at titles and messages
function renderConvs() {
  const q = $("conv-search").value.trim().toLowerCase();
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const t0 = day.getTime(), DAY = 86400000;
  const group = (time) => (time >= t0 ? "Today" : time >= t0 - DAY ? "Yesterday" : time >= t0 - 7 * DAY ? "Previous 7 days" : "Older");
  const match = (c) => !q || (c.title || "").toLowerCase().includes(q) ||
    store.get(`chat.${c.id}`, []).some((m) => (m.text || "").toLowerCase().includes(q));
  const list = [...convs].sort((a, b) => b.updated - a.updated).filter(match);
  let html = "", last = "";
  for (const c of list) {
    const g = group(c.updated);
    if (g !== last) { html += `<div class="convs__group">${esc(t(g))}</div>`; last = g; }
    html += `<div class="conv${c.id === convId ? " conv--on" : ""}" data-conv="${esc(c.id)}" role="button" tabindex="0">` +
      `<span class="conv__title">${esc(c.title || t("Untitled"))}</span>` +
      `<button class="st-btn st-btn--icon" data-conv-rename aria-label="${esc(t("Rename"))}" title="${esc(t("Rename"))}">${icon("edit", "st-icon st-icon--sm")}</button>` +
      `<button class="st-btn st-btn--icon" data-conv-delete aria-label="${esc(t("Delete"))}" title="${esc(t("Delete"))}">${icon("trash", "st-icon st-icon--sm")}</button></div>`;
  }
  $("conv-list").innerHTML = html || `<p class="muted small convs__empty">${esc(t(q ? "No matching chats" : "No chats yet"))}</p>`;
}
$("conv-list").addEventListener("click", (e) => {
  const item = e.target.closest("[data-conv]");
  if (!item) return;
  if (e.target.closest("[data-conv-delete]")) deleteConv(item.dataset.conv);
  else if (e.target.closest("[data-conv-rename]")) renameConv(item.dataset.conv);
  else if (item.dataset.conv !== convId) openConv(item.dataset.conv);
  else if (narrow()) showConvs(false);
});
$("conv-list").addEventListener("keydown", (e) => {
  const item = e.target.closest("[data-conv]");
  if (item && e.target === item && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openConv(item.dataset.conv); }
});
$("conv-search").addEventListener("input", renderConvs);
$("conv-new").onclick = newConv;

// the list is a column on a wide window (open unless closed), a sheet over the chat on a narrow one (closed unless opened)
const narrow = () => matchMedia("(max-width: 900px)").matches;
function showConvs(open, save = false) {
  document.body.classList.toggle("convs-open", open);
  $("convs-btn").setAttribute("aria-expanded", String(open));
  $("convs-scrim").hidden = !(open && narrow());
  if (save) store.set("convs.open", open);
}
$("convs-btn").onclick = () => showConvs(!document.body.classList.contains("convs-open"), !narrow());
$("convs-scrim").onclick = () => showConvs(false);
showConvs(!narrow() && store.get("convs.open", true));
matchMedia("(max-width: 900px)").addEventListener("change", (e) => showConvs(!e.matches && store.get("convs.open", true)));

// ------------------------------------------------------------------ Chat
function timeStr(time) { return new Date(time).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }

function msgEl(m, i) {
  const el = document.createElement("div");
  el.className = `st-msg st-msg--${m.role}`;
  el.dataset.i = i;
  if (m.role === "user") {
    if (m.files && m.files.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const f of m.files) {
        const c = document.createElement("span");
        c.className = "chip";
        c.innerHTML = icon("attach", "st-icon st-icon--sm");
        c.append(f.name);
        wrap.appendChild(c);
      }
      el.appendChild(wrap);
    }
    if (m.images && m.images.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const im of m.images) {
        if (im.url) { const img = document.createElement("img"); img.src = im.url; img.alt = im.name || "image"; wrap.appendChild(img); }
        else { const c = document.createElement("span"); c.className = "chip"; c.innerHTML = icon("image", "st-icon st-icon--sm"); c.append(im.name || "image"); wrap.appendChild(c); }
      }
      el.appendChild(wrap);
    }
    const b = document.createElement("div");
    b.className = "st-bubble";
    b.textContent = m.text;
    el.appendChild(b);
    const meta = document.createElement("div");
    meta.className = "st-msg__meta";
    meta.innerHTML = `<span class="meta-text"></span>` +
      `<button class="st-btn st-btn--icon" data-msg-edit aria-label="${esc(t("Edit and send again"))}" title="${esc(t("Edit and send again"))}">${icon("edit")}</button>` +
      `<button class="st-btn st-btn--icon" data-msg-copy aria-label="${esc(t("Copy"))}" title="${esc(t("Copy"))}">${icon("copy")}</button>`;
    meta.querySelector(".meta-text").textContent = `${t("You")} · ${timeStr(m.time)}`;
    el.appendChild(meta);
  } else {
    el.innerHTML = `<details class="st-collapse think" hidden><summary>${icon("thinking", "st-icon st-icon--sm")}<span class="think-title"></span>` +
      `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body thinking"></div></details>` +
      `<div class="st-bubble"></div><div class="st-msg__meta"><span class="meta-text"></span>` +
      `<button class="st-btn st-btn--icon" data-msg-copy aria-label="${esc(t("Copy the answer"))}" title="${esc(t("Copy"))}">${icon("copy")}</button>` +
      `<button class="st-btn st-btn--icon" data-msg-regen aria-label="${esc(t("Regenerate"))}" title="${esc(t("Regenerate"))}">${icon("refresh")}</button></div>`;
    updateAssistant(el, m, false);
  }
  return el;
}
// One MCP tool call in the answer: a compact block (name, state, a one-line preview) that opens to the arguments and
// the result as the model read it.  Its body is built only while open: a result can be 20,000 characters.
const TOOL_STATE = {writing: ["st-badge--reading", "Writing"], running: ["st-badge--generating", "Running"], done: ["", "Done"],
                    error: ["st-badge--error", "Error"], skipped: ["st-badge--queued", "Not run"]};
function toolHtml(x, k) {
  const [cls, label] = TOOL_STATE[x.state] || ["", x.state];
  const args = x.arguments == null ? "" : JSON.stringify(x.arguments, null, 2);
  const preview = x.result != null ? x.result : args.replace(/\s+/g, " ");
  let body = "";
  if (x.open) {
    body = `<div class="tool-call__label">${esc(t("Arguments"))}</div><pre class="tool-call__pre">${esc(args || t("(being written)"))}</pre>`;
    if (x.result != null) {
      body += `<div class="tool-call__label">${esc(t(x.ok ? "Result" : "Error"))}${x.chars ? esc(t(" · {n} characters", {n: fmt(x.chars)})) : ""}` +
              `${x.truncated ? esc(t(", cut for the model")) : ""}</div><pre class="tool-call__pre">${esc(x.result)}</pre>`;
    }
  }
  return `<details class="st-collapse tool-call" data-tool="${k}" data-state="${esc(x.state)}"${x.open ? " open" : ""}>` +
    `<summary>${icon("tool", "st-icon st-icon--sm")}<span class="tool-call__name" title="${esc(x.name || "")}">${esc(x.tool || x.name || "tool")}</span>` +
    (x.server ? `<span class="muted small">${esc(x.server)}</span>` : "") +
    `<span class="tool-call__preview muted">${esc(preview.slice(0, 200))}</span>` +
    `<span class="st-badge ${cls}">${esc(t(label))}</span>${x.ms != null && x.state !== "skipped" ? `<span class="muted small">${fmt(x.ms / 1000, 1)} s</span>` : ""}` +
    `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body">${body}</div></details>`;
}
// the answer's text with the tool blocks where the model called them
function answerHtml(m) {
  if (!m.tools || !m.tools.length) return markdown(m.text || "");
  let html = "", pos = 0;
  m.tools.forEach((x, k) => {
    const at = Math.min(Math.max(x.at || 0, pos), m.text.length);
    if (at > pos) html += markdown(m.text.slice(pos, at));
    pos = at;
    html += toolHtml(x, k);
  });
  return html + markdown(m.text.slice(pos));
}
// a tool event from the stream (the `strata_mcp` field of a chunk)
function onTool(m, x) {
  if (x.event === "limit") { m.limit = x.max_rounds; return; }
  m.tools = m.tools || [];
  let y = m.tools.find((z) => z.id === x.id);
  if (!y) { y = {id: x.id, name: x.name, at: m.text.length, rat: m.reasoning.length, state: "writing"}; m.tools.push(y); }
  if (x.event === "call") {
    Object.assign(y, {name: x.name, server: x.server, tool: x.tool, arguments: x.arguments, round: x.round, state: "running"});
  } else if (x.event === "result") {
    Object.assign(y, {result: x.text, ok: x.ok, chars: x.chars, truncated: x.truncated, ms: x.ms,
                      state: x.skipped ? "skipped" : x.ok ? "done" : "error"});
  }
}
function updateAssistant(el, m, streaming) {
  const det = el.querySelector("details.think");
  if (m.reasoning) {
    det.hidden = false;
    const thinkingNow = streaming && !m.text;
    el.querySelector(".think-title").textContent = thinkingNow ? t("Thinking…") :
      m.thinkSecs != null ? t("Thought for {s} s", {s: fmt(m.thinkSecs, 1)}) : t("Thoughts");
    const body = el.querySelector(".thinking");
    if (det.open || thinkingNow) body.textContent = m.reasoning;
    else body.dataset.pending = "1";
    // open while it streams (if wanted), closed once the answer starts - unless the user toggled it themselves
    if (thinkingNow && settings.show && !det.dataset.touched && !det.open) { det._auto = true; det.open = true; }
    if (!thinkingNow && det.open && !det.dataset.touched) { det._auto = true; det.open = false; }
  }
  const bubble = el.querySelector(".st-bubble");
  if (m.error) {
    bubble.innerHTML = `<div class="msg-error"></div>`;
    bubble.firstChild.textContent = m.error;
  } else if (!m.text && streaming && !(m.tools && m.tools.length)) {
    bubble.innerHTML = m.reasoning ? `<span class="muted cursor">${esc(t("Writing"))}</span>` : `<span class="cursor"></span>`;
  } else {
    bubble.innerHTML = answerHtml(m);
    if (streaming) bubble.classList.add("cursor"); else bubble.classList.remove("cursor");
  }
  el.querySelector(".meta-text").textContent = m.meta || (streaming ? "" : m.stopped ? t("Stopped") : "");
  el.querySelector("[data-msg-copy]").hidden = streaming || !m.text;
  // a new answer: only for the last one, when nothing is being written
  el.querySelector("[data-msg-regen]").hidden = streaming || +el.dataset.i !== messages.length - 1;
}
// example questions on an empty chat: a click puts one in the message box
const STARTERS = [
  L("Explain how a mixture-of-experts model works, in simple words", "用通俗的话解释一下“混合专家”模型是怎么工作的"),
  L("Write a Python script that renames all photos in a folder by date", "写一个 Python 脚本，按拍摄日期批量重命名文件夹里的照片"),
  L("Translate into Chinese: Strata runs a 125B model on a gaming PC.", "翻译成英文：在自己的电脑上运行大模型，数据不出本机。"),
  L("Give me a one-week study plan for learning SQL", "帮我制定一个一周入门 SQL 的学习计划"),
];
$("starters").innerHTML = STARTERS.map((s) => `<button type="button" class="starter">${esc(s)}</button>`).join("");
$("starters").addEventListener("click", (e) => {
  const b = e.target.closest(".starter");
  if (!b) return;
  $("input").value = b.textContent;
  autosize();
  $("input").focus();
});
function renderChat() {
  const chat = $("chat");
  chat.querySelectorAll(".st-msg").forEach((e) => e.remove());
  $("chat-empty").hidden = messages.length > 0;
  messages.forEach((m, i) => chat.appendChild(msgEl(m, i)));
  scrollDown(true);
}
function nearBottom() { const s = $("chat-scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; }
function scrollDown(force) { const s = $("chat-scroll"); if (force || nearBottom()) s.scrollTop = s.scrollHeight; }

$("chat").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-code-copy]");
  if (cc) { copyText(cc.closest(".st-code").querySelector("pre").textContent, cc); return; }
  const mc = e.target.closest("[data-msg-copy]");
  if (mc) { const i = +mc.closest(".st-msg").dataset.i; copyText(messages[i].text, mc); return; }
  const rg = e.target.closest("[data-msg-regen]");
  if (rg) { regenerate(); return; }
  const ed = e.target.closest("[data-msg-edit]");
  if (ed) { editFrom(+ed.closest(".st-msg").dataset.i); return; }
  // a tool block: its open state lives in the message (the answer is rebuilt while it streams), so the click sets it
  const sum = e.target.closest(".tool-call > summary");
  if (sum) {
    e.preventDefault();
    const el = sum.closest(".st-msg"), m = messages[+el.dataset.i], x = m && m.tools && m.tools[+sum.parentElement.dataset.tool];
    if (!x) return;
    x.open = !x.open;
    updateAssistant(el, m, !!busy && busy.msg === m);
  }
});
$("chat").addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.tagName !== "DETAILS" || !d.classList.contains("think")) return;
  if (d._auto) { d._auto = false; return; }          // our own open/close, not the user's
  d.dataset.touched = "1";
  const body = d.querySelector(".thinking");
  if (d.open && body.dataset.pending) { body.textContent = messages[+d.closest(".st-msg").dataset.i].reasoning; delete body.dataset.pending; }
}, true);

function apiMessages() {
  const out = [];
  const sys = (settings.system || "").trim();
  if (sys) out.push({role: "system", content: sys});
  for (const m of messages) {
    if (m.role === "user") {
      const imgs = (m.images || []).filter((i) => i.url);
      const text = userText(m);
      out.push({role: "user", content: imgs.length ? [{type: "text", text},
        ...imgs.map((i) => ({type: "image_url", image_url: {url: i.url}}))] : text});
    } else if (!m.error) {
      out.push(...assistantMessages(m));
    }
  }
  return out;
}
// An answer that used MCP tools goes back as the model wrote it: per round the text before the calls, the calls and
// their results (as the model read them), then the rest - so the next question can build on what the tools found.
function assistantMessages(m) {
  const ran = (m.tools || []).filter((x) => x.round != null && x.result != null && x.state !== "skipped");
  if (!ran.length) return m.text ? [{role: "assistant", content: m.text}] : [];
  const out = [];
  let pos = 0;
  for (const r of [...new Set(ran.map((x) => x.round))]) {
    const calls = ran.filter((x) => x.round === r);
    const at = Math.min(Math.max(pos, calls[0].at || 0), m.text.length);
    out.push({role: "assistant", content: m.text.slice(pos, at).trim(),
              tool_calls: calls.map((x) => ({id: x.id, type: "function", function: {name: x.name, arguments: JSON.stringify(x.arguments || {})}}))});
    for (const x of calls) out.push({role: "tool", tool_call_id: x.id, content: x.result});
    pos = at;
  }
  const rest = m.text.slice(pos).trim();
  if (rest) out.push({role: "assistant", content: rest});
  return out;
}

function setBusy(on) {
  $("stop-btn").hidden = !on;
  $("send-btn").disabled = on;
  $("composer-hint").textContent = on ? "" : t("Shift+Enter: new line");
}

async function send() {
  const text = $("input").value.trim();
  if ((!text && !attachments.length) || busy) return;
  messages.push({role: "user", text, images: attachments.filter((a) => a.kind !== "file"),
                 files: attachments.filter((a) => a.kind === "file"), time: Date.now()});
  attachments = [];
  renderAttachments();
  $("input").value = "";
  autosize();
  await answer();
}
// a new answer to the last question (the old one is replaced)
function regenerate() {
  if (busy || !messages.length || messages[messages.length - 1].role !== "assistant") return;
  messages.pop();
  answer();
}
// a question back in the message box: it and everything after it leave the chat (Undo puts them back)
function editFrom(i) {
  if (busy) { toast("warn", t("Still writing"), t("Stop the answer first.")); return; }
  const m = messages[i];
  if (!m || m.role !== "user") return;
  const removed = messages.slice(i);
  messages = messages.slice(0, i);
  $("input").value = m.text || "";
  attachments = [...(m.images || []).filter((x) => x.url), ...(m.files || []).filter((f) => f.text != null)];
  renderAttachments();
  autosize();
  renderChat();
  saveChat();
  $("input").focus();
}

async function answer() {
  const m = {role: "assistant", text: "", reasoning: "", time: Date.now()};
  messages.push(m);
  renderChat();
  const el = $("chat").lastElementChild;
  const controller = new AbortController();
  busy = {controller, msg: m};
  setBusy(true);

  const body = {model: health.model, messages: apiMessages(), stream: true,
                reasoning_effort: settings.thinking};
  if (settings.temperature > 0) {
    Object.assign(body, {temperature: +settings.temperature, top_p: +settings.top_p, top_k: +settings.top_k});
  } else {
    body.temperature = 0;
  }
  if (settings.seed) body.seed = +settings.seed;
  if (settings.max) body.max_tokens = +settings.max;
  if (projectionLoaded()) body.experimental_speed_projection = !!settings.esp;
  if (settings.mcp !== false && mcpInfo.tools > 0) body.strata_mcp = true;   // this server may run MCP tools for it

  let firstAt = null, thinkStart = null, usage = null, frame = 0;
  const paint = () => { frame = 0; updateAssistant(el, m, true); scrollDown(); };
  try {
    const r = await fetch("v1/chat/completions", {method: "POST", headers: headers(true), body: JSON.stringify(body),
                                                   signal: controller.signal});
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
      if (r.status === 401) msg = t("This server needs an API key: add it under About > Settings.");
      throw new Error(msg);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;              // ": keep-alive" comments while a long prompt is read
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new Error(j.error.message || t("the engine reported an error"));
        if (j.usage) usage = j.usage;
        if (j.strata_mcp) onTool(m, j.strata_mcp);
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        const lastTool = m.tools && m.tools.length ? m.tools[m.tools.length - 1] : null;   // a new round after a tool
        if (d.reasoning_content) {
          if (!firstAt) firstAt = performance.now();
          if (!thinkStart) thinkStart = performance.now();
          if (lastTool && m.reasoning && lastTool.rat === m.reasoning.length) m.reasoning += "\n\n";
          m.reasoning += d.reasoning_content;
        }
        if (d.content) {
          if (!firstAt) firstAt = performance.now();
          if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
          if (lastTool && m.text && lastTool.at === m.text.length) m.text += "\n\n";
          m.text += d.content;
        }
        if (!frame) frame = requestAnimationFrame(paint);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") m.stopped = true;
    else { m.error = e.message || String(e); toast("error", t("The request failed"), m.error, 6000); }
  }
  if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
  const n = usage ? usage.completion_tokens : null;
  if (n && firstAt) {
    const secs = (performance.now() - firstAt) / 1000;
    m.meta = `${t("{n} tokens", {n: fmt(n)})}${secs > 0.25 ? ` · ${fmt(n / secs, 1)} tok/s` : ""}${m.stopped ? t(" · stopped") : ""}` +
             (projectionLoaded() ? t(settings.esp ? " · projection on" : " · projection off") : "");
  } else if (m.stopped) {
    m.meta = t("Stopped");
  }
  for (const x of m.tools || []) if (x.state === "writing" || x.state === "running") { x.state = "skipped"; x.ms = null; }
  const ran = (m.tools || []).filter((x) => x.state === "done" || x.state === "error").length;
  if (ran) m.meta = `${m.meta ? `${m.meta} · ` : ""}${t(ran > 1 ? "{n} tool calls" : "{n} tool call", {n: ran})}`;
  if (m.limit) m.meta = `${m.meta || ""}${t(" · stopped at the limit of {n} tool rounds (mcp.max_rounds)", {n: m.limit})}`;
  busy = null;
  setBusy(false);
  if (frame) cancelAnimationFrame(frame);
  updateAssistant(el, m, false);
  // the answer before this one may have lost its "new answer" button's place as the last message
  for (const x of $("chat").querySelectorAll(".st-msg--assistant [data-msg-regen]")) x.hidden = x.closest(".st-msg") !== el;
  saveChat();
  scrollDown();
}

$("composer").onsubmit = (e) => { e.preventDefault(); send(); };
$("stop-btn").onclick = () => { if (busy) busy.controller.abort(); };
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
function autosize() { const x = $("input"); x.style.height = "auto"; x.style.height = `${Math.min(x.scrollHeight, innerHeight * 0.4)}px`; }
$("input").addEventListener("input", autosize);

$("new-btn").onclick = newConv;
$("export-btn").onclick = () => {
  if (!messages.length) { toast("info", t("Nothing to save yet")); return; }
  const tools = (m) => (m.tools || []).filter((x) => x.result != null).map((x) =>
    `<details><summary>${t("Tool")} ${x.server ? `${x.server} / ` : ""}${x.tool || x.name}${x.ok ? "" : ` (${t("Error")})`}</summary>\n\n` +
    `\`\`\`json\n${JSON.stringify(x.arguments || {}, null, 2)}\n\`\`\`\n\n\`\`\`\n${x.result}\n\`\`\`\n\n</details>\n\n`).join("");
  const sys = (settings.system || "").trim();
  const md = (sys ? `## ${t("System prompt")}\n\n${sys}\n\n` : "") + messages.map((m) => m.role === "user" ? `## ${t("You")}\n\n${m.text}\n` :
    `## ${health.model}\n\n${m.reasoning ? `<details><summary>${t("Thinking")}</summary>\n\n${m.reasoning}\n\n</details>\n\n` : ""}${tools(m)}${m.text || m.error || ""}\n`).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], {type: "text/markdown"}));
  a.download = `strata-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// pictures and text files: the attach button, dropping them on the chat, or pasting a picture (issue #30)
const TEXT_EXT = /\.(txt|md|markdown|rst|tex|py|pyi|ipynb|js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|jsonl|csv|tsv|log|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|c|cc|cpp|cxx|h|hh|hpp|cu|cuh|rs|go|java|kt|kts|swift|rb|php|pl|lua|r|jl|scala|sql|sh|bash|zsh|fish|ps1|psm1|bat|cmd|diff|patch|gradle|cmake|mk|dockerfile|gitignore|proto|graphql)$/i;
const MAX_TEXT_FILE = 512 * 1024;
function isTextFile(f) {
  return f.type.startsWith("text/") || /json|xml|javascript|yaml|toml|x-sh|x-python/.test(f.type) ||
         TEXT_EXT.test(f.name) || /(^|[\\/])(makefile|dockerfile|readme|license)$/i.test(f.name);
}
function addFiles(files) {
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      if (!health.images) { toast("warn", t("Pictures are off"), t("This model was set up for text only.")); continue; }
      if (f.size > 20e6) { toast("warn", t("Picture too large"), t("{name} is over 20 MB.", {name: f.name})); continue; }
      const r = new FileReader();
      r.onload = () => { attachments.push({kind: "image", name: f.name || t("pasted image"), url: r.result}); renderAttachments(); };
      r.readAsDataURL(f);
      continue;
    }
    if (!isTextFile(f)) {
      toast("warn", t("Not a text file"), t(health.images ? "{name}: attach text files (code, notes, logs, data) or pictures."
                                                           : "{name}: attach text files (code, notes, logs, data).", {name: f.name}));
      continue;
    }
    if (f.size > MAX_TEXT_FILE) { toast("warn", t("File too large"), t("{name} is over 512 KB.", {name: f.name})); continue; }
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result);
      if (text.includes("\u0000")) { toast("warn", t("Not a text file"), t("{name} looks like a binary file.", {name: f.name})); return; }
      attachments.push({kind: "file", name: f.name, text});
      renderAttachments();
    };
    r.readAsText(f);
  }
}
// a file's text in the message, fenced with more backticks than it contains itself
function fileBlock(f) {
  const longest = Math.max(2, ...(f.text.match(/`+/g) || []).map((s) => s.length));
  const fence = "`".repeat(longest + 1);
  return `File: ${f.name}\n${fence}\n${f.text}\n${fence}`;
}
function userText(m) {
  const files = (m.files || []).filter((f) => f.text != null);
  return [m.text, ...files.map(fileBlock)].filter((s) => s).join("\n\n");
}
function renderAttachments() {
  const box = $("attachments");
  box.hidden = !attachments.length;
  box.innerHTML = "";
  attachments.forEach((a, i) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = icon(a.kind === "file" || a.text != null ? "attach" : "image", "st-icon st-icon--sm");
    c.append(a.name);
    const x = document.createElement("button");
    x.type = "button"; x.className = "st-btn st-btn--icon"; x.setAttribute("aria-label", t("Remove"));
    x.innerHTML = icon("trash");
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    c.appendChild(x);
    box.appendChild(c);
  });
}
$("attach-btn").onclick = () => $("file").click();
// drop files on the chat or the message box
for (const id of ["chat", "composer"]) {
  const el = $(id);
  el.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer || {}).types || []].includes("Files")) return;
    e.preventDefault();
    $("composer").classList.add("dragging");
  });
  el.addEventListener("dragleave", () => $("composer").classList.remove("dragging"));
  el.addEventListener("drop", (e) => {
    $("composer").classList.remove("dragging");
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
    $("input").focus();
  });
}
$("file").onchange = () => { addFiles($("file").files); $("file").value = ""; };
$("input").addEventListener("paste", (e) => {
  if (!health.images) return;
  const files = [...(e.clipboardData || {}).files || []].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// ------------------------------------------------------------------ the sampling drawer
function openDrawer(open) {
  $("drawer").dataset.open = String(open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("scrim").hidden = !open;
  if (open) { loadDrawer(); loadShared(); loadMcp(); }
}
$("s-role").innerHTML = `<option value="">${esc(t("None"))}</option>` +
  ROLES.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("") + `<option value="custom">${esc(t("Custom"))}</option>`;
$("s-role").onchange = () => {
  const r = ROLES.find((x) => x[0] === $("s-role").value);
  if (r) $("s-system").value = r[2];
  else if (!$("s-role").value) $("s-system").value = "";
};
$("s-system").oninput = () => {
  const r = ROLES.find((x) => x[0] === $("s-role").value);
  if (!r || $("s-system").value !== r[2]) $("s-role").value = $("s-system").value.trim() ? "custom" : "";
};
// the long help under the sliders: what each one does and its default
$("h-thinking").textContent = L("Deeper thinking answers hard questions better but takes longer. For small talk or translation, Off is enough.",
  "思考越深入，复杂问题（数学、编程、分析）答得越好，但要多等一会儿。闲聊、翻译选“不思考”就够了。");
$("h-preset").textContent = L("Precise: temperature 0, the same answer every time (code, math, translation). Balanced: the defaults. " +
  "Creative: more varied wording (writing, brainstorming).",
  "精确：温度 0，每次回答相同，适合代码、数学、翻译。平衡：默认值，适合日常问答。创意：用词更多样，适合写作、头脑风暴。");
$("h-temp").textContent = L("Higher = more varied answers, lower = steadier ones. 0 = always the most likely word (exact, repeatable). Default 0.6.",
  "越高回答越多样、越有创意；越低越稳定。0 = 每次都选最可能的词，同样的问题得到同样的回答。默认 0.6。");
$("h-topp").textContent = L("Picks only among the most likely words that together reach this probability. Smaller = more conservative. Default 0.95; unused at temperature 0.",
  "只从概率最高、累计达到 p 的那些候选词里选。越小越保守。默认 0.95；温度为 0 时不起作用。");
$("h-topk").textContent = L("Picks only among the k most likely words. Smaller = more conservative. Default 20; unused at temperature 0.",
  "只从概率最高的 k 个候选词里选。越小越保守。默认 20；温度为 0 时不起作用。");
$("h-max").textContent = L("The longest answer in tokens (the units the model reads and writes text in).",
  "回答最长多少个 token（token 是模型处理文字的基本单位）。");
$("h-seed").textContent = L("With a fixed number the same question and settings give the same answer, so a result can be repeated.",
  "固定一个数字后，同样的问题和参数会得到同样的回答，方便复现结果。");

function loadDrawer(s = settings) {
  for (const b of $("s-thinking").children) b.setAttribute("aria-checked", String(b.dataset.v === s.thinking));
  $("s-temp").value = s.temperature; $("s-topp").value = s.top_p; $("s-topk").value = s.top_k;
  $("s-max").value = s.max; $("s-seed").value = s.seed;
  $("s-role").value = s.system && !s.role ? "custom" : s.role || "";
  $("s-system").value = s.system || "";
  $("s-show").setAttribute("aria-checked", String(!!s.show));
  $("s-esp").setAttribute("aria-checked", String(s.esp !== false));
  $("esp-row").hidden = !projectionLoaded();
  $("s-mcp").setAttribute("aria-checked", String(s.mcp !== false));
  $("s-share").setAttribute("aria-checked", String(sharedOn));
  outputs();
}
// "Use for other apps too": the server keeps these settings as every client's defaults (GET/POST /settings)
let sharedOn = false;
async function loadShared() {
  try {
    const r = await fetch("settings", {headers: headers()});
    if (r.ok) sharedOn = !!(await r.json()).shared;
  } catch (e) { /* an older server: the switch just stays off */ }
  $("s-share").setAttribute("aria-checked", String(sharedOn));
}
function sharedDefaults(s) {
  const d = {reasoning_effort: s.thinking, temperature: +s.temperature};
  if (+s.temperature > 0) Object.assign(d, {top_p: +s.top_p, top_k: +s.top_k});
  if (s.seed) d.seed = +s.seed;
  if (s.max) d.max_tokens = +s.max;
  if (projectionLoaded()) d.experimental_speed_projection = s.esp !== false;
  return d;
}
async function saveShared(on, s) {
  const r = await fetch("settings", {method: "POST", headers: headers(true),
                                      body: JSON.stringify({defaults: on ? sharedDefaults(s) : null})});
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
    throw new Error(msg);
  }
  sharedOn = !!(await r.json()).shared;
}
// the engine was started with the experimental-speed-projection control vector (INFO cvec=...)
function projectionLoaded() {
  const c = lastMetrics && lastMetrics.engine ? lastMetrics.engine.cvec : 0;
  return !!c && c !== "0";
}
function outputs() {
  const temp = +$("s-temp").value;
  $("o-temp").textContent = temp === 0 ? t("0 · greedy") : temp.toFixed(2);
  $("o-topp").textContent = (+$("s-topp").value).toFixed(2);
  $("o-topk").textContent = $("s-topk").value;
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  $("o-thinking").textContent = sel ? t(THINK_HELP[sel.dataset.v]) : "";
  for (const id of ["s-topp", "s-topk"]) $(id).disabled = temp === 0;
  // the preset these sliders are, if any
  const cur = {temperature: temp, top_p: +$("s-topp").value, top_k: +$("s-topk").value};
  const same = (p) => p.temperature === cur.temperature && (p.temperature === 0 || (p.top_p === cur.top_p && p.top_k === cur.top_k));
  for (const b of $("s-preset").children) b.setAttribute("aria-checked", String(same(PRESETS[b.dataset.v])));
}
for (const b of $("s-thinking").children) b.onclick = () => { for (const x of $("s-thinking").children) x.setAttribute("aria-checked", String(x === b)); outputs(); };
for (const b of $("s-preset").children) b.onclick = () => {
  const p = PRESETS[b.dataset.v];
  $("s-temp").value = p.temperature; $("s-topp").value = p.top_p; $("s-topk").value = p.top_k;
  outputs();
};
for (const id of ["s-temp", "s-topp", "s-topk"]) $(id).oninput = outputs;
$("s-show").onclick = () => $("s-show").setAttribute("aria-checked", String($("s-show").getAttribute("aria-checked") !== "true"));
$("s-esp").onclick = () => $("s-esp").setAttribute("aria-checked", String($("s-esp").getAttribute("aria-checked") !== "true"));
$("s-mcp").onclick = () => $("s-mcp").setAttribute("aria-checked", String($("s-mcp").getAttribute("aria-checked") !== "true"));
$("s-share").onclick = () => $("s-share").setAttribute("aria-checked", String($("s-share").getAttribute("aria-checked") !== "true"));
$("s-reset").onclick = () => loadDrawer(DEFAULTS);
$("s-apply").onclick = async () => {
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  const system = $("s-system").value.trim();
  settings = {thinking: sel ? sel.dataset.v : "high", temperature: +$("s-temp").value, top_p: +$("s-topp").value,
              top_k: +$("s-topk").value, max: $("s-max").value.trim(), seed: $("s-seed").value.trim(),
              show: $("s-show").getAttribute("aria-checked") === "true",
              esp: $("s-esp").getAttribute("aria-checked") === "true",
              mcp: $("s-mcp").getAttribute("aria-checked") === "true",
              role: system ? $("s-role").value : "", system};
  saveSettings();
  const share = $("s-share").getAttribute("aria-checked") === "true";
  openDrawer(false);
  if (share || sharedOn) {
    try {
      await saveShared(share, settings);
      toast("success", t("Sampling saved"), share ? t("Other apps (omp, API clients) use these settings from their next request.")
                                                  : t("Other apps use their own settings again."));
    } catch (e) {
      toast("error", t("Saved here, but not for other apps"), e.message, 6000);
    }
    return;
  }
  toast("success", t("Sampling saved"), settings.temperature === 0 ? t("Greedy: the same question gives the same answer.") : "");
};
$("sampling-btn").onclick = () => openDrawer(true);
$("drawer-close").onclick = () => openDrawer(false);
$("scrim").onclick = () => openDrawer(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("drawer").dataset.open === "true") openDrawer(false); });

// ------------------------------------------------------------------ start
setBusy(false);
renderQuick();
renderConvs();
renderChat();
const startQuestion = new URLSearchParams(location.search).get("q");   // /?q=... starts a chat (a shortcut)
if (startQuestion) history.replaceState(null, "", location.pathname + location.hash);
loadHealth().then(loadMcp).then(() => { if (startQuestion) { $("input").value = startQuestion; send(); } });
showTab(location.hash.slice(1) || "chat");
poll();
