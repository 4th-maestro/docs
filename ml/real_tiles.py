"""실제 도면 라벨(real_labels/*.json)과 PDF로 YOLO 타일 생성. 축척을 1m당 80px(ifc_eval.py와 같음)로 맞춘 뒤 1400px 타일로 자름.

사용: python3 real_tiles.py OUT 라벨.json=도면.pdf [라벨.json=도면.pdf ...] [--split test]
  --split: 라벨 파일의 split 값을 덮어씀. test로 만들 때는 같은 실내기 배치를 다시 그린 쪽(dup)을 제외
의존성: Pillow, poppler(pdftoppm)
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageStat

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth import CLASSES  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
PX = 80  # 1m당 픽셀
TILE, STEP = 1400, 1000
VISIBLE = 0.6  # 타일 안에 60% 이상 보이는 기호만 라벨


def tiles(im, boxes):
    """(타일 원점, 라벨 행 목록) 생성. boxes: [(클래스 번호, x0, y0, x1, y1)] 이미지 좌표."""
    W, H = im.size
    xs = list(range(0, max(W - TILE, 0) + 1, STEP)) + ([W - TILE] if W > TILE and (W - TILE) % STEP else [])
    ys = list(range(0, max(H - TILE, 0) + 1, STEP)) + ([H - TILE] if H > TILE and (H - TILE) % STEP else [])
    for y in ys:
        for x in xs:
            rows = []
            for k, b0, b1, b2, b3 in boxes:
                c0, c1, c2, c3 = max(b0, x), max(b1, y), min(b2, x + TILE), min(b3, y + TILE)
                if c2 > c0 and c3 > c1 and (c2 - c0) * (c3 - c1) >= VISIBLE * (b2 - b0) * (b3 - b1):
                    v = ((c0 + c2) / 2 - x) / TILE, ((c1 + c3) / 2 - y) / TILE, (c2 - c0) / TILE, (c3 - c1) / TILE
                    rows.append(f'{k} ' + ' '.join(f'{t:.6f}' for t in v))
            yield (x, y), rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('pairs', nargs='+', help='라벨.json=도면.pdf')
    ap.add_argument('--split')
    a = ap.parse_args()
    stats = {}
    for pair in a.pairs:
        lab_path, pdf = pair.split('=', 1)
        lab = json.load(open(lab_path))
        split = a.split or lab['split']
        for sub in ('images', 'labels'):
            os.makedirs(os.path.join(a.out, sub, split), exist_ok=True)
        name = os.path.splitext(os.path.basename(lab_path))[0]
        with tempfile.TemporaryDirectory() as tmp:
            for no, pg in lab['pages'].items():
                if split == 'test' and pg.get('dup'):
                    continue
                subprocess.run(['pdftoppm', '-r', str(lab['dpi']), '-png', '-f', no, '-l', no, '-singlefile', pdf, f'{tmp}/p'], check=True)
                im = Image.open(f'{tmp}/p.png').convert('RGB')
                area = pg.get('area') or [0, 0, im.width, im.height]  # area가 없으면 쪽 전체
                im = im.crop(area)
                f = PX / (lab['dpi'] / 0.0254 / pg['scale'])  # 도면 축척 1/scale을 1m당 PX로 변환
                im = im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)
                ax, ay = area[:2]
                boxes = [(CLASSES.index(c), (x0 - ax) * f, (y0 - ay) * f, (x1 - ax) * f, (y1 - ay) * f) for x0, y0, x1, y1, c in pg['boxes']]
                for (x, y), rows in tiles(im, boxes):
                    t = im.crop((x, y, x + TILE, y + TILE))
                    if not rows and ImageStat.Stat(t.convert('L')).stddev[0] < 8:  # 빈 여백 타일 제외
                        continue
                    stem = f'{name}_p{no}_{x}_{y}'
                    t.save(os.path.join(a.out, 'images', split, stem + '.png'))
                    with open(os.path.join(a.out, 'labels', split, stem + '.txt'), 'w') as fo:
                        fo.write('\n'.join(rows) + ('\n' if rows else ''))
                    s = stats.setdefault(split, {'tiles': 0, 'labels': 0})
                    s['tiles'] += 1
                    s['labels'] += len(rows)
    print(json.dumps(stats))


if __name__ == '__main__':
    main()
