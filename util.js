/* 共通ユーティリティ */
(function () {
  "use strict";
  const GJ = (window.GJ = window.GJ || {});

  GJ.$ = (sel, root) => (root || document).querySelector(sel);
  GJ.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  GJ.escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  GJ.formatBytes = (n) => {
    if (!n && n !== 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  };

  GJ.formatDuration = (sec) => {
    if (!isFinite(sec)) return "";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}時間${m}分` : m ? `${m}分${s}秒` : `${s}秒`;
  };

  GJ.blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });

  let toastTimer;
  GJ.toast = (msg) => {
    const el = GJ.$("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  };

  /* ---- 生成された HTML の無害化（許可したタグ・属性のみ残す） ---- */
  const ALLOWED = new Set([
    "H1", "H2", "H3", "H4", "P", "BR", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD",
    "STRONG", "B", "EM", "I", "U", "MARK", "SPAN", "DIV", "HR", "CAPTION", "COLGROUP", "COL", "SUB", "SUP"
  ]);
  const ALLOWED_ATTR = new Set(["colspan", "rowspan", "class", "style"]);
  const SAFE_STYLE = /^(\s*(text-align|width|vertical-align|font-weight|text-decoration)\s*:\s*[-a-z0-9.%# ]+;?)*\s*$/i;

  GJ.sanitizeHtml = (html) => {
    const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, "text/html");
    const root = doc.getElementById("__root");
    const walk = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 1) {
          if (!ALLOWED.has(child.tagName)) {
            // 中身は残してタグだけ外す（script/style は丸ごと削除）
            if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|TEMPLATE)$/.test(child.tagName)) {
              child.remove();
              return;
            }
            const frag = doc.createDocumentFragment();
            while (child.firstChild) frag.appendChild(child.firstChild);
            child.replaceWith(frag);
            walk(node);
            return;
          }
          Array.from(child.attributes).forEach((a) => {
            const name = a.name.toLowerCase();
            if (!ALLOWED_ATTR.has(name)) child.removeAttribute(a.name);
            else if (name === "style" && !SAFE_STYLE.test(a.value)) child.removeAttribute(a.name);
            else if (name === "class" && a.value !== "needs-check") child.removeAttribute(a.name);
          });
          walk(child);
        } else if (child.nodeType !== 3) {
          child.remove();
        }
      });
    };
    walk(root);
    return root.innerHTML;
  };

  /* 【要確認】をハイライト */
  GJ.highlightChecks = (html) =>
    html.replace(/(?<!<mark class="needs-check">)【要確認[^】]*】/g, (m) => `<mark class="needs-check">${m}</mark>`);

  /* HTML → 読みやすいテキスト */
  GJ.htmlToText = (html) => {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const out = [];
    const block = (el, depth) => {
      el.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
          const t = n.textContent.replace(/\s+/g, " ");
          if (t.trim()) out.push(t);
          return;
        }
        if (n.nodeType !== 1) return;
        const tag = n.tagName;
        if (tag === "BR") return out.push("\n");
        if (/^H[1-4]$/.test(tag)) {
          const t = n.textContent.trim();
          out.push(tag === "H1" ? `\n${t}\n${"=".repeat(Math.min(40, t.length * 2))}\n` : tag === "H2" ? `\n■ ${t}\n` : `\n□ ${t}\n`);
          return;
        }
        if (tag === "UL" || tag === "OL") {
          let i = 1;
          n.querySelectorAll(":scope > li").forEach((li) => {
            out.push(`${"  ".repeat(depth)}${tag === "OL" ? i++ + "." : "・"} `);
            block(li, depth + 1);
            out.push("\n");
          });
          return;
        }
        if (tag === "TABLE") {
          n.querySelectorAll("tr").forEach((tr) => {
            const cells = Array.from(tr.children).map((c) => c.innerText !== undefined ? c.textContent.trim().replace(/\s+/g, " ") : "");
            out.push(cells.join(" ｜ ") + "\n");
          });
          out.push("\n");
          return;
        }
        if (tag === "P" || tag === "DIV" || tag === "LI") {
          block(n, depth);
          out.push("\n");
          return;
        }
        if (tag === "HR") return out.push("\n――――――――――\n");
        block(n, depth);
      });
    };
    block(doc.body.firstChild, 0);
    return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  };

  GJ.download = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  GJ.safeFileName = (s) => String(s || "").replace(/[\\/:*?"<>|\r\n]+/g, "_").trim().slice(0, 80);

  GJ.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
})();
