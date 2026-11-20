// 기사·논문 핵심 문장 강조 캡처, 이미지·화면 캡처
// - 입력: argv[2] JSON 목록, argv[3] 출력 폴더
// - mode text: marks 문장에 노란 강조 후 주변 문단 캡처
// - mode img: selector 또는 본문 큰 이미지 캡처
// - mode page: 첫 화면 캡처
const { chromium } = await import(process.env.PLAYWRIGHT ?? '/Users/mac/Desktop/Coding/_nuktu/doc/node_modules/playwright/index.mjs');
const targets = JSON.parse(process.argv[2]);
const out = process.argv[3];
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' });
for (const t of targets) {
  const page = await ctx.newPage();
  try {
    await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(t.wait ?? 3000);
    // 쿠키 동의 버튼 클릭, 고정 요소 숨김
    for (const label of ['Accept all', 'Accept All', 'Accept', 'I agree', 'Reject Cookies', 'Reject All', '동의', '확인']) {
      const b = page.getByRole('button', { name: label, exact: true });
      if (await b.count()) { await b.first().click({ timeout: 2000 }).catch(() => {}); break; }
    }
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el);
        if ((s.position === 'fixed' || s.position === 'sticky') && el.offsetHeight < innerHeight * 0.9) el.style.setProperty('display', 'none', 'important');
      }
    });
    const file = `${out}/${t.id}.png`;
    if (t.mode === 'page') {
      // 첫 화면을 가리는 팝업·대화상자 제거
      await page.keyboard.press('Escape').catch(() => {});
      await page.evaluate(() => document.querySelectorAll('[role=dialog], [aria-modal=true], [class*=modal], [class*=Modal], [class*=popup], [class*=Popup]')
        .forEach((e) => e.style.setProperty('display', 'none', 'important')));
      await page.waitForTimeout(500);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1280, height: t.height ?? 760 } });
    } else if (t.mode === 'img') {
      const handle = await page.evaluateHandle(({ sel, near }) => {
        if (sel) return document.querySelector(sel);
        const imgs = [...document.querySelectorAll('img')].filter(i => i.naturalWidth >= 400 && i.getBoundingClientRect().width >= 300);
        if (!near) return imgs[0];
        const anchor = [...document.querySelectorAll('p, div, span, figcaption')].find(e => e.textContent.includes(near) && e.children.length < 5);
        if (!anchor) return imgs[0];
        const ay = anchor.getBoundingClientRect().top;
        return imgs.sort((a, b) => Math.abs(a.getBoundingClientRect().top - ay) - Math.abs(b.getBoundingClientRect().top - ay))[0];
      }, { sel: t.selector, near: t.near });
      const el = handle.asElement();
      if (!el) throw new Error('이미지 없음');
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await el.screenshot({ path: file });
    } else {
      const missing = await page.evaluate((marks) => {
        const miss = [];
        for (const m of marks) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node, done = false;
          while (!done && (node = walker.nextNode())) {
            const el = node.parentElement;
            if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
            const norm = node.data.replace(/\s+/g, ' ');
            const i = norm.indexOf(m);
            if (i < 0) continue;
            let raw = 0, n = 0;
            while (n < i) { if (/\s/.test(node.data[raw]) && /\s/.test(node.data[raw + 1] ?? '')) { raw++; continue; } raw++; n++; }
            const range = document.createRange();
            range.setStart(node, raw); range.setEnd(node, Math.min(node.data.length, raw + m.length));
            const mark = document.createElement('mark');
            mark.className = 'cap-mark';
            mark.style.cssText = 'background:#FFE45C;color:inherit;padding:0 1px;';
            range.surroundContents(mark);
            done = true;
          }
          if (!done) {
            // 검색어 강조 등으로 문장이 여러 텍스트 노드로 나뉜 경우 요소 단위로 강조
            const norm = (s) => s.replace(/\s+/g, ' ');
            const cands = [...document.querySelectorAll('p, li, dd, td, span, a, div')]
              .filter((e) => e.getClientRects().length && norm(e.textContent).includes(m))
              .sort((a, b) => a.textContent.length - b.textContent.length);
            if (cands[0]) {
              cands[0].classList.add('cap-mark');
              cands[0].style.cssText += ';background:#FFE45C;';
              done = true;
            }
          }
          if (!done) miss.push(m);
        }
        document.querySelector('.cap-mark')?.scrollIntoView({ block: 'center' });
        return miss;
      }, t.marks);
      if (missing.length) console.log(`  ${t.id} 강조 실패: ${missing.join(' | ')}`);
      await page.waitForTimeout(1200);
      const box = await page.evaluate(({ maxW, pad }) => {
        const marks = [...document.querySelectorAll('.cap-mark')];
        if (!marks.length) return null;
        const rs = marks.map(mk => {
          const block = mk.closest('p, li, blockquote') || mk.parentElement;
          const r = block.getBoundingClientRect(), rm = mk.getBoundingClientRect();
          const tall = r.height > 420;
          return { left: r.left, right: r.right, top: tall ? rm.top - 90 : r.top, bottom: tall ? rm.bottom + 90 : r.bottom };
        });
        const left = Math.max(0, Math.min(...rs.map(r => r.left)) - 20);
        const right = Math.min(document.documentElement.clientWidth, Math.max(...rs.map(r => r.right)) + 20);
        const top = Math.max(0, Math.min(...rs.map(r => r.top)) - pad);
        const bottom = Math.min(innerHeight, Math.max(...rs.map(r => r.bottom)) + pad);
        return { x: left, y: top, width: Math.min(right - left, maxW), height: bottom - top };
      }, { maxW: t.maxW ?? 1100, pad: t.pad ?? 12 });
      if (!box) throw new Error('문장 없음');
      await page.screenshot({ path: file, clip: box });
    }
    console.log(`ok ${t.id}`);
  } catch (e) { console.log(`실패 ${t.id} ${e.message.split('\n')[0]}`); }
  await page.close();
}
await browser.close();
