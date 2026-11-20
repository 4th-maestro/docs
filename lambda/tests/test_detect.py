"""실내기 기호 인식 Lambda 테스트: 타일 위치, IoU·NMS, 타일 → 페이지 좌표, 축척 조정 후 원본 픽셀 환산(가짜 S3·Endpoint, 네트워크 없음)"""
import importlib.util
import io
import json
import os
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import detect  # noqa: E402

HAS_PIL = importlib.util.find_spec('PIL') is not None


def det(box, conf=0.9, cls='cassette_4way'):
    return {'cls': cls, 'conf': conf, 'box': box}


class TileTest(unittest.TestCase):
    def test_starts(self):
        self.assertEqual(detect.starts(500), [0])
        self.assertEqual(detect.starts(1400), [0])
        self.assertEqual(detect.starts(2400), [0, 1000])
        self.assertEqual(detect.starts(3000), [0, 1000, 1600])

    def test_tiles_cover_page_with_overlap(self):
        for n in (1, 1399, 1401, 2401, 5000, 6789):
            s = detect.starts(n)
            self.assertEqual(s[0], 0)
            self.assertEqual(min(s[-1] + detect.TILE, n), n)
            self.assertTrue(all(b - a <= detect.STEP for a, b in zip(s, s[1:])), n)  # 겹침 400px 이상
            self.assertTrue(all(0 <= x < n for x in s), n)


class NmsTest(unittest.TestCase):
    def test_iou(self):
        self.assertEqual(detect.iou([0, 0, 10, 10], [10, 0, 20, 10]), 0.0)
        self.assertAlmostEqual(detect.iou([0, 0, 10, 10], [5, 0, 15, 10]), 50 / 150)
        self.assertEqual(detect.iou([0, 0, 10, 10], [0, 0, 10, 10]), 1.0)

    def test_nms_keeps_highest_and_ignores_class(self):
        dets = [det([0, 0, 10, 10], 0.6), det([1, 0, 11, 10], 0.9, 'wall_mounted'), det([100, 100, 110, 110], 0.3)]
        self.assertEqual(detect.nms(dets), [dets[1], dets[2]])

    def test_nms_separates_doors_from_units(self):
        unit, door, door2 = det([0, 0, 10, 10], 0.6, 'wall_mounted'), det([1, 0, 11, 10], 0.9, 'door'), det([2, 0, 12, 10], 0.7, 'door')
        self.assertEqual(detect.nms([unit, door, door2]), [door, unit])

    def test_nms_threshold(self):
        # IoU 정확히 0.5는 남김(0.5 초과만 제거)
        a, b = det([0, 0, 30, 10], 0.9), det([10, 0, 40, 10], 0.8)
        self.assertAlmostEqual(detect.iou(a['box'], b['box']), 0.5)
        self.assertEqual(len(detect.nms([a, b])), 2)


class PageTest(unittest.TestCase):
    def test_tile_to_page_coordinates_and_overlap_dedup(self):
        # 페이지 2400×1000: 타일 (0,0)·(1000,0). 페이지 (1100~1150, 500~550)의 기호가 두 타일에서 모두 보임
        calls = []

        def infer(box):
            calls.append(box)
            x0, y0 = box[:2]
            return {'model': 'v3', 'size': [box[2] - x0, box[3] - y0],
                    'detections': [det([1100 - x0, 500 - y0, 1150 - x0, 550 - y0], 0.8 if x0 else 0.7)]}
        dets, model = detect.page_detections(2400, 1000, infer)
        self.assertEqual(calls, [(0, 0, 1400, 1000), (1000, 0, 2400, 1000)])
        self.assertEqual(model, 'v3')
        self.assertEqual(dets, [det([1100, 500, 1150, 550], 0.8)])


@unittest.skipUnless(HAS_PIL, 'Pillow 없음')
class HandlerTest(unittest.TestCase):
    def run_handler(self, img, event):
        from PIL import Image  # noqa: F401
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        tiles = []

        def invoke_endpoint(EndpointName, ContentType, Body):
            from PIL import Image
            tile = Image.open(io.BytesIO(Body))
            tiles.append((EndpointName, ContentType, tile.size, tile.getpixel((0, 0))))
            # 타일마다 왼쪽 위 (10, 20)~(90, 100)에 기호 1개
            out = {'model': 'v1', 'size': list(tile.size), 'detections': [det([10, 20, 90, 100])]}
            return {'Body': types.SimpleNamespace(read=lambda: json.dumps(out).encode())}
        detect._c.update(s3=types.SimpleNamespace(get_object=lambda Bucket, Key: {'Body': io.BytesIO(buf.getvalue())}),
                         **{'sagemaker-runtime': types.SimpleNamespace(invoke_endpoint=invoke_endpoint)})
        try:
            with patch.dict(os.environ, {'PLANS_BUCKET': 'bk'}):
                return detect.handler(event, None), tiles
        finally:
            detect._c.clear()

    def test_scale_to_80px_per_m_and_back(self):
        from PIL import Image
        # 원본 1500×600, 1m = 40px → 2배 확대 3000×1200 → 타일 x 0·1000·1600(3장)
        out, tiles = self.run_handler(Image.new('RGB', (1500, 600), 'white'), {'floor': '2F', 'imageKey': 'jobs/j/pages/2.png', 'pxPerM': 40})
        self.assertEqual([t[2] for t in tiles], [(1400, 1200)] * 3)
        self.assertEqual({t[:2] for t in tiles}, {('hvac-symbol-detector-sls', 'image/png')})
        self.assertEqual((out['floor'], out['model']), ('2F', 'v1'))
        # 확대 좌표 (x+10, 20)~(x+90, 100)을 원본 픽셀(1/2)로 환산
        self.assertEqual(sorted(d['box'] for d in out['detections']),
                         [[5.0, 10.0, 45.0, 50.0], [505.0, 10.0, 545.0, 50.0], [805.0, 10.0, 845.0, 50.0]])

    def test_unknown_scale_and_transparent_background(self):
        from PIL import Image
        out, tiles = self.run_handler(Image.new('RGBA', (800, 500), (0, 0, 0, 0)), {'floor': None, 'imageKey': 'uploads/j/a.png', 'pxPerM': None})
        self.assertEqual([(t[2], t[3]) for t in tiles], [((800, 500), (255, 255, 255))])
        self.assertEqual(out['detections'], [det([10.0, 20.0, 90.0, 100.0])])


if __name__ == '__main__':
    unittest.main()
