# Agent Guidelines

## Project Overview

Markdown Desk는 [Markdown Viewer](https://github.com/ThisIs-Developer/Markdown-Viewer)를 Tauri 2.x로 래핑한 macOS 네이티브 마크다운 편집기입니다. 원본 소스는 Git 서브모듈(`Markdown-Viewer/`)로 관리하며 직접 수정하지 않습니다. 모든 커스텀 동작은 `scripts/bridge.js`를 통해 오버라이드합니다.

## Build

```bash
npm install
npm run tauri dev          # 개발 모드
npm run tauri build        # 릴리스 빌드 (서명 키 필요)
```

- 릴리스 빌드 전 `cargo clean --manifest-path src-tauri/Cargo.toml --release` 실행
- 서명 키: `TAURI_SIGNING_PRIVATE_KEY` 환경변수 필요 (`~/.tauri/markdown-desk.key`)

## Test

```bash
cd src-tauri && cargo test --lib    # Rust 유닛 테스트
npm run test:e2e                     # E2E 테스트 (debug 빌드 필요)
```

E2E 테스트 실행 전 debug 빌드가 필요하다:
```bash
npm run tauri build -- --debug
```

## Versioning

CalVer (`YY.M.MICRO`) 사용. 예: `26.3.2`
- Leading zero 불가 (SemVer 호환)
- `./scripts/bump.sh`로 3개 파일 동기화: `package.json`, `Cargo.toml`, `tauri.conf.json`

## Release

```bash
./scripts/bump.sh              # 버전 bump
git add -A && git commit       # 커밋
git tag v$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
git push origin main --tags    # push → GitHub Actions 자동 빌드/릴리스
```

- `release.yml`의 `generate_release_notes: true`는 항상 유지할 것 (GitHub "Full Changelog" 비교 링크 생성용)

## Manual QA Checklist

릴리스 전 앱을 실행하여 아래 항목을 확인한다. ✅ 표시 항목은 `npm run test:e2e`로 자동 검증된다.

### 파일 열기/저장
- [ ] `Cmd+O`로 .md 파일 열기 → 내용이 프리뷰에 표시
- [ ] 외부 편집기에서 파일 수정 → Live Reload로 자동 갱신
- [ ] `Cmd+S`로 저장 → 원본 파일에 반영

### Export
- [ ] Export > Markdown → 네이티브 저장 다이얼로그, 파일 정상 저장
- [ ] Export > HTML → 동일 확인
- [ ] Export > PDF → 동일 확인

### Mermaid 다이어그램
- [ ] Mermaid 코드 블록이 다이어그램으로 렌더링 ✅
- [ ] 펼쳐보기(Zoom) 버튼 클릭 → 모달에서 다이어그램 정상 표시 ✅
- [ ] 모달에서 드래그(패닝) → 부드럽게 이동, 깜빡임 없음
- [ ] 모달에서 줌 인/아웃 → 정상 동작
- [ ] 모달 닫기 후 다른 다이어그램 펼쳐보기 → 정상 동작

### 테마/UI
- [ ] 테마 토글(라이트/다크) → 재시작 후에도 유지 ✅
- [ ] 탭 여러 개 열기/닫기/전환 정상 ✅
- [ ] Reset 버튼 → 상태 초기화 후 새로고침 ✅
- [ ] 데스크톱 탭 우클릭 → Close Tab / Other / Right / Left 4항목, 양 끝 탭에서 해당 방향 비활성 ✅
- [ ] 모바일 탭(좁은 뷰포트) 우클릭 → 동일 메뉴 동작 (E2E 미커버)

### 텍스트 찾기
- [ ] `Cmd+F` → 검색 바 표시, 프리뷰에서 하이라이트 ✅
- [ ] `Enter`/`Shift+Enter` → 다음/이전 매치 이동 ✅
- [ ] `Esc` 또는 X 버튼 → 검색 바 닫기, 하이라이트 제거 ✅
- [ ] 탭 전환 시 → 검색 바 자동 닫기 ✅
- [ ] 뷰 모드 변경(Editor/Split/Preview) 시 → 검색 바 자동 닫기 ✅
- [ ] Mermaid 모달 열린 상태에서 `Cmd+F` → 검색 바 열리지 않음 ✅

### 페이지 줌 (WebView)
- [ ] `Cmd+` / `Cmd-` / `Cmd+0` → 줌 인/아웃/100% 리셋 (텍스트 + 이미지 함께 스케일) ✅
- [ ] 트랙패드 핀치 → 부드럽게 확대/축소 (macOS WebKit 합성 `wheel+ctrlKey`)
- [ ] 마우스 휠 + `Ctrl` 또는 `Cmd` → 확대/축소 ✅
- [ ] 줌 레벨이 재실행/리로드 후에도 유지(localStorage) ✅
- [ ] 메뉴바 View → Zoom In (`⌘+`) / Zoom Out (`⌘-`) / Actual Size (`⌘0`) 항목 동작 — 단축키와 동일 경로(`window.__mdDeskZoomMenu`)
- [ ] 범위 클램프: 0.3 ~ 3.0 ✅

### 신규 탭 뷰 모드
- [ ] 사용자가 Editor / Split / Preview 토글 → 마지막 모드가 `localStorage('markdown-desk-last-view-mode')` 에 기록 ✅
- [ ] `Cmd+T` 또는 `+` 새 탭 → 마지막 모드로 시작 (split 이면 기본 동작 그대로) ✅
- [ ] 옛 탭으로 switching → 그 탭의 viewMode 그대로 복원 (override 하지 않음) ✅
- [ ] 알려지지 않은 저장값 → split 으로 fallback ✅

### 목차(TOC) 드로어
- [ ] 미리보기 우상단의 FAB 버튼에 마우스 hover → 80ms 후 drawer 자동 펼침 ✅
- [ ] FAB / drawer 영역을 동시에 벗어남 → 250ms 후 자동 닫힘 ✅
- [ ] drawer 영역에 마우스 진입 → 닫힘 타이머 cancel
- [ ] FAB 클릭 토글 / `Esc` 키 → 즉시 닫힘 ✅
- [ ] drawer 헤더에 X 버튼 없음 (hover-leave / Esc 로 대체) ✅
- [ ] 헤딩 H1~H4 자동 추출, 클릭 시 해당 위치로 점프, scroll 따라 active 헤딩 갱신 ✅

### 기본 앱 설정
- [ ] 첫 설치 또는 업데이트 후 기본 앱이 아니면 → 설정 다이얼로그 표시
- [ ] 다이얼로그에서 확인 → 기본 앱으로 설정
- [ ] 다이얼로그에서 취소 → 같은 버전에서 다시 묻지 않음

### 업데이트
- [ ] 메뉴 > Check for Updates — 업데이트 있으면 하단 status bar 표시(snooze 무시), 없으면 "latest version" 다이얼로그, 실패 시 에러 다이얼로그
- [ ] 업데이트 존재 시 실행 2초 후 하단 status bar + 타이틀바 " — Update Available" 표시 (24h 창 내면 생략, 백그라운드는 snooze 존중) ✅
- [ ] status bar의 Update 버튼 → 기존 다운로드/재시작 플로우
- [ ] status bar의 What's new 링크 → 외부 브라우저로 GitHub 릴리즈 페이지 (`releases/tag/v<version>`; 태그 미공개 시 GitHub 가 친화적 "release not found" 페이지를 표시 — 별도 fallback 호출 없음)
- [ ] status bar의 × 닫기 → status bar 사라짐, 해당 버전은 재표시 안 됨 (새 버전 나오면 다시 표시) ✅
- [ ] 앱을 24시간 이상 켜두면 백그라운드 재체크 ✅

## Architecture

- `src-tauri/src/` — Rust 백엔드 (commands, watcher, menu, logger)
- `scripts/bridge.js` — Tauri ↔ 웹 앱 브리지 (테마, 단축키, 줌, 업데이트, 탭 갱신, 마지막 viewMode 기억)
- `scripts/bridge-helpers.js` — bridge.js 의 DOM-free 순수 함수 (단위 테스트 대상)
- `scripts/toc.js` — 미리보기 우상단 목차 FAB + drawer (hover 자동 펼침)
- `scripts/prepare-frontend.sh` — 빌드 시 서브모듈을 `dist/` 로 복사, bridge.js / bridge-helpers.js / toc.js 주입. 릴리즈 빌드에선 `@dev-hook` 블록 strip.
- `Markdown-Viewer/` — 원본 웹 앱 (서브모듈, 수정 금지)

## Key Rules

- 원본 `Markdown-Viewer/` 서브모듈은 절대 직접 수정하지 않음
- 모든 오버라이드는 `scripts/bridge.js` (또는 `scripts/toc.js`)에서 처리
- 새 커스텀 동작은 keydown / wheel / click 등을 *capture phase* 로 가로채는 것이 기본. 합성 `KeyboardEvent.dispatchEvent` 는 capture listener 에 도달하지 않으므로(WKWebView 제약), e2e 는 `@dev-hook` 진입점을 통해 핸들러를 직접 호출
- `bridge.js` / `bridge-helpers.js` / `toc.js` 는 `prepare-frontend.sh` 경로 외에서 포매터·번들러·린터에 태우지 말 것. `// @dev-hook-start` / `// @dev-hook-end` 주석이 릴리즈 빌드에서 훅을 제거하는 sentinel이므로 주석이 지워지면 테스트 표면이 프로덕션에 유출된다
- 한국어로 소통
- 커밋 메시지, 릴리즈 노트는 한국어로 작성

## Workflow Rules

- **커밋과 e2e 는 자동 실행하지 않는다.** 코드 변경마다 자동으로 `git commit` 또는 `npm run test:e2e` 를 돌리지 말고, 사용자가 명시적으로 승인하거나 별도로 요청할 때만 실행한다. 작업 중에는 변경 영역에 해당하는 spec 만 부분 실행으로 회귀를 확인하는 것이 기본.
- **푸시 / 릴리즈 전에는 단위 테스트 + 전체 e2e 확인을 반드시 게이트한다.** 사용자가 `git push` 또는 릴리즈를 요청하면, 이 세션 동안 단위 테스트(`cargo test --lib`, `node --test tests/unit/*.mjs`)와 전체 e2e(`npm run test:e2e`)가 최종 확인된 적이 있는지 점검한다. 아직이라면 사용자에게 "지금 돌릴지" 묻고, 승인 후 실행한다. 통과 확인 없이 푸시/릴리즈를 진행하지 않는다.
