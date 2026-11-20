"""IFC 평가 세트: 공조 급기구 좌표를 실내기 기호로 치환한 평면도 타일과 YOLO 라벨 생성.

사용: python3 ifc_eval.py <ifc_extract.py 출력 JSON> <출력 폴더>
  입력 JSON: docs/reports/tools/ifc_extract.py 결과(spaces, terms)
  출력: images/test, labels/test, data.yaml(학습과 같은 클래스)
학습에는 사용하지 않음. 벽 정보가 없어 천장형 3종만 배치하고, 환기구·배기구는 라벨 없는 기호로 그림
"""
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFont

import synth

PX = 80  # 1m당 픽셀: CubiCasa5K 평면도와 비슷한 축척
TILE = 1400
T = 0.12 * PX  # synth.SIZE의 기준 벽 두께(0.12m)
CEILING = [0, 1, 3]
INK = (0, 0, 0)


def render(spaces, terms, rng):
    pts = [p for s in spaces for poly in s['coords'] for p in poly]
    x0, y1 = min(p[0] for p in pts) - 2, max(p[1] for p in pts) + 2
    W, H = int((max(p[0] for p in pts) + 2 - x0) * PX), int((y1 - min(p[1] for p in pts) + 2) * PX)
    px = lambda x, y: ((x - x0) * PX, (y1 - y) * PX)  # 도면 y축 위쪽 → 이미지 y축 아래쪽
    im = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(im)
    font = ImageFont.load_default(size=22)
    for s in spaces:
        for poly in s['coords']:
            d.polygon([px(*p) for p in poly], outline=INK, width=3)
        ring = s['coords'][0]
        d.text(px(sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)), s['name'][:18], fill=INK, font=font, anchor='mm')
    boxes = []
    for t in terms:
        cx, cy = px(t['x'], t['y'])
        if 'Supply Diffuser' not in t['name']:
            r = 0.3 * PX  # 600mm 환기구·배기구: 정사각형과 대각선 1개
            d.rectangle((cx - r, cy - r, cx + r, cy + r), outline=INK, width=2)
            d.line([(cx - r, cy + r), (cx + r, cy - r)], fill=INK, width=2)
            continue
        k = rng.choice(CEILING)
        L, D = (v * T for v in synth.SIZE[k](rng))
        w, h = (L, D) if rng.random() < 0.5 else (D, L)
        box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
        if synth.apart(box, [b for _, b in boxes], 0):
            synth.draw(d, k, box, rng.randrange(4), INK, 2, T)
            boxes.append((k, box))
    return im, boxes


def main():
    src, out = sys.argv[1:3]
    data = json.load(open(src))
    rng = random.Random(0)
    for sub in ('images', 'labels'):
        os.makedirs(os.path.join(out, sub, 'test'), exist_ok=True)
    n = {'tiles': 0, 'boxes': 0}
    for storey in ('First Floor', 'Second Floor'):
        spaces = [s for s in data['spaces'] if s['storey'] == storey]
        z = spaces[0]['z']
        # 같은 층 높이 범위(바닥 -0.5~+4.5m)의 단말만 사용: ifc-sample-feasibility.md 3절과 같은 기준
        im, boxes = render(spaces, [t for t in data['terms'] if z - 0.5 <= t['z'] <= z + 4.5], rng)
        for ty in range(0, im.height, TILE):
            for tx in range(0, im.width, TILE):
                tile = im.crop((tx, ty, tx + TILE, ty + TILE))
                if tile.convert('L').point(lambda v: 255 - v).getbbox() is None:
                    continue
                rows = []
                for k, (a, b, c, e) in boxes:
                    ca, cb, cc, ce = max(a, tx), max(b, ty), min(c, tx + TILE), min(e, ty + TILE)
                    # 타일 경계에서 60% 이상 보이는 기호만 라벨
                    if cc > ca and ce > cb and (cc - ca) * (ce - cb) >= 0.6 * (c - a) * (e - b):
                        rows.append(f'{k} {((ca + cc) / 2 - tx) / TILE:.6f} {((cb + ce) / 2 - ty) / TILE:.6f} {(cc - ca) / TILE:.6f} {(ce - cb) / TILE:.6f}')
                name = f"clinic_{storey.split()[0].lower()}_{ty // TILE}_{tx // TILE}"
                tile.save(os.path.join(out, 'images', 'test', name + '.png'))
                with open(os.path.join(out, 'labels', 'test', name + '.txt'), 'w') as f:
                    f.write('\n'.join(rows) + ('\n' if rows else ''))
                n['tiles'] += 1
                n['boxes'] += len(rows)
    with open(os.path.join(out, 'data.yaml'), 'w') as f:
        f.write('train: images/test\nval: images/test\ntest: images/test\nnames:\n' + ''.join(f'  {i}: {c}\n' for i, c in enumerate(synth.CLASSES)))
    print(json.dumps(n))


if __name__ == '__main__':
    main()
