// toc.js — Floating TOC drawer for Markdown Desk.
//
// A small pill button floats at the preview's top-right corner; clicking it
// slides a TOC panel in from the right edge. The FAB and drawer live in
// <body> with `position: fixed`, then realign to the preview pane's bounding
// rect via ResizeObserver + window resize + view-mode click hooks. We can't
// host them inside `.preview-pane` because that element is the scroll
// container — absolute children there scroll with its content.
//
// Pure helpers (slugify, activeHeadingIndex, computeScrollTarget) are
// exported for unit tests via CommonJS when loaded from Node; in the browser
// the module installs itself on DOMContentLoaded.

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
    return;
  }
  root.__TOC__ = api;
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { api.install(document); });
  } else {
    api.install(document);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------------- Pure helpers (tested) ----------------

  function slugify(text, used) {
    var slug = String(text).toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) slug = 'section';
    var base = slug;
    var i = 1;
    while (used.has(slug)) {
      slug = base + '-' + i;
      i++;
    }
    used.add(slug);
    return slug;
  }

  function activeHeadingIndex(scrollTop, offsets) {
    var active = -1;
    for (var i = 0; i < offsets.length; i++) {
      if (offsets[i] <= scrollTop) active = i;
      else break;
    }
    return active;
  }

  function computeScrollTarget(elementTop, paneTop, currentScrollTop) {
    var target = currentScrollTop + (elementTop - paneTop);
    return target < 0 ? 0 : target;
  }

  // ---------------- DOM install (not exercised by unit tests) ----------------

  function injectStyles(doc) {
    if (doc.getElementById('toc-proto-styles')) return;
    var css = [
      '#toc-fab{position:fixed;z-index:9998;width:34px;height:34px;border-radius:999px;border:1px solid var(--border-color,#d0d7de);background:var(--bg-secondary,#fff);color:var(--text-primary,#24292f);box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;padding:0;transition:background .12s}',
      '#toc-fab:hover{background:var(--bg-tertiary,#f6f8fa)}',
      '#toc-fab[hidden]{display:none}',
      '#toc-drawer{position:fixed;width:240px;display:flex;flex-direction:column;background:var(--bg-secondary,#fff);border:1px solid var(--border-color,#d0d7de);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.15);transition:transform .18s ease,opacity .18s ease;z-index:9998;font-size:13px;transform:translateX(16px);opacity:0;pointer-events:none}',
      '#toc-drawer.open{transform:translateX(0);opacity:1;pointer-events:auto}',
      '#toc-drawer[hidden]{display:none}',
      '.toc-drawer-header{padding:8px 12px;font-weight:600;border-bottom:1px solid var(--border-color,#d0d7de)}',
      '.toc-drawer-list{padding:6px 0;overflow:auto;flex:1}',
      '.toc-drawer-empty{padding:14px 12px;color:var(--text-muted,#6e7781);font-size:12px;text-align:center}',
      '.toc-drawer-item{display:block;padding:4px 12px;color:var(--text-primary,#24292f);text-decoration:none;border-left:2px solid transparent;line-height:1.35}',
      '.toc-drawer-item:hover{background:var(--bg-tertiary,#f6f8fa)}',
      '.toc-drawer-item.active{border-left-color:var(--accent-color,#0969da);color:var(--accent-color,#0969da);background:var(--bg-tertiary,#f6f8fa)}',
      '.toc-drawer-item.toc-level-2{padding-left:20px}',
      '.toc-drawer-item.toc-level-3{padding-left:28px}',
      '.toc-drawer-item.toc-level-4{padding-left:36px;font-size:12px;opacity:.85}',
      '[data-theme="dark"] #toc-fab,[data-theme="dark"] #toc-drawer{background:#161b22;color:#c9d1d9;border-color:#30363d}',
      '[data-theme="dark"] #toc-fab:hover,[data-theme="dark"] .toc-drawer-item:hover,[data-theme="dark"] .toc-drawer-item.active{background:#21262d}',
      '[data-theme="dark"] .toc-drawer-item{color:#c9d1d9}',
    ].join('');
    var style = doc.createElement('style');
    style.id = 'toc-proto-styles';
    style.textContent = css;
    doc.head.appendChild(style);
  }

  var FAB_SIZE = 34;
  var DRAWER_WIDTH = 240;
  var GAP = 10;

  function install(doc) {
    var preview = doc.getElementById('markdown-preview');
    if (!preview) return;
    var previewPane = preview.closest('.preview-pane') || preview.parentElement;
    injectStyles(doc);

    // state.rows and state.offsets mirror each other index-for-index and are
    // replaced together inside rebuild(), so consumers always see a matched
    // pair. Initialize both to [] so the scroll handler can run safely even
    // before the first rebuild.
    var state = { headings: [], rows: [], offsets: [], rebuildTimer: 0 };

    var fab = doc.createElement('button');
    fab.id = 'toc-fab';
    fab.type = 'button';
    fab.title = 'Table of contents';
    fab.setAttribute('aria-label', 'Open table of contents');
    fab.innerHTML = '<i class="bi bi-list-nested"></i>';
    doc.body.appendChild(fab);

    var drawer = doc.createElement('aside');
    drawer.id = 'toc-drawer';
    drawer.setAttribute('aria-label', 'Table of contents');
    drawer.innerHTML =
      '<div class="toc-drawer-header">목차</div>' +
      '<nav class="toc-drawer-list"></nav>';
    doc.body.appendChild(drawer);

    function realign() {
      var rect = previewPane.getBoundingClientRect();
      // Editor-only view mode collapses the preview pane — hide TOC too.
      if (rect.width < 40 || rect.height < 40) {
        fab.hidden = true;
        drawer.hidden = true;
        return;
      }
      drawer.hidden = false;
      if (!drawer.classList.contains('open')) fab.hidden = false;
      fab.style.top = (rect.top + GAP) + 'px';
      fab.style.left = (rect.right - GAP - FAB_SIZE) + 'px';
      drawer.style.top = (rect.top + GAP) + 'px';
      drawer.style.left = (rect.right - GAP - DRAWER_WIDTH) + 'px';
      drawer.style.maxHeight = (rect.height - GAP * 2) + 'px';
      // Pane geometry changed → cached heading offsets are stale.
      recomputeOffsets();
    }
    // realign() does a few `getBoundingClientRect` reads and style writes,
    // then a full `recomputeOffsets` over all headings. Window resize and
    // ResizeObserver can both burst at >1 event per frame during a drag —
    // without this throttle we'd thrash layout proportional to heading
    // count on every burst. RAF collapses bursts to at most one run per
    // frame; we still call realign() synchronously once at install so the
    // initial paint is positioned correctly.
    var realignRAF = 0;
    function realignThrottled() {
      if (realignRAF) return;
      realignRAF = requestAnimationFrame(function () {
        realignRAF = 0;
        realign();
      });
    }
    realign();
    window.addEventListener('resize', realignThrottled);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(realignThrottled).observe(previewPane);
    }
    // View-mode toggle (editor/split/preview) mutates classes on
    // .content-container without changing sizes immediately; poll once
    // after the CSS transition settles. Not RAF-throttled because it's a
    // single scheduled call, not a burst source.
    doc.querySelectorAll('.view-mode-btn, .mobile-view-mode-btn').forEach(function (b) {
      b.addEventListener('click', function () { setTimeout(realign, 200); });
    });

    function openDrawer() {
      drawer.classList.add('open');
      fab.hidden = true;
    }
    function closeDrawer() {
      drawer.classList.remove('open');
      fab.hidden = false;
    }

    // Hover-intent open: 80ms guard avoids opening on pointer passing
    // through the FAB en route to elsewhere. Close grace: 250ms after
    // leaving FAB *or* drawer lets the user travel the gap between them
    // without the panel collapsing under them. Both timers are mutually
    // canceling so click/Escape still take effect immediately.
    var openTimer = 0;
    var closeTimer = 0;
    function cancelOpen() {
      if (openTimer) { clearTimeout(openTimer); openTimer = 0; }
    }
    function cancelClose() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
    }
    function scheduleOpen() {
      cancelClose();
      if (drawer.classList.contains('open') || openTimer) return;
      openTimer = setTimeout(function () {
        openTimer = 0;
        openDrawer();
      }, 80);
    }
    function scheduleClose() {
      cancelOpen();
      if (!drawer.classList.contains('open') || closeTimer) return;
      closeTimer = setTimeout(function () {
        closeTimer = 0;
        closeDrawer();
      }, 250);
    }

    fab.addEventListener('mouseenter', scheduleOpen);
    fab.addEventListener('mouseleave', scheduleClose);
    drawer.addEventListener('mouseenter', cancelClose);
    drawer.addEventListener('mouseleave', scheduleClose);

    // @dev-hook-start
    // Cancel any in-flight hover-intent / hover-leave timers so e2e specs
    // can isolate themselves from a prior spec's lingering hover state.
    // Stripped from release by prepare-frontend.sh.
    if (doc.defaultView) {
      doc.defaultView.__mdDeskTocInternals = {
        cancelTimers: function () { cancelOpen(); cancelClose(); },
      };
    }
    // @dev-hook-end

    // Click stays as an explicit toggle so touch / keyboard users (and the
    // existing e2e click flow) continue to work without depending on hover.
    fab.addEventListener('click', function () {
      cancelOpen();
      cancelClose();
      if (drawer.classList.contains('open')) closeDrawer();
      else openDrawer();
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('open')) {
        cancelOpen();
        cancelClose();
        closeDrawer();
      }
    });

    function rebuild() {
      var used = new Set();
      var nodes = preview.querySelectorAll('h1, h2, h3, h4');
      state.headings = [];
      nodes.forEach(function (el) {
        if (!el.id) el.id = slugify(el.textContent || '', used);
        else used.add(el.id);
        state.headings.push({
          level: parseInt(el.tagName.substring(1), 10),
          text: (el.textContent || '').trim(),
          id: el.id,
          element: el,
        });
      });
      renderDrawer();
      recomputeOffsets();
    }

    // "Scroll offset where this heading would sit at the pane top" — stable
    // across scroll events and only changes when layout does. Computing it
    // inside every scroll event is n+1 `getBoundingClientRect` calls per
    // frame on long docs, which thrashes layout. Cache once per rebuild /
    // realign and read from the cache on scroll.
    function recomputeOffsets() {
      if (!state.headings.length) {
        state.offsets = [];
        return;
      }
      var paneRect = previewPane.getBoundingClientRect();
      var st = previewPane.scrollTop;
      state.offsets = state.headings.map(function (h) {
        return computeScrollTarget(
          h.element.getBoundingClientRect().top, paneRect.top, st
        );
      });
    }

    function renderDrawer() {
      var list = drawer.querySelector('.toc-drawer-list');
      list.innerHTML = '';
      state.rows = [];
      if (!state.headings.length) {
        var empty = doc.createElement('div');
        empty.className = 'toc-drawer-empty';
        empty.textContent = '헤딩이 없습니다';
        list.appendChild(empty);
        return;
      }
      state.headings.forEach(function (h) {
        var a = doc.createElement('a');
        a.href = '#' + h.id;
        a.className = 'toc-drawer-item toc-level-' + h.level;
        a.textContent = h.text;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          scrollHeadingIntoPane(h.element);
        });
        list.appendChild(a);
        state.rows.push(a);
      });
    }

    // Instant jump instead of smooth: a smooth scroll locks in its target
    // at call time, so any MathJax/mermaid/image reflow during the ~300ms
    // animation lands us in the wrong place. We then have to snap, which
    // looks like a visible two-stage scroll. Instant + one RAF correction
    // gives a single movement; if the first jump is slightly off because
    // the heading moved since we read its rect, the RAF catches it within
    // ~16ms — imperceptible.
    function scrollHeadingIntoPane(el) {
      if (!el) return;
      function snap() {
        var paneRect = previewPane.getBoundingClientRect();
        var elRect = el.getBoundingClientRect();
        var delta = elRect.top - paneRect.top;
        if (Math.abs(delta) > 1) {
          previewPane.scrollTop = computeScrollTarget(
            elRect.top, paneRect.top, previewPane.scrollTop
          );
        }
      }
      snap();
      requestAnimationFrame(function () { requestAnimationFrame(snap); });
    }

    // RAF-coalesce scroll events: the native scroll event can fire dozens
    // of times per frame, but the active-heading decision only needs one
    // read per frame. `scrollRAF` holds the pending callback id so repeat
    // events during the same frame are dropped.
    var scrollRAF = 0;
    previewPane.addEventListener('scroll', function () {
      if (!state.offsets || !state.offsets.length) return;
      if (scrollRAF) return;
      scrollRAF = requestAnimationFrame(function () {
        scrollRAF = 0;
        var idx = activeHeadingIndex(previewPane.scrollTop, state.offsets);
        var rows = state.rows || [];
        for (var i = 0; i < rows.length; i++) {
          rows[i].classList.toggle('active', i === idx);
        }
      });
    });

    var observer = new MutationObserver(function () {
      // Debounce: Markdown re-render fires a burst of childList/characterData
      // mutations; one rebuild after the burst settles is enough.
      if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
      state.rebuildTimer = setTimeout(rebuild, 80);
    });
    observer.observe(preview, { childList: true, subtree: true, characterData: true });
    rebuild();
  }

  return {
    slugify: slugify,
    activeHeadingIndex: activeHeadingIndex,
    computeScrollTarget: computeScrollTarget,
    install: install,
  };
});
