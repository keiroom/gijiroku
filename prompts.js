/* AI への指示文（利用者がプロンプトを書かなくて済むよう、ここで全て用意する） */
(function () {
  "use strict";
  const GJ = (window.GJ = window.GJ || {});

  const DEFAULT_TEMPLATE = `
<h1>議事録</h1>
<table>
<tr><th>会議名</th><td></td></tr>
<tr><th>日時</th><td>YYYY年M月D日（曜） HH:MM〜HH:MM</td></tr>
<tr><th>場所</th><td></td></tr>
<tr><th>出席者</th><td>（敬称略）</td></tr>
<tr><th>記録者</th><td></td></tr>
</table>
<h2>1. 議題</h2>
<ol><li>議題名</li></ol>
<h2>2. 議事内容</h2>
<h3>(1) 議題名</h3>
<ul><li>報告・説明・意見・質疑の要点</li></ul>
<h2>3. 決定事項</h2>
<ul><li>決まったこと</li></ul>
<h2>4. 課題・保留事項</h2>
<ul><li>結論が出なかったこと、継続検討となったこと</li></ul>
<h2>5. 今後の対応（ToDo）</h2>
<table>
<thead><tr><th>No.</th><th>対応内容</th><th>担当</th><th>期限</th></tr></thead>
<tbody><tr><td>1</td><td></td><td></td><td></td></tr></tbody>
</table>
<h2>6. 次回予定</h2>
<p>日時・議題など</p>
<p style="text-align: right">以上</p>`.trim();

  const DETAIL = {
    concise: "簡潔にまとめる。議事内容は議題ごとに要点を2〜4項目程度に絞り、結論・決定事項・ToDo を最優先で正確に残す。議論の経緯は省略してよい。",
    standard: "標準的な粒度でまとめる。議題ごとに、報告・説明の要点、主な意見や質疑とその回答、結論を残す。",
    detailed: "詳細にまとめる。議題ごとに、報告・説明の内容、出された意見・懸念・代替案、質疑応答、結論に至った経緯を、発言者が分かる形で残す。ただし雑談や重複は除く。"
  };

  const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  function formatDate(d) {
    if (!d) return "";
    const dt = new Date(d + "T00:00:00");
    if (isNaN(dt)) return d;
    return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日（${WEEK[dt.getDay()]}）`;
  }

  function speakerLines(speakers) {
    return speakers
      .map((s) => [s.name, s.org && `所属・役職：${s.org}`, s.role && `役割：${s.role}`].filter(Boolean).join("／"))
      .join("\n");
  }

  function meetingBlock(m, map) {
    const time = m.start || m.end ? `${m.start || "（不明）"}〜${m.end || "（不明）"}` : "";
    const rows = [
      ["会議名", m.title],
      ["日付", formatDate(m.date)],
      ["時間", time],
      ["場所・形式", m.place],
      ["記録者", m.author]
    ].filter(([, v]) => v);
    let s = rows.length ? rows.map(([k, v]) => `${k}：${v}`).join("\n") : "（入力なし）";
    s += "\n\n【参加者・話者】\n" + (m.speakers.length ? speakerLines(m.speakers) : "（入力なし）");
    if (m.glossary) s += "\n\n【社内用語・固有名詞（この表記を正とする）】\n" + m.glossary;
    s += speakerMapBlock(map);
    return s;
  }

  /* ---------- 1. 音声の文字起こし ---------- */
  function transcribe(m) {
    const names = `話者は氏名ではなく【話者A】【話者B】【話者C】…の記号で区別する（氏名の特定は後の工程で行うため、ここでは記号のみ使う）。
   - 声の高さ・話し方・口癖・話の内容の一貫性から、同じ人物には音声の最後まで必ず同じ記号を使う。
   - 同じ人物を別の記号に分けたり、別の人物を同じ記号にまとめたりしないよう、特に慎重に聞き分ける。
   - 記号は最初に話した順に A, B, C … と割り振る。${m.speakers.length ? `\n   - 参考：この会議の参加者は ${m.speakers.length} 名の予定（${m.speakers.map((x) => x.name).join("、")}）。人数の目安として使う。` : ""}`;
    return `あなたは日本の企業で会議の文字起こしを専門に担当している担当者です。添付の会議音声を、日本語で正確に文字起こししてください。

# 規則
1. 要約・省略・言い換えをしない。話された内容はすべて書き起こす。
2. 「えー」「あのー」などのつなぎ言葉、明らかな言い直し・言いよどみは除いてよい（意味は変えない）。
3. 話者が替わるたびに改行し、行頭に「[時:分:秒] 【話者名】」を付ける（時刻は音声の経過時間の目安）。
4. ${names}
5. 数字・金額・日付・期限・固有名詞は特に注意して聞き取る。自信がない語の直後には（？）を付ける。
6. 聞き取れない箇所は推測で埋めず［聞き取り不明］と書く。
7. 無音・雑音・会議と無関係な部分は［中断］などと短く記す。
8. 出力は文字起こし本文のみ。前置き・説明・まとめは書かない。
${m.glossary ? `\n# 用語の表記（音が近い場合はこの表記を使う）\n${m.glossary}\n` : ""}`;
  }

  /* ---------- 2. 話者の特定 ---------- */
  function identify(m, records) {
    const people = m.speakers.length ? speakerLines(m.speakers) : "（参加者の入力なし）";
    return [{
      text: `あなたは会議記録の発言者を特定する担当者です。次の「会議の記録」に出てくる話者ラベル（【話者A】、A:、Speaker 1、氏名など）が、それぞれ誰なのかを推定してください。

# 参加者（利用者が入力した名簿）
${people}

# 会議の記録
${records}

# 推定の方法（根拠になるもの）
- 呼びかけと応答：「佐藤さん、いかがですか」の直後に答えた話者は佐藤さんの可能性が高い。
- 自己紹介・名乗り：「営業部の佐藤です」など。
- 他者からの言及：「さきほど鈴木さんが言ったように」が指す発言の話者。
- 役割：会議を進行・指名・まとめをしている話者は司会・進行役の可能性。
- 所属・担当の話題：「営業部としては」「経理の立場から」など、名簿の所属・役職と一致する発言。
- 記録内のラベル自体が氏名の場合（Teams 等の文字起こし）は、名簿と照合する（表記ゆれは名簿の表記に合わせる）。

# 規則
- 声の印象や話し方だけで決めない。上記の根拠が記録の中に具体的にある場合のみ氏名を割り当てる。
- 名簿の 1 人を複数のラベルに割り当てない（同一人物が分割されていると強く判断できる場合のみ例外。その場合は根拠にその旨を書く）。
- 根拠が弱い場合は confidence を "low"、根拠がない場合は name を空文字、confidence を "none" にする。
- 名簿にない人物が会話から明確に分かる場合は、その名前を name に入れ、in_roster を false にする。
- evidence には根拠となった発言の内容を具体的に、短く書く（例：「[00:03:12] 話者B『佐藤さん、売上の報告を』の直後に話者A が報告」）。
- samples にはその話者の特徴的な発言を 2 つ、各 40 文字以内で記録から抜き出す。
- 記録に話者の区別がまったくない場合は speakers を空配列にする。`
    }];
  }

  const IDENTIFY_SCHEMA = {
    type: "OBJECT",
    properties: {
      speakers: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            label: { type: "STRING", description: "記録内の話者ラベル（例：話者A）" },
            name: { type: "STRING", description: "推定した氏名。不明なら空文字" },
            in_roster: { type: "BOOLEAN" },
            confidence: { type: "STRING", enum: ["high", "medium", "low", "none"] },
            evidence: { type: "STRING" },
            samples: { type: "ARRAY", items: { type: "STRING" } },
            turns: { type: "INTEGER", description: "おおよその発言回数" }
          },
          required: ["label", "name", "confidence", "evidence", "samples"]
        }
      }
    },
    required: ["speakers"]
  };

  function speakerMapBlock(map) {
    if (!map || !map.length) return "";
    const lines = map.map((x) => x.name
      ? `${x.label} → ${x.name}${x.org ? "（" + x.org + "）" : ""}`
      : `${x.label} → 特定できず（議事録では「${x.label.replace(/[【】]/g, "")}」と表記）`);
    return `\n\n【話者の対応表（利用者が確認済み。この対応を事実として使う）】\n${lines.join("\n")}`;
  }

  /* ---------- 3. 議事録の作成 ---------- */
  const SYSTEM = `あなたは日本の企業で長年、議事録の作成を担当してきた熟練の担当者です。提供された「会議の記録（音声の文字起こし・文字起こし・メモ）」だけを根拠に、指定されたテンプレートの書式どおりに議事録を作成します。

# 最も重要な原則（正確性）
- 記録に書かれていない事実・数字・日付・担当者・決定を作らない。推測で補わない。
- 数字・金額・日付・期限・固有名詞・製品名は記録どおりに書く。社内用語の一覧があればその表記を正とする。
- 「決定事項」には、会議中に合意・決定・承認されたと読み取れることだけを書く。提案・検討中・意見にとどまるものは決定事項に入れない。
- ToDo（今後の対応）は「誰が・何を・いつまでに」を記録から拾う。担当や期限が記録にない場合は推測せず「未定」と書く。
- 発言者：「話者の対応表」がある場合は、記録中のラベルを必ず対応表の氏名に置き換えて書く。対応表で「特定できず」とされた話者や対応表にない話者は、推測で氏名を当てず記号（話者A など）のまま書く。
- 報告・説明・意見・質問・回答など、誰の発言かが意味を持つ内容には発言者を明記する（例：「〜との報告があった（佐藤）」）。テンプレートに発言者の欄や書き方の決まりがあればそれに従う。
- 決定事項は誰が提案し誰が了承したかが記録から分かる場合、必要に応じて併記する。
- 判断に迷う箇所・記録が不十分な箇所・聞き取りが不確かな箇所は、本文の該当箇所に【要確認：理由】と書き、review_points にも挙げる。
- 記録どうしで内容が食い違う場合は、どちらかに決めつけず【要確認：記録により「A」と「B」で異なる】と書く。

# テンプレートの扱い
- テンプレートの見出し・項目名・項目の順序・表の列構成・番号の振り方・語尾（である調／です・ます調）・日付の書き方を忠実に再現する。項目を勝手に増やしたり削ったりしない。
- テンプレート中の記入例・注意書き（「〇〇を記入」「※」「例：」など）や仮の文字（YYYY、〇〇 など）は、実際の内容に置き換え、記入例の文言自体は残さない。
- テンプレートの項目に該当する内容が記録にない場合は「特になし」と書く（会議名・日時などの基本情報が分からない場合は【要確認】とする）。
- 会議情報として入力された値（会議名・日付・時間・場所・参加者・記録者）は、そのまま正しい情報として使う。

# 文章
- ビジネス文書として簡潔・明瞭に書く。口語・話し言葉は書き言葉に整える。テンプレートに指定がなければ「である調」と体言止めを用いる。
- 1 項目 1 内容を基本とし、箇条書きを活用する。
- 出席者は「氏名（所属・役職）」の形で並べ、敬称は付けない（テンプレートに指定があればそれに従う）。

# 出力（HTML）
- html には議事録本文を HTML の断片で出力する。使用できるタグは h1, h2, h3, p, br, ul, ol, li, table, thead, tbody, tr, th, td, strong, u のみ。
- 表は table で表し、結合セルは colspan / rowspan で表す。属性は colspan, rowspan と style="text-align: right|center" 以外は使わない。
- Markdown、コードブロック、html/body タグ、説明文は出力しない。`;

  const SCHEMA = {
    type: "OBJECT",
    properties: {
      html: { type: "STRING", description: "議事録本文（HTML 断片）" },
      review_points: {
        type: "ARRAY",
        description: "利用者に確認してほしい箇所",
        items: {
          type: "OBJECT",
          properties: {
            where: { type: "STRING", description: "議事録のどの項目・箇所か（短く）" },
            reason: { type: "STRING", description: "確認が必要な理由（記録の状況を具体的に）" }
          },
          required: ["where", "reason"]
        }
      }
    },
    required: ["html", "review_points"]
  };

  function templateParts(tpl) {
    if (!tpl) {
      return [{ text: `# テンプレート\n指定がないため、次の標準形式を使ってください。\n\n${DEFAULT_TEMPLATE}` }];
    }
    if (tpl.kind === "pdf") {
      return [
        { text: "# テンプレート\n次の PDF が、この会社の議事録テンプレートです。見出し・項目・表の構成と記載ルールを読み取り、その書式で作成してください。" },
        { inline_data: { mime_type: "application/pdf", data: tpl.base64 } }
      ];
    }
    return [{ text: `# テンプレート（${tpl.format}：ファイル名「${tpl.name}」）\nこの会社の議事録テンプレートです。この構成・書式で作成してください。\n\n<template>\n${tpl.content}\n</template>` }];
  }

  function sourcesText(src) {
    const out = [];
    if (src.audioTranscript) out.push(`<record type="音声の文字起こし（自動）">\n${src.audioTranscript}\n</record>`);
    if (src.transcript) out.push(`<record type="文字起こし（利用者が提供）">\n${src.transcript}\n</record>`);
    if (src.memo) out.push(`<record type="会議中のメモ（利用者が提供。走り書きのため、文字起こしと照らして補完すること。メモにしかない決定事項・数字も重要な情報として扱う）">\n${src.memo}\n</record>`);
    return out.join("\n\n");
  }

  function minutes({ meeting, template, sources, detail, speakerMap }) {
    return [
      ...templateParts(template),
      { text: `# 会議情報（利用者が入力した正しい情報）\n${meetingBlock(meeting, speakerMap)}` },
      { text: `# 会議の記録\n${sourcesText(sources)}` },
      {
        text: `# 作成の指示\n- まとめ方：${DETAIL[detail] || DETAIL.standard}\n- 上記の原則とテンプレートに従って議事録を作成し、指定の JSON 形式（html と review_points）で出力してください。\n- 作成前に、記録全体から「議題」「決定事項」「ToDo（担当・期限）」「数字・日付」「次回予定」をもれなく拾い出してから書き始めてください。`
      }
    ];
  }

  /* ---------- 3. 見直し（精度優先モード） ---------- */
  function verify({ meeting, template, sources, draftHtml, draftPoints, speakerMap }) {
    return [
      ...templateParts(template),
      { text: `# 会議情報（利用者が入力した正しい情報）\n${meetingBlock(meeting, speakerMap)}` },
      { text: `# 会議の記録\n${sourcesText(sources)}` },
      { text: `# 議事録の下書き\n<draft>\n${draftHtml}\n</draft>\n\n# 下書き時点の確認事項\n${JSON.stringify(draftPoints || [], null, 1)}` },
      {
        text: `# 指示：下書きの検証と修正
あなたは下書きを作った担当者とは別の、ダブルチェック担当者です。下書きを「会議の記録」と一文ずつ照らし合わせ、次を確認して修正済みの最終版を作成してください。

1. 根拠のない記述：記録に書かれていない事実・数字・日付・担当者・決定が含まれていないか。あれば削除するか【要確認】にする。
2. 誤り：数字・金額・日付・期限・固有名詞・発言者が記録と一致しているか。
3. 漏れ：記録にある決定事項・ToDo・数字・期限・次回予定・重要な意見が落ちていないか。あれば追加する。
4. 分類：単なる提案や意見が「決定事項」に入っていないか。発言者が話者の対応表どおりになっているか（対応表にない氏名を当てていないか）。決定されたことが「課題」側に入っていないか。
5. テンプレート：項目名・順序・表の列・語尾・日付形式がテンプレートどおりか。記入例の文言が残っていないか。
6. 確認事項：下書きの【要確認】のうち、記録を読めば解消できるものは解消する。新たに見つかった不確かな点は追加する。

問題がない部分は書き換えない。出力は、修正後の議事録全体（html）と、最終的に利用者が確認すべき点（review_points）を指定の JSON 形式で返すこと。`
      }
    ];
  }

  GJ.Prompts = { SYSTEM, SCHEMA, IDENTIFY_SCHEMA, identify, transcribe, minutes, verify, formatDate, DEFAULT_TEMPLATE };
})();
