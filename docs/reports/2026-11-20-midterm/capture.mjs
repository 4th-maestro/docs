// 중간 발표 제품 화면 캡처
// - 전제: frontend에서 목업 서버 2개 실행(.env 없음, 로그인 생략)
//   npx vite --port 5199 --strictPort
//   VITE_TWIN_URL=/twin/digital-twin.html npx vite --port 5200 --strictPort
// - 실행: node capture.mjs img [id,id]
const { chromium } = await import(process.env.PLAYWRIGHT ?? '/Users/mac/Desktop/Coding/_nuktu/doc/node_modules/playwright/index.mjs');
const OUT = process.argv[2] ?? 'img';
const only = process.argv[3]?.split(',');
const shots = [
  { id: 'portfolio', url: 'http://localhost:5199/#/' },
  { id: 'energy', url: 'http://localhost:5199/#/b/main/energy' },
  { id: 'twin', url: 'http://localhost:5200/#/b/eng6', wait: 9000 },
  // 3D 강조와 AI 답변: 3D 카드와 AI 카드 영역
  { id: 'ask', url: 'http://localhost:5199/#/b/main', ask: '현재 전력 사용량이 높은 공간은?', clip: '.grid' },
  // 스케줄 초안: AI 카드만
  { id: 'draft', url: 'http://localhost:5199/#/b/main', ask: '2층 13시 이후 미사용 회의실 냉방 OFF', clip: '.chat', scrollTo: '.chat .primary' },
];
const browser = await chromium.launch();
for (const s of shots) {
  if (only && !only.includes(s.id)) continue;
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await ctx.addInitScript(() => { try { localStorage.setItem('maestro-theme', 'light') } catch {} });
  const page = await ctx.newPage();
  await page.goto(s.url, { waitUntil: 'load' });
  await page.waitForTimeout(s.wait ?? 4000);
  // 로컬 목업 안내 배너는 숨기고, 발표 화면 주석에 가상 데이터임을 표시
  await page.addStyleTag({ content: '.banner{display:none!important}' });
  if (s.ask) {
    await page.fill('#chat-q', s.ask);
    await page.click('button[aria-label="질문 보내기"]');
    await page.waitForTimeout(5000);
    // 질문 말풍선부터 보이도록 대화 목록 맨 위로 이동
    // scrollTo가 있으면 해당 요소(저장 버튼)가 보이는 위치까지 이동
    await page.evaluate((sel) => {
      const l = document.querySelector('.chat-log'); if (!l) return
      l.scrollTop = 0
      const t = sel && document.querySelector(sel)
      if (t) l.scrollTop = Math.max(0, t.getBoundingClientRect().bottom - l.getBoundingClientRect().bottom + 16)
    }, s.scrollTo);
    await page.waitForTimeout(300);
  }
  let clip;
  if (s.clip) {
    const b = await page.locator(s.clip).first().boundingBox();
    clip = { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, 900 - b.y) };
  }
  await page.screenshot({ path: `${OUT}/${s.id}.png`, clip });
  console.log('ok', s.id);
  await ctx.close();
}
await browser.close();
