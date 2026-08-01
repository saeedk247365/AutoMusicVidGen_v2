(() => {
  const state = { ...(window.__MVID_INITIAL__ || {}) };
  const $ = (id) => document.getElementById(id);

  const statusMsg = $("statusMsg");
  const stagePill = $("stagePill");
  const autoApprove = $("autoApprove");
  const btnApprove = $("btnApprove");
  const btnReject = $("btnReject");
  const lyricsText = $("lyricsText");
  const planRaw = $("planRaw");
  const logEl = $("log");

  const TAB_TO_GATE = {
    setup: "setup",
    lyrics: "lyrics",
    song: "song",
    storyline: "plan",
    scenes: "plan",
    scripts: "plan",
    keyframes: "keyframes",
    clips: "clips",
    final: "final",
  };

  let activeTab = "setup";
  let setupLoaded = false;

  function log(msg) {
    const line = document.createElement("div");
    line.className = "line";
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function waitingGate() {
    if (!state.stage?.startsWith("await_")) return null;
    return state.stage.replace(/^await_/, "");
  }

  function collectSetupPayload() {
    const castIds = [...document.querySelectorAll("#castList input[type=checkbox]:checked")].map(
      (el) => el.value,
    );
    const locationIds = [
      ...document.querySelectorAll("#setupScenesList input[type=checkbox]:checked"),
    ].map((el) => el.value);
    return {
      castIds,
      locationIds,
      title: $("setupTitle")?.value?.trim() || "",
      objective: $("setupObjective")?.value?.trim() || "",
      theme: $("setupTheme")?.value?.trim() || "",
    };
  }

  async function loadSetupLists() {
    if (setupLoaded) return;
    try {
      const [charsRes, scenesRes] = await Promise.all([
        fetch("/api/characters"),
        fetch("/api/scenes"),
      ]);
      const chars = await charsRes.json();
      const scenes = await scenesRes.json();
      const castEl = $("castList");
      const selected = new Set(state.setup?.castIds || ["adam", "sasha"]);
      if (chars.ok) {
        castEl.className = "check-list";
        castEl.innerHTML = (chars.characters || [])
          .map(
            (c) => `<label>
              <input type="checkbox" value="${esc(c.id)}" ${selected.has(c.id) ? "checked" : ""} />
              <span><strong>${esc(c.name)}</strong> <span class="meta">${esc(c.role)}${c.hasLora ? " · LoRA" : ""}</span>
              <div class="meta">${esc((c.appearance || "").slice(0, 90))}</div></span>
            </label>`,
          )
          .join("");
      }
      const locEl = $("setupScenesList");
      const locSel = new Set(state.setup?.locationIds || []);
      if (scenes.ok) {
        locEl.className = "check-list";
        locEl.innerHTML = (scenes.scenes || [])
          .map((s) => {
            const checked = !locSel.size || locSel.has(s.id) ? "checked" : "";
            return `<label>
              <input type="checkbox" value="${esc(s.id)}" ${checked} />
              <span><strong>${esc(s.name || s.id)}</strong>
              ${s.thumbUrl ? `<div><img src="${s.thumbUrl}" alt="" style="max-width:100%;border-radius:4px;margin-top:4px" /></div>` : ""}
              </span>
            </label>`;
          })
          .join("");
      }
      if (state.setup?.title) $("setupTitle").value = state.setup.title;
      if (state.setup?.objective) $("setupObjective").value = state.setup.objective;
      if (state.setup?.theme) $("setupTheme").value = state.setup.theme;
      setupLoaded = true;
    } catch (err) {
      log(`Setup load failed: ${err.message || err}`);
    }
  }

  function updateButtons() {
    const gate = waitingGate();
    const paused = !!state.paused;
    const stopped = !!state.stopped || state.stage === "stopped";
    const enabled = !!gate && !autoApprove.checked && !paused && !stopped;
    btnApprove.disabled = !enabled;
    btnReject.disabled = !enabled || gate === "final" || gate === "setup";
    if (gate === "final") btnReject.disabled = !enabled;
    if (gate === "setup") {
      btnApprove.disabled = !enabled;
      btnReject.disabled = true;
    }
    const btnPause = $("btnPause");
    const btnResume = $("btnResume");
    const btnStop = $("btnStop");
    const btnContinue = $("btnContinue");
    const btnNewProject = $("btnNewProject");
    if (btnPause) btnPause.disabled = paused || stopped || state.stage === "done" || !!state.viewOnly;
    if (btnResume) btnResume.disabled = !paused || stopped;
    if (btnStop) btnStop.disabled = stopped || state.stage === "done" || !!state.viewOnly;
    if (btnContinue) {
      // Allow Continue while paused so Pause → change GPU → Continue resumes with new route
      btnContinue.disabled =
        (!!state.running && !state.paused) || !state.songDir || stopped;
    }
    if (btnNewProject) {
      btnNewProject.disabled = !!state.running;
    }
  }

  async function refreshSaladStatus() {
    const pill = $("saladStatusPill");
    if (!pill) return;
    try {
      const res = await fetch("/api/salad/status");
      const data = await res.json();
      state.salad = data;
      if (!data.configured) {
        pill.textContent = "Salad: set SALAD_ORG";
        pill.className = "salad-pill warn";
        return;
      }
      if (!data.ok) {
        pill.textContent = `Salad: ${data.error || "error"}`.slice(0, 48);
        pill.className = "salad-pill err";
        return;
      }
      const g = data.group;
      if (g) {
        const st = g.currentState?.status || g.currentState || "?";
        const run = g.running != null ? ` · ${g.running} run` : "";
        pill.textContent = `Salad: ${st}${run}`;
        pill.className = /stop|fail/i.test(String(st))
          ? "salad-pill warn"
          : "salad-pill ok";
      } else if (data.groups) {
        pill.textContent = `Salad: ${data.groups.length} group(s)`;
        pill.className = "salad-pill ok";
      } else {
        pill.textContent = "Salad: ok";
        pill.className = "salad-pill ok";
      }
    } catch (err) {
      pill.textContent = "Salad: unreachable";
      pill.className = "salad-pill err";
      log(`Salad status: ${err.message || err}`);
    }
  }

  function fmtPct(n) {
    return n == null || !Number.isFinite(Number(n)) ? "—" : `${Math.round(Number(n))}%`;
  }

  function setMeter(scopeEl, key, percent, label) {
    const meter = scopeEl?.querySelector(`.meter[data-key="${key}"]`);
    if (!meter) return;
    const bar = meter.querySelector(".meter-bar");
    const txt = meter.querySelector(".meter-txt");
    const pct = percent == null || !Number.isFinite(Number(percent)) ? null : Number(percent);
    if (bar) bar.style.width = pct == null ? "0%" : `${Math.max(0, Math.min(100, pct))}%`;
    if (txt) txt.textContent = label;
    meter.classList.toggle("hot", pct != null && pct >= 85);
    meter.title = label;
  }

  function renderResourceMeters(data) {
    const root = $("resourceMeters");
    if (!root || !data) return;
    const localGroup = root.querySelector('[data-scope="local"]');
    const saladGroup = root.querySelector('[data-scope="salad"]');
    const local = data.local || {};
    const salad = data.salad || {};

    setMeter(
      localGroup,
      "cpu",
      local.cpuPercent,
      `CPU ${fmtPct(local.cpuPercent)}`,
    );
    setMeter(
      localGroup,
      "ram",
      local.ramPercent,
      `RAM ${fmtPct(local.ramPercent)}`,
    );
    const localGpuLabel =
      local.gpuPercent == null && local.gpuVramPercent == null
        ? "GPU —"
        : `GPU ${fmtPct(local.gpuPercent)}${
            local.gpuVramPercent != null ? ` · VRAM ${fmtPct(local.gpuVramPercent)}` : ""
          }`;
    setMeter(
      localGroup,
      "gpu",
      local.gpuPercent ?? local.gpuVramPercent,
      localGpuLabel,
    );
    if (localGroup) {
      localGroup.title = local.gpuName
        ? `Local · ${local.gpuName}`
        : "Local machine";
    }

    const saladLive = !!(salad.available || salad.comfyUp);
    const saladDown = !!(salad.configured && !saladLive);
    const downLabel =
      salad.httpStatus === 503
        ? "Comfy 503"
        : salad.httpStatus
          ? `HTTP ${salad.httpStatus}`
          : "Comfy down";
    if (saladGroup) {
      saladGroup.classList.toggle("dim", !saladLive);
      const tipParts = [
        salad.gpuName ? salad.gpuName : null,
        salad.note || null,
        saladDown ? downLabel : null,
      ].filter(Boolean);
      saladGroup.title = tipParts.length
        ? `Salad · ${tipParts.join(" · ")}`
        : "Salad Cloud";
    }
    setMeter(
      saladGroup,
      "cpu",
      salad.cpuPercent,
      salad.cpuPercent != null
        ? `CPU ${fmtPct(salad.cpuPercent)}`
        : saladLive
          ? "CPU n/a (set SALAD_ORG)"
          : saladDown
            ? `CPU · ${downLabel}`
            : "CPU —",
    );
    setMeter(
      saladGroup,
      "ram",
      salad.ramPercent,
      salad.ramPercent != null
        ? `RAM ${fmtPct(salad.ramPercent)}`
        : saladLive
          ? "RAM …"
          : saladDown
            ? `RAM · ${downLabel}`
            : "RAM —",
    );
    const saladGpuLabel =
      salad.gpuPercent != null
        ? `GPU ${fmtPct(salad.gpuPercent)}${
            salad.gpuVramPercent != null ? ` · VRAM ${fmtPct(salad.gpuVramPercent)}` : ""
          }`
        : salad.gpuVramPercent != null
          ? `VRAM ${fmtPct(salad.gpuVramPercent)}`
          : saladLive
            ? "GPU …"
            : saladDown
              ? `GPU · ${downLabel}`
              : "GPU —";
    setMeter(
      saladGroup,
      "gpu",
      salad.gpuPercent ?? salad.gpuVramPercent,
      saladGpuLabel,
    );
  }

  async function refreshMetrics() {
    try {
      const res = await fetch("/api/metrics");
      const data = await res.json();
      if (!data.ok) return;
      state.metrics = data;
      renderResourceMeters(data);
    } catch {
      /* ignore transient poll errors */
    }
  }

  function selectTab(name) {
    activeTab = name;
    document.querySelectorAll(".tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    document.querySelectorAll(".pane").forEach((p) => {
      p.classList.toggle("active", p.id === `pane-${name}`);
    });
  }

  function markTabData(tabs) {
    document.querySelectorAll(".tabs button").forEach((b) => {
      const key = b.dataset.tab;
      const data = tabs?.[key];
      const has =
        data &&
        (data.text ||
          data.url ||
          data.beats?.length ||
          data.images?.length ||
          data.videos?.length ||
          data.locations?.length ||
          data.raw);
      b.classList.toggle("has-data", !!has);
    });
  }

  function renderLyrics(tabs) {
    if (tabs?.lyrics?.text != null) {
      // Don't clobber user edits while waiting on lyrics unless empty or stage just filled
      if (
        document.activeElement !== lyricsText ||
        !lyricsText.value ||
        waitingGate() === "lyrics"
      ) {
        if (document.activeElement !== lyricsText) {
          lyricsText.value = tabs.lyrics.text;
        } else if (!lyricsText.dataset.touched) {
          lyricsText.value = tabs.lyrics.text;
        }
      }
    }
  }

  function renderSong(tabs) {
    const el = $("songPlayer");
    if (!tabs?.song?.url) {
      el.className = "empty";
      el.textContent = "No audio yet";
      return;
    }
    el.className = "";
    el.innerHTML = `<p>${tabs.song.name}</p><audio controls src="${tabs.song.url}?t=${Date.now()}"></audio>`;
  }

  function renderStoryline(tabs) {
    const el = $("storylineView");
    const s = tabs?.storyline;
    if (!s) {
      el.className = "empty";
      el.textContent = "No storyline yet";
      planRaw.value = "";
      return;
    }
    el.className = "";
    const rows = (s.beats || [])
      .map(
        (b) => `<tr>
        <td>${esc(b.id)}</td>
        <td>${esc(b.storyBeat || "")}</td>
        <td>${esc(b.location || "")}</td>
        <td>${esc(b.cause || "")}</td>
        <td>${esc(b.effect || "")}</td>
        <td>${b.startSec ?? ""}–${b.endSec ?? ""}</td>
      </tr>`,
      )
      .join("");
    el.innerHTML = `
      <div class="objective"><strong>Objective:</strong> ${esc(s.objective || "(none)")}
        ${s.theme ? `<div class="meta">theme: ${esc(s.theme)}</div>` : ""}
      </div>
      <table class="beat-table">
        <thead><tr><th>Beat</th><th>Arc</th><th>Room</th><th>Cause</th><th>Effect</th><th>Time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    if (document.activeElement !== planRaw) {
      planRaw.value = s.raw || "";
    }
  }

  function renderScenes(tabs) {
    const el = $("scenesGrid");
    const locs = tabs?.scenes?.locations || [];
    if (!locs.length) {
      el.className = "grid empty";
      el.textContent = "No scenes yet";
      return;
    }
    el.className = "grid";
    el.innerHTML = locs
      .map(
        (l) => `<div class="card">
        ${l.url ? `<img src="${l.url}?t=${Date.now()}" alt="${esc(l.id)}" />` : `<div class="empty">missing</div>`}
        <div class="cap">${esc(l.id)} · ${esc((l.beats || []).join(", "))}</div>
      </div>`,
      )
      .join("");
  }

  function optionList(values, selected) {
    return values
      .map(
        (v) =>
          `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(v)}</option>`,
      )
      .join("");
  }

  const SCRIPT_POSES = [
    "stand",
    "sit",
    "kneel",
    "wave",
    "point",
    "hands_up",
    "walk",
    "stomp",
    "clap",
    "stretch",
    "tiptoe",
    "dance",
  ];
  const SCRIPT_EXPR = [
    "happy",
    "curious",
    "surprised",
    "excited",
    "proud",
    "worried",
    "determined",
  ];
  const SCRIPT_FACING = ["front", "three_quarter", "profile", "back"];
  const SCRIPT_STORY = ["problem", "discovery", "fun", "celebration"];
  const SCRIPT_CAM = [
    "full_body",
    "medium_full",
    "medium",
    "close_up",
    "wide",
  ];

  function collectScriptEdits() {
    const cards = [...document.querySelectorAll("#scriptsView .shot-card")];
    return cards.map((card) => {
      const id = card.dataset.beatId;
      const val = (sel) => card.querySelector(sel)?.value ?? "";
      const chars = [...card.querySelectorAll(".shot-char")].map((row) => ({
        name: row.dataset.name || row.querySelector("[data-f=name]")?.value || "",
        pose: row.querySelector("[data-f=pose]")?.value || "stand",
        expression: row.querySelector("[data-f=expression]")?.value || "happy",
        facing: row.querySelector("[data-f=facing]")?.value || "front",
      }));
      return {
        id,
        lyricHint: val("[data-f=lyricHint]"),
        cause: val("[data-f=cause]"),
        effect: val("[data-f=effect]"),
        interaction: val("[data-f=interaction]"),
        cutMotivation: val("[data-f=cutMotivation]"),
        actionPhase: val("[data-f=actionPhase]"),
        storyBeat: val("[data-f=storyBeat]"),
        location: val("[data-f=location]"),
        camera: val("[data-f=camera]"),
        characters: chars,
      };
    });
  }

  /** beatId → { at, keyframeMtime, animate } for "Just remade" badges */
  const remadeFlash = new Map();
  let remakingBeatId = null;

  function markRemade(payload) {
    const at = payload?.at || Date.now();
    for (const item of payload?.remade || []) {
      const id = item.beatId;
      if (!id) continue;
      remadeFlash.set(id, {
        at,
        keyframeMtime: item.keyframeMtime || at,
        animate: !!payload.animate,
      });
    }
    for (const id of payload?.only || []) {
      if (!remadeFlash.has(id)) {
        remadeFlash.set(id, { at, keyframeMtime: at, animate: !!payload.animate });
      }
    }
    // Expire badges after 2 minutes
    setTimeout(() => {
      for (const [id, meta] of remadeFlash) {
        if (meta.at === at) remadeFlash.delete(id);
      }
    }, 120000);
  }

  function isJustRemade(beatId) {
    return remadeFlash.has(beatId);
  }

  function renderScripts(tabs) {
    const el = $("scriptsView");
    const beats = tabs?.scripts?.beats || [];
    if (!beats.length) {
      el.className = "empty";
      el.textContent = "No scripts yet";
      return;
    }
    // Don't wipe in-progress edits
    if (el.contains(document.activeElement)) return;

    const locs = tabs?.scripts?.locations?.length
      ? tabs.scripts.locations
      : [...new Set(beats.map((b) => b.location).filter(Boolean))];

    el.className = "shot-list";
    el.innerHTML = beats
      .map((b) => {
        const chars = (b.characters || []).length
          ? b.characters
          : [{ name: "Adam", pose: "stand", expression: "happy", facing: "front" }];
        const charHtml = chars
          .map(
            (c) => `<div class="shot-char" data-name="${esc(c.name)}">
            <span class="shot-char-name">${esc(c.name)}</span>
            <label>Pose <select data-f="pose">${optionList(SCRIPT_POSES, c.pose || "stand")}</select></label>
            <label>Face <select data-f="expression">${optionList(SCRIPT_EXPR, c.expression || "happy")}</select></label>
            <label>Facing <select data-f="facing">${optionList(SCRIPT_FACING, c.facing || "front")}</select></label>
          </div>`,
          )
          .join("");
        const t0 = b.startSec != null ? Number(b.startSec).toFixed(1) : "?";
        const t1 = b.endSec != null ? Number(b.endSec).toFixed(1) : "?";
        return `<article class="shot-card" data-beat-id="${esc(b.id)}" data-stem="${esc(b.keyframeStem || "")}">
          <header class="shot-head">
            <div>
              <h4>Shot ${esc(String(b.index || ""))}: ${esc(b.id)}</h4>
              <p class="meta">${esc(b.section || "")} · ${t0}s–${t1}s · file ${esc(b.keyframeStem || "")}.png</p>
            </div>
            <div class="shot-actions">
              ${isJustRemade(b.id) ? `<span class="remade-badge inline">Just remade</span>` : ""}
              <button type="button" class="btn tiny" data-act="goto-kf" data-beat="${esc(b.id)}">View still</button>
              <button type="button" class="btn tiny primary" data-act="remake" data-beat="${esc(b.id)}"${remakingBeatId === b.id ? " disabled" : ""}>${remakingBeatId === b.id ? "Remaking…" : "Remake still"}</button>
              <button type="button" class="btn tiny" data-act="remake-clip" data-beat="${esc(b.id)}"${remakingBeatId === b.id ? " disabled" : ""}>Remake still+clip</button>
            </div>
          </header>
          <p class="shot-plain">This shot is a frozen picture of what happens on this lyric line. Change the fields, then remake the still.</p>
          <div class="shot-grid">
            <label class="field wide">Lyric line (what kids hear)
              <input data-f="lyricHint" value="${esc(b.lyricHint || "")}" />
            </label>
            <label class="field">What just happened (cause)
              <input data-f="cause" value="${esc(b.cause || "")}" />
            </label>
            <label class="field">What this shot shows (effect)
              <input data-f="effect" value="${esc(b.effect || "")}" />
            </label>
            <label class="field wide">Action on screen (plain English)
              <input data-f="interaction" value="${esc(b.interaction || "")}" />
            </label>
            <label class="field">Room
              <select data-f="location">${optionList(locs.length ? locs : [b.location || "home"], b.location || "")}</select>
            </label>
            <label class="field">Story beat
              <select data-f="storyBeat">${optionList(SCRIPT_STORY, b.storyBeat || "fun")}</select>
            </label>
            <label class="field">Camera
              <select data-f="camera">${optionList(SCRIPT_CAM, b.camera || "full_body")}</select>
            </label>
            <label class="field">Why we cut here
              <input data-f="cutMotivation" value="${esc(b.cutMotivation || "")}" />
            </label>
            <label class="field">Action phase
              <input data-f="actionPhase" value="${esc(b.actionPhase || "")}" />
            </label>
          </div>
          <div class="shot-cast">
            <h5>Who is in the shot</h5>
            ${charHtml}
          </div>
        </article>`;
      })
      .join("");
  }

  function renderKeyframes(tabs) {
    const el = $("keyframesGrid");
    const images = tabs?.keyframes?.images || [];
    if (!images.length) {
      el.className = "grid empty";
      el.textContent = "No keyframes yet";
      return;
    }
    el.className = "grid";
    el.innerHTML = images
      .map((img) => {
        const bust = img.mtime || Date.now();
        const just = isJustRemade(img.beatId);
        const busy = remakingBeatId === img.beatId;
        return `<div class="card kf-card${just ? " just-remade" : ""}${busy ? " remaking" : ""}" data-beat="${esc(img.beatId || "")}">
        ${just ? `<span class="remade-badge">Just remade</span>` : ""}
        <img src="${img.url}?t=${bust}" alt="${esc(img.name)}" />
        <div class="cap">${esc(img.name)}${img.mtime ? ` · ${new Date(img.mtime).toLocaleTimeString()}` : ""}</div>
        <div class="kf-actions">
          <button type="button" class="btn tiny" data-act="edit-script" data-beat="${esc(img.beatId || "")}">Edit script</button>
          <button type="button" class="btn tiny primary" data-act="remake" data-beat="${esc(img.beatId || "")}"${busy ? " disabled" : ""}>${busy ? "Remaking…" : "Remake"}</button>
        </div>
      </div>`;
      })
      .join("");
  }

  function renderClips(tabs) {
    const previewEl = $("previewPlayer");
    if (previewEl) {
      const preview = tabs?.preview;
      if (!preview?.url) {
        previewEl.className = "empty";
        previewEl.textContent = "Preview will appear after the first clip…";
      } else {
        const mtime = preview.mtime || Date.now();
        const n = preview.clips || tabs?.clips?.videos?.length || "?";
        previewEl.className = "";
        previewEl.innerHTML = `<p class="hint">Progressive preview · ${n} clip(s) + sound</p>
          <video id="previewVideo" controls src="${preview.url}?t=${mtime}"></video>`;
      }
    }

    const el = $("clipsGrid");
    const videos = tabs?.clips?.videos || [];
    if (!videos.length) {
      el.className = "grid empty";
      el.textContent = "No clips yet";
      return;
    }
    el.className = "grid";
    el.innerHTML = videos
      .map((v) => {
        const bust = v.mtime || Date.now();
        const stem = v.stem || String(v.name || "").replace(/\.mp4$/i, "");
        const beatId = /^(\d+)_(.+)$/.exec(stem)?.[2] || stem;
        return `<div class="card clip-card" data-stem="${esc(stem)}" data-name="${esc(v.name)}" data-beat="${esc(beatId)}">
        <video controls src="${v.url}?t=${bust}"></video>
        <div class="cap">${esc(v.name)}${v.mtime ? ` · ${new Date(v.mtime).toLocaleTimeString()}` : ""}</div>
        <div class="kf-actions">
          <button type="button" class="btn tiny danger" data-act="delete-clip" data-name="${esc(v.name)}" data-stem="${esc(stem)}" data-beat="${esc(beatId)}">Delete</button>
        </div>
      </div>`;
      })
      .join("");
  }

  function renderFinal(tabs) {
    const el = $("finalPlayer");
    if (!tabs?.final?.url) {
      el.className = "empty";
      el.textContent = "No final yet";
      return;
    }
    el.className = "";
    el.innerHTML = `<video controls src="${tabs.final.url}?t=${Date.now()}"></video>`;
  }

  function renderAll(tabs) {
    renderLyrics(tabs);
    renderSong(tabs);
    renderStoryline(tabs);
    renderScenes(tabs);
    renderScripts(tabs);
    renderKeyframes(tabs);
    renderClips(tabs);
    renderFinal(tabs);
    markTabData(tabs);
  }

  function applyState(s) {
    Object.assign(state, s);
    if (s.statusMessage) statusMsg.textContent = s.statusMessage;
    if (s.stage) stagePill.textContent = s.stage;
    if (typeof s.autoApprove === "boolean") autoApprove.checked = s.autoApprove;
    if (typeof s.paused === "boolean") state.paused = s.paused;
    if (typeof s.stopped === "boolean") state.stopped = s.stopped;
    if (typeof s.viewOnly === "boolean") state.viewOnly = s.viewOnly;
    if (typeof s.running === "boolean") state.running = s.running;
    if (s.gpu?.backend && $("gpuBackend")) $("gpuBackend").value = s.gpu.backend;
    if (s.outputResolution && $("outputResolution")) {
      $("outputResolution").value = s.outputResolution;
    }
    const pill = $("projectPill");
    if (pill) {
      pill.textContent = s.songDir ? `Project: ${s.songDir}` : "Project: —";
      pill.title = s.songDir
        ? `Active project (saved across restarts)\n${s.songDir}`
        : "No project open";
    }
    if (s.songDir && $("batchPicker")) {
      const opt = [...$("batchPicker").options].find((o) => o.value === s.songDir);
      if (opt) $("batchPicker").value = s.songDir;
    }
    if (s.tabs) renderAll(s.tabs);
    updateButtons();
    loadSetupLists();

    const gate = waitingGate();
    if (gate && !state.paused) {
      const tab =
        gate === "setup"
          ? "setup"
          : gate === "plan"
            ? "storyline"
            : gate === "song"
              ? "song"
              : gate === "lyrics"
                ? "lyrics"
                : gate === "keyframes"
                  ? "keyframes"
                  : gate === "clips"
                    ? "clips"
                    : gate === "final"
                      ? "final"
                      : activeTab;
      selectTab(tab);
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.querySelectorAll(".tabs button").forEach((b) => {
    b.addEventListener("click", () => selectTab(b.dataset.tab));
  });

  lyricsText.addEventListener("input", () => {
    lyricsText.dataset.touched = "1";
  });

  autoApprove.addEventListener("change", async () => {
    await fetch("/api/auto-approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: autoApprove.checked }),
    });
    updateButtons();
  });

  $("gpuBackend")?.addEventListener("change", async () => {
    const backend = $("gpuBackend").value;
    const res = await fetch("/api/gpu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`GPU switch failed: ${data.error || res.status}`);
      $("gpuBackend").value = state.gpu?.backend || "local";
      return;
    }
    state.gpu = data;
    const routeNote =
      data.backend === "split"
        ? ` · prep ${data.comfyUrl || "local"} · clips ${data.clipsComfyUrl || "?"}`
        : "";
    log(
      `GPU → ${data.backend} (${data.comfyUrl})${data.comfyUp ? " · up" : " · not reachable yet"}${routeNote}`,
    );
  });

  $("outputResolution")?.addEventListener("change", async () => {
    const id = $("outputResolution").value;
    const res = await fetch("/api/resolution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Resolution switch failed: ${data.error || res.status}`);
      $("outputResolution").value = state.outputResolution || "preview";
      return;
    }
    state.outputResolution = data.outputResolution;
    const p = data.preset;
    log(
      `Output → ${data.outputResolution}` +
        (p ? ` (${p.stillWidth}×${p.stillHeight} stills / Wan)` : ""),
    );
  });

  async function refreshBatchPicker() {
    const sel = $("batchPicker");
    if (!sel) return;
    try {
      const res = await fetch("/api/batches");
      const data = await res.json();
      if (!data.ok) return;
      const cur = data.current || state.songDir || "";
      const prev = sel.value;
      sel.innerHTML = `<option value="">— open batch —</option>`;
      for (const b of data.batches || []) {
        const marks = [
          b.hasFinal ? "final" : null,
          b.hasClips ? "clips" : null,
          b.hasKeyframes ? "kf" : null,
        ]
          .filter(Boolean)
          .join(",");
        const opt = document.createElement("option");
        opt.value = b.path;
        opt.textContent = `${b.date}/${b.slug}${marks ? ` [${marks}]` : ""}`;
        sel.appendChild(opt);
      }
      sel.value = cur || prev || "";
    } catch (err) {
      console.warn(err);
    }
  }

  $("batchPicker")?.addEventListener("change", async () => {
    const path = $("batchPicker").value;
    if (!path) return;
    const res = await fetch("/api/open-song", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Open batch failed: ${data.error || res.status}`);
      return;
    }
    state.songDir = data.songDir;
    if (data.tabs) renderAll(data.tabs);
    log(`Viewing ${data.songDir}`);
    // Jump to richest available tab
    const t = data.tabs || {};
    if (t.final?.url) selectTab("final");
    else if (t.clips?.videos?.length) selectTab("clips");
    else if (t.keyframes?.images?.length) selectTab("keyframes");
    else if (t.song?.url) selectTab("song");
    else if (t.lyrics?.text) selectTab("lyrics");
  });

  $("btnContinue")?.addEventListener("click", async () => {
    const res = await fetch("/api/continue", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Continue failed: ${data.error}`);
    else if (data.resumed) {
      state.paused = false;
      log(
        `Resumed with GPU ${data.backend || state.gpu?.backend || "?"}` +
          (data.clipsComfyUrl ? ` · clips ${data.clipsComfyUrl}` : ""),
      );
      updateButtons();
    } else log(`Continuing pipeline for ${data.songDir || state.songDir}`);
  });

  $("btnNewProject")?.addEventListener("click", async () => {
    if (
      !confirm(
        "Start a brand-new project? Your current batch stays on disk; this only switches the active session.",
      )
    ) {
      return;
    }
    const res = await fetch("/api/new-project", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`New project failed: ${data.error}`);
    else log("Starting new project…");
  });

  $("btnPause")?.addEventListener("click", async () => {
    const res = await fetch("/api/pause", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Pause failed: ${data.error}`);
    else log(`Paused (from ${data.from || "?"})`);
    state.paused = true;
    updateButtons();
  });

  $("btnResume")?.addEventListener("click", async () => {
    const res = await fetch("/api/resume", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Resume failed: ${data.error}`);
    else {
      log(
        `Resumed · GPU ${data.backend || state.gpu?.backend || "?"}` +
          (data.clipsComfyUrl ? ` · clips ${data.clipsComfyUrl}` : ""),
      );
    }
    state.paused = false;
    updateButtons();
  });

  $("btnStop")?.addEventListener("click", async () => {
    if (!confirm("Stop the pipeline? You will need to restart mvid to continue.")) return;
    const res = await fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Stopped by user" }),
    });
    const data = await res.json();
    log(data.ok ? "Stopped" : `Stop failed: ${data.error}`);
    state.stopped = true;
    state.paused = false;
    updateButtons();
  });

  $("btnSaladRefresh")?.addEventListener("click", () => refreshSaladStatus());
  $("btnSaladStart")?.addEventListener("click", async () => {
    log("Starting Salad container…");
    const res = await fetch("/api/salad/start", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Salad start failed: ${data.error}`);
    else log("Salad start requested (billing begins when instances run)");
    await refreshSaladStatus();
  });
  $("btnSaladStop")?.addEventListener("click", async () => {
    if (!confirm("Shutdown Salad container group to stop GPU billing?")) return;
    log("Stopping Salad container…");
    const res = await fetch("/api/salad/stop", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Salad shutdown failed: ${data.error}`);
    else log("Salad shutdown requested");
    await refreshSaladStatus();
  });

  $("btnCreateChar")?.addEventListener("click", async () => {
    const name = $("newCharName").value.trim();
    if (!name) return log("Character name required");
    const res = await fetch("/api/characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        role: $("newCharRole").value,
        appearance: $("newCharAppearance").value,
        outfit: $("newCharOutfit").value,
      }),
    });
    const data = await res.json();
    if (!data.ok) return log(`Create character failed: ${data.error}`);
    log(`Created character ${data.character.id}`);
    setupLoaded = false;
    await loadSetupLists();
  });

  async function saveScripts() {
    const beats = collectScriptEdits();
    if (!beats.length) {
      log("No script cards to save");
      return { ok: false };
    }
    const status = $("scriptsSaveStatus");
    if (status) status.textContent = "Saving…";
    const res = await fetch("/api/scripts/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ beats }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (status) status.textContent = data.error || "Save failed";
      log(`Save scripts failed: ${data.error || res.status}`);
      return data;
    }
    if (status) status.textContent = "Saved";
    log(`Saved ${beats.length} shot script(s)`);
    return data;
  }

  async function remakeBeat(beatId, { animate = false } = {}) {
    if (!beatId || remakingBeatId) return;
    const beats = collectScriptEdits();
    remakingBeatId = beatId;
    statusMsg.textContent = `Remaking ${beatId}${animate ? " + clip" : ""}…`;
    log(`Remaking ${beatId}${animate ? " + clip" : ""}…`);
    renderScripts(state.tabs);
    renderKeyframes(state.tabs);
    try {
      const res = await fetch("/api/remake-keyframe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beatId,
          animate,
          reuseCutouts: true,
          beats,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        log(`Remake failed: ${data.error || res.status}`);
        statusMsg.textContent = `Remake failed: ${data.error || res.status}`;
        return;
      }
      markRemade(data);
      const mt = data.remade?.[0]?.keyframeMtime;
      log(
        `Remake finished: ${beatId}` +
          (mt ? ` · still ${new Date(mt).toLocaleTimeString()}` : " · still updated"),
      );
      statusMsg.textContent = `Remade ${beatId} — open Keyframes to compare`;
      selectTab(animate ? "clips" : "keyframes");
      requestAnimationFrame(() => {
        const card = document.querySelector(
          `.kf-card[data-beat="${CSS.escape(beatId)}"]`,
        );
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
        card?.classList.add("just-remade-pulse");
      });
    } finally {
      remakingBeatId = null;
      renderScripts(state.tabs);
      renderKeyframes(state.tabs);
    }
  }

  async function deleteClip({ name, stem, beatId } = {}) {
    if (!name && !stem && !beatId) return;
    const label = name || stem || beatId;
    if (!confirm(`Delete clip ${label}?`)) return;
    log(`Deleting clip ${label}…`);
    const res = await fetch("/api/delete-clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: name ? [name] : null, stems: stem ? [stem] : null, beatId }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Delete failed: ${data.error || res.status}`);
      return;
    }
    log(`Deleted ${data.deleted?.join(", ") || label} · ${data.remaining ?? "?"} left`);
    selectTab("clips");
  }

  $("btnSaveScripts")?.addEventListener("click", () => {
    saveScripts();
  });

  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const beat = btn.dataset.beat;
    if (act === "goto-kf" || act === "edit-script") {
      if (act === "edit-script") selectTab("scripts");
      else selectTab("keyframes");
      if (act === "goto-kf") {
        selectTab("keyframes");
        const card = document.querySelector(`.kf-card[data-beat="${CSS.escape(beat)}"]`);
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      if (act === "edit-script") {
        const card = document.querySelector(`.shot-card[data-beat-id="${CSS.escape(beat)}"]`);
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
        card?.querySelector("[data-f=lyricHint]")?.focus();
      }
      return;
    }
    if (act === "remake") {
      remakeBeat(beat, { animate: false });
      return;
    }
    if (act === "remake-clip") {
      remakeBeat(beat, { animate: true });
      return;
    }
    if (act === "delete-clip") {
      deleteClip({
        name: btn.dataset.name,
        stem: btn.dataset.stem,
        beatId: beat,
      });
    }
  });

  btnApprove.addEventListener("click", async () => {
    const gate = waitingGate();
    if (!gate) return;
    const payload = {};
    if (gate === "setup") Object.assign(payload, collectSetupPayload());
    if (gate === "lyrics") payload.text = lyricsText.value;
    if (gate === "plan") {
      // Prefer raw JSON; if shot cards edited, merge those fields into raw first
      try {
        const edits = collectScriptEdits();
        if (edits.length && planRaw.value.trim()) {
          const plan = JSON.parse(planRaw.value);
          const byId = new Map(edits.map((e) => [e.id, e]));
          plan.beats = (plan.beats || []).map((b) => {
            const e = byId.get(b.id);
            if (!e) return b;
            return {
              ...b,
              ...Object.fromEntries(
                Object.entries(e).filter(([k, v]) => k !== "id" && v != null && v !== ""),
              ),
            };
          });
          planRaw.value = JSON.stringify(plan, null, 2);
        }
      } catch {
        /* keep planRaw as-is */
      }
      payload.raw = planRaw.value;
    }
    if (gate === "setup" && !payload.castIds?.length) {
      log("Pick at least one cast member");
      return;
    }
    btnApprove.disabled = true;
    btnReject.disabled = true;
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: gate, payload }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Approve failed: ${data.error || res.status}`);
      updateButtons();
    } else {
      log(`Approved ${gate}`);
      lyricsText.dataset.touched = "";
    }
  });

  btnReject.addEventListener("click", async () => {
    const gate = waitingGate();
    if (!gate) return;
    btnApprove.disabled = true;
    btnReject.disabled = true;
    const res = await fetch("/api/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: gate }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Regenerate failed: ${data.error || res.status}`);
      updateButtons();
    } else {
      log(`Regenerate ${gate}`);
      lyricsText.dataset.touched = "";
    }
  });

  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "log") log(msg.message);
      else if (msg.type === "tabs") {
        state.tabs = msg.tabs;
        renderAll(msg.tabs);
      } else if (msg.type === "remake_done") {
        markRemade(msg);
        log(
          `Still updated: ${(msg.only || []).join(", ")}` +
            (msg.animate ? " (+ clip)" : ""),
        );
        if (state.tabs) {
          renderKeyframes(state.tabs);
          renderScripts(state.tabs);
          if (msg.animate) renderClips(state.tabs);
        }
        const id = msg.only?.[0];
        if (id) {
          selectTab(msg.animate ? "clips" : "keyframes");
          requestAnimationFrame(() => {
            const card = document.querySelector(
              `.kf-card[data-beat="${CSS.escape(id)}"]`,
            );
            card?.scrollIntoView({ behavior: "smooth", block: "center" });
          });
        }
      } else if (msg.type === "clips_deleted") {
        log(`Clips deleted: ${(msg.deleted || []).join(", ")}`);
      } else if (msg.type === "gpu") {
        state.gpu = msg;
        if ($("gpuBackend") && msg.backend) $("gpuBackend").value = msg.backend;
        log(`GPU: ${msg.backend} → ${msg.comfyUrl}`);
      } else if (msg.type === "resolution") {
        state.outputResolution = msg.outputResolution;
        if ($("outputResolution") && msg.outputResolution) {
          $("outputResolution").value = msg.outputResolution;
        }
      } else if (msg.type === "stage" || msg.type === "state" || msg.type === "auto_approve") {
        applyState(msg);
        if (msg.message) log(msg.message);
        if (msg.type === "state") refreshBatchPicker();
      }
    } catch (err) {
      console.warn(err);
    }
  };
  es.onerror = () => log("SSE disconnected — retrying…");

  applyState(state);
  renderAll(state.tabs || {});
  refreshBatchPicker();
  log("Connected to mvid GUI");
  refreshSaladStatus();
  refreshMetrics();
  setInterval(refreshMetrics, 2000);
  setInterval(refreshSaladStatus, 30000);
})();
