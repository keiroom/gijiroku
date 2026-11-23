/**
 * 中継サーバー（任意）— Cloudflare Workers 用
 * ------------------------------------------------------------
 * 目的：利用者一人ひとりに API キーを配らずに済むよう、キーをこのサーバー側だけで保持する。
 * 内容を保存・記録する処理は一切ありません（受け取ったリクエストを Google へ中継するだけ）。
 *
 * 設定（Cloudflare の管理画面 → Workers → 設定 → 変数）
 *   GEMINI_API_KEY   : Gemini API キー（「シークレット」として登録）
 *   ALLOWED_ORIGIN   : アプリの公開 URL のオリジン（例：https://example.github.io）
 *
 * アプリ側：config.js の PROXY_URL にこの Worker の URL を設定する。
 */
const GOOGLE = "https://generativelanguage.googleapis.com";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);

    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : "null",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Goog-Upload-Protocol, X-Goog-Upload-Command, X-Goog-Upload-Header-Content-Length, X-Goog-Upload-Header-Content-Type, X-Goog-Upload-Offset",
      "Access-Control-Expose-Headers": "x-goog-upload-url, x-goog-upload-status",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    if (!okOrigin) return new Response("Forbidden", { status: 403, headers: cors });

    const url = new URL(request.url);
    if (!/^\/(upload\/)?v1beta\//.test(url.pathname)) return new Response("Not Found", { status: 404, headers: cors });

    const target = new URL(GOOGLE + url.pathname + url.search);
    target.searchParams.delete("key");

    const headers = new Headers();
    for (const [k, v] of request.headers) {
      if (/^(content-type|x-goog-upload-)/i.test(k)) headers.set(k, v);
    }
    headers.set("x-goog-api-key", env.GEMINI_API_KEY);

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body
    });

    const out = new Headers(cors);
    const ct = upstream.headers.get("content-type");
    if (ct) out.set("content-type", ct);
    const status = upstream.headers.get("x-goog-upload-status");
    if (status) out.set("x-goog-upload-status", status);
    const uploadUrl = upstream.headers.get("x-goog-upload-url");
    if (uploadUrl) {
      // 続きのアップロードもこの中継サーバーを通す
      const u = new URL(uploadUrl);
      out.set("x-goog-upload-url", url.origin + u.pathname + u.search);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
};
