"""쾌적 지표 계산 테스트: pythermalcomfort 4.8.1 교차 확인값, 기상청 불쾌지수 단계 경계"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
import comfort  # noqa: E402

# (ta, tr, vr, rh, met, clo, PMV, PPD): pythermalcomfort 4.8.1 pmv_ppd_iso(model='7730-2005') 결과(2026-11-20)
ISO_D1 = [
    (22, 22, 0.1, 60, 1.2, 0.5, -0.75, 16.9),
    (27, 27, 0.1, 60, 1.2, 0.5, 0.77, 17.3),
    (27, 27, 0.3, 60, 1.2, 0.5, 0.43, 8.9),
    (23.5, 25.5, 0.1, 60, 1.2, 0.5, -0.01, 5.0),
    (23.5, 25.5, 0.3, 60, 1.2, 0.5, -0.56, 11.5),
    (19, 18, 0.1, 40, 1.2, 1.0, -0.70, 15.2),
    (26, 26, 0.1, 55, 1.1, 0.5, 0.24, 6.2),
    (20, 20, 0.1, 40, 1.1, 1.0, -0.63, 13.4),
]


class Comfort(unittest.TestCase):
    def test_pmv_iso_table(self):
        for ta, tr, vr, rh, met, clo, pmv, ppd in ISO_D1:
            got = comfort.pmv_ppd(ta, tr, vr, rh, met, clo)
            self.assertAlmostEqual(got[0], pmv, delta=0.02, msg=(ta, tr, vr))
            self.assertAlmostEqual(got[1], ppd, delta=0.2, msg=(ta, tr, vr))

    def test_discomfort_index_stages(self):
        self.assertEqual(comfort.discomfort_index(30, 80), 82.9)
        self.assertEqual([comfort.di_stage(x) for x in (80, 79.9, 75, 68, 67.9)], ['매우 높음', '높음', '높음', '보통', '낮음'])


if __name__ == '__main__':
    unittest.main()
