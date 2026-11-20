"""inference.py 후처리 테스트: python3 -m unittest ml/serve/test_inference.py (numpy, opencv-python-headless 필요, 모델 불필요)."""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import inference  # noqa: E402


class FakeSession:
    """앵커 3개: 같은 클래스 중복 1쌍(NMS로 1개 제거)과 다른 클래스 1개를 레터박스 좌표로 반환."""

    def __init__(self, out):
        self.out = out

    def get_inputs(self):
        return [type('I', (), {'name': 'images'})()]

    def run(self, _, feed):
        assert feed['images'].shape == (1, 3, inference.IMGSZ, inference.IMGSZ)
        return [self.out[None]]


class InferenceTest(unittest.TestCase):
    def test_letterbox_coordinates_and_nms(self):
        im = np.full((500, 1000, 3), 255, np.uint8)  # 가로 1000, 세로 500: 축소 비율 1.024, 위아래 여백 256px
        x, r, left, top = inference.letterbox(im)
        self.assertAlmostEqual(r, 1.024)
        self.assertEqual((left, top), (0, 256))
        # 원본 (100, 100)~(200, 150) 상자를 레터박스 좌표 중심·크기로 변환
        cx, cy, w, h = 150 * r, 125 * r + top, 100 * r, 50 * r
        out = np.zeros((4 + 6, 3), np.float32)
        out[:4, 0] = [cx, cy, w, h]
        out[:4, 1] = [cx + 2, cy, w, h]  # 같은 클래스 중복
        out[:4, 2] = [cx, cy, w, h]
        out[4, 0], out[4, 1], out[9, 2] = 0.9, 0.8, 0.6  # 클래스 0 두 개, 클래스 5 한 개
        model = {'sess': FakeSession(out), 'names': {i: f'c{i}' for i in range(6)}, 'version': 't'}
        res = inference.predict_fn(im, model)
        self.assertEqual(res['size'], [1000, 500])
        self.assertEqual(sorted(d['cls'] for d in res['detections']), ['c0', 'c5'])
        top1 = res['detections'][0]
        self.assertEqual(top1['conf'], 0.9)
        np.testing.assert_allclose(top1['box'], [100, 100, 200, 150], atol=0.2)

    def test_rejects_unknown_type(self):
        with self.assertRaises(ValueError):
            inference.input_fn(b'abc', 'text/plain')


if __name__ == '__main__':
    unittest.main()
