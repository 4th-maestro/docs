"""제어 규칙, JEV 선택지, 지표 계산 단위 테스트. 실행: python3 -m unittest test_control (EnergyPlus 불필요)"""
import datetime as dt
import unittest

import control as C
from run import score


def zone(people=0, in_min=None, sp=28):
    return {'people': people, 'next_use': None if in_min is None else {'in_min': in_min, 'people': 5, 'duration_min': 60}, 'setpoint_c': sp, 'mode': 'COOL'}


class Rule(unittest.TestCase):
    def test_precool_window(self):
        self.assertEqual(C.rule('cooling', zone(in_min=30)), ('COOL', 27))
        self.assertEqual(C.rule('cooling', zone(in_min=45)), ('COOL', 28))

    def test_step_limit(self):
        self.assertEqual(C.rule('cooling', zone(people=3, sp=28)), ('COOL', 27))
        self.assertEqual(C.rule('cooling', zone(people=3, sp=26)), ('COOL', 26))
        self.assertEqual(C.rule('heating', zone(people=0, sp=20)), ('HEAT', 19))


class Occupancy(unittest.TestCase):
    def test_now_and_next(self):
        mon_0945 = dt.datetime(2026, 8, 3, 9, 45)  # 월요일, 회의실 A 10:00~11:30
        self.assertEqual(C.occupancy('SPACE2-1', mon_0945), (0, {'in_min': 15, 'people': 5, 'duration_min': 90}))
        self.assertEqual(C.occupancy('SPACE2-1', mon_0945 + dt.timedelta(minutes=15))[0], 5)

    def test_weekend_next_is_monday(self):
        sat = dt.datetime(2026, 8, 8, 12, 0)
        self.assertEqual(C.occupancy('SPACE1-1', sat), (0, {'in_min': 45 * 60, 'people': 10, 'duration_min': 540}))


class Candidates(unittest.TestCase):
    def test_clip_to_range(self):
        self.assertEqual(sorted(C.candidates('cooling', 28)), ['COOL_27', 'COOL_28', 'FAN', 'OFF'])
        self.assertEqual(sorted(C.candidates('heating', 20)), ['FAN', 'HEAT_19', 'HEAT_20', 'HEAT_21', 'OFF'])
        self.assertEqual(C.candidates('cooling', 26)['COOL_25'][:2], ('COOL', 25))


class Score(unittest.TestCase):
    def test_tolerance_and_peak(self):
        base = {f'{z}.{k}': 0 for z in C.ZONES for k in ('temp', 'people')}
        rows = [{**base, 'hvac_kwh': 1.0, 'SPACE1-1.temp': 26.4, 'SPACE1-1.people': 5},  # 허용 오차 안
                {**base, 'hvac_kwh': 2.0, 'SPACE1-1.temp': 27.5, 'SPACE1-1.people': 5},  # 1.0℃ 초과
                {**base, 'hvac_kwh': 0.5, 'SPACE1-1.temp': 30.0}]  # 공실은 판정 제외
        s = score(rows, 'cooling')
        self.assertEqual((s['energy_kwh'], s['peak_kw'], s['energy_kwh_vacant']), (3.5, 8.0, 0.5))
        self.assertEqual((s['occupied_zone_h'], s['discomfort_zone_h'], s['discomfort_degree_h']), (0.5, 0.25, 0.25))
        self.assertEqual((s['cold_zone_h'], s['hot_zone_h']), (0, 0.25))


if __name__ == '__main__':
    unittest.main()
