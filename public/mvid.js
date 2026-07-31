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
    lyrics: "lyrics",
    song: "song",
    storyline: "plan",
    scenes: "plan",
    scripts: "plan",
    keyframes: "keyframes",
    clips: "clips",
    final: "final",
  };

  let activeTab = "lyrics";

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

  function updateButtons() {
    const gate = waitingGate();
    const enabled = !!gate && !autoApprove.checked;
    btnApprove.disabled = !enabled;
    btnReject.disabled = !enabled || gate === "final";
    // On final, still allow approve to mark done; reject regenerates stitch
    if (gate === "final") btnReject.disabled = !enabled;
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
    if (s.tabs) renderAll(s.tabs);
    updateButtons();

    const gate = waitingGate();
    if (gate) {
      const tab =
        gate === "plan"
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

  btnApprove.addEventListener("click", async () => {
    const gate = waitingGate();
    if (!gate) return;
    const payload = {};
    if (gate === "lyrics") payload.text = lyricsText.value;
    if (gate === "plan") payload.raw = planRaw.value;
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
      else if (msg.type === "stage" || msg.type === "state" || msg.type === "auto_approve") {
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
})();
