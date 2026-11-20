"""synth.py 단위 테스트: python3 -m unittest ml/test_synth.py (Pillow 필요)."""
import os
import random
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import synth  # noqa: E402

ROOM = [(100, 100), (700, 100), (700, 600), (100, 600)]
WALLS = [[(88, 88), (712, 88), (712, 100), (88, 100)], [(88, 600), (712, 600), (712, 612), (88, 612)],
         [(88, 100), (100, 100), (100, 600), (88, 600)], [(700, 100), (712, 100), (712, 600), (700, 600)]]


def svg(rooms, walls):
    g = lambda c, p: f'<g class="{c}"><polygon points="{" ".join(f"{x},{y}" for x, y in p)}"/></g>'
    body = g('Space Bedroom', rooms) + ''.join(g('Wall', w) for w in walls)
    return f'<svg xmlns="http://www.w3.org/2000/svg">{body}</svg>'


class SynthTest(unittest.TestCase):
    def test_hvac_types_match_classes(self):
        import json
        types = json.load(open(os.path.join(os.path.dirname(__file__), 'hvac_types.json')))['types']
        self.assertEqual([t['class'] for t in types], synth.CLASSES)

    def test_parse_and_thickness(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, 'model.svg'), 'w').write(svg(ROOM, WALLS))
            rooms, walls = synth.parse(os.path.join(d, 'model.svg'))
        self.assertEqual(len(rooms), 1)
        self.assertEqual(len(walls), 4)
        self.assertAlmostEqual(synth.thickness(walls), 12, delta=1)

    def test_place_inside_room_without_overlap(self):
        n = 0
        for seed in range(200):
            syms = synth.place(random.Random(seed), [('Space Bedroom', ROOM)], 12)
            for k, (x0, y0, x1, y1), side in syms:
                self.assertTrue(100 <= x0 < x1 <= 700 and 100 <= y0 < y1 <= 600, (k, seed))
                self.assertEqual(side is None, k not in synth.ON_WALL and k != 1)
            boxes = [b for _, b, _ in syms]
            for i, b in enumerate(boxes):
                self.assertTrue(synth.apart(b, boxes[:i] + boxes[i + 1:], 0))
            n += len(syms)
        self.assertGreater(n, 100)

    def test_draw_all_classes_and_styles(self):
        from PIL import ImageDraw
        for style in ('std', 'kr'):
            for k in range(len(synth.CLASSES)):
                for side in range(4):
                    im = Image.new('RGB', (300, 300), 'white')
                    d = ImageDraw.Draw(im)
                    box = (100, 120, 190, 160) if side % 2 == 0 else (130, 100, 170, 190)
                    synth.draw(d, k, box, side, (0, 0, 0), 2, 12, style)
                    if style == 'kr':
                        synth.context(d, random.Random(k * 4 + side), box, (0, 0, 0))
                    # 기호 상자 안 어두운 픽셀 존재 확인
                    self.assertLess(min(im.crop(box).convert('L').getdata()), 50, (style, k, side))

    def test_make_writes_normalized_labels(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as out:
            os.makedirs(os.path.join(src, 'hq', '1'))
            open(os.path.join(src, 'hq', '1', 'model.svg'), 'w').write(svg(ROOM, WALLS))
            Image.new('RGB', (800, 700), 'white').save(os.path.join(src, 'hq', '1', 'F1_scaled.png'))
            for sub in ('images', 'labels'):
                os.makedirs(os.path.join(out, sub, 'train'))
            rows = []
            for seed in range(10):
                _, ks, err = synth.make((src, '/hq/1/', 'train', out, seed))
                self.assertIsNone(err)
                rows += open(os.path.join(out, 'labels', 'train', 'hq_1.txt')).read().split('\n')[:len(ks)]
            self.assertTrue(rows)
            # 방 다각형이 이미지(가로 400px) 밖까지 있는 도면도 오류 없이 범위 안 라벨만 기록
            Image.new('RGB', (400, 700), 'white').save(os.path.join(src, 'hq', '1', 'F1_scaled.png'))
            for seed in range(10):
                _, ks, err = synth.make((src, '/hq/1/', 'train', out, seed))
                self.assertIsNone(err)
                rows += open(os.path.join(out, 'labels', 'train', 'hq_1.txt')).read().split('\n')[:len(ks)]
            for r in rows:
                k, *v = r.split()
                self.assertIn(int(k), range(len(synth.CLASSES)))
                self.assertTrue(all(0 <= float(x) <= 1 for x in v))


if __name__ == '__main__':
    unittest.main()
