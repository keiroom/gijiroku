/* Gemini API との通信（ブラウザから直接、または社内の中継サーバー経由） */
(function () {
  "use strict";
  const GJ = (window.GJ = window.GJ || {});
  const CFG = window.GIJIROKU_CONFIG || {};
  const GOOGLE = "https://generativelanguage.googleapis.com";
  const INLINE_LIMIT = 18 * 1024 * 1024; // これ以下の音声はアップロードせず直接送れる

  const KEY_SS = "gj_api_key";
  const KEY_LS = "gj_api_key_persist";
  const MODEL_SS = "gj_model_auto";
  const MODEL_LS = "gj_model_manual";

  const usesProxy = () => !!(CFG.PROXY_URL && CFG.PROXY_URL.trim());
  const base = () => (usesProxy() ? CFG.PROXY_URL.trim().replace(/\/+$/, "") : GOOGLE);

  /* ---- 接続キー（入力内容とは別に、キーだけは利用者の選択で保持） ---- */
  const Key = {
    get() {
      try { return sessionStorage.getItem(KEY_SS) || localStorage.getItem(KEY_LS) || ""; } catch (_) { return ""; }
    },
    isPersisted() {
      try { return !!localStorage.getItem(KEY_LS); } catch (_) { return false; }
    },
    set(key, persist) {
      try {
        sessionStorage.setItem(KEY_SS, key);
        if (persist) localStorage.setItem(KEY_LS, key);
        else localStorage.removeItem(KEY_LS);
      } catch (_) {}
    },
    clear() {
      try { sessionStorage.removeItem(KEY_SS); localStorage.removeItem(KEY_LS); sessionStorage.removeItem(MODEL_SS); } catch (_) {}
    }
  };

  const ready = () => usesProxy() || !!Key.get();

  function headers(extra) {
    const h = Object.assign({}, extra || {});
    if (!usesProxy()) h["x-goog-api-key"] = Key.get();
    return h;
  }

  /* ---- エラーを利用者向けの日本語に ---- */
  class ApiError extends Error {
    constructor(message, detail, status) { super(message); this.detail = detail; this.status = status; }
  }
  async function toError(res) {
    let detail = "";
    try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.status)) || JSON.stringify(j); }
    catch (_) { try { detail = await res.text(); } catch (__) {} }
    const s = res.status;
    let msg;
    if (s === 400 && /api key/i.test(detail)) msg = "接続キーが正しくありません。設定画面でキーを確認してください。";
    else if (s === 400) msg = "送信した内容を処理できませんでした。ファイルの形式や大きさを確認してください。";
    else if (s === 401 || s === 403) msg = "接続が許可されませんでした。接続キーの権限、または利用契約を確認してください。";
    else if (s === 404) msg = "指定したモデルが見つかりません。設定画面の「使用するモデル」を「自動選択」にしてください。";
    else if (s === 413) msg = "ファイルが大きすぎます。音声を分割するか、圧縮してください。";
    else if (s === 429) msg = "利用回数の上限に達しました。しばらく待ってから再度お試しください。";
    else if (s >= 500) msg = "AI サービスが混み合っています。少し待ってから再度お試しください。";
    else msg = `通信エラーが発生しました（${s}）。`;
    return new ApiError(msg, detail, s);
  }

  async function request(path, opts, retries = 2) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      let res;
      try {
        res = await fetch(base() + path, opts);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = new ApiError("サーバーに接続できませんでした。ネットワーク環境（社内のセキュリティ設定など）を確認してください。", String(e), 0);
        await GJ.sleep(1500 * (i + 1));
        continue;
      }
      if (res.ok) return res;
      const err = await toError(res);
      if ([429, 500, 502, 503, 504].includes(res.status) && i < retries) {
        lastErr = err;
        await GJ.sleep(res.status === 429 ? 8000 * (i + 1) : 3000 * (i + 1));
        continue;
      }
      throw err;
    }
    throw lastErr;
  }

  /* ---- モデル ---- */
  async function listModels() {
    const res = await request("/v1beta/models?pageSize=1000", { headers: headers() }, 1);
    const j = await res.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }));
  }

  /* 安定版の gemini-<版>-pro / flash から最新を選ぶ */
  function chooseBest(models) {
    const pref = CFG.MODEL_PREFERENCE === "flash" ? ["flash", "pro"] : ["pro", "flash"];
    const parse = (id) => {
      const m = id.match(/^gemini-(\d+)(?:\.(\d+))?-(pro|flash)$/);
      return m ? { id, ver: +m[1] + (+(m[2] || 0)) / 100, tier: m[3] } : null;
    };
    const parsed = models.map((m) => parse(m.id)).filter(Boolean);
    for (const tier of pref) {
      const c = parsed.filter((p) => p.tier === tier).sort((a, b) => b.ver - a.ver);
      if (c.length) return c[0].id;
    }
    // 安定版がなければプレビュー版も候補に
    const loose = models.map((m) => m.id).filter((id) => /^gemini-[\d.]+-(pro|flash)(-preview)?$/.test(id)).sort().reverse();
    return loose[0] || "gemini-2.5-flash";
  }

  async function resolveModel() {
    if (CFG.MODEL) return CFG.MODEL;
    try { const manual = localStorage.getItem(MODEL_LS); if (manual) return manual; } catch (_) {}
    try { const cached = sessionStorage.getItem(MODEL_SS); if (cached) return cached; } catch (_) {}
    const best = chooseBest(await listModels());
    try { sessionStorage.setItem(MODEL_SS, best); } catch (_) {}
    return best;
  }

  const Model = {
    getManual() { try { return localStorage.getItem(MODEL_LS) || ""; } catch (_) { return ""; } },
    setManual(id) {
      try {
        if (id) localStorage.setItem(MODEL_LS, id); else localStorage.removeItem(MODEL_LS);
        sessionStorage.removeItem(MODEL_SS);
      } catch (_) {}
    }
  };

  /* ---- 音声ファイルのアップロード（処理後すぐ削除） ---- */
  async function uploadFile(blob, mime, displayName, signal) {
    const start = await request("/upload/v1beta/files", {
      method: "POST",
      signal,
      headers: headers({
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(blob.size),
        "X-Goog-Upload-Header-Content-Type": mime,
        "Content-Type": "application/json"
      }),
      body: JSON.stringify({ file: { display_name: displayName } })
    }, 1);
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new ApiError("音声のアップロードを開始できませんでした。", "x-goog-upload-url ヘッダーが取得できません", 0);

    const up = await fetch(uploadUrl, {
      method: "POST",
      signal,
      headers: headers({ "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }),
      body: blob
    });
    if (!up.ok) throw await toError(up);
    let file = (await up.json()).file;

    // 処理完了まで待機
    const started = Date.now();
    while (file.state === "PROCESSING") {
      if (Date.now() - started > 10 * 60 * 1000) throw new ApiError("音声の準備に時間がかかりすぎています。", "", 0);
      await GJ.sleep(3000);
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      const r = await request(`/v1beta/${file.name}`, { headers: headers(), signal });
      file = await r.json();
    }
    if (file.state === "FAILED") throw new ApiError("音声ファイルを読み取れませんでした。別の形式で保存し直してお試しください。", "", 0);
    return file;
  }

  async function deleteFile(name) {
    if (!name) return;
    try { await fetch(`${base()}/v1beta/${name}`, { method: "DELETE", headers: headers() }); } catch (_) {}
  }

  /* 音声を Gemini に渡せる形にする（大きい場合はアップロード） */
  async function prepareAudio(blob, mime, signal) {
    try {
      const f = await uploadFile(blob, mime, "meeting-audio", signal);
      return { part: { file_data: { mime_type: f.mimeType || mime, file_uri: f.uri } }, fileName: f.name };
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (blob.size <= INLINE_LIMIT) {
        return { part: { inline_data: { mime_type: mime, data: await GJ.blobToBase64(blob) } }, fileName: null };
      }
      throw e;
    }
  }

  /* ---- 生成 ---- */
  async function generate({ model, system, parts, json, signal }) {
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {}
    };
    if (system) body.system_instruction = { parts: [{ text: system }] };
    if (json) {
      body.generationConfig.responseMimeType = "application/json";
      body.generationConfig.responseSchema = json;
    }
    const res = await request(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal,
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    const j = await res.json();
    const cand = (j.candidates || [])[0];
    if (!cand) {
      const reason = j.promptFeedback && j.promptFeedback.blockReason;
      throw new ApiError("内容を処理できませんでした。" + (reason ? "（入力内容が安全基準により処理対象外と判断されました）" : ""), JSON.stringify(j).slice(0, 400), 0);
    }
    const text = (cand.content && cand.content.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!text) throw new ApiError("結果が空でした。もう一度お試しください。", cand.finishReason || "", 0);
    return { text, finishReason: cand.finishReason };
  }

  async function test() {
    const models = await listModels();
    const chosen = CFG.MODEL || Model.getManual() || chooseBest(models);
    return { count: models.length, chosen, models };
  }

  GJ.Gemini = { Key, Model, ready, usesProxy, listModels, chooseBest, resolveModel, prepareAudio, deleteFile, generate, test, ApiError };
})();
