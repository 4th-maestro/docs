// JPEG 등 → PNG (무손실). JPEG는 해독기(브라우저·Windows)마다 픽셀값이 ±1씩 달라 색 경계 판정이 갈릴 수 있다.
// 파이프라인에 넣기 전에 한 번 PNG로 바꿔 두면 브라우저와 명령줄의 결과가 항상 같다.
//   node tools/to-png.mjs 파일1.jpg [파일2.jpg ...]   → 같은 폴더에 .png
import fs from 'node:fs';
import { decode, encodePng } from './image-io.mjs';
import path from 'node:path';
for (const f of process.argv.slice(2)) {
  const out = f.replace(/\.(jpe?g|bmp|gif|tiff?)$/i, '.png');
  fs.writeFileSync(out, encodePng(decode(path.resolve(f))));
  console.log(path.basename(f), '→', path.basename(out), (fs.statSync(out).size / 1e6).toFixed(1) + 'MB');
}
