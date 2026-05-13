describe('자동 업데이트 배너 (하단 status bar)', () => {
  const BANNER_SEL = '.bridge-update-banner';
  const REPO_RELEASE_PREFIX =
    'https://github.com/jhrepo/markdown-desk/releases/tag/v';

  async function hookPresent() {
    return browser.execute(() =>
      !!(window.__mdDeskUpdateInternals && typeof window.__mdDeskUpdateInternals.showBanner === 'function')
    );
  }

  async function showBanner(version) {
    await browser.execute((v) => {
      window.__mdDeskUpdateInternals.clearSnooze();
      window.__mdDeskUpdateInternals.showBanner(v);
    }, version);
    await browser.pause(50);
  }

  async function hideBanner() {
    await browser.execute(() => {
      window.__mdDeskUpdateInternals.hideBanner();
      window.__mdDeskUpdateInternals.clearSnooze();
    });
    await browser.pause(50);
  }

  before(async function () {
    // dev-hook 이 없으면 release 빌드 — 본 spec 의 showBanner/hideBanner
    // 가 모두 hook 경유라 release smoke 에서는 통째로 무의미. hard fail
    // 대신 skip 으로 false-negative 를 막는다.
    if (!(await hookPresent())) this.skip();
  });

  afterEach(async () => {
    await hideBanner();
  });

  it('테스트 훅이 노출된다', async () => {
    expect(await hookPresent()).toBe(true);
  });

  it('배너가 버전 문구·Update 버튼·What\'s new 링크·× 닫기를 포함한다', async () => {
    await showBanner('99.0.0');

    const banner = await $(BANNER_SEL);
    await banner.waitForExist({ timeout: 2000 });
    expect(await banner.isDisplayed()).toBe(true);

    const msg = await banner.$('.bridge-update-banner-msg');
    expect(await msg.getText()).toContain('99.0.0');

    const updateBtn = await banner.$('.bridge-update-banner-update');
    expect(await updateBtn.isExisting()).toBe(true);
    expect(await updateBtn.getText()).toBe('Update');

    const releaseLink = await banner.$('.bridge-update-banner-release-link');
    expect(await releaseLink.isExisting()).toBe(true);
    expect(await releaseLink.getText()).toContain("What's new");

    const closeBtn = await banner.$('.bridge-update-banner-close');
    expect(await closeBtn.isExisting()).toBe(true);
    // 닫기 버튼은 시각적 × 글리프 + aria-label 양쪽으로 식별 가능해야 한다.
    // aria-label 만 검증하면 글리프를 다른 문자로 바꿔도 통과하므로 함께 단언.
    const ariaLabel = await closeBtn.getAttribute('aria-label');
    expect((ariaLabel || '').toLowerCase()).toContain('close');
    expect((await closeBtn.getText()).trim()).toBe('×');
  });

  it('What\'s new 링크는 해당 버전의 GitHub 릴리즈 페이지를 가리킨다', async () => {
    await showBanner('99.1.2');
    const releaseLink = await $(BANNER_SEL + ' .bridge-update-banner-release-link');
    const href = await releaseLink.getAttribute('href');
    expect(href).toBe(REPO_RELEASE_PREFIX + '99.1.2');
  });

  it('같은 showBanner 호출이 중복 배너를 만들지 않는다', async () => {
    await showBanner('99.0.0');
    await showBanner('99.0.1');

    const banners = await $$(BANNER_SEL);
    expect(banners.length).toBe(1);

    const msg = await $(BANNER_SEL + ' .bridge-update-banner-msg');
    expect(await msg.getText()).toContain('99.0.1');
  });

  it('× 클릭 시 배너가 사라지고 해당 버전이 스누즈된다', async () => {
    await showBanner('99.0.2');
    const closeBtn = await $(BANNER_SEL + ' .bridge-update-banner-close');
    await closeBtn.click();
    await browser.pause(100);

    const banner = await browser.execute((sel) => !!document.querySelector(sel), BANNER_SEL);
    expect(banner).toBe(false);

    const snoozed = await browser.execute(() =>
      window.__mdDeskUpdateInternals.getSnoozedVersion()
    );
    expect(snoozed).toBe('99.0.2');
  });

  it('배너는 하단 fixed status bar로 표시된다', async () => {
    // 상단 배너가 시야를 강하게 침범한다는 피드백으로 하단으로 이동.
    // position:fixed; bottom:0;을 직접 검증해 다시 상단으로 회귀하는 것을 막는다.
    await showBanner('99.0.5');
    const banner = await $(BANNER_SEL);
    const position = await banner.getCSSProperty('position');
    const bottom = await banner.getCSSProperty('bottom');
    expect(position.value).toBe('fixed');
    expect(bottom.value).toBe('0px');
  });

  it('배너는 슬림 높이로 표시된다 (status bar 톤)', async () => {
    // 두꺼운 배너는 침투적이라는 사용자 결정에 따라 슬림한 상태바 톤.
    // 본질적인 위치 회귀(상단 → 하단) 방어선은 위쪽 it 의 position:fixed;
    // bottom:0 단언이다. 이 케이스는 그 위치가 유지된다는 전제 위에서,
    // 두께만 따로 상한으로 가드한다.
    //
    // 상한 60px 의 의미: CI 의 폰트 메트릭/접근성 확대(macOS Larger Text 등)
    // 가 슬림 톤에서도 ~40~50px 사이로 늘어날 수 있어 30~40 으로 좁히면
    // 환경 의존적 flake 가 생긴다. 60 은 “정상 환경의 슬림”과 “명백한
    // 다중 라인 두꺼운 배너(>=70px)” 를 가르는 sanity 경계로만 의미가
    // 있다 — 옛 45~50 톤 자체를 이 단언만으로 분간하지는 않는다.
    await showBanner('99.0.6');
    const banner = await $(BANNER_SEL);
    const height = await browser.execute((sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().height : null;
    }, BANNER_SEL);
    expect(height).toBeGreaterThanOrEqual(16);
    expect(height).toBeLessThanOrEqual(60);
  });

  it('악성 version 토큰은 거부되어 배너 DOM이 만들어지지 않는다', async () => {
    // JS 측 가드(scripts/bridge-helpers.js isSafeVersionToken / buildReleaseUrl)
    // 가 실제로 banner 생성 경로를 차단하는지 직접 검증. Tauri IPC 가
    // 없는 dev 서버나 e2e 런타임에서는 이 가드가 유일한 방어선이라,
    // 가드 회귀를 cargo 단위테스트만으로 잡기에는 불충분하다.
    const malicious = [
      '..', '.', '...', '.5', '5.', '0..0',
      'v26.5.1', '26.5.1-rc1', '26.5.1;ls',
      '26.5.1`whoami`', '26.5.1$(id)',
      '26.5.1|cat',                     // pipe shell-metacharacter
      '26.5.1/extra', '../etc/passwd',
      '1.2.3.4.5.6.7',                  // 7-segment
      '1'.repeat(33),                   // overlong
      '٠.١.٢',                          // Arabic-Indic digits
      '１.２.３',                       // fullwidth digits
    ];
    for (const bad of malicious) {
      await showBanner(bad);
      const exists = await browser.execute(
        (s) => !!document.querySelector(s),
        BANNER_SEL
      );
      expect(exists).toBe(false);
      // 정리 — 다음 케이스 사이 격리.
      await hideBanner();
    }
  });

  it('배너가 문서의 마지막 자식으로 삽입된다', async () => {
    // 하단 status bar는 z-index와 무관히 마지막 자식으로 두는 게
    // DOM 의미와도 일치한다 (top:0 시절엔 firstElementChild였음).
    await showBanner('99.0.3');
    const lastIsBanner = await browser.execute((sel) => {
      const last = document.body.lastElementChild;
      return !!last && last.matches(sel);
    }, BANNER_SEL);
    expect(lastIsBanner).toBe(true);
  });
});
