// 도식 HTML의 section을 PNG로 저장
// - 입력: diagrams.html의 section#id
// - 출력: docs/human/tutorials/img/<id>.png (2배 해상도)
// - 실행: node render.mjs, playwright 경로는 PLAYWRIGHT 환경변수로 변경
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pw = process.env.PLAYWRIGHT ?? '/Users/mac/Desktop/Coding/_nuktu/doc/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const out = path.resolve(here, '../../../human/tutorials/img');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(here, 'diagrams.html'));
await page.evaluate(() => document.fonts.ready);
for (const id of await page.$$eval('section', (s) => s.map((e) => e.id))) {
  await page.locator(`#${id}`).screenshot({ path: path.join(out, `${id}.png`) });
  console.log(`ok ${id}`);
}
await browser.close();
