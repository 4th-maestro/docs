"""도면 기호 찾기(op=match) 테스트: 합성 도면에 기호 사본(90도 회전 포함)과 다른 기호를 그려 찾기 결과와 입력 검사를 확인"""
import io
import pathlib
import sys
import unittest

import numpy as np
from botocore.exceptions import ClientError
from PIL import Image, ImageDraw

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import app  # noqa: E402
import match  # noqa: E402
from fixtures import FakeS3  # noqa: E402

KEY = 'jobs/j/pages/1.png'


def symbol():
    """가로 90, 세로 60px 비대칭 기호(테두리, 대각선, 한쪽 모서리 원): 90도 회전하면 가로세로가 바뀜"""
    im = Image.new('L', (90, 60), 255)
    d = ImageDraw.Draw(im)
    d.rectangle([2, 2, 87, 57], outline=0, width=4)
    d.line([8, 8, 60, 52], fill=0, width=4)
    d.ellipse([66, 10, 82, 26], fill=0)
    return np.asarray(im)


def page():
    """2,400×1,600px 흰 도면: 기호 0도 3개, 90도 3개(정답 상자)와 다른 모양 4개"""
    img = np.full((1600, 2400), 255, np.uint8)
    sym, truth = symbol(), []
    for x, y, r in [(200, 150, 0), (900, 300, 0), (1700, 1200, 0), (400, 900, 1), (1300, 700, 1), (2100, 200, 1)]:
        s = np.rot90(sym, r)
        img[y:y + s.shape[0], x:x + s.shape[1]] = s
        truth.append([x, y, x + s.shape[1], y + s.shape[0]])
    im = Image.fromarray(img)
    d = ImageDraw.Draw(im)
    d.ellipse([600, 1300, 660, 1360], outline=0, width=4)  # 원
    d.line([1900, 900, 1990, 900], fill=0, width=4)  # 십자
    d.line([1945, 870, 1945, 930], fill=0, width=4)
    d.text((1000, 1400), 'AC-01 7.2kW', fill=0)  # 문자
    for i in range(0, 90, 10):  # 빗금
        d.line([100 + i, 1400, 100 + i, 1460], fill=0, width=2)
    return np.asarray(im), truth


def png(img):
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, 'PNG')
    return buf.getvalue()


class FindTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.img, cls.truth = page()

    def near(self, box, boxes, tol=3):
        return next((b for b in boxes if all(abs(p - q) <= tol for p, q in zip(box, b))), None)

    def test_all_copies_found_with_rotated_box_and_no_distractor(self):
        out = match.find(self.img, self.truth[0], .35, True)
        self.assertEqual(len(out), 6, out)
        for t in self.truth:
            self.assertIsNotNone(self.near(t, [m['box'] for m in out]), t)  # 90도 사본은 가로세로가 바뀐 상자
        self.assertGreaterEqual(next(m for m in out if self.near(self.truth[0], [m['box']], 1))['score'], .99)  # 본 기호 자신 포함
        self.assertEqual([m['score'] for m in out], sorted((m['score'] for m in out), reverse=True))

    def test_without_rotation_only_upright_copies(self):
        out = match.find(self.img, self.truth[0], .35, False)
        self.assertEqual(len(out), 3, out)
        for t in self.truth[:3]:
            self.assertIsNotNone(self.near(t, [m['box'] for m in out]), t)

    def test_small_exemplar_is_not_upscaled(self):
        # 짧은 변 32px 이하 상자는 원본 화소 그대로 계산하고 상자도 원본 크기
        img = np.full((300, 300), 255, np.uint8)
        img[100:120, 100:120] = 0
        img[200:220, 40:60] = 0
        out = match.find(img, [95, 95, 125, 125], .9, True)
        self.assertEqual([m['box'] for m in out], [[95, 95, 125, 125], [35, 195, 65, 225]])

    def test_flat_box_rejected(self):
        with self.assertRaises(match.Invalid):
            match.find(self.img, [10, 10, 60, 60], .35, True)


class RunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.img, cls.truth = page()
        cls.s3 = FakeS3({KEY: png(cls.img), 'jobs/j/pages/2.png': b'not an image'})

    def call(self, **kw):
        app.s3 = self.s3
        return app.handler({'op': 'match', 'bucket': 'bk', 'key': KEY, 'box': self.truth[0], 'min': .35, 'rotate': True, **kw}, None)

    def test_handler_returns_matches_and_size(self):
        out = self.call()
        self.assertEqual(out['size'], [2400, 1600])
        self.assertEqual(len(out['matches']), 6)
        self.assertIsInstance(out['ms'], int)

    def test_validation(self):
        cases = [([0, 0, 7, 40], '8~400px'), ([0, 0, 401, 40], '8~400px'), ([2380, 10, 2420, 50], '밖'), ([-5, 10, 30, 50], '밖'),
                 ([10, 10, 60, 60], '선이 없습니다')]
        for box, text in cases:
            out = self.call(box=box)
            self.assertEqual(out['status'], 400, box)
            self.assertIn(text, out['error'])
        out = self.call(key='jobs/j/pages/2.png')
        self.assertEqual((out['status'], out['error']), (400, '도면 이미지 형식(PNG, JPEG)이 아닙니다.'))

    def test_missing_image_is_404(self):
        class Missing(FakeS3):
            def get_object(self, Bucket, Key):
                raise ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject')
        app.s3 = Missing()
        out = app.handler({'op': 'match', 'bucket': 'bk', 'key': KEY, 'box': self.truth[0]}, None)
        self.assertEqual(out['status'], 404)

    def test_pixel_cap(self):
        old, match.MAX_PX = match.MAX_PX, 1000
        try:
            self.assertEqual(self.call()['status'], 400)
        finally:
            match.MAX_PX = old


if __name__ == '__main__':
    unittest.main()
