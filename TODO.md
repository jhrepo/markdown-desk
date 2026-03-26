# TODO

## 버저닝

- [ ] SemVer(MAJOR.MINOR.PATCH) 규칙 적용
- [ ] 버전 관리 대상: `tauri.conf.json`, `Cargo.toml`, `package.json` 동기화
- [ ] 릴리스 시 git tag 생성 (예: `v0.2.0`)
- [ ] (선택) 버전 bump 스크립트 또는 `cargo-release` 도입

## 자동 업데이트 기능

- [ ] 서명 키 생성 (`npm run tauri signer generate -- -w ~/.tauri/markdown-desk.key`)
- [ ] 비밀 키 안전하게 보관 (GitHub Secrets 등, 절대 레포에 커밋하지 않기)
- [ ] `tauri-plugin-updater`, `tauri-plugin-process` 의존성 추가
- [ ] `tauri.conf.json`에 `createUpdaterArtifacts: true` 및 updater 설정 추가
- [ ] `capabilities/default.json`에 updater/process 권한 추가
- [ ] `lib.rs`에 updater/process 플러그인 등록
- [ ] 프론트엔드 업데이트 체크 로직 구현 (앱 시작 시 확인 → 다운로드 → 재실행)
- [ ] GitHub Releases에 빌드 산출물(`.tar.gz`, `.tar.gz.sig`) 업로드 및 `latest.json` 호스팅
- [ ] (선택) GitHub Actions로 태그 push 시 자동 빌드/릴리스 CI/CD 구성
