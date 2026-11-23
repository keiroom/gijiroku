/* ファイル読み込み（すべてブラウザ内で処理し、どこにも送信・保存しない） */
(function () {
  "use strict";
  const GJ = (window.GJ = window.GJ || {});

  const ext = (name) => (String(name).match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  GJ.fileExt = ext;

  /* 文字コード自動判定（UTF-8 → Shift_JIS） */
  async function readTextAuto(file) {
    const buf = await file.arrayBuffer();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
    } catch (_) {
      try {
        return new TextDecoder("shift_jis").decode(buf);
      } catch (e) {
        return new TextDecoder("utf-8").decode(buf);
      }
    }
  }

  /* Teams / Zoom などの字幕形式（VTT・SRT）を「話者：発言」形式へ */
  function cleanSubtitle(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    const out = [];
    let lastSpeaker = null;
    let buf = [];
    const flush = () => {
      if (buf.length) out.push((lastSpeaker ? `${lastSpeaker}：` : "") + buf.join(""));
      buf = [];
    };
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || /^WEBVTT/.test(line) || /^NOTE\b/.test(line) || /^\d+$/.test(line) || /-->/.test(line)) continue;
      let speaker = null, body = line;
      const v = line.match(/^<v\s+([^>]+)>(.*?)(<\/v>)?$/);
      if (v) { speaker = v[1].trim(); body = v[2]; }
      else {
        const m = line.match(/^([^:：]{1,30})[:：]\s*(.+)$/);
        if (m) { speaker = m[1].trim(); body = m[2]; }
      }
      body = body.replace(/<[^>]+>/g, "").trim();
      if (!body) continue;
      if (speaker !== null && speaker !== lastSpeaker) { flush(); lastSpeaker = speaker; }
      buf.push(body + (/[。！？!?]$/.test(body) ? "" : " "));
    }
    flush();
    return out.join("\n");
  }

  /* 文字起こし・メモ用：テキストとして読み込む */
  GJ.readTextSource = async function (file) {
    const e = ext(file.name);
    if (e === "docx") {
      const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return r.value.replace(/\n{3,}/g, "\n\n").trim();
    }
    const text = await readTextAuto(file);
    if (e === "vtt" || e === "srt") return cleanSubtitle(text);
    return text.trim();
  };

  /* テンプレートの読み込み */
  GJ.readTemplate = async function (file) {
    const e = ext(file.name);
    const base = { name: file.name, size: file.size, ext: e };

    if (e === "docx") {
      const ab = await file.arrayBuffer();
      const r = await window.mammoth.convertToHtml(
        { arrayBuffer: ab },
        { includeDefaultStyleMap: true, ignoreEmptyParagraphs: false, convertImage: window.mammoth.images.imgElement(() => Promise.resolve({ src: "" })) }
      );
      const html = r.value.replace(/<img[^>]*>/g, "").replace(/<a [^>]*>|<\/a>/g, "");
      return { ...base, label: "Word", kind: "text", content: html, previewHtml: GJ.sanitizeHtml(html), format: "HTML（Word から変換）" };
    }

    if (e === "xlsx" || e === "xls") {
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
      const parts = [], previews = [];
      wb.SheetNames.forEach((sn) => {
        const ws = wb.Sheets[sn];
        if (!ws || !ws["!ref"]) return;
        let html = window.XLSX.utils.sheet_to_html(ws, { header: "", footer: "" });
        html = html.replace(/ (id|data-[a-z]+|t|v)="[^"]*"/g, "").replace(/<td><\/td>/g, "<td></td>");
        parts.push(`<h2>シート：${GJ.escapeHtml(sn)}</h2>\n${html}`);
        previews.push(`<h3>${GJ.escapeHtml(sn)}</h3>${GJ.sanitizeHtml(html)}`);
      });
      return { ...base, label: "Excel", kind: "text", content: parts.join("\n"), previewHtml: previews.join(""), format: "HTML 表（Excel から変換）" };
    }

    if (e === "pdf") {
      const b64 = await GJ.blobToBase64(file);
      return {
        ...base, label: "PDF", kind: "pdf", mime: "application/pdf", base64: b64,
        previewHtml: `<p>PDF のテンプレートは、作成時に書式を読み取ります（この画面ではプレビューできません）。</p>`,
        format: "PDF"
      };
    }

    // txt / md / csv
    const text = await readTextAuto(file);
    return { ...base, label: "TEXT", kind: "text", content: text, previewHtml: `<pre>${GJ.escapeHtml(text)}</pre>`, format: "テキスト" };
  };

  /* 音声ファイルの MIME を補完 */
  GJ.audioMime = function (file) {
    if (file.type) return file.type.replace(/;.*$/, "");
    const map = { mp3: "audio/mp3", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", webm: "audio/webm", mp4: "video/mp4", aiff: "audio/aiff" };
    return map[ext(file.name)] || "audio/mpeg";
  };
})();
