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
    if (btnPause) btnPause.disabled = paused || stopped || state.stage === "done";
    if (btnResume) btnResume.disabled = !paused || stopped;
    if (btnStop) btnStop.disabled = stopped || state.stage === "done";
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

  function renderScripts(tabs) {
    const el = $("scriptsView");
    const beats = tabs?.scripts?.beats || [];
    if (!beats.length) {
      el.className = "empty";
      el.textContent = "No scripts yet";
      return;
    }
    el.className = "script-list";
    el.innerHTML = beats
      .map(
        (b) => `<div class="script-item">
        <h4>${esc(b.id)}</h4>
        <p><strong>Lyric hint:</strong> ${esc(b.lyricHint || "—")}</p>
        <p class="meta">${esc(b.cause || "")} → ${esc(b.effect || "")}</p>
        <p class="meta">cut: ${esc(b.cutMotivation || "—")} · phase: ${esc(b.actionPhase || "—")}</p>
      </div>`,
      )
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
      .map(
        (img) => `<div class="card">
        <img src="${img.url}?t=${Date.now()}" alt="${esc(img.name)}" />
        <div class="cap">${esc(img.name)}</div>
      </div>`,
      )
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
      .map(
        (v) => `<div class="card">
        <video controls src="${v.url}?t=${Date.now()}"></video>
        <div class="cap">${esc(v.name)}</div>
      </div>`,
      )
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
    if (s.gpu?.backend && $("gpuBackend")) $("gpuBackend").value = s.gpu.backend;
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
    log(
      `GPU → ${data.backend} (${data.comfyUrl})${data.comfyUp ? " · up" : " · not reachable yet"}`,
    );
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
    else log(`Resumed`);
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

  btnApprove.addEventListener("click", async () => {
    const gate = waitingGate();
    if (!gate) return;
    const payload = {};
    if (gate === "setup") Object.assign(payload, collectSetupPayload());
    if (gate === "lyrics") payload.text = lyricsText.value;
    if (gate === "plan") payload.raw = planRaw.value;
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
      else if (msg.type === "tabs") renderAll(msg.tabs);
      else if (msg.type === "gpu") {
        state.gpu = msg;
        if ($("gpuBackend") && msg.backend) $("gpuBackend").value = msg.backend;
        log(`GPU: ${msg.backend} → ${msg.comfyUrl}`);
      } else if (msg.type === "stage" || msg.type === "state" || msg.type === "auto_approve") {
        applyState(msg);
        if (msg.message) log(msg.message);
      }
    } catch (err) {
      console.warn(err);
    }
  };
  es.onerror = () => log("SSE disconnected — retrying…");

  applyState(state);
  renderAll(state.tabs || {});
  log("Connected to mvid GUI");
  refreshSaladStatus();
})();
