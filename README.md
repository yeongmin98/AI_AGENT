# Hynix Brief News

SK하이닉스 엔지니어를 위한 **일일 반도체 뉴스 브리핑 AI Agent**.
실행 즉시 최근 48시간 이내 뉴스를 자동 수집·분석하여, 엔지니어 관점(공정·수율·품질·제품·패키징·공급망)의 고정 형식 한국어 브리핑을 생성한다.

- **LLM**: Google Gemini (`gemini-2.5-flash`) + Google 검색 그라운딩
- **호스팅**: GitHub Pages (정적)
- **워크플로우**: ① 자동 뉴스 수집 → ② 분석·항목 구조화 → ③ 고정 템플릿 브리핑 생성

## 구성
```
index.html            # 단일 페이지 UI
assets/prompt.js      # 시스템 프롬프트(일관성 규칙 + 고정 출력 템플릿)
assets/app.js         # Gemini 호출 + 렌더 + 복사/다운로드
assets/style.css      # 스타일
config.sample.js      # 키 설정 템플릿 (config.js 는 gitignore)
.github/workflows/deploy.yml  # Pages 배포 + 키 주입
```

## 로컬 실행
```sh
python3 -m http.server 8000
# http://localhost:8000 접속 → 키 입력 후 "브리핑 생성"
```

## 배포 (GitHub Pages, 권장: Actions + Secret)
정적 사이트라 키를 숨길 서버가 없다. 키를 **소스에 커밋하지 않고** 배포 시 주입한다.

1. GitHub에 새 레포 생성 후 이 디렉토리를 push (`main`).
2. 레포 **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `GEMINI_API_KEY`, Value: 발급받은 Gemini 키
3. 레포 **Settings → Pages → Build and deployment → Source: GitHub Actions**
4. `main` push 시 `deploy.yml` 이 웹앱 파일만 모아 `config.js`(키 주입)와 함께 배포한다.
5. 배포 URL이 외부에서 열리는지 확인.

> 배포본 라이브 JS에는 키가 노출된다(정적의 한계). **Google AI Studio에서 키에 HTTP 리퍼러 제한**(배포 도메인만 허용)을 걸어 도용을 막을 것.

### 개인정보 주의
제출 양식(`*.docx`)·이미지에는 이름/이메일이 포함된다. `deploy.yml` 은 **웹앱 파일만** 배포하므로 공개 사이트엔 노출되지 않는다. 단, 브랜치 루트에서 직접 Pages를 켜는 방식은 사용하지 말 것.

## 키 없이 접속 시
`config.js`/Secret이 없으면 화면에 키 입력창이 뜬다. 키 입력 후 "브리핑 생성"으로 동작한다.
