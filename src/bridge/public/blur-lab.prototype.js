// PROTOTYPE — throwaway. Lives only on branch prototype/ios-top-blur; never merge.
//
// Question: which strategy removes iOS 27's system top-edge blur on an installed PWA
// WITHOUT pushing content down (clearance padding is the fallback we want to drop)?
//
// Inert unless the page URL carries ?lab=<status-bar-style>. Two axes:
//  - Install-time (?lab=default|black|translucent|none): the apple-mobile-web-app-
//    status-bar-style iOS bakes into the home-screen icon at Add-to-Home time. One
//    icon per value; the query survives into the icon's start URL.
//  - Runtime (floating switcher, persisted in localStorage so it survives a cold
//    relaunch): strips WebKit may sample + "kicks" that may knock the blur off.
(() => {
  const lab = new URLSearchParams(location.search).get("lab");
  if (!lab) return;

  // --- install-time axis -----------------------------------------------------
  const sbsMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  const sbs = { default: "default", black: "black", translucent: "black-translucent" }[lab];
  if (sbs) sbsMeta.setAttribute("content", sbs);
  else if (lab === "none") sbsMeta.remove();
  document.querySelector('meta[name="apple-mobile-web-app-title"]').setAttribute("content", `lab-${lab}`);

  // --- runtime axis ----------------------------------------------------------
  const PRESETS = [
    { key: "A", short: "raw", name: "raw (no fix)", flags: [] },
    { key: "B", short: "shipped", name: "shipped: 1px strip + 16px clearance", flags: ["strip1", "clear16"] },
    { key: "C", short: "strip 11", name: "11px opaque strip", flags: ["strip11"] },
    { key: "D", short: "strip safe", name: "safe-area-tall strip", flags: ["stripSafe"] },
    { key: "E", short: "strip clip", name: "11px invisible strip (bg-clip:text)", flags: ["stripClip"] },
    { key: "F", short: "doc scroll", name: "document scroll kick", flags: ["docScroll"] },
    { key: "G", short: "inner scroll", name: "inner scroller kick", flags: ["innerScroll"] },
    { key: "H", short: "panel slide", name: "fixed-panel slide kick", flags: ["panel"] },
    { key: "I", short: "strip+theme", name: "11px strip + theme-color nudge", flags: ["strip11", "theme"] },
    { key: "J", short: "everything", name: "everything (strip11 + all kicks)", flags: ["strip11", "docScroll", "innerScroll", "panel", "theme"] },
  ];
  const store = JSON.parse(localStorage.getItem("blurlab") || "{}");
  const state = { preset: store.preset || "A", ruler: store.ruler ?? true, hidden: !!store.hidden, launches: (store.launches || 0) + 1 };
  const save = () => localStorage.setItem("blurlab", JSON.stringify(state));
  save();
  const preset = PRESETS.find((p) => p.key === state.preset) || PRESETS[0];
  const on = (f) => preset.flags.includes(f);
  const t0 = performance.now();
  const log = [];
  const note = (msg) => { log.push(`${((performance.now() - t0) / 1000).toFixed(2)}s ${msg}`); render(); };

  const css = document.createElement("style");
  css.textContent = `
    :root.iphone-pwa.blurlab-noclear { --ios-blur-clearance: 0px; }
    /* black-translucent hands a standalone app a viewport one status bar shorter than
       the screen, leaving dead space at the bottom; extend the document to fill it. */
    :root.iphone-pwa.blurlab-translucent { height: calc(100% + env(safe-area-inset-top)); }
    :root.iphone-pwa.blurlab-translucent #app { height: 100%; }
    .blurlab-nostrip1 .status-bar-background { display: none; }
    .bl-strip { position: fixed; top: 0; left: 0; right: 0; height: 11px; background-color: #101010;
      pointer-events: none; z-index: 2147483000; }
    .bl-strip.safe { height: max(11px, env(safe-area-inset-top)); }
    .bl-strip.clip { -webkit-background-clip: text; background-clip: text; }
    .bl-cover { position: fixed; inset: 0; z-index: 2147483001; pointer-events: none; background: rgb(255 255 255 / 0.01); opacity: 0; }
    .bl-cover.on { opacity: 1; }
    .bl-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 90%; z-index: 2147483002; pointer-events: none;
      background: rgb(255 255 255 / 0.01); transform: translateX(110%); transition: transform .3s; }
    .bl-panel.in { transform: translateX(0); }
    .bl-ruler { position: fixed; top: 0; left: 0; width: 36px; height: 140px; z-index: 2147483100; pointer-events: none;
      font: 8px/1 -apple-system, sans-serif; color: #fff; }
    .bl-ruler i { position: absolute; left: 0; height: 1px; background: #fff; }
    .bl-ruler b { position: absolute; left: 16px; text-shadow: 0 0 2px #000, 0 0 2px #000; font-weight: 600; transform: translateY(-50%); }
    .bl-bar { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(env(safe-area-inset-bottom) + 84px);
      z-index: 2147483200; display: flex; align-items: center; gap: 2px; background: #ffe600; color: #000;
      border-radius: 999px; padding: 4px; font: 600 13px -apple-system, sans-serif; box-shadow: 0 4px 18px rgb(0 0 0 / .6); }
    .bl-bar button { all: unset; white-space: nowrap; padding: 8px 12px; border-radius: 999px; }
    .bl-bar button:active { background: rgb(0 0 0 / .15); }
    .bl-dot { position: fixed; right: 10px; bottom: calc(env(safe-area-inset-bottom) + 84px); width: 22px; height: 22px;
      border-radius: 50%; background: #ffe600; z-index: 2147483200; }
    .bl-sheet { position: fixed; left: 8px; right: 8px; bottom: calc(env(safe-area-inset-bottom) + 132px); max-height: 60dvh;
      overflow: auto; z-index: 2147483200; background: #fff; color: #000; border-radius: 14px; padding: 12px;
      font: 13px/1.4 -apple-system, sans-serif; box-shadow: 0 8px 30px rgb(0 0 0 / .7); }
    .bl-sheet h4 { margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; color: #666; }
    .bl-sheet label { display: block; padding: 5px 0; }
    .bl-sheet input { all: revert; margin: 0 6px 0 0; vertical-align: middle; }
    .bl-sheet pre { color: #000; background: none; padding: 0; margin: 0; font: 11px/1.35 ui-monospace, monospace; white-space: pre-wrap; }
    .bl-sheet .row { display: flex; gap: 8px; margin-top: 10px; }
    .bl-sheet .row button { flex: 1; padding: 9px; border: 1px solid #000; border-radius: 8px; background: #fff; font: inherit; }
  `;
  document.head.appendChild(css);
  const root = document.documentElement;
  if (!on("clear16")) root.classList.add("blurlab-noclear");
  if (lab === "translucent") root.classList.add("blurlab-translucent");
  if (!on("strip1")) root.classList.add("blurlab-nostrip1");

  // Strips go in before first paint (this script runs at the top of <body>): febbbi's
  // tests found WebKit misses runtime transparent↔colour changes until a reload.
  const strip = (cls) => {
    const el = document.createElement("div");
    el.className = `bl-strip ${cls}`;
    el.setAttribute("aria-hidden", "true");
    document.body.prepend(el);
  };
  if (on("strip11")) strip("");
  if (on("stripSafe")) strip("safe");
  if (on("stripClip")) strip("clip");

  // --- kicks -----------------------------------------------------------------
  // Reported on-device: the blur clears on the first scroll and stays gone until
  // relaunch. Portkey's document never scrolls (html/body overflow:hidden), so make it
  // scrollable for two frames and move the WKWebView's own scroll view 2px and back.
  function docScrollKick() {
    const de = document.documentElement, b = document.body;
    const prev = [de.style.overflow, b.style.overflow];
    de.style.overflow = "auto";
    b.style.overflow = "visible";
    const sp = document.createElement("div");
    sp.style.cssText = "position:absolute;top:0;left:0;width:1px;height:calc(100dvh + 8px);pointer-events:none";
    b.appendChild(sp);
    scrollTo(0, 4);
    const moved = scrollY;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollTo(0, 0);
      sp.remove();
      [de.style.overflow, b.style.overflow] = prev;
      note(`docScroll moved scrollY→${moved}, back to ${scrollY}`);
    }));
  }
  function innerScrollKick(tries = 0) {
    const el = document.querySelector("#app .scroll");
    if (!el) return tries < 50 ? setTimeout(() => innerScrollKick(tries + 1), 100) : note("innerScroll: no .scroll found");
    // A short list can't scroll: pad it for the two frames the kick takes.
    const sp = document.createElement("div");
    sp.style.height = `${el.clientHeight + 8}px`;
    sp.style.flex = "none"; // the scroller is a flex column: an empty item shrinks to 0
    el.appendChild(sp);
    const before = el.scrollTop;
    el.scrollTop = before + 4;
    const moved = el.scrollTop - before;
    requestAnimationFrame(() => requestAnimationFrame(() => { el.scrollTop = before; sp.remove(); note(`innerScroll moved ${moved}px`); }));
  }
  function panelKick() {
    let cover = document.querySelector(".bl-cover"), panel = document.querySelector(".bl-panel");
    if (!panel) {
      cover = Object.assign(document.createElement("div"), { className: "bl-cover" });
      panel = Object.assign(document.createElement("div"), { className: "bl-panel" });
      document.body.append(cover, panel);
      void panel.offsetWidth;
    }
    requestAnimationFrame(() => {
      cover.classList.add("on");
      panel.classList.add("in");
      setTimeout(() => { cover.classList.remove("on"); panel.classList.remove("in"); note("panel slid in/out"); }, 450);
    });
  }
  function themeNudge() {
    const m = document.querySelector('meta[name="theme-color"]');
    const c = m.getAttribute("content");
    m.setAttribute("content", c + "fe");
    requestAnimationFrame(() => requestAnimationFrame(() => { m.setAttribute("content", c); note("theme-color nudged"); }));
  }
  function kick(why) {
    if (!preset.flags.some((f) => ["docScroll", "innerScroll", "panel", "theme"].includes(f))) return;
    note(`kick (${why})`);
    if (on("theme")) themeNudge();
    if (on("docScroll")) docScrollKick();
    if (on("innerScroll")) innerScrollKick();
    if (on("panel")) panelKick();
  }
  addEventListener("load", () => {
    requestAnimationFrame(() => kick("load"));
    setTimeout(() => kick("load+800ms"), 800);
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick("resume"); });

  // --- ruler: ticks every 2px from the viewport top, labelled every 10px -------
  if (state.ruler) {
    const r = document.createElement("div");
    r.className = "bl-ruler";
    let h = "";
    for (let y = 0; y <= 130; y += 2) h += `<i style="top:${y}px;width:${y % 10 ? 4 : 14}px"></i>`;
    for (let y = 10; y <= 130; y += 10) h += `<b style="top:${y}px">${y}</b>`;
    r.innerHTML = h;
    document.body.appendChild(r);
  }

  // --- switcher + state readout ---------------------------------------------
  const ui = document.createElement("div");
  document.body.appendChild(ui);
  let sheetOpen = false;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;width:0;visibility:hidden;padding-top:env(safe-area-inset-top)";
  document.body.appendChild(probe);

  function diag() {
    const meta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    const ios = navigator.userAgent.match(/OS (\d+[_\d]*)/)?.[1]?.replaceAll("_", ".") ?? "?";
    return [
      `install axis   ?lab=${lab}  (meta: ${meta ? meta.content : "absent"})`,
      `preset         ${preset.key} ${preset.name}`,
      `flags          ${preset.flags.join(", ") || "—"}`,
      `launch #       ${state.launches}`,
      `iOS            ${ios}`,
      `standalone     mm=${matchMedia("(display-mode: standalone)").matches} nav=${navigator.standalone}`,
      `safe-top       ${getComputedStyle(probe).paddingTop}`,
      `inner/screen   ${innerWidth}x${innerHeight} / ${screen.width}x${screen.height} dpr ${devicePixelRatio}`,
      `vv offsetTop   ${visualViewport?.offsetTop ?? "?"}`,
      ...log.slice(-8),
    ].join("\n");
  }
  function go(key) {
    state.preset = key;
    save();
    location.reload();
  }
  const step = (d) => {
    const i = PRESETS.findIndex((p) => p.key === preset.key);
    go(PRESETS[(i + d + PRESETS.length) % PRESETS.length].key);
  };
  function render() {
    if (!ui.isConnected) return;
    if (state.hidden) {
      ui.innerHTML = `<div class="bl-dot"></div>`;
      ui.firstChild.onclick = () => { state.hidden = false; save(); render(); };
      return;
    }
    ui.innerHTML = `
      <div class="bl-bar"><button data-a="prev">◀</button><button data-a="sheet">${preset.key} · ${preset.short}</button><button data-a="next">▶</button></div>
      ${sheetOpen ? `<div class="bl-sheet">
        <h4>Strategy (applies via reload; cold-relaunch to judge)</h4>
        ${PRESETS.map((p) => `<label><input type="radio" name="blp" value="${p.key}" ${p.key === preset.key ? "checked" : ""}> ${p.key} · ${p.name}</label>`).join("")}
        <label><input type="checkbox" data-a="ruler" ${state.ruler ? "checked" : ""}> ruler overlay</label>
        <h4>State</h4><pre>${diag()}</pre>
        <div class="row"><button data-a="reload">Reload</button><button data-a="hide">Hide bar</button><button data-a="close">Close</button></div>
      </div>` : ""}`;
  }
  ui.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "prev") step(-1);
    else if (a === "next") step(1);
    else if (a === "sheet") { sheetOpen = !sheetOpen; render(); }
    else if (a === "close") { sheetOpen = false; render(); }
    else if (a === "reload") location.reload();
    else if (a === "hide") { state.hidden = true; sheetOpen = false; save(); render(); }
    else if (a === "ruler") { state.ruler = e.target.checked; save(); location.reload(); }
  });
  ui.addEventListener("change", (e) => { if (e.target.name === "blp") go(e.target.value); });
  addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, [contenteditable]")) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
  render();
})();
