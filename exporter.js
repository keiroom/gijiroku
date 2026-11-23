/* 出力（Word・テキスト・コピー・印刷） */
(function () {
  "use strict";
  const GJ = (window.GJ = window.GJ || {});

  const DOC_CSS = `
    body { font-family: "Yu Mincho", "游明朝", serif; font-size: 10.5pt; }
    h1 { font-family: "Yu Gothic", "游ゴシック", sans-serif; font-size: 16pt; text-align: center; }
    h2 { font-family: "Yu Gothic", "游ゴシック", sans-serif; font-size: 12pt; border-bottom: 1px solid #000; }
    h3 { font-family: "Yu Gothic", "游ゴシック", sans-serif; font-size: 10.5pt; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #000; padding: 3pt 5pt; vertical-align: top; }
    th { background: #f0f2f5; font-family: "Yu Gothic", "游ゴシック", sans-serif; font-weight: bold; }
    mark { background: #fff1b8; }
  `;

  function cleanForExport(html) {
    // 確認用ハイライトはそのまま残す（Word 上でも黄色で目立つ）
    return GJ.sanitizeHtml(html);
  }

  async function toDocx(html) {
    const docx = window.docx;
    const content = window.docxHtml.htmlToContent(cleanForExport(html), { stylesheet: DOC_CSS, maxImageWidth: 600 });
    const font = { ascii: "Yu Mincho", eastAsia: "Yu Mincho", hAnsi: "Yu Mincho" };
    const gothic = { ascii: "Yu Gothic", eastAsia: "Yu Gothic", hAnsi: "Yu Gothic" };
    const doc = new docx.Document({
      creator: "",
      title: "議事録",
      styles: {
        default: {
          document: { run: { font, size: 21 }, paragraph: { spacing: { after: 60, line: 300 } } },
          heading1: { run: { font: gothic, size: 32, bold: true, color: "000000" }, paragraph: { alignment: docx.AlignmentType.CENTER, spacing: { after: 240 } } },
          heading2: { run: { font: gothic, size: 24, bold: true, color: "000000" }, paragraph: { spacing: { before: 240, after: 80 } } },
          heading3: { run: { font: gothic, size: 21, bold: true, color: "000000" }, paragraph: { spacing: { before: 160, after: 60 } } }
        }
      },
      sections: [{
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        children: content
      }]
    });
    return docx.Packer.toBlob(doc);
  }

  function inlineStyled(html) {
    // 貼り付け先（Word・Outlook 等）で罫線が消えないよう、style を直接付与
    const d = new DOMParser().parseFromString(`<div>${cleanForExport(html)}</div>`, "text/html");
    d.querySelectorAll("table").forEach((t) => t.setAttribute("style", "border-collapse:collapse;width:100%;"));
    d.querySelectorAll("th,td").forEach((c) => {
      const align = c.style.textAlign ? `text-align:${c.style.textAlign};` : "";
      c.setAttribute("style", `border:1px solid #000;padding:3pt 6pt;vertical-align:top;${align}${c.tagName === "TH" ? "background:#f0f2f5;font-weight:bold;" : ""}`);
    });
    d.querySelectorAll("h1").forEach((h) => h.setAttribute("style", "text-align:center;font-size:16pt;"));
    d.querySelectorAll("h2").forEach((h) => h.setAttribute("style", "font-size:12pt;border-bottom:1px solid #000;"));
    d.querySelectorAll("mark").forEach((m) => m.setAttribute("style", "background:#fff1b8;"));
    return d.body.firstChild.innerHTML;
  }

  async function copy(html) {
    const text = GJ.htmlToText(html);
    const rich = `<html><body>${inlineStyled(html)}</body></html>`;
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([rich], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })
      ]);
      return;
    }
    // 予備手段
    const holder = document.createElement("div");
    holder.contentEditable = "true";
    holder.style.cssText = "position:fixed;left:-9999px;top:0;";
    holder.innerHTML = rich;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("copy");
    sel.removeAllRanges();
    holder.remove();
  }

  GJ.Exporter = {
    async docx(html, name) { GJ.download(await toDocx(html), `${name}.docx`); },
    txt(html, name) {
      const text = GJ.htmlToText(html).replace(/\n/g, "\r\n");
      GJ.download(new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" }), `${name}.txt`);
    },
    pdf() { window.print(); },
    copy,
    toDocx
  };
})();
