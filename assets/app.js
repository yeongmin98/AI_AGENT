/* Hynix Brief News — 클라이언트 에이전트 로직
 * Phase 2: 다단계 에이전트 루프(계획→검색×3→검증·종합) + 진행 가시화
 * Phase 1: 브리핑 기반 대화형 후속 질문 (멀티턴 + 검색 보강)
 * Phase 4: 빠른 액션(심층분석/경쟁사비교/학습플랜) → 대화 채널로 연결
 * UI: 종합 단계는 구조화 JSON → 커스텀 대시보드 렌더 (실패 시 마크다운 폴백)
 */
(function () {
  "use strict";

  var MODEL = (window.HYNIX_CONFIG && window.HYNIX_CONFIG.GEMINI_MODEL) || "gemini-2.5-flash";
  var ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
  var LS_KEY = "hynix_gemini_key";

  var lastBriefing = "";   // 최종 브리핑 마크다운(복사/다운로드/대화 컨텍스트)
  var collectedNotes = ""; // 검색 단계 노트
  var chatHistory = [];
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
    { id: "verify", label: "⑤ 검증·중복 제거·구조화 종합" }
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
      "각 항목을 다음 형식의 불릿으로 정리하라: '- 제목 / 출처 / 게시일(YYYY-MM-DD HH:MM) / URL / 핵심 1~2문장 / 엔지니어 관점 한 줄'. " +
      "한국어로, 노트만 출력(서론·결론 없이).";
  }

  // 구조화 종합 지시 (8개 섹션을 JSON으로)
  function synthJSONInstruction() {
    return "당신은 'Hynix Brief News' 편집 에이전트다. 제공된 수집 노트만 근거로, SK하이닉스 엔지니어용 일일 브리핑을 " +
      "아래 JSON 스키마로만 출력한다. 코드펜스/설명 없이 순수 JSON. 모든 텍스트는 한국어.\n" +
      "impact 와 priority 값은 정확히 '높음' | '중간' | '낮음' 중 하나.\n" +
      "노트에 있는 사실만 사용하고 게시일/출처/url 은 노트의 값을 쓴다. 노트에 근거가 없으면 해당 배열은 빈 배열로 둔다. 추측 금지.\n" +
      "{\n" +
      '  "meta": { "date": "YYYY년 MM월 DD일", "time": "HH:MM" },\n' +
      '  "executive_summary": [ { "issue": "", "summary": "", "engineer_meaning": "", "impact": "높음" } ],\n' +
      '  "hynix_news": [ { "title": "", "source": "", "published_at": "YYYY-MM-DD HH:MM", "url": "", "core": "", "insight": "", "keywords": "", "impact": "높음" } ],\n' +
      '  "stock": { "price": "", "change": "", "cause": "", "news_summary": "", "market_reaction": "", "engineer_point": "", "source": "", "published_at": "", "url": "" },\n' +
      '  "competitors": [ { "company": "삼성전자", "core": "", "impact_on_hynix": "", "keywords": "", "impact": "중간", "source": "", "published_at": "", "url": "" } ],\n' +
      '  "trends": [ { "core": "", "related_companies": "", "impact_on_hynix": "", "engineer_point": "", "impact": "중간", "source": "", "published_at": "", "url": "" } ],\n' +
      '  "risks": [ { "risk": "", "related": "", "checkpoint": "" } ],\n' +
      '  "opportunities": [ { "opportunity": "", "related": "", "point": "" } ],\n' +
      '  "action_items": [ { "action": "", "related": "", "priority": "높음" } ],\n' +
      '  "references": [ { "category": "SK하이닉스", "title": "", "source": "", "published_at": "YYYY-MM-DD HH:MM", "url": "" } ]\n' +
      "}\n" +
      "주가 데이터가 없으면 stock.price 에 '현재 사용 가능한 정보에서 최신 주가 데이터를 확인할 수 없습니다.' 를 넣는다.";
  }

  function runAgent() {
    var key = activeKey();
    if (!key) { setStatus("API 키가 없습니다. 키를 입력한 뒤 다시 시도하세요.", "warn"); return; }

    setBusy(true);
    resetOutput();
    renderSteps();
    var nowStr = fmt(new Date());

    setStep("plan", "active");
    setStatus("에이전트가 수집 계획을 수립하고 다단계 리서치를 시작합니다…", "");
    setStep("plan", "done");

    var allSources = [];
    var notes = { s1: "", s2: "", s3: "" };

    // 순차 검색 (분당 요청 버스트 완화) — 각 호출은 429 시 자동 재시도
    var searchChain = ["s1", "s2", "s3"].reduce(function (p, id) {
      return p.then(function () {
        setStep(id, "active");
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
    }, Promise.resolve());

    searchChain.then(function () {
      setStep("verify", "active");
      setStatus("수집한 뉴스를 검증·중복 제거하고 대시보드로 구조화 중…", "");
      collectedNotes =
        "## SK하이닉스·주가\n" + notes.s1 + "\n\n## 경쟁사\n" + notes.s2 + "\n\n## 산업 트렌드\n" + notes.s3;

      var synthUser =
        "현재 시각은 " + nowStr + " (Asia/Seoul) 이다.\n" +
        "아래는 에이전트가 단계별로 수집·정리한 최근 48시간 반도체 뉴스 노트다. 이 노트를 근거로 스키마에 맞춰 JSON을 생성하라.\n\n" +
        "[수집 노트]\n" + collectedNotes;

      return geminiCall({
        system: synthJSONInstruction(),
        contents: [{ role: "user", parts: [{ text: synthUser }] }],
        useSearch: false, maxTokens: 16384, json: true
      }).then(function (res) {
        var data = tryParseJSON(res.text);
        if (data) {
          lastBriefing = jsonToMarkdown(data);
          renderDashboard(data);
        } else {
          // 폴백: 마크다운으로 다시 종합
          return geminiCall({
            system: window.HYNIX_SYSTEM_PROMPT,
            contents: [{ role: "user", parts: [{ text: synthUser + "\n\n보고서 마크다운 본문만 출력하라." }] }],
            useSearch: false, maxTokens: 16384
          }).then(function (r2) {
            lastBriefing = stripFence(r2.text);
            renderMarkdown(el.report, lastBriefing);
            el.report.className = "report";
          });
        }
      });
    }).then(function () {
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

  /* ============ 대시보드 렌더 ============ */
  function renderDashboard(d) {
    var m = d.meta || {};
    var h = "";
    h += '<div class="dash-head"><div><h1 class="dash-title">Hynix Brief News</h1>' +
      '<p class="dash-sub">SK하이닉스 엔지니어 일일 반도체 뉴스 브리핑</p></div>' +
      '<div class="dash-meta">' + esc(m.date || "") + (m.time ? " · 기준 " + esc(m.time) : "") +
      '<span class="dash-meta-sub">최근 48시간 이내 게시 뉴스 · SK하이닉스 엔지니어</span></div></div>';

    h += section("1. Executive Summary");
    var es = d.executive_summary || [];
    if (es.length) {
      h += '<div class="exec-box">';
      es.forEach(function (it) {
        h += '<div class="exec-row">' + impactBadge(it.impact) +
          '<div class="exec-body"><div class="exec-issue">' + esc(it.issue) + '</div>' +
          '<div class="exec-sum">' + esc(it.summary) + '</div>' +
          '<div class="exec-mean"><span>엔지니어 관점</span> ' + esc(it.engineer_meaning) + '</div></div></div>';
      });
      h += "</div>";
    } else h += emptyNote();

    h += section("2. SK하이닉스 주요 뉴스");
    h += cardGrid((d.hynix_news || []).map(function (n) {
      return card(n.title, n.impact, n.source, n.published_at, n.url, [
        { v: n.core }, { k: "엔지니어 관점", v: n.insight }, { k: "키워드", v: n.keywords }
      ]);
    }));

    h += section("3. SK하이닉스 주가 및 시장 반응");
    h += stockPanel(d.stock || {});

    h += section("4. 경쟁사 주요 뉴스");
    h += cardGrid((d.competitors || []).map(function (c) {
      return card(c.company, c.impact, c.source, c.published_at, c.url, [
        { v: c.core }, { k: "SK하이닉스 영향", v: c.impact_on_hynix }, { k: "키워드", v: c.keywords }
      ]);
    }));

    h += section("5. 반도체 산업 트렌드");
    h += cardGrid((d.trends || []).map(function (t) {
      return card(t.related_companies ? "관련: " + t.related_companies : "산업 트렌드", t.impact, t.source, t.published_at, t.url, [
        { v: t.core }, { k: "SK하이닉스 영향", v: t.impact_on_hynix }, { k: "관전 포인트", v: t.engineer_point }
      ]);
    }));

    h += section("6. 오늘의 핵심 리스크와 기회");
    h += '<div class="assess-grid">' +
      assessPanel("Risk Assessment · 핵심 리스크", ["리스크", "관련 뉴스", "엔지니어 체크포인트"],
        (d.risks || []).map(function (r) { return [r.risk, r.related, r.checkpoint]; }), "risk") +
      assessPanel("Opportunity Assessment · 핵심 기회", ["기회", "관련 뉴스", "활용 포인트"],
        (d.opportunities || []).map(function (o) { return [o.opportunity, o.related, o.point]; }), "opp") +
      "</div>";

    h += section("7. 엔지니어 관점 Action Item");
    h += actionPanel(d.action_items || []);

    h += section("8. 참고 기사 목록");
    h += refTable(d.references || []);

    el.report.className = "report dashboard";
    el.report.innerHTML = window.DOMPurify ? DOMPurify.sanitize(h, { ADD_ATTR: ["target", "rel"] }) : h;
    el.report.querySelectorAll("a").forEach(function (a) {
      a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer");
    });
  }

  function section(t) { return '<h2 class="dash-section">' + esc(t) + "</h2>"; }
  function emptyNote() { return '<p class="empty-note">최근 48시간 이내 확인된 관련 뉴스 없음</p>'; }
  function cardGrid(cards) {
    cards = cards.filter(Boolean);
    if (!cards.length) return emptyNote();
    return '<div class="card-grid">' + cards.join("") + "</div>";
  }
  function impactBadge(level) {
    level = (level || "").trim();
    var cls = level === "높음" ? "lv-high" : level === "중간" ? "lv-mid" : level === "낮음" ? "lv-low" : "lv-none";
    var dot = level === "높음" ? "🔴" : level === "중간" ? "🟡" : level === "낮음" ? "🟢" : "";
    return '<span class="badge-impact ' + cls + '">' + dot + " " + esc(level || "—") + "</span>";
  }
  function srcLine(source, date, url) {
    var parts = [];
    if (source) parts.push(esc(source));
    if (date) parts.push(esc(date));
    var s = parts.join(" · ");
    if (url && /^https?:/i.test(url)) s += (s ? " · " : "") + '<a href="' + esc(url) + '">원문</a>';
    return s ? '<div class="card-src">' + s + "</div>" : "";
  }
  function card(title, impact, source, date, url, lines) {
    var h = '<div class="card"><div class="card-top"><h3 class="card-title">' + esc(title || "") + "</h3>" +
      (impact ? impactBadge(impact) : "") + "</div>";
    h += srcLine(source, date, url);
    (lines || []).forEach(function (l) {
      if (!l || !l.v) return;
      h += '<div class="card-line">' + (l.k ? '<span class="card-k">' + esc(l.k) + "</span> " : "") + esc(l.v) + "</div>";
    });
    h += "</div>";
    return h;
  }
  function stockPanel(s) {
    var has = s && (s.price || s.change || s.cause || s.news_summary || s.market_reaction || s.engineer_point);
    if (!has) return emptyNote();
    var h = '<div class="stock-panel"><div class="stock-metrics">';
    h += '<div class="metric"><span class="metric-k">현재가 / 종가</span><span class="metric-v">' + esc(s.price || "—") + "</span></div>";
    h += '<div class="metric"><span class="metric-k">등락률</span><span class="metric-v">' + esc(s.change || "—") + "</span></div>";
    h += '</div><div class="stock-rows">';
    function row(k, v) { return v ? '<p><span class="card-k">' + esc(k) + "</span> " + esc(v) + "</p>" : ""; }
    h += row("주가 변동 원인", s.cause) + row("관련 뉴스", s.news_summary) +
      row("시장 반응", s.market_reaction) + row("엔지니어 관전 포인트", s.engineer_point);
    h += "</div>" + srcLine(s.source, s.published_at, s.url) + "</div>";
    return h;
  }
  function assessPanel(title, cols, rows, kind) {
    var h = '<div class="assess-panel ' + kind + '"><h3 class="assess-title">' + esc(title) + "</h3>";
    if (!rows.length) { h += emptyNote() + "</div>"; return h; }
    h += "<table><thead><tr>";
    cols.forEach(function (c) { h += "<th>" + esc(c) + "</th>"; });
    h += "</tr></thead><tbody>";
    rows.forEach(function (r) {
      h += "<tr>";
      r.forEach(function (c) { h += "<td>" + esc(c || "") + "</td>"; });
      h += "</tr>";
    });
    h += "</tbody></table></div>";
    return h;
  }
  function actionPanel(items) {
    if (!items.length) return emptyNote();
    var h = '<div class="action-panel">';
    items.forEach(function (a, i) {
      h += '<div class="action-item"><span class="action-no">' + (i + 1) + "</span>" +
        '<div class="action-body"><p class="action-text">' + esc(a.action || "") + "</p>" +
        '<p class="action-sub">' + (a.related ? esc(a.related) + " · " : "") +
        '우선순위 ' + esc(a.priority || "—") + "</p></div></div>";
    });
    h += "</div>";
    return h;
  }
  function refTable(refs) {
    if (!refs.length) return emptyNote();
    var h = '<div class="ref-wrap"><table class="ref-table"><thead><tr>' +
      "<th>구분</th><th>제목</th><th>출처</th><th>게시일</th><th>링크</th></tr></thead><tbody>";
    refs.forEach(function (r) {
      var link = (r.url && /^https?:/i.test(r.url)) ? '<a href="' + esc(r.url) + '">원문</a>' : "—";
      h += "<tr><td>" + esc(r.category || "") + "</td><td>" + esc(r.title || "") + "</td><td>" +
        esc(r.source || "") + "</td><td>" + esc(r.published_at || "") + "</td><td>" + link + "</td></tr>";
    });
    h += "</tbody></table></div>";
    return h;
  }

  // JSON → 고정 템플릿 마크다운 (복사/다운로드/대화 컨텍스트용)
  function jsonToMarkdown(d) {
    var m = d.meta || {};
    var L = [];
    L.push("# Hynix Brief News", "", "## SK하이닉스 엔지니어 일일 반도체 뉴스 브리핑", "");
    L.push("> **작성일:** " + (m.date || "") + "  ", "> **기준 시각:** " + (m.time || "") + "  ",
      "> **수집 범위:** 최근 48시간 이내 게시 뉴스  ", "> **대상:** SK하이닉스 엔지니어", "");
    L.push("## 1. Executive Summary", "");
    L.push("| 핵심 이슈 | 요약 | 엔지니어 관점 의미 | 영향도 |", "| --- | --- | --- | --- |");
    (d.executive_summary || []).forEach(function (it) {
      L.push("| " + c(it.issue) + " | " + c(it.summary) + " | " + c(it.engineer_meaning) + " | " + c(it.impact) + " |");
    });
    L.push("", "## 2. SK하이닉스 주요 뉴스", "");
    (d.hynix_news || []).forEach(function (n, i) {
      L.push("### 2." + (i + 1) + " " + c(n.title), "");
      L.push("> **출처:** " + c(n.source) + " | **게시일:** " + c(n.published_at) + " | **URL:** " + c(n.url), "");
      L.push("- **핵심 내용:** " + c(n.core), "- **엔지니어 관점 시사점:** " + c(n.insight),
        "- **관련 키워드:** " + c(n.keywords), "- **영향도:** " + c(n.impact), "");
    });
    var s = d.stock || {};
    L.push("## 3. SK하이닉스 주가 및 시장 반응", "");
    L.push("- **현재 주가 또는 최근 종가:** " + c(s.price), "- **등락률:** " + c(s.change),
      "- **주가 변동 주요 원인:** " + c(s.cause), "- **관련 뉴스 요약:** " + c(s.news_summary),
      "- **증권가 또는 시장 반응:** " + c(s.market_reaction), "- **엔지니어 관점 관전 포인트:** " + c(s.engineer_point),
      "- **출처:** " + c(s.source) + " | **게시일:** " + c(s.published_at) + " | **URL:** " + c(s.url), "");
    L.push("## 4. 경쟁사 주요 뉴스", "");
    (d.competitors || []).forEach(function (x, i) {
      L.push("### 4." + (i + 1) + " " + c(x.company), "");
      L.push("> **출처:** " + c(x.source) + " | **게시일:** " + c(x.published_at) + " | **URL:** " + c(x.url), "");
      L.push("- **핵심 내용:** " + c(x.core), "- **SK하이닉스 엔지니어 관점 영향:** " + c(x.impact_on_hynix),
        "- **관련 키워드:** " + c(x.keywords), "- **영향도:** " + c(x.impact), "");
    });
    L.push("## 5. 반도체 산업 트렌드", "");
    (d.trends || []).forEach(function (t, i) {
      L.push("### 5." + (i + 1) + " 산업 트렌드 " + (i + 1), "");
      L.push("> **출처:** " + c(t.source) + " | **게시일:** " + c(t.published_at) + " | **URL:** " + c(t.url), "");
      L.push("- **핵심 내용:** " + c(t.core), "- **관련 기업:** " + c(t.related_companies),
        "- **SK하이닉스에 미칠 수 있는 영향:** " + c(t.impact_on_hynix),
        "- **엔지니어 관점 관전 포인트:** " + c(t.engineer_point), "- **영향도:** " + c(t.impact), "");
    });
    L.push("## 6. 오늘의 핵심 리스크와 기회", "", "### 6.1 핵심 리스크", "",
      "| 번호 | 리스크 | 관련 뉴스 | 엔지니어 관점 체크포인트 |", "| -- | -- | -- | -- |");
    (d.risks || []).forEach(function (r, i) { L.push("| " + (i + 1) + " | " + c(r.risk) + " | " + c(r.related) + " | " + c(r.checkpoint) + " |"); });
    L.push("", "### 6.2 핵심 기회", "", "| 번호 | 기회 | 관련 뉴스 | 엔지니어 관점 활용 포인트 |", "| -- | -- | -- | -- |");
    (d.opportunities || []).forEach(function (o, i) { L.push("| " + (i + 1) + " | " + c(o.opportunity) + " | " + c(o.related) + " | " + c(o.point) + " |"); });
    L.push("", "## 7. 엔지니어 관점 Action Item", "", "| 번호 | Action Item | 관련 이슈 | 우선순위 |", "| -- | -- | -- | -- |");
    (d.action_items || []).forEach(function (a, i) { L.push("| " + (i + 1) + " | " + c(a.action) + " | " + c(a.related) + " | " + c(a.priority) + " |"); });
    L.push("", "## 8. 참고 기사 목록", "", "| 번호 | 구분 | 제목 | 출처 | 게시일 | URL |", "| -- | -- | -- | -- | -- | -- |");
    (d.references || []).forEach(function (r, i) {
      L.push("| " + (i + 1) + " | " + c(r.category) + " | " + c(r.title) + " | " + c(r.source) + " | " + c(r.published_at) + " | " + c(r.url) + " |");
    });
    return L.join("\n");
  }
  function c(v) { return (v == null ? "" : String(v)).replace(/\|/g, "\\|").replace(/\n+/g, " "); }

  function tryParseJSON(t) {
    try {
      t = stripFence(t).trim();
      var s = t.indexOf("{"), e = t.lastIndexOf("}");
      if (s >= 0 && e > s) t = t.slice(s, e + 1);
      var d = JSON.parse(t);
      return (d && typeof d === "object") ? d : null;
    } catch (e) { return null; }
  }

  /* ============ Phase 1: 대화 ============ */
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
      "[오늘 브리핑 본문]\n" + lastBriefing + "\n\n[브리핑 근거가 된 수집 노트]\n" + collectedNotes;
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
    var contents = chatHistory.map(function (m) { return { role: m.role, parts: [{ text: m.text }] }; });
    geminiCall({ system: chatSystem(), contents: contents, useSearch: true, maxTokens: 4096 })
      .then(function (res) {
        var answer = stripFence(res.text) || "(빈 응답)";
        chatHistory.push({ role: "model", text: answer });
        replaceBubble(thinking, answer, res.sources);
      })
      .catch(function (err) {
        replaceBubble(thinking, "⚠️ 오류: " + (err && err.message ? err.message : err), []);
        chatHistory.pop();
      })
      .finally(function () { chatBusy = false; el.chatSend.disabled = false; el.chatInput.focus(); });
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
    body.innerHTML = ""; renderMarkdown(body, text);
    if (sources && sources.length) {
      var s = dedupeSources(sources).slice(0, 6);
      var ul = document.createElement("ul"); ul.className = "bubble-sources";
      s.forEach(function (src) {
        var li = document.createElement("li"), a = document.createElement("a");
        a.href = src.uri; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = src.title || src.uri;
        li.appendChild(a); ul.appendChild(li);
      });
      body.appendChild(ul);
    }
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  /* ============ Gemini 호출 (429 자동 재시도 포함) ============ */
  var MAX_RETRY = 3;
  function geminiCall(opts, attempt) {
    attempt = attempt || 0;
    var key = activeKey();
    var body = { contents: opts.contents };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    if (opts.useSearch) body.tools = [{ google_search: {} }];
    body.generationConfig = { temperature: 0.3, maxOutputTokens: opts.maxTokens || 8192 };
    if (opts.json) body.generationConfig.responseMimeType = "application/json";
    var url = ENDPOINT + encodeURIComponent(MODEL) + ":generateContent?key=" + encodeURIComponent(key);

    return fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    }).then(function (resp) {
      if (!resp.ok) {
        var msg = (resp.data && resp.data.error && resp.data.error.message) || ("HTTP " + resp.status);
        if (resp.status === 429 && attempt < MAX_RETRY) {
          var sec = parseRetryDelay(resp.data);
          setStatus("무료 사용량(분당) 한도 도달 — " + sec + "초 후 자동 재시도합니다… (" + (attempt + 1) + "/" + MAX_RETRY + ")", "warn");
          return wait(sec * 1000).then(function () { return geminiCall(opts, attempt + 1); });
        }
        throw new Error(msg);
      }
      var cand = resp.data && resp.data.candidates && resp.data.candidates[0];
      if (!cand) throw new Error("응답에 후보가 없습니다. (안전 필터 또는 빈 결과)");
      var parts = (cand.content && cand.content.parts) || [];
      return { text: parts.map(function (p) { return p.text || ""; }).join("").trim(), sources: extractSources(cand) };
    });
  }
  function parseRetryDelay(data) {
    try {
      var det = (data && data.error && data.error.details) || [];
      for (var i = 0; i < det.length; i++) {
        if (det[i].retryDelay) {
          var n = parseFloat(String(det[i].retryDelay).replace(/[^0-9.]/g, ""));
          if (!isNaN(n)) return Math.min(45, Math.ceil(n) + 1);
        }
      }
    } catch (e) {}
    return 25;
  }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function extractSources(cand) {
    var out = [], gm = cand && cand.groundingMetadata;
    if (gm && gm.groundingChunks) gm.groundingChunks.forEach(function (c) {
      if (c.web && c.web.uri) out.push({ title: c.web.title || c.web.uri, uri: c.web.uri });
    });
    return out;
  }
  function dedupeSources(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (s) { if (s && s.uri && !seen[s.uri]) { seen[s.uri] = 1; out.push(s); } });
    return out;
  }

  /* ============ 공통 렌더/유틸 ============ */
  function renderMarkdown(target, md) {
    var html = window.marked ? window.marked.parse(md) : esc(md);
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
      h += '<li><a href="' + esc(s.uri) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title) + "</a></li>";
    });
    h += "</ul>";
    el.sources.innerHTML = window.DOMPurify ? DOMPurify.sanitize(h, { ADD_ATTR: ["target", "rel"] }) : h;
  }
  function renderSteps() {
    el.steps.style.display = ""; el.steps.innerHTML = "";
    STEPS.forEach(function (s) {
      var li = document.createElement("li");
      li.id = "step-" + s.id; li.className = "step";
      li.innerHTML = '<span class="step-ico">•</span><span class="step-label"></span>';
      li.querySelector(".step-label").textContent = s.label;
      el.steps.appendChild(li);
    });
  }
  function setStep(id, state) {
    var li = $("step-" + id); if (!li) return;
    li.className = "step " + state;
    li.querySelector(".step-ico").textContent =
      state === "done" ? "✓" : state === "fail" ? "✗" : state === "active" ? "⟳" : "•";
  }
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
    el.report.innerHTML = ""; el.report.className = "report";
    el.sources.innerHTML = ""; el.meta.textContent = "";
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
  function setStatus(msg, kind) { el.status.textContent = msg; el.status.className = "status" + (kind ? " " + kind : ""); }
  function stripFence(t) {
    return String(t || "").replace(/^```(?:json|markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
})();
