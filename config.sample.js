// config.sample.js — 복사해서 config.js 로 사용하거나, 배포 시 GitHub Actions가 자동 생성한다.
//
// 사용법 A (권장: GitHub Actions Secret 주입)
//   - 레포 Settings → Secrets and variables → Actions → New repository secret
//   - Name: GEMINI_API_KEY / Value: 발급받은 Gemini 키
//   - .github/workflows/deploy.yml 이 배포 시 config.js 를 자동 생성한다. (소스에는 키가 안 남음)
//
// 사용법 B (간단하지만 비권장: 직접 입력)
//   - 이 파일을 config.js 로 복사 후 키를 채운다.
//   - 단, 공개 레포에 config.js 를 커밋하면 Google이 노출 키를 자동 폐기할 수 있다.
//   - 반드시 Google AI Studio에서 키에 'HTTP 리퍼러 제한'(배포 도메인만 허용)을 걸 것.
//
// 키 발급: https://aistudio.google.com/app/apikey

window.HYNIX_CONFIG = {
  GEMINI_API_KEY: "REPLACE_WITH_YOUR_GEMINI_API_KEY",
  GEMINI_MODEL: "gemini-2.5-flash"
};
