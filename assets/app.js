/* Hynix Brief News — 클라이언트 로직
 * - Gemini API(google_search 그라운딩)로 최근 48시간 뉴스 수집·분석·고정 템플릿 생성
 * - API 키 우선순위: window.HYNIX_CONFIG.GEMINI_API_KEY (config.js / Actions 주입) → 입력창(localStorage)
 * - 키 없을 때는 키 입력창을 노출(localStorage 저장)
 */
(function () {
  "use strict";

  var MODEL = (window.HYNIX_CONFIG && window.HYNIX_CONFIG.GEMINI_MODEL) || "gemini-2.5-flash";
  var ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
  var LS_KEY = "hynix_gemini_key";

  var el = {};
  function $(id) { return document.getElementById(id); }

  document.addEventListener("DOMContentLoaded", function () {
    el.generate = $("btn-generate");
    el.copy = $("btn-copy");
    el.download = $("btn-download");
    el.keyRow = $("key-row");
    el.keyInput = $("key-input");
    el.keySave = $("btn-key-save");
    el.status = $("status");
    el.report = $("report");
    el.sources = $("sources");
    el.meta = $("run-meta");

    el.generate.addEventListener("click", onGenerate);
    el.copy.addEventListener("click", copyReport);
    el.download.addEventListener("click", downloadReport);
    if (el.keySave) el.keySave.addEventListener("click", saveKey);

    initKeyUI();
  });

  // ---- API 키 처리 ----
  function configKey() {
    return (window.HYNIX_CONFIG && window.HYNIX_CONFIG.GEMINI_API_KEY &&
      String(window.HYNIX_CONFIG.GEMINI_API_KEY).indexOf("REPLACE") === -1)
      ? window.HYNIX_CONFIG.GEMINI_API_KEY : "";
  }
  function activeKey() {
    return configKey() || localStorage.getItem(LS_KEY) || "";
  }
  function initKeyUI() {
    if (configKey()) {
      // 배포 환경에 키가 주입됨 → 입력창 숨김, 채점자는 바로 실행
      if (el.keyRow) el.keyRow.style.display = "none";
      setStatus("준비 완료. ‘브리핑 생성’을 누르면 최근 48시간 뉴스를 수집합니다.", "");
    } else {
      if (el.keyRow) el.keyRow.style.display = "";
      var saved = localStorage.getItem(LS_KEY);
      if (saved && el.keyInput) el.keyInput.value = saved;
      setStatus("API 키가 설정되지 않았습니다. 키를 입력한 뒤 ‘브리핑 생성’을 누르세요.", "warn");
    }
  }
  function saveKey() {
    var v = (el.keyInput.value || "").trim();
    if (!v) { setStatus("키를 입력하세요.", "warn"); return; }
    localStorage.setItem(LS_KEY, v);
    setStatus("키가 이 브라우저에 저장되었습니다.", "ok");
  }

  // ---- 생성 ----
  function onGenerate() {
    var key = activeKey();
    if (!key) {
      setStatus("API 키가 없습니다. 키를 입력한 뒤 다시 시도하세요.", "warn");
      return;
    }
    setBusy(true);
    setStatus("최근 48시간 뉴스를 수집·분석 중입니다… (10~40초 소요)", "");
    el.report.innerHTML = "";
    el.sources.innerHTML = "";

    callGemini(key)
      .then(function (res) {
        renderMarkdown(res.text);
        renderSources(res.sources);
        var now = new Date();
        el.meta.textContent = "생성: " + fmt(now) + " · 모델: " + MODEL;
        setStatus("브리핑 생성 완료.", "ok");
        showActions(true);
      })
      .catch(function (err) {
        console.error(err);
        setStatus("오류: " + (err && err.message ? err.message : err), "warn");
      })
      .finally(function () { setBusy(false); });
  }

  // ---- Gemini 호출 ----
  function callGemini(key) {
    var now = new Date();
    var userPrompt =
      "현재 시각은 " + fmt(now) + " (Asia/Seoul) 이다.\n" +
      "이 시각 기준 최근 48시간 이내에 게시된 뉴스만 Google 검색으로 수집하여, " +
      "'Hynix Brief News' 일일 반도체 뉴스 브리핑을 시스템 지침의 고정 출력 템플릿 그대로 한국어로 생성하라.\n" +
      "보고서 마크다운 본문만 출력하고, 코드펜스나 부가 설명은 붙이지 마라.";

    var body = {
      systemInstruction: { parts: [{ text: window.HYNIX_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 16384 }
    };

    var url = ENDPOINT + encodeURIComponent(MODEL) + ":generateContent?key=" + encodeURIComponent(key);

    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) {
          var msg = (data && data.error && data.error.message) || ("HTTP " + r.status);
          throw new Error(msg);
        }
        return data;
      });
    }).then(function (data) {
      var cand = data && data.candidates && data.candidates[0];
      if (!cand) throw new Error("응답에 후보가 없습니다. (안전 필터 또는 빈 결과)");
      var parts = (cand.content && cand.content.parts) || [];
      var text = parts.map(function (p) { return p.text || ""; }).join("").trim();
      text = stripFence(text);
      if (!text) throw new Error("빈 응답입니다. 잠시 후 다시 시도하세요.");
      return { text: text, sources: extractSources(cand) };
    });
  }

  function extractSources(cand) {
    var out = [];
    var gm = cand && cand.groundingMetadata;
    if (gm && gm.groundingChunks) {
      gm.groundingChunks.forEach(function (c) {
        if (c.web && c.web.uri) out.push({ title: c.web.title || c.web.uri, uri: c.web.uri });
      });
    }
    return out;
  }

  // ---- 렌더 ----
  function renderMarkdown(md) {
    window.__lastMarkdown = md;
    var html = window.marked ? window.marked.parse(md) : escapeHtml(md);
    if (window.DOMPurify) html = window.DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
    el.report.innerHTML = html;
    el.report.querySelectorAll("a").forEach(function (a) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
  }
  function renderSources(sources) {
    if (!sources || !sources.length) { el.sources.innerHTML = ""; return; }
    var h = '<h3 class="sources-title">검색 출처 (그라운딩)</h3><ul class="sources-list">';
    sources.forEach(function (s) {
      h += '<li><a href="' + escapeAttr(s.uri) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(s.title) + "</a></li>";
    });
    h += "</ul>";
    el.sources.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(h, { ADD_ATTR: ["target", "rel"] }) : h;
  }

  // ---- 액션 ----
  function copyReport() {
    var md = window.__lastMarkdown || "";
    if (!md) return;
    navigator.clipboard.writeText(md).then(function () {
      setStatus("마크다운을 클립보드에 복사했습니다.", "ok");
    }, function () { setStatus("복사 실패. 브라우저 권한을 확인하세요.", "warn"); });
  }
  function downloadReport() {
    var md = window.__lastMarkdown || "";
    if (!md) return;
    var name = "hynix-brief-news_" + fmt(new Date()).replace(/[: ]/g, "-") + ".md";
    var blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // ---- 유틸 ----
  function setBusy(b) {
    el.generate.disabled = b;
    el.generate.textContent = b ? "생성 중…" : "브리핑 생성";
  }
  function showActions(on) {
    el.copy.style.display = on ? "" : "none";
    el.download.style.display = on ? "" : "none";
  }
  function setStatus(msg, kind) {
    el.status.textContent = msg;
    el.status.className = "status" + (kind ? " " + kind : "");
  }
  function stripFence(t) {
    return t.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
