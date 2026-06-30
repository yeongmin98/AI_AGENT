/* Hynix Brief News — 클라이언트 에이전트 로직
 * Phase 2: 다단계 에이전트 루프(계획→검색×3→검증·종합) + 진행 가시화
 * Phase 1: 브리핑 기반 대화형 후속 질문 (멀티턴 + 검색 보강)
 * Phase 4: 빠른 액션(심층분석/경쟁사비교/학습플랜) → 대화 채널로 연결
 *
 * API 키 우선순위: window.HYNIX_CONFIG.GEMINI_API_KEY (config.js / Actions 주입) → 입력창(localStorage)
 */
(function () {
  "use strict";

  var MODEL = (window.HYNIX_CONFIG && window.HYNIX_CONFIG.GEMINI_MODEL) || "gemini-2.5-flash";
  var ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
  var LS_KEY = "hynix_gemini_key";

  // 상태
  var lastBriefing = "";      // 최종 브리핑 마크다운
  var collectedNotes = "";    // 검색 단계에서 수집한 노트 (대화 컨텍스트)
  var chatHistory = [];       // [{role:'user'|'model', text}]
  var chatBusy = false;

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
    el.steps = $("agent-steps");
    el.report = $("report");
    el.sources = $("sources");
    el.meta = $("run-meta");
    el.followup = $("followup");
    el.quick = $("quick-actions");
    el.chatLog = $("chat-log");
    el.chatInput = $("chat-input");
    el.chatSend = $("btn-chat-send");

    el.generate.addEventListener("click", runAgent);
    el.copy.addEventListener("click", copyReport);
    el.download.addEventListener("click", downloadReport);
    if (el.keySave) el.keySave.addEventListener("click", saveKey);

    el.chatSend.addEventListener("click", function () { sendChat(el.chatInput.value); });
    el.chatInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); sendChat(el.chatInput.value); }
    });
    el.quick.addEventListener("click", function (e) {
      var b = e.target.closest("button.chip");
      if (b) sendChat(b.getAttribute("data-prompt"));
    });

    initKeyUI();
  });

  /* ============ API 키 ============ */
  function configKey() {
    return (window.HYNIX_CONFIG && window.HYNIX_CONFIG.GEMINI_API_KEY &&
      String(window.HYNIX_CONFIG.GEMINI_API_KEY).indexOf("REPLACE") === -1)
      ? window.HYNIX_CONFIG.GEMINI_API_KEY : "";
  }
  function activeKey() { return configKey() || localStorage.getItem(LS_KEY) || ""; }
  function initKeyUI() {
    if (configKey()) {
      if (el.keyRow) el.keyRow.style.display = "none";
      setStatus("준비 완료. ‘브리핑 생성’을 누르면 에이전트가 단계별로 뉴스를 수집·분석합니다.", "");
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

  /* ============ Phase 2: 에이전트 루프 ============ */
  var STEPS = [
    { id: "plan", label: "① 수집 계획 수립" },
    { id: "s1", label: "② SK하이닉스·주가 뉴스 검색" },
    { id: "s2", label: "③ 경쟁사(삼성·마이크론·엔비디아 등) 검색" },
    { id: "s3", label: "④ 반도체 산업 트렌드 검색" },
    { id: "verify", label: "⑤ 검증·중복 제거·종합" }
  ];
  var SEARCH_TASKS = {
    s1: "SK하이닉스 관련 최근 48시간 뉴스와 주가·시장 반응을 Google 검색으로 수집하라. " +
        "키워드: SK하이닉스 HBM/HBM4/DRAM/NAND/CXL/수율/공정/패키징/투자/공급망/고객사/주가/증권사 리포트.",
    s2: "반도체 경쟁사의 최근 48시간 뉴스를 Google 검색으로 수집하라. " +
        "대상: 삼성전자(반도체/HBM/파운드리/패키징), 마이크론(Micron HBM/DRAM/NAND/earnings), TSMC/인텔/엔비디아/AMD/ASML.",
    s3: "반도체 산업 트렌드의 최근 48시간 뉴스를 Google 검색으로 수집하라. " +
        "주제: HBM 수요·공급, DRAM/NAND 가격, AI 서버·데이터센터 투자, CXL, 첨단 패키징, 장비 공급망, 미국·중국 반도체 규제."
  };
  function searchInstruction(task) {
    return "당신은 반도체 뉴스 리서처다. " + task + "\n" +
      "규칙: 현재 시각 기준 최근 48시간 이내 게시 뉴스만. 출처 불명확·중복·관련성 낮은 기사 제외. " +
      "각 항목을 다음 형식의 불릿으로 정리하라: '- [제목] / 출처 / 게시일(YYYY-MM-DD HH:MM) / URL / 핵심 1~2문장 / 엔지니어 관점 한 줄'. " +
      "한국어로, 노트만 출력(서론·결론 없이).";
  }

  function runAgent() {
    var key = activeKey();
    if (!key) { setStatus("API 키가 없습니다. 키를 입력한 뒤 다시 시도하세요.", "warn"); return; }

    setBusy(true);
    resetOutput();
    renderSteps();
    var now = new Date();
    var nowStr = fmt(now);

    // ① 계획 (스펙상 고정된 수집 계획을 즉시 제시 — 에이전트의 작업 설계 공개)
    setStep("plan", "active");
    setStatus("에이전트가 수집 계획을 수립하고 다단계 리서치를 시작합니다…", "");
    setStep("plan", "done");

    // ②③④ 병렬 검색
    ["s1", "s2", "s3"].forEach(function (id) { setStep(id, "active"); });
    var allSources = [];
    var notes = { s1: "", s2: "", s3: "" };

    var jobs = ["s1", "s2", "s3"].map(function (id) {
      var userText = "현재 시각은 " + nowStr + " (Asia/Seoul) 이다.\n" + SEARCH_TASKS[id];
      return geminiCall({
        system: searchInstruction(SEARCH_TASKS[id]),
        contents: [{ role: "user", parts: [{ text: userText }] }],
        useSearch: true, maxTokens: 4096
      }).then(function (res) {
        notes[id] = res.text || "(수집 결과 없음)";
        allSources = allSources.concat(res.sources || []);
        setStep(id, "done");
      }).catch(function (err) {
        notes[id] = "(검색 실패: " + (err && err.message ? err.message : err) + ")";
        setStep(id, "fail");
      });
    });

    Promise.all(jobs).then(function () {
      // ⑤ 검증·종합
      setStep("verify", "active");
      setStatus("수집한 뉴스를 검증·중복 제거하고 고정 형식 브리핑으로 종합 중…", "");
      collectedNotes =
        "## SK하이닉스·주가\n" + notes.s1 + "\n\n## 경쟁사\n" + notes.s2 + "\n\n## 산업 트렌드\n" + notes.s3;

      var synthUser =
        "현재 시각은 " + nowStr + " (Asia/Seoul) 이다.\n" +
        "아래는 에이전트가 단계별로 수집·정리한 최근 48시간 반도체 뉴스 노트다. " +
        "이 노트를 근거로 'Hynix Brief News' 일일 브리핑을 시스템 지침의 고정 출력 템플릿 그대로 한국어로 작성하라. " +
        "노트에 없는 사실을 지어내지 말고, 게시일/출처/URL은 노트의 값을 사용하라. " +
        "부족한 섹션은 '최근 48시간 이내 확인된 관련 뉴스 없음'으로 채워라. 보고서 마크다운 본문만 출력하라.\n\n" +
        "[수집 노트]\n" + collectedNotes;

      return geminiCall({
        system: window.HYNIX_SYSTEM_PROMPT,
        contents: [{ role: "user", parts: [{ text: synthUser }] }],
        useSearch: false, maxTokens: 16384
      });
    }).then(function (res) {
      lastBriefing = stripFence(res.text);
      renderMarkdown(el.report, lastBriefing);
      renderSources(dedupeSources(allSources));
      setStep("verify", "done");
      el.meta.textContent = "생성: " + nowStr + " · 모델: " + MODEL + " · 5단계 에이전트 파이프라인";
      setStatus("브리핑 생성 완료. 아래에서 이어서 질문하거나 더 파고들 수 있습니다.", "ok");
      showActions(true);
      startFollowup();
    }).catch(function (err) {
      console.error(err);
      setStatus("오류: " + (err && err.message ? err.message : err), "warn");
    }).finally(function () { setBusy(false); });
  }

  /* ============ Phase 1: 대화형 후속 질문 ============ */
  function startFollowup() {
    chatHistory = [];
    el.chatLog.innerHTML = "";
    el.followup.style.display = "";
  }
  function chatSystem() {
    return "당신은 'Hynix Brief News' 후속 질의 어시스턴트다. SK하이닉스 엔지니어의 질문에 한국어로, " +
      "공정·수율·품질·제품·패키징·공급망 관점을 살려 간결하고 근거 있게 답한다. " +
      "필요하면 Google 검색으로 최신 정보를 보강하고 출처(URL)를 표기한다. " +
      "추측은 추측이라고 밝히고, 모르면 모른다고 한다. 표가 적합하면 마크다운 표를 쓴다.\n\n" +
      "[오늘 브리핑 본문]\n" + lastBriefing + "\n\n" +
      "[브리핑 근거가 된 수집 노트]\n" + collectedNotes;
  }
  function sendChat(text) {
    text = (text || "").trim();
    if (!text || chatBusy) return;
    if (!activeKey()) { setStatus("API 키가 없어 대화할 수 없습니다.", "warn"); return; }

    el.chatInput.value = "";
    chatHistory.push({ role: "user", text: text });
    appendBubble("user", text);
    var thinking = appendBubble("model", "…", true);
    chatBusy = true; el.chatSend.disabled = true;

    var contents = chatHistory.map(function (m) {
      return { role: m.role, parts: [{ text: m.text }] };
    });

    geminiCall({ system: chatSystem(), contents: contents, useSearch: true, maxTokens: 4096 })
      .then(function (res) {
        var answer = stripFence(res.text) || "(빈 응답)";
        chatHistory.push({ role: "model", text: answer });
        replaceBubble(thinking, answer, res.sources);
      })
      .catch(function (err) {
        replaceBubble(thinking, "⚠️ 오류: " + (err && err.message ? err.message : err), []);
        // 실패한 user 턴은 history에서 되돌려 다음 호출 일관성 유지
        chatHistory.pop();
      })
      .finally(function () {
        chatBusy = false; el.chatSend.disabled = false;
        el.chatInput.focus();
      });
  }
  function appendBubble(role, text, isThinking) {
    var wrap = document.createElement("div");
    wrap.className = "bubble " + role + (isThinking ? " thinking" : "");
    var body = document.createElement("div");
    body.className = "bubble-body";
    if (role === "model" && !isThinking) renderMarkdown(body, text);
    else body.textContent = text;
    wrap.appendChild(body);
    el.chatLog.appendChild(wrap);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    return wrap;
  }
  function replaceBubble(wrap, text, sources) {
    wrap.classList.remove("thinking");
    var body = wrap.querySelector(".bubble-body");
    body.innerHTML = "";
    renderMarkdown(body, text);
    if (sources && sources.length) {
      var s = dedupeSources(sources).slice(0, 6);
      var ul = document.createElement("ul");
      ul.className = "bubble-sources";
      s.forEach(function (src) {
        var li = document.createElement("li");
        var a = document.createElement("a");
        a.href = src.uri; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = src.title || src.uri;
        li.appendChild(a); ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  /* ============ Gemini 호출 (공통) ============ */
  function geminiCall(opts) {
    var key = activeKey();
    var body = { contents: opts.contents };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    if (opts.useSearch) body.tools = [{ google_search: {} }];
    body.generationConfig = { temperature: 0.3, maxOutputTokens: opts.maxTokens || 8192 };

    var url = ENDPOINT + encodeURIComponent(MODEL) + ":generateContent?key=" + encodeURIComponent(key);
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error && data.error.message) || ("HTTP " + r.status));
        return data;
      });
    }).then(function (data) {
      var cand = data && data.candidates && data.candidates[0];
      if (!cand) throw new Error("응답에 후보가 없습니다. (안전 필터 또는 빈 결과)");
      var parts = (cand.content && cand.content.parts) || [];
      var text = parts.map(function (p) { return p.text || ""; }).join("").trim();
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
  function dedupeSources(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (s) {
      if (s && s.uri && !seen[s.uri]) { seen[s.uri] = 1; out.push(s); }
    });
    return out;
  }

  /* ============ 렌더 ============ */
  function renderMarkdown(target, md) {
    var html = window.marked ? window.marked.parse(md) : escapeHtml(md);
    if (window.DOMPurify) html = window.DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
    target.innerHTML = html;
    target.querySelectorAll("a").forEach(function (a) {
      a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer");
    });
  }
  function renderSources(sources) {
    if (!sources || !sources.length) { el.sources.innerHTML = ""; return; }
    var h = '<h3 class="sources-title">검색 출처 (그라운딩)</h3><ul class="sources-list">';
    sources.forEach(function (s) {
      h += '<li><a href="' + escapeHtml(s.uri) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(s.title) + "</a></li>";
    });
    h += "</ul>";
    el.sources.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(h, { ADD_ATTR: ["target", "rel"] }) : h;
  }
  function renderSteps() {
    el.steps.style.display = "";
    el.steps.innerHTML = "";
    STEPS.forEach(function (s) {
      var li = document.createElement("li");
      li.id = "step-" + s.id;
      li.className = "step";
      li.innerHTML = '<span class="step-ico">•</span><span class="step-label"></span>';
      li.querySelector(".step-label").textContent = s.label;
      el.steps.appendChild(li);
    });
  }
  function setStep(id, state) {
    var li = $("step-" + id);
    if (!li) return;
    li.className = "step " + state;
    var ico = li.querySelector(".step-ico");
    ico.textContent = state === "done" ? "✓" : state === "fail" ? "✗" : state === "active" ? "⟳" : "•";
  }

  /* ============ 액션/유틸 ============ */
  function copyReport() {
    if (!lastBriefing) return;
    navigator.clipboard.writeText(lastBriefing).then(
      function () { setStatus("마크다운을 클립보드에 복사했습니다.", "ok"); },
      function () { setStatus("복사 실패. 브라우저 권한을 확인하세요.", "warn"); });
  }
  function downloadReport() {
    if (!lastBriefing) return;
    var name = "hynix-brief-news_" + fmt(new Date()).replace(/[: ]/g, "-") + ".md";
    var blob = new Blob([lastBriefing], { type: "text/markdown;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }
  function resetOutput() {
    el.report.innerHTML = ""; el.sources.innerHTML = ""; el.meta.textContent = "";
    el.followup.style.display = "none"; el.chatLog.innerHTML = ""; chatHistory = [];
  }
  function setBusy(b) {
    el.generate.disabled = b;
    el.generate.textContent = b ? "에이전트 작업 중…" : "브리핑 생성";
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
    return String(t || "").replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
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
})();
