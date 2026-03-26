# TODO

## 1. 서명 키 생성 및 등록

- [x] `npm run tauri signer generate -- -w ~/.tauri/markdown-desk.key`
- [x] 공개 키 → `tauri.conf.json`에 등록
- [x] 비밀 키 → GitHub Secrets에 `TAURI_SIGNING_PRIVATE_KEY`로 등록
- [x] 비밀 키 절대 레포에 커밋하지 않기

## 2. 자동 업데이트 플러그인

- [x] `tauri-plugin-updater`, `tauri-plugin-process` 의존성 추가
- [x] `tauri.conf.json`에 `createUpdaterArtifacts: true` 및 updater endpoint/pubkey 설정
- [x] `capabilities/default.json`에 `updater:default`, `process:allow-restart` 권한 추가
- [x] `lib.rs`에 updater/process 플러그인 등록
- [x] `bridge.js`에 업데이트 체크 로직 (앱 시작 시 확인 → 알림 → 다운로드 → 재실행)

## 3. 릴리스 빌드 자동화 (GitHub Actions)

- [x] `.github/workflows/release.yml` 작성
  - git tag (`v*`) push 시 트리거
  - macOS 빌드 (`.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`)
  - GitHub Release 자동 생성 및 빌드 산출물 업로드
  - `latest.json` 매니페스트 자동 생성
- [x] 서명 키를 GitHub Secrets에서 환경변수로 주입
- [x] v0.1.0 첫 릴리스 성공

## 4. 원본 서브모듈 업데이트 자동 감지

- [x] `.github/workflows/submodule-update.yml` 작성
  - 주기적 실행 (schedule, 매일 9:00 UTC)
  - 서브모듈 최신 커밋 확인
  - 변경 시 자동 PR 생성 → 빌드/테스트 실행
  - 수동 머지 후 필요 시 태그 생성하여 릴리스

## 5. 버저닝

- [x] SemVer(MAJOR.MINOR.PATCH) 규칙 적용
- [x] 버전 관리 대상 동기화: `tauri.conf.json`, `Cargo.toml`, `package.json`
- [x] 릴리스 시 git tag 생성 (예: `v0.1.0`)
- [ ] (선택) 버전 bump 스크립트 또는 `cargo-release` 도입
