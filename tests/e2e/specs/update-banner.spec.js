describe('자동 업데이트 배너', () => {
  const BANNER_SEL = '.bridge-update-banner';

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

  it('배너가 버전 문구와 Update/Later 버튼을 포함한다', async () => {
    await showBanner('99.0.0');

    const banner = await $(BANNER_SEL);
    await banner.waitForExist({ timeout: 2000 });
    expect(await banner.isDisplayed()).toBe(true);

    const msg = await banner.$('.bridge-update-banner-msg');
    expect(await msg.getText()).toContain('99.0.0');

    const updateBtn = await banner.$('.bridge-update-banner-update');
    expect(await updateBtn.isExisting()).toBe(true);
    expect(await updateBtn.getText()).toBe('Update');

    const laterBtn = await banner.$('.bridge-update-banner-later');
    expect(await laterBtn.isExisting()).toBe(true);
    expect(await laterBtn.getText()).toBe('Later');
  });

  it('같은 showBanner 호출이 중복 배너를 만들지 않는다', async () => {
    await showBanner('99.0.0');
    await showBanner('99.0.1');

    const banners = await $$(BANNER_SEL);
    expect(banners.length).toBe(1);

    const msg = await $(BANNER_SEL + ' .bridge-update-banner-msg');
    expect(await msg.getText()).toContain('99.0.1');
  });

  it('Later 클릭 시 배너가 사라지고 해당 버전이 스누즈된다', async () => {
    await showBanner('99.0.2');
    const laterBtn = await $(BANNER_SEL + ' .bridge-update-banner-later');
    await laterBtn.click();
    await browser.pause(100);

    const banner = await browser.execute((sel) => !!document.querySelector(sel), BANNER_SEL);
    expect(banner).toBe(false);

    const snoozed = await browser.execute(() =>
      window.__mdDeskUpdateInternals.getSnoozedVersion()
    );
    expect(snoozed).toBe('99.0.2');
  });

  it('배너가 문서의 첫 번째 자식으로 삽입된다', async () => {
    await showBanner('99.0.3');
    const firstIsBanner = await browser.execute((sel) => {
      const first = document.body.firstElementChild;
      return !!first && first.matches(sel);
    }, BANNER_SEL);
    expect(firstIsBanner).toBe(true);
  });
});
