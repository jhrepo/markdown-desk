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
cd src-tauri && cargo test --lib
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

## Architecture

- `src-tauri/src/` — Rust 백엔드 (commands, watcher, menu, logger)
- `scripts/bridge.js` — Tauri ↔ 웹 앱 브리지 (테마, 단축키, 업데이트, 탭 갱신)
- `scripts/prepare-frontend.sh` — 빌드 시 서브모듈을 `dist/`로 복사, bridge.js 주입
- `Markdown-Viewer/` — 원본 웹 앱 (서브모듈, 수정 금지)

## Key Rules

- 원본 `Markdown-Viewer/` 서브모듈은 절대 직접 수정하지 않음
- 모든 오버라이드는 `scripts/bridge.js`에서 처리
- 한국어로 소통
- 커밋 메시지, 릴리즈 노트는 한국어로 작성
