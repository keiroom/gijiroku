/*
 * 管理者向け設定ファイル
 * ------------------------------------------------------------
 * このファイルだけを書き換えれば、社内向けの調整ができます。
 * ※ GitHub で公開されるファイルです。API キーは絶対に書かないでください。
 */
window.GIJIROKU_CONFIG = {
  // 画面左上に表示するツール名
  APP_NAME: "議事録作成ツール",

  // 中継サーバー（proxy/cloudflare-worker.js）の URL。
  // 設定すると、利用者は接続キーを登録せずに使えます（キーは中継サーバー側で管理）。
  // 例: "https://gijiroku-proxy.example.workers.dev"
  // ※ workers.dev 以外のドメインを使う場合は index.html の connect-src にも追記してください。
  PROXY_URL: "",

  // 使用するモデルを固定する場合に指定（例: "gemini-3.7-flash"）。
  // 空欄の場合は、利用可能なモデルから自動で選びます。
  MODEL: "",

  // 自動選択の優先順位: "pro"（精度重視）または "flash"（速度・コスト重視）
  MODEL_PREFERENCE: "pro",

  // あらかじめ登録しておくテンプレート（templates/ フォルダに置いたファイル）。
  // 利用者はプルダウンから選ぶだけで使えます。
  // 例: [{ name: "本社定例会議", file: "templates/teirei.docx" }]
  PRESET_TEMPLATES: []
};
