"""DDPG 행동 변환·보상 단위 테스트. 실행: python3 -m unittest test_ddpg (numpy 필요, EnergyPlus 불필요)"""
import datetime as dt
import unittest

from ddpg import days_in, reward, setpoints


class Ddpg(unittest.TestCase):
    def test_setpoints_range_and_step_limit(self):
        # -1 → 23℃, 1 → 28℃, 0 → 25.5℃. 현재 설정 대비 ±1℃ 제한
        self.assertEqual(setpoints([-1, 1, 0, 0], [28, 26, 25, 25.2], (23, 28)), [27, 27, 25.5, 25.5])

    def test_reward_only_occupied_deviation(self):
        r = reward(1.25, [(27.0, 5), (30.0, 0), (23.5, 2)], (24, 26), 2.0)
        self.assertAlmostEqual(r, -0.5 - 2.0 * (1.0 + 0.5))

    def test_days_in(self):
        self.assertEqual(len(days_in([('2026-06-01', '2026-07-12')])), 42)
        self.assertEqual(days_in([('2026-12-31', '2026-12-31')]), [dt.date(2026, 12, 31)])


if __name__ == '__main__':
    unittest.main()
