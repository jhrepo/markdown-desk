# Markdown Desk

![Screenshot](assets/screenshot.png)

<p align="center"><a href="#english">English</a> · <a href="#한국어">한국어</a></p>

---

## English

A native macOS desktop app that provides every feature of
[Markdown Viewer](https://github.com/ThisIs-Developer/Markdown-Viewer),
wrapped with [Tauri](https://tauri.app/) for a system-friendly experience —
keyboard shortcuts, live reload, native dialogs, in-app updates.

### ✨ Desktop-only Features

| Feature | What it does |
|---------|--------------|
| **Live Reload** | An open file is refreshed automatically when an external editor saves it. |
| **Native Open / Save** | `Cmd+O` opens a native file dialog; `Cmd+S` writes back to the original file. |
| **Page Zoom** | `Cmd+` / `Cmd-` / `Cmd0`, trackpad pinch, and `Ctrl`/`Cmd` + mouse wheel all zoom the entire view. Level persists across reloads. |
| **View → Zoom Menu** | macOS menu bar exposes Zoom In (`⌘+`) / Zoom Out (`⌘-`) / Actual Size (`⌘0`). |
| **Remembers Last View Mode** | New tabs open in the mode you last used (Editor / Split / Preview). Existing tabs keep their own mode. |
| **TOC Auto-reveal** | Hovering the floating TOC button on the preview opens the table of contents drawer instantly. Move away and it auto-closes. `Esc` also closes it. |
| **In-app Update Status Bar** | A slim bottom bar appears when a new version is available — Update, *What's new* link (release notes in your default browser), or × to dismiss for that version. |
| **Default `.md` Handler** | Once set as the default app, double-clicking a `.md` file opens it in Markdown Desk. |

### 📦 Install

1. Download the latest `.dmg` from [Releases](https://github.com/jhrepo/markdown-desk/releases)
2. Open the downloaded file and drag **Markdown Desk.app** to the Applications folder

### 🔄 Update

When a new version is released, the app detects it automatically and shows a slim status bar at the bottom:

- **Update** — Download, install, and relaunch in place.
- **What's new** — Open the release notes in your default browser.
- **×** — Snooze the prompt for this specific version (the bar reappears on the next release).

For manual checks, visit [Releases](https://github.com/jhrepo/markdown-desk/releases) directly.

### 🔓 First Launch

macOS may block apps downloaded outside the App Store. Use either option:

**Option A.** Run in Terminal:
```bash
xattr -rd com.apple.quarantine /Applications/Markdown\ Desk.app
```

**Option B.** Right-click the app icon → **Open**, then click "Open" in the popup.

### 📂 Set as Default for `.md`

1. Right-click any `.md` file → **Get Info**
2. Under **Open with**, select **Markdown Desk**
3. Click **Change All...**

### ⌨️ Keyboard Shortcuts

**File & tabs**

| Shortcut | Action |
|----------|--------|
| `Cmd+O` | Open a markdown file |
| `Cmd+S` | Save to the original file |
| `Cmd+R` | Reload window (tabs preserved) |
| `Cmd+T` | New tab (max 20) |
| `Cmd+W` | Close current tab |

**View & zoom**

| Shortcut | Action |
|----------|--------|
| `Cmd+` *(= / +)* | Zoom in (0.1 step, max 3.0) |
| `Cmd-` | Zoom out (0.1 step, min 0.3) |
| `Cmd+0` | Reset zoom to 100% |
| Trackpad pinch | Smooth zoom in / out |
| `Ctrl` / `Cmd` + mouse wheel | Zoom in / out |
| `Cmd+Shift+S` | Toggle scroll sync in Split view |

**Find & misc**

| Shortcut | Action |
|----------|--------|
| `Cmd+F` | Find text in preview |
| `Enter` / `Shift+Enter` | Next / previous match in Find bar |
| `Esc` | Close Find bar, modal, or TOC drawer |
| `Tab` | Insert 2 spaces in the editor |

Standard shortcuts (Cut / Copy / Paste / Undo / Fullscreen, etc.) follow macOS defaults.

### 🤝 Contributing

Everyone is welcome — bug reports and feature ideas are all appreciated.

1. Fork this project
2. Create a new branch (`git checkout -b amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin amazing-feature`)
5. Open a Pull Request

### 📄 License

This project is licensed under the [MIT License](LICENSE).
The web frontend is based on
[Markdown Viewer](https://github.com/ThisIs-Developer/Markdown-Viewer)
by [ThisIs-Developer](https://github.com/ThisIs-Developer), also
[MIT-licensed](https://github.com/ThisIs-Developer/Markdown-Viewer/blob/main/LICENSE).
The macOS desktop wrapper is built with [Tauri](https://tauri.app/).

---

## 한국어

[Markdown Viewer](https://github.com/ThisIs-Developer/Markdown-Viewer)의
모든 기능을 macOS 네이티브 데스크톱 앱으로 제공합니다. [Tauri](https://tauri.app/)로
래핑해 단축키·라이브 리로드·네이티브 다이얼로그·인앱 업데이트 등 데스크톱 친화적인
경험을 더했습니다.

### ✨ 데스크톱 전용 기능

| 기능 | 동작 |
|------|------|
| **Live Reload** | 외부 편집기에서 파일을 수정하면 열린 탭이 자동으로 갱신됩니다. |
| **네이티브 열기/저장** | `Cmd+O` 로 macOS 파일 다이얼로그, `Cmd+S` 로 원본 파일에 저장. |
| **페이지 줌** | `Cmd+` / `Cmd-` / `Cmd0`, 트랙패드 핀치, `Ctrl`/`Cmd` + 마우스 휠 모두 화면 전체를 확대/축소합니다. 줌 레벨은 재실행 후에도 유지됩니다. |
| **View → Zoom 메뉴** | 메뉴바에 Zoom In (`⌘+`) / Zoom Out (`⌘-`) / Actual Size (`⌘0`) 항목 노출. |
| **마지막 뷰 모드 기억** | 새 탭은 마지막에 선택한 모드(Editor / Split / Preview)로 시작합니다. 옛 탭은 각자의 모드가 그대로 유지됩니다. |
| **목차 자동 펼침** | 미리보기 우상단의 목차 버튼에 마우스를 올리면 즉시 펼쳐지고, 영역을 벗어나면 자동으로 닫힙니다. `Esc` 로도 닫을 수 있습니다. |
| **인앱 업데이트 알림 바** | 새 버전이 있으면 화면 하단에 슬림한 status bar 가 표시됩니다 — Update, *What's new* 링크(기본 브라우저로 릴리즈 노트), × 닫기(해당 버전 한 번만 숨김). |
| **기본 앱으로 등록** | 기본 앱 설정 시 `.md` 파일 더블클릭으로 Markdown Desk 에서 열립니다. |

### 📦 설치

1. [Releases](https://github.com/jhrepo/markdown-desk/releases)에서 최신 `.dmg` 다운로드
2. 다운로드된 파일을 열고 **Markdown Desk.app** 을 Applications 폴더로 이동

### 🔄 업데이트

새 버전이 게시되면 앱이 자동으로 감지해 화면 하단에 슬림한 status bar 를 표시합니다:

- **Update** — 인앱에서 바로 다운로드 → 설치 → 재실행합니다.
- **What's new** — 기본 브라우저로 릴리즈 노트를 엽니다.
- **×** — 해당 버전 알림만 한 번 숨깁니다 (다음 새 버전이 나오면 다시 표시).

수동으로 확인하려면 [Releases](https://github.com/jhrepo/markdown-desk/releases) 페이지를 방문하세요.

### 🔓 처음 실행

macOS 는 App Store 외부에서 다운로드한 앱을 차단할 수 있습니다. 아래 중 하나로 해결하세요.

**방법 A.** Terminal 에서 실행:
```bash
xattr -rd com.apple.quarantine /Applications/Markdown\ Desk.app
```

**방법 B.** 앱 아이콘 **우클릭 → 열기** 선택 후 팝업에서 "열기" 클릭.

### 📂 `.md` 기본 앱으로 설정

1. `.md` 파일을 우클릭 → **정보 가져오기**
2. **다음으로 열기** 섹션에서 **Markdown Desk** 선택
3. **모두 변경...** 클릭

### ⌨️ 단축키

**파일과 탭**

| 단축키 | 동작 |
|--------|------|
| `Cmd+O` | 마크다운 파일 열기 |
| `Cmd+S` | 원본 파일에 저장 |
| `Cmd+R` | 창 새로고침 (탭 상태 유지) |
| `Cmd+T` | 새 탭 (최대 20개) |
| `Cmd+W` | 현재 탭 닫기 |

**뷰와 줌**

| 단축키 | 동작 |
|--------|------|
| `Cmd+` *(= / +)* | 줌 인 (0.1 단위, 최대 3.0) |
| `Cmd-` | 줌 아웃 (0.1 단위, 최소 0.3) |
| `Cmd+0` | 100% 로 리셋 |
| 트랙패드 핀치 | 부드러운 확대/축소 |
| `Ctrl` / `Cmd` + 마우스 휠 | 확대/축소 |
| `Cmd+Shift+S` | Split 뷰에서 스크롤 동기화 토글 |

**찾기와 기타**

| 단축키 | 동작 |
|--------|------|
| `Cmd+F` | 프리뷰에서 텍스트 찾기 |
| `Enter` / `Shift+Enter` | Find 바에서 다음 / 이전 매치 |
| `Esc` | Find 바, 모달, 목차 드로어 닫기 |
| `Tab` | 에디터에서 공백 2칸 삽입 |

잘라내기 · 복사 · 붙여넣기 · 실행 취소 · 전체 화면 같은 표준 단축키는 macOS 기본 동작을 따릅니다.

### 🤝 함께 만들어요

누구나 참여할 수 있습니다. 개선 아이디어나 버그 제보 모두 환영합니다.

1. 이 프로젝트를 Fork 합니다
2. 새 브랜치를 만듭니다 (`git checkout -b amazing-feature`)
3. 수정 내용을 커밋합니다 (`git commit -m 'Add some amazing feature'`)
4. 브랜치에 올립니다 (`git push origin amazing-feature`)
5. Pull Request 를 보내주세요

### 📄 라이선스

이 프로젝트는 [MIT License](LICENSE) 로 배포됩니다.
웹 프론트엔드는 [ThisIs-Developer](https://github.com/ThisIs-Developer) 의
[Markdown Viewer](https://github.com/ThisIs-Developer/Markdown-Viewer) 를 기반으로 하며,
동일하게 [MIT License](https://github.com/ThisIs-Developer/Markdown-Viewer/blob/main/LICENSE) 로 배포됩니다.
macOS 데스크톱 래퍼는 [Tauri](https://tauri.app/) 로 제작되었습니다.
