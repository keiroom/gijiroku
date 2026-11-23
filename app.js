/* 画面の制御。入力内容・結果はこの変数（メモリ）上にのみ保持し、どこにも保存しない。 */
(function () {
  "use strict";
  const GJ = window.GJ;
  const { $, $$ } = GJ;
  const CFG = window.GIJIROKU_CONFIG || {};
  const API = GJ.Gemini;

  const SPEAKER_COUNT = 10;
  const ROLES = ["", "司会・進行", "書記", "報告・発表者", "決裁者", "参加者", "社外・ゲスト"];

  const state = {
    template: null,          // 読み込んだテンプレート
    audio: null,             // { blob, name, mime, size, duration }
    audioTranscript: null,   // 音声から起こした文字（作り直し時に再利用）
    audioKey: null,
    result: null,            // { html, points }
    speakerCand: null,       // 話者の推定結果 { key, list }
    speakerMap: null,        // 確認済みの対応 [{ label, name, org }]
    speakerKey: null,
    abort: null,
    recorder: null
  };

  /* ================= 初期化 ================= */
  function init() {
    if (CFG.APP_NAME) { $("#appName").textContent = CFG.APP_NAME; document.title = CFG.APP_NAME; }
    buildSpeakerRows();
    $("#mtgDate").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    bindTemplate();
    bindSources();
    bindRecorder();
    bindTabs();
    bindGenerate();
    bindResult();
    bindSettings();
    bindStepNav();
    loadPresets();
    refreshSetupNotice();
    $("#btnHelp").addEventListener("click", showHelp);
    $("#btnClearAll").addEventListener("click", () => {
      if (confirm("入力した内容をすべて消去します。よろしいですか？")) clearAll();
    });
    window.addEventListener("beforeunload", (e) => {
      if (hasAnyInput() || state.result) { e.preventDefault(); e.returnValue = ""; }
    });
    document.addEventListener("input", updateStatus);
    document.addEventListener("change", updateStatus);
    updateStatus();
  }

  /* ================= 話者 ================= */
  function buildSpeakerRows() {
    const wrap = $("#speakerRows");
    const opts = ROLES.map((r) => `<option value="${r}">${r || "―"}</option>`).join("");
    let html = "";
    for (let i = 1; i <= SPEAKER_COUNT; i++) {
      html += `<div class="speaker-row" role="row">
        <span class="speaker-row__no" role="cell">${i}</span>
        <input type="text" class="input" data-sp="name" aria-label="${i}人目の氏名" placeholder="${i === 1 ? "例：佐藤 一郎" : ""}" autocomplete="off">
        <input type="text" class="input" data-sp="org" aria-label="${i}人目の所属・役職" placeholder="${i === 1 ? "例：営業部 部長" : ""}" autocomplete="off">
        <select class="input" data-sp="role" aria-label="${i}人目の役割">${opts}</select>
      </div>`;
    }
    wrap.innerHTML = html;
  }

  function getSpeakers() {
    return $$("#speakerRows .speaker-row")
      .map((r) => ({ name: $('[data-sp="name"]', r).value.trim(), org: $('[data-sp="org"]', r).value.trim(), role: $('[data-sp="role"]', r).value }))
      .filter((s) => s.name || s.org);
  }

  function getMeeting() {
    return {
      title: $("#mtgTitle").value.trim(),
      place: $("#mtgPlace").value.trim(),
      date: $("#mtgDate").value,
      start: $("#mtgStart").value,
      end: $("#mtgEnd").value,
      author: $("#mtgAuthor").value.trim(),
      glossary: $("#mtgGlossary").value.trim(),
      speakers: getSpeakers().map((s, i) => ({ ...s, name: s.name || `参加者${i + 1}` }))
    };
  }

  /* ================= テンプレート ================= */
  function setupDropzone(zone, input, onFile) {
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); zone.classList.remove("is-over");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
    input.addEventListener("change", () => { const f = input.files[0]; input.value = ""; if (f) onFile(f); });
  }

  function bindTemplate() {
    setupDropzone($("#templateDrop"), $("#templateFile"), loadTemplateFile);
    $("#btnTemplateRemove").addEventListener("click", () => {
      state.template = null;
      $("#presetSelect").value = "";
      renderTemplate();
    });
    $("#btnTemplatePreview").addEventListener("click", () => {
      const p = $("#templatePreview");
      p.hidden = !p.hidden;
      $("#btnTemplatePreview").textContent = p.hidden ? "内容を確認" : "確認を閉じる";
    });
    $("#presetSelect").addEventListener("change", async (e) => {
      const v = e.target.value;
      if (!v) { state.template = null; renderTemplate(); return; }
      const preset = (CFG.PRESET_TEMPLATES || [])[+v];
      try {
        const res = await fetch(preset.file, { cache: "no-store" });
        if (!res.ok) throw new Error(res.status);
        const blob = await res.blob();
        const name = preset.file.split("/").pop();
        await loadTemplateFile(new File([blob], name, { type: blob.type }), preset.name);
      } catch (err) {
        GJ.toast("登録済みテンプレートを読み込めませんでした");
      }
    });
  }

  async function loadTemplateFile(file, displayName) {
    const okExt = ["docx", "xlsx", "xls", "pdf", "txt", "md", "csv"];
    if (!okExt.includes(GJ.fileExt(file.name))) {
      if (GJ.fileExt(file.name) === "doc") return alertBox("この形式は読み込めません", "古い Word 形式（.doc）です。Word で開き「名前を付けて保存」から「Word 文書（.docx）」で保存し直してください。");
      return alertBox("この形式は読み込めません", "Word（.docx）、Excel（.xlsx）、PDF、テキスト（.txt）のいずれかを選んでください。");
    }
    if (file.size > 15 * 1024 * 1024) return alertBox("ファイルが大きすぎます", "テンプレートは 15MB 以下のファイルを選んでください。");
    try {
      const t = await GJ.readTemplate(file);
      if (displayName) t.displayName = displayName;
      state.template = t;
      renderTemplate();
    } catch (e) {
      alertBox("テンプレートを読み込めませんでした", "ファイルが壊れているか、パスワードで保護されている可能性があります。", String(e));
    }
  }

  function renderTemplate() {
    const t = state.template;
    $("#templateCard").hidden = !t;
    $("#templateDrop").hidden = !!t;
    $("#templatePreview").hidden = true;
    $("#btnTemplatePreview").textContent = "内容を確認";
    if (t) {
      $("#templateIcon").textContent = t.label === "TEXT" ? "TXT" : t.label === "Excel" ? "XLS" : t.label === "PDF" ? "PDF" : "DOC";
      $("#templateName").textContent = t.displayName || t.name;
      $("#templateSub").textContent = `${t.format}・${GJ.formatBytes(t.size)}　この書式に合わせて作成します`;
      $("#templatePreview").innerHTML = t.previewHtml || "";
    }
    updateStatus();
  }

  async function loadPresets() {
    const list = CFG.PRESET_TEMPLATES || [];
    if (!list.length) return;
    $("#presetField").hidden = false;
    $("#presetSelect").innerHTML = `<option value="">（選択しない）</option>` + list.map((p, i) => `<option value="${i}">${GJ.escapeHtml(p.name)}</option>`).join("");
  }

  /* ================= 議事録のもと ================= */
  function bindTabs() {
    $$(".tabs__tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        $$(".tabs__tab").forEach((t) => { t.classList.toggle("is-active", t === tab); t.setAttribute("aria-selected", t === tab); });
        $$(".tabpanel").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
      })
    );
  }

  function bindSources() {
    setupDropzone($("#audioDrop"), $("#audioFile"), (f) => setAudio(f, f.name, GJ.audioMime(f)));
    $("#btnAudioRemove").addEventListener("click", () => setAudio(null));

    const textLoader = (btn, input, target) => {
      $(btn).addEventListener("click", () => $(input).click());
      $(input).addEventListener("change", async () => {
        const f = $(input).files[0];
        $(input).value = "";
        if (!f) return;
        try {
          const text = await GJ.readTextSource(f);
          const ta = $(target);
          if (ta.value.trim() && !confirm("入力済みの内容を、読み込んだファイルの内容で置き換えますか？\n（キャンセルすると末尾に追加します）")) ta.value += "\n\n" + text;
          else ta.value = text;
          updateStatus();
        } catch (e) {
          alertBox("ファイルを読み込めませんでした", "テキスト形式（.txt）で保存し直してお試しください。", String(e));
        }
      });
    };
    textLoader("#btnTranscriptFile", "#transcriptFile", "#srcTranscript");
    textLoader("#btnMemoFile", "#memoFile", "#srcMemo");
  }

  function setAudio(blob, name, mime, knownDuration) {
    const player = $("#audioPlayer");
    if (player.src) URL.revokeObjectURL(player.src);
    player.removeAttribute("src");
    if (!blob) {
      state.audio = null;
      state.audioTranscript = null;
      $("#audioCard").hidden = true;
      updateStatus();
      return;
    }
    if (blob.size > 2 * 1024 * 1024 * 1024) return alertBox("ファイルが大きすぎます", "音声は 2GB 以下にしてください。長時間の録音は分割するか、mp3 などに変換してください。");
    state.audio = { blob, name, mime, size: blob.size, duration: knownDuration || null };
    state.audioTranscript = null;
    $("#audioCard").hidden = false;
    $("#audioName").textContent = name;
    player.src = URL.createObjectURL(blob);
    const sub = () => `${GJ.formatBytes(blob.size)}${state.audio && state.audio.duration ? "・約" + GJ.formatDuration(state.audio.duration) : ""}`;
    $("#audioSub").textContent = sub();
    player.onloadedmetadata = () => {
      if (state.audio && isFinite(player.duration) && player.duration > 0) { state.audio.duration = player.duration; $("#audioSub").textContent = sub(); updateStatus(); }
    };
    updateStatus();
  }

  /* ================= 録音 ================= */
  function bindRecorder() {
    const startBtn = $("#btnRecStart"), pauseBtn = $("#btnRecPause"), stopBtn = $("#btnRecStop");
    let timer = null, elapsed = 0, lastTick = 0;

    const tick = () => {
      const now = Date.now();
      if (state.recorder && state.recorder.state === "recording") elapsed += (now - lastTick) / 1000;
      lastTick = now;
      const s = Math.floor(elapsed);
      $("#recTime").textContent = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
    };

    startBtn.addEventListener("click", async () => {
      if (!navigator.mediaDevices || !window.MediaRecorder) return alertBox("録音できません", "このブラウザは録音に対応していません。Chrome または Edge をお使いください。");
      if (state.audio && !confirm("選択中の音声を取り消して、新しく録音しますか？")) return;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      } catch (e) {
        return alertBox("マイクを使用できません", "ブラウザのマイクの使用が許可されていません。アドレスバー左の鍵マークから、マイクを「許可」にしてください。", String(e));
      }
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(timer);
        const type = (rec.mimeType || mime || "audio/webm").replace(/;.*$/, "");
        const blob = new Blob(chunks, { type });
        const d = new Date();
        const name = `録音_${d.getMonth() + 1}月${d.getDate()}日_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}.${type.includes("mp4") ? "m4a" : "webm"}`;
        state.recorder = null;
        $("#recorder").classList.remove("is-recording");
        startBtn.hidden = false; pauseBtn.hidden = true; stopBtn.hidden = true;
        $("#recHint").textContent = "録音が完了しました。左側に音声が登録されています。";
        setAudio(blob, name, type, elapsed);
      };
      rec.start(1000);
      state.recorder = rec;
      elapsed = 0; lastTick = Date.now();
      timer = setInterval(tick, 250);
      $("#recorder").classList.add("is-recording");
      startBtn.hidden = true; pauseBtn.hidden = false; stopBtn.hidden = false; pauseBtn.textContent = "一時停止";
      $("#recHint").textContent = "録音中です。会議が終わったら「録音を終了」を押してください。";
    });
    pauseBtn.addEventListener("click", () => {
      const r = state.recorder;
      if (!r) return;
      if (r.state === "recording") { r.pause(); pauseBtn.textContent = "再開"; $("#recHint").textContent = "一時停止中です。"; }
      else { r.resume(); lastTick = Date.now(); pauseBtn.textContent = "一時停止"; $("#recHint").textContent = "録音中です。"; }
    });
    stopBtn.addEventListener("click", () => state.recorder && state.recorder.stop());
  }

  /* ================= 状態表示 ================= */
  function sources() {
    return {
      transcript: $("#srcTranscript").value.trim(),
      memo: $("#srcMemo").value.trim()
    };
  }
  function hasSource() { const s = sources(); return !!(state.audio || s.transcript || s.memo); }
  function hasAnyInput() {
    return hasSource() || !!state.template || getSpeakers().length > 0 || ["#mtgTitle", "#mtgPlace", "#mtgAuthor", "#mtgGlossary"].some((s) => $(s).value.trim());
  }

  function updateStatus() {
    const s = sources();
    const m = getMeeting();
    // 文字数
    $$("[data-charcount-for]").forEach((el) => {
      const n = $("#" + el.dataset.charcountFor).value.trim().length;
      el.textContent = n ? `${n.toLocaleString()} 文字` : "";
    });
    const cnt = { audio: state.audio ? "1" : "", transcript: s.transcript ? "入力済" : "", memo: s.memo ? "入力済" : "" };
    $$("[data-count-for]").forEach((el) => (el.textContent = cnt[el.dataset.countFor]));

    // ステップ表示
    const setState = (key, done, text) => {
      const el = $(`[data-state-for="${key}"]`);
      const a = $(`[data-step="${key}"]`);
      a.classList.toggle("is-done", done);
      if (el) { el.textContent = text; el.classList.toggle("is-ok", done); el.classList.toggle("is-required", key === "source" && !done); }
    };
    setState("template", !!state.template, state.template ? "設定済" : "任意");
    const meetingFilled = !!(m.title || m.speakers.length);
    setState("meeting", meetingFilled, meetingFilled ? "入力済" : "任意");
    setState("source", hasSource(), hasSource() ? "入力済" : "必須");

    // 作成前の確認
    const rows = [
      ["テンプレート", state.template ? (state.template.displayName || state.template.name) : "標準形式で作成"],
      ["会議名", m.title || "（未入力）"],
      ["参加者", m.speakers.length ? `${m.speakers.length}名：` + m.speakers.map((x) => x.name).join("、") : "（未入力）"],
      ["議事録のもと", [
        state.audio && `音声${state.audio.duration ? "（約" + GJ.formatDuration(state.audio.duration) + "）" : ""}`,
        s.transcript && `文字起こし（${s.transcript.length.toLocaleString()}文字）`,
        s.memo && `メモ（${s.memo.length.toLocaleString()}文字）`
      ].filter(Boolean).join("＋") || "（未入力）"]
    ];
    $("#checklist").innerHTML = rows
      .map(([k, v]) => `<li><span class="checklist__k">${k}</span><span class="checklist__v ${/^（/.test(v) ? "is-empty" : ""}">${GJ.escapeHtml(v)}</span></li>`)
      .join("");

    const ok = hasSource() && !state.recorder;
    $("#btnGenerate").disabled = !ok;
    $("#generateNote").textContent = state.recorder ? "録音中です。録音を終了してから作成してください"
      : !hasSource() ? "「3. 議事録のもと」に音声・文字起こし・メモのいずれかを入れてください"
      : estimateNote();
  }

  function estimateNote() {
    const mins = state.audio && state.audio.duration ? state.audio.duration / 60 : 0;
    if (mins > 20) return `目安：${Math.ceil(mins / 10) + 1}〜${Math.ceil(mins / 5) + 2}分程度かかります`;
    return "目安：1〜3分程度で完成します";
  }

  function bindStepNav() {
    $$(".stepnav a").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      $(a.getAttribute("href")).scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  /* ================= 作成 ================= */
  function bindGenerate() {
    $("#btnGenerate").addEventListener("click", () => run());
    $("#btnCancel").addEventListener("click", () => state.abort && state.abort.abort());
  }

  const Progress = {
    steps: [],
    t0: 0,
    timer: null,
    open(labels) {
      this.steps = labels;
      $("#progressSteps").innerHTML = labels.map((l) => `<li><span class="ps-icon"></span><span>${l}</span></li>`).join("");
      $("#progressOverlay").hidden = false;
      this.t0 = Date.now();
      const upd = () => {
        const s = Math.floor((Date.now() - this.t0) / 1000);
        $("#progressElapsed").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      };
      upd();
      this.timer = setInterval(upd, 1000);
    },
    set(i) {
      $$("#progressSteps li").forEach((li, idx) => {
        li.classList.toggle("is-done", idx < i);
        li.classList.toggle("is-active", idx === i);
      });
    },
    note(t) { $("#progressNote").textContent = t; },
    hide() { $("#progressOverlay").hidden = true; },
    show() { $("#progressOverlay").hidden = false; },
    close() { clearInterval(this.timer); $("#progressOverlay").hidden = true; }
  };

  function parseJson(text) {
    let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(t); } catch (_) {}
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
    return null;
  }

  async function run(opts = {}) {
    if (!API.ready()) { openSettings(true); return; }
    const meeting = getMeeting();
    const src = sources();
    const verifyOn = $("#optVerify").checked;
    const audioKey = state.audio ? `${state.audio.name}:${state.audio.size}` : null;
    const needTranscribe = state.audio && !(state.audioTranscript && state.audioKey === audioKey);
    const wantSpeakers = !!(state.audio || src.transcript);

    const labels = [];
    if (needTranscribe) labels.push("音声を送信しています", "音声を文字に起こしています");
    if (wantSpeakers) labels.push("発言者を特定しています");
    labels.push("議事録を作成しています");
    if (verifyOn) labels.push("元の内容と照らし合わせて見直しています");
    labels.push("仕上げています");

    const ctrl = new AbortController();
    state.abort = ctrl;
    Progress.open(labels);
    Progress.note("画面を閉じずにお待ちください");
    const go = (label) => Progress.set(labels.indexOf(label));
    let uploaded = null;

    try {
      Progress.set(0);
      const model = await API.resolveModel();

      // 1) 音声 → 文字
      if (needTranscribe) {
        const a = state.audio;
        if (a.size > 50 * 1024 * 1024) Progress.note("音声ファイルが大きいため、送信に時間がかかります");
        const prepared = await API.prepareAudio(a.blob, a.mime, ctrl.signal);
        uploaded = prepared.fileName;
        go("音声を文字に起こしています");
        Progress.note(a.duration && a.duration > 1800 ? "長時間の音声のため、数分かかります" : "画面を閉じずにお待ちください");
        const r = await API.generate({
          model,
          parts: [{ text: GJ.Prompts.transcribe(meeting) }, prepared.part],
          signal: ctrl.signal
        });
        state.audioTranscript = r.text.trim();
        state.audioKey = audioKey;
        if (uploaded) { API.deleteFile(uploaded); uploaded = null; }
      }

      // 2) 発言者の特定
      let speakerMap = null;
      const extraPoints = [];
      if (wantSpeakers) {
        go("発言者を特定しています");
        const raw = state.audio ? state.audioTranscript : null;
        const key = hashStr([raw, src.transcript, meeting.speakers.map((x) => x.name + "/" + x.org + "/" + x.role).join("|")].join("\u0000"));
        if (state.speakerMap && state.speakerKey === key && !opts.editSpeakers) {
          speakerMap = state.speakerMap;
        } else {
          let cand = state.speakerCand && state.speakerCand.key === key ? state.speakerCand.list : null;
          if (!cand) {
            try {
              const records = [raw && `<record type="音声の文字起こし">\n${raw}\n</record>`, src.transcript && `<record type="文字起こし">\n${src.transcript}\n</record>`].filter(Boolean).join("\n\n");
              const r = await API.generate({ model, parts: GJ.Prompts.identify(meeting, records), json: GJ.Prompts.IDENTIFY_SCHEMA, signal: ctrl.signal });
              const j = parseJson(r.text);
              cand = normalizeCandidates((j && j.speakers) || []);
              state.speakerCand = { key, list: cand };
            } catch (e) {
              if (e.name === "AbortError") throw e;
              cand = [];
              extraPoints.push({ where: "発言者", reason: "発言者の自動特定を完了できませんでした。発言者名をご確認ください。" });
            }
          }
          if (cand.length) {
            if ($("#optSpeakerCheck").checked || opts.editSpeakers) {
              Progress.hide();
              const ans = await openSpeakerDialog(cand, meeting.speakers, opts.editSpeakers ? state.speakerMap : null);
              if (ans === null) throw new DOMException("Aborted", "AbortError");
              Progress.show();
              speakerMap = ans;
            } else {
              // 確認なし：根拠が十分なもの（高・中）のみ自動で採用
              speakerMap = cand.map((c) => {
                const r = c.confidence === "high" || c.confidence === "medium" ? findRoster(c.name, meeting.speakers) : null;
                return { label: c.label, name: r ? r.name : (c.confidence === "high" && c.name ? c.name : ""), org: r ? r.org : "" };
              });
            }
          } else speakerMap = [];
          state.speakerMap = speakerMap;
          state.speakerKey = key;
        }
      }
      const mappedAudio = state.audio ? applySpeakerMap(state.audioTranscript, speakerMap) : null;

      const allSources = { audioTranscript: mappedAudio, transcript: src.transcript, memo: src.memo };
      const ctx = { meeting, template: state.template, sources: allSources, detail: $("#mtgDetail").value, speakerMap: speakerMap && speakerMap.length ? speakerMap : null };

      // 2) 議事録
      go("議事録を作成しています");
      Progress.note("画面を閉じずにお待ちください");
      const draftRes = await API.generate({ model, system: GJ.Prompts.SYSTEM, parts: GJ.Prompts.minutes(ctx), json: GJ.Prompts.SCHEMA, signal: ctrl.signal });
      let out = parseJson(draftRes.text);
      if (!out || !out.html) throw new API.ApiError("作成結果を読み取れませんでした。もう一度お試しください。", draftRes.finishReason, 0);
      if (draftRes.finishReason === "MAX_TOKENS") out.review_points = (out.review_points || []).concat([{ where: "全体", reason: "分量が多く、末尾が途中で切れている可能性があります。" }]);

      // 3) 見直し
      if (verifyOn) {
        go("元の内容と照らし合わせて見直しています");
        try {
          const vRes = await API.generate({
            model, system: GJ.Prompts.SYSTEM,
            parts: GJ.Prompts.verify({ ...ctx, draftHtml: out.html, draftPoints: out.review_points }),
            json: GJ.Prompts.SCHEMA, signal: ctrl.signal
          });
          const v = parseJson(vRes.text);
          if (v && v.html && v.html.length > out.html.length * 0.5 && vRes.finishReason !== "MAX_TOKENS") out = v;
        } catch (e) {
          if (e.name === "AbortError") throw e;
          // 見直しに失敗しても下書きは使う
          out.review_points = (out.review_points || []).concat([{ where: "全体", reason: "自動の見直しを完了できませんでした。内容を特に丁寧にご確認ください。" }]);
        }
      }

      go("仕上げています");
      state.result = { html: GJ.highlightChecks(GJ.sanitizeHtml(out.html)), points: extraPoints.concat(out.review_points || []), mappedTranscript: mappedAudio };
      await GJ.sleep(250);
      Progress.close();
      showResult();
    } catch (e) {
      Progress.close();
      if (e.name === "AbortError") { GJ.toast("作成を中止しました"); return; }
      console.error(e);
      alertBox("議事録を作成できませんでした", e.message || "予期しないエラーが発生しました。", e.detail || String(e));
    } finally {
      if (uploaded) API.deleteFile(uploaded);
      state.abort = null;
    }
  }

  /* ================= 発言者 ================= */
  function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h) + ":" + str.length;
  }
  const coreLabel = (l) => String(l || "").replace(/[【】\[\]]/g, "").trim();
  const norm = (n) => String(n || "").replace(/[\s　]/g, "").replace(/(さん|様|氏|部長|課長|社長)$/, "");

  function findRoster(name, roster) {
    const n = norm(name);
    if (!n) return null;
    return roster.find((r) => norm(r.name) === n) ||
      roster.find((r) => norm(r.name).startsWith(n) || n.startsWith(norm(r.name))) || null;
  }

  function normalizeCandidates(list) {
    const seen = new Set();
    return list
      .map((c) => ({ ...c, label: coreLabel(c.label), samples: (c.samples || []).slice(0, 2), confidence: c.confidence || "none" }))
      .filter((c) => c.label && !seen.has(c.label) && seen.add(c.label));
  }

  function applySpeakerMap(text, map) {
    if (!text || !map || !map.length) return text;
    let out = text;
    map.forEach((m) => {
      if (!m.name) return;
      out = out.split(`【${m.label}】`).join(`【${m.name}】`);
    });
    return out;
  }

  /* 発言者の確認ダイアログ（利用者の回答を Promise で返す） */
  function openSpeakerDialog(cand, roster, current) {
    return new Promise((resolve) => {
      const extras = [];
      cand.forEach((c) => {
        if (c.name && !findRoster(c.name, roster) && !extras.includes(c.name)) extras.push(c.name);
      });
      const confText = { high: "確度 高", medium: "確度 中", low: "確度 低", none: "根拠なし" };
      const optHtml = (selected) =>
        `<option value="">特定しない</option>` +
        (roster.length ? `<optgroup label="参加者">${roster.map((r) => `<option value="r:${GJ.escapeHtml(r.name)}" ${selected === "r:" + r.name ? "selected" : ""}>${GJ.escapeHtml(r.name)}${r.org ? "（" + GJ.escapeHtml(r.org) + "）" : ""}</option>`).join("")}</optgroup>` : "") +
        (extras.length ? `<optgroup label="会話中に出てきた名前">${extras.map((n) => `<option value="x:${GJ.escapeHtml(n)}" ${selected === "x:" + n ? "selected" : ""}>${GJ.escapeHtml(n)}</option>`).join("")}</optgroup>` : "") +
        `<option value="other" ${selected === "other" ? "selected" : ""}>その他（名前を入力）</option>`;

      $("#spkRows").innerHTML = cand.map((c, i) => {
        let sel = "", otherVal = "";
        const prev = current && current.find((m) => m.label === c.label);
        const name = prev ? prev.name : c.confidence !== "none" ? c.name : "";
        if (name) {
          const r = findRoster(name, roster);
          if (r) sel = "r:" + r.name;
          else if (extras.includes(name)) sel = "x:" + name;
          else { sel = "other"; otherVal = name; }
        }
        return `<div class="spk-row" role="row" data-i="${i}">
          <div class="spk-label">${GJ.escapeHtml(c.label)}${c.turns ? `<small>発言 約${c.turns}回</small>` : ""}</div>
          <ul class="spk-samples">${c.samples.map((x) => `<li>${GJ.escapeHtml(x)}</li>`).join("") || "<li>―</li>"}</ul>
          <div class="spk-assign">
            <select class="input" aria-label="${GJ.escapeHtml(c.label)} の割り当て">${optHtml(sel)}</select>
            <input type="text" class="input" placeholder="氏名を入力" value="${GJ.escapeHtml(otherVal)}" ${sel === "other" ? "" : "hidden"}>
          </div>
          <div class="spk-evidence"><span class="conf conf--${c.confidence}">${confText[c.confidence] || ""}</span><br>${GJ.escapeHtml(c.evidence || "記録の中に手がかりが見つかりませんでした。")}</div>
        </div>`;
      }).join("");

      const read = () => $$("#spkRows .spk-row").map((row) => {
        const c = cand[+row.dataset.i];
        const v = $("select", row).value;
        let name = "", org = "";
        if (v.startsWith("r:")) { const r = roster.find((x) => x.name === v.slice(2)); name = r.name; org = r.org; }
        else if (v.startsWith("x:")) name = v.slice(2);
        else if (v === "other") name = $("input", row).value.trim();
        return { label: c.label, name, org };
      });
      const checkDup = () => {
        const names = read().map((m) => m.name).filter(Boolean);
        const dup = names.filter((n, i) => names.indexOf(n) !== i);
        $("#spkWarn").hidden = !dup.length;
        $("#spkWarn").textContent = dup.length ? `「${[...new Set(dup)].join("」「")}」が複数の話者に割り当てられています。同じ人が分かれて認識された場合はこのままで問題ありません。` : "";
      };
      $$("#spkRows select").forEach((s) => s.addEventListener("change", () => {
        const inp = s.nextElementSibling;
        inp.hidden = s.value !== "other";
        if (!inp.hidden) inp.focus();
        checkDup();
      }));
      $$("#spkRows input").forEach((i) => i.addEventListener("input", checkDup));
      checkDup();

      const done = (val) => {
        $("#speakerOverlay").hidden = true;
        $("#btnSpkOk").onclick = $("#btnSpkSkip").onclick = $("#btnSpkCancel").onclick = null;
        resolve(val);
      };
      $("#btnSpkOk").onclick = () => done(read());
      $("#btnSpkSkip").onclick = () => done(cand.map((c) => ({ label: c.label, name: "", org: "" })));
      $("#btnSpkCancel").onclick = () => done(null);
      $("#speakerOverlay").hidden = false;
      setTimeout(() => { const f = $("#spkRows select"); f && f.focus(); }, 50);
    });
  }

  /* ================= 結果 ================= */
  function showResult() {
    const r = state.result;
    $("#docContent").innerHTML = r.html;
    const list = $("#reviewList");
    $("#reviewCount").textContent = r.points.length;
    $("#reviewCount").classList.toggle("is-zero", r.points.length === 0);
    list.innerHTML = r.points.length
      ? r.points.map((p) => `<li><span class="review-list__where">${GJ.escapeHtml(p.where)}</span>${GJ.escapeHtml(p.reason)}</li>`).join("")
      : `<li class="review-list__empty">特に指摘はありません。念のため全体をご確認ください。</li>`;
    $("#transcriptCard").hidden = !(state.audio && state.audioTranscript);
    const map = state.speakerMap || [];
    $("#speakerCard").hidden = !map.length;
    $("#speakerSummary").innerHTML = map.map((m) => `<li class="${m.name ? "" : "is-unknown"}"><span>${GJ.escapeHtml(m.label)}</span><span>${GJ.escapeHtml(m.name || "特定しない")}</span></li>`).join("");
    $("#viewInput").hidden = true;
    $("#setupNotice").hidden = true;
    $("#viewResult").hidden = false;
    window.scrollTo(0, 0);
  }

  function docName() {
    const m = getMeeting();
    const d = m.date ? m.date.replace(/-/g, "") : "";
    return GJ.safeFileName(`議事録_${m.title || "会議"}${d ? "_" + d : ""}`);
  }

  function bindResult() {
    $("#btnBack").addEventListener("click", () => {
      if (state.result) state.result.html = $("#docContent").innerHTML;
      $("#viewResult").hidden = true;
      $("#viewInput").hidden = false;
      refreshSetupNotice();
      window.scrollTo(0, 0);
    });
    $("#btnRegenerate").addEventListener("click", () => {
      if (confirm("入力内容をもとに、議事録をもう一度作り直します。\n画面上で修正した内容は失われます。よろしいですか？")) run();
    });
    $("#btnCopy").addEventListener("click", async () => {
      try { await GJ.Exporter.copy($("#docContent").innerHTML); GJ.toast("コピーしました。Word やメールに貼り付けられます"); }
      catch (e) { alertBox("コピーできませんでした", "ブラウザの設定によりコピーが制限されています。「保存」から Word 形式で保存してください。", String(e)); }
    });
    const menu = $("#exportMenu"), btn = $("#btnExport");
    btn.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", !menu.hidden); });
    document.addEventListener("click", () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); });
    $$("[data-export]", menu).forEach((b) => b.addEventListener("click", async () => {
      const html = $("#docContent").innerHTML;
      try {
        if (b.dataset.export === "docx") await GJ.Exporter.docx(html, docName());
        else if (b.dataset.export === "txt") GJ.Exporter.txt(html, docName());
        else GJ.Exporter.pdf();
      } catch (e) {
        alertBox("保存できませんでした", "「コピー」で Word に貼り付ける方法もお試しください。", String(e));
      }
    }));
    $("#btnEditSpeakers").addEventListener("click", () => {
      if (confirm("発言者の割り当てを変更して、議事録を作り直します。\n画面上で修正した内容は失われます。よろしいですか？")) run({ editSpeakers: true });
    });
    $("#btnShowTranscript").addEventListener("click", () => {
      $("#infoTitle").textContent = "音声の文字起こし";
      $("#infoBody").innerHTML = `<pre class="transcript-view">${GJ.escapeHtml((state.result && state.result.mappedTranscript) || state.audioTranscript || "")}</pre>`;
      $("#infoOverlay").hidden = false;
    });
    $("#btnSaveTranscript").addEventListener("click", () => {
      GJ.download(new Blob(["﻿" + ((state.result && state.result.mappedTranscript) || state.audioTranscript || "").replace(/\n/g, "\r\n")], { type: "text/plain;charset=utf-8" }), `${docName().replace(/^議事録/, "文字起こし")}.txt`);
    });
  }

  /* ================= 消去 ================= */
  function clearAll() {
    state.template = null; state.result = null; state.audioTranscript = null;
    state.speakerCand = null; state.speakerMap = null; state.speakerKey = null;
    setAudio(null);
    renderTemplate();
    $$("#viewInput input[type=text], #viewInput textarea").forEach((el) => (el.value = ""));
    $$("#speakerRows select").forEach((el) => (el.value = ""));
    $("#mtgStart").value = ""; $("#mtgEnd").value = "";
    $("#presetSelect").value = "";
    $("#docContent").innerHTML = "";
    updateStatus();
    GJ.toast("入力内容を消去しました");
  }

  /* ================= 設定 ================= */
  function refreshSetupNotice() { $("#setupNotice").hidden = API.ready(); }

  function openSettings(fromGenerate) {
    const proxy = API.usesProxy();
    $("#proxyInfo").hidden = !proxy;
    $("#keySection").hidden = proxy;
    $("#apiKey").value = API.Key.get();
    $("#apiKey").type = "password";
    $("#btnToggleKey").textContent = "表示";
    $$('input[name="keyStore"]').forEach((r) => (r.checked = r.value === (API.Key.isPersisted() ? "local" : "session")));
    $("#testResult").hidden = true;
    const manual = API.Model.getManual();
    const sel = $("#modelSelect");
    if (manual && !Array.from(sel.options).some((o) => o.value === manual)) sel.insertAdjacentHTML("beforeend", `<option value="${GJ.escapeHtml(manual)}">${GJ.escapeHtml(manual)}</option>`);
    sel.value = manual;
    sel.disabled = !!CFG.MODEL;
    $("#modelHelp").textContent = CFG.MODEL ? `管理者の設定により「${CFG.MODEL}」に固定されています。` : "通常は「自動選択」のままで問題ありません。";
    $("#settingsOverlay").hidden = false;
    if (fromGenerate) {
      $("#testResult").hidden = false;
      $("#testResult").className = "test-result is-run";
      $("#testResult").textContent = "議事録を作成するには、先に接続キーを登録してください。";
    }
    setTimeout(() => (proxy ? $("#btnSettingsClose") : $("#apiKey")).focus(), 50);
  }

  function bindSettings() {
    $("#btnSettings").addEventListener("click", () => openSettings(false));
    $("#btnSetupNow").addEventListener("click", () => openSettings(false));
    $("#btnSettingsClose").addEventListener("click", () => ($("#settingsOverlay").hidden = true));
    $("#btnToggleKey").addEventListener("click", () => {
      const i = $("#apiKey");
      i.type = i.type === "password" ? "text" : "password";
      $("#btnToggleKey").textContent = i.type === "password" ? "表示" : "隠す";
    });
    const saveKey = () => {
      if (API.usesProxy()) return true;
      const k = $("#apiKey").value.trim();
      if (!k) { showTest("ng", "接続キーを入力してください。"); return false; }
      API.Key.set(k, $('input[name="keyStore"]:checked').value === "local");
      return true;
    };
    $("#btnSettingsSave").addEventListener("click", () => {
      if (!saveKey()) return;
      if (!CFG.MODEL) API.Model.setManual($("#modelSelect").value);
      $("#settingsOverlay").hidden = true;
      refreshSetupNotice();
      GJ.toast("設定を保存しました");
    });
    $("#btnKeyDelete").addEventListener("click", () => {
      API.Key.clear();
      $("#apiKey").value = "";
      refreshSetupNotice();
      showTest("run", "このブラウザから接続キーを削除しました。");
    });
    $("#btnTestKey").addEventListener("click", async () => {
      if (!saveKey()) return;
      showTest("run", "接続を確認しています…");
      try {
        const r = await API.test();
        showTest("ok", `接続できました。使用するモデル：${r.chosen}`);
        fillModels(r.models);
        refreshSetupNotice();
      } catch (e) {
        showTest("ng", e.message || "接続できませんでした。");
      }
    });
    $("#btnLoadModels").addEventListener("click", async () => {
      if (!saveKey()) return;
      try { fillModels(await API.listModels()); GJ.toast("モデルの一覧を取得しました"); }
      catch (e) { showTest("ng", e.message); }
    });
  }

  function fillModels(models) {
    const sel = $("#modelSelect");
    const cur = sel.value;
    const ids = models.map((m) => m.id).filter((id) => /^gemini-/.test(id) && !/(tts|image|embedding|live|audio|transcribe|robotics|computer)/.test(id)).sort().reverse();
    sel.innerHTML = `<option value="">自動選択（推奨）</option>` + ids.map((id) => `<option value="${GJ.escapeHtml(id)}">${GJ.escapeHtml(id)}</option>`).join("");
    sel.value = ids.includes(cur) ? cur : "";
  }

  function showTest(kind, msg) {
    const el = $("#testResult");
    el.hidden = false;
    el.className = `test-result is-${kind}`;
    el.textContent = msg;
  }

  /* ================= ダイアログ ================= */
  function alertBox(title, message, detail) {
    $("#infoTitle").textContent = title;
    $("#infoBody").innerHTML = `<div class="error-box">${GJ.escapeHtml(message)}</div>` +
      (detail ? `<details class="details"><summary>詳細情報（管理者向け）</summary><div class="error-detail">${GJ.escapeHtml(String(detail).slice(0, 800))}</div></details>` : "");
    $("#infoOverlay").hidden = false;
  }
  function showHelp() {
    $("#infoTitle").textContent = "使い方";
    $("#infoBody").innerHTML = "";
    $("#infoBody").appendChild($("#helpTemplate").content.cloneNode(true));
    $("#infoOverlay").hidden = false;
  }
  $("#btnInfoClose").addEventListener("click", () => ($("#infoOverlay").hidden = true));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#infoOverlay").hidden) $("#infoOverlay").hidden = true;
    else if (!$("#settingsOverlay").hidden) $("#settingsOverlay").hidden = true;
  });

  GJ.App = { state, run };
  init();
})();
