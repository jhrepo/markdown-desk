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
    // 닫기 버튼은 시각적 × 글리프 또는 aria-label로 식별 가능해야 한다.
    const ariaLabel = await closeBtn.getAttribute('aria-label');
    expect((ariaLabel || '').toLowerCase()).toContain('close');
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
    // 정확한 픽셀이 아니라 합리적 상한(40px)으로 가드한다 — 폰트/패딩
    // 조정 여지를 남기되 옛 두꺼운 배너(45~50px)로의 회귀는 막는다.
    await showBanner('99.0.6');
    const banner = await $(BANNER_SEL);
    const height = await browser.execute((sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().height : null;
    }, BANNER_SEL);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThanOrEqual(40);
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
