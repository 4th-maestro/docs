"""AI 답변 그래프: 도구 결과와 그래프 숫자 일치, 표 선호, 스케줄 전후 비교 검증"""
import datetime as dt
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import common  # noqa: E402
import sim  # noqa: E402
import tools  # noqa: E402

T = dt.datetime(2026, 11, 18, 14, 0, tzinfo=sim.KST)


class ChartTest(unittest.TestCase):
    def setUp(self):
        self.orig = common.list_schedules
        common.list_schedules = lambda: []

    def tearDown(self):
        common.list_schedules = self.orig

    def test_ranking_bar_matches_result(self):
        out, view = tools.run('query_spaces', {'floor': '1F', 'use': 'all', 'metric': 'powerKw', 'order': 'desc', 'limit': 5, 'view': 'auto'}, T, [], 'main')
        c = view['chart']
        self.assertEqual(c['kind'], 'bar')
        self.assertEqual([i['value'] for i in c['items']], [r['powerKw'] for r in out['rooms']])
        self.assertNotIn('prefer', c)

    def test_aggregate_by_floor_sums(self):
        out, view = tools.run('aggregate_spaces', {'floor': 'all', 'use': 'all', 'group_by': 'floor', 'metric': 'powerKw', 'view': 'table'}, T, [], 'office')
        self.assertEqual([g['group'] for g in out['groups']], ['1F', '2F', '3F'])
        total = round(sum(sim.state(r, T)['powerKw'] for r in tools.buildings.rooms('office')), 1)
        self.assertAlmostEqual(sum(g['value'] for g in out['groups']), total, delta=0.2)
        self.assertEqual(view['chart']['prefer'], 'table')

    def test_trend_line_has_two_series(self):
        out, view = tools.run('energy_trend', {'period': 'day', 'view': 'auto'}, T, [], 'main')
        c = view['chart']
        self.assertEqual((c['kind'], len(c['labels'])), ('line', 24))
        self.assertEqual([s['role'] for s in c['series']], ['previous', 'current'])
        self.assertEqual(sum(v for v in c['series'][1]['values'] if v is not None), sum(p['kwh'] for p in out['current']))
        self.assertEqual(out['changePct'], round((out['currentTotal'] - out['previousSamePoint']) / out['previousSamePoint'] * 100, 1))
        self.assertIn(f"{out['changePct']:+}%", c['note'])

    def test_schedule_effect_and_saving_consistent(self):
        args = {'floor': '1F', 'use': 'all', 'action': 'off', 'time': '13:00', 'condition': 'always', 'setpoint': 0}
        _, view = tools.run('create_schedule', args, T, [], 'main')
        before, after = (s['values'] for s in view['chart']['series'])
        self.assertEqual(before[:13], after[:13])
        self.assertTrue(all(a == 0 for a in after[13:]))
        self.assertAlmostEqual(view['draft']['estimatedSavingKwh'], round(sum(b - a for b, a in zip(before[13:], after[13:])), 1), delta=0.1)

    def test_bad_period_rejected(self):
        with self.assertRaises(ValueError):
            tools.run('energy_trend', {'period': 'year', 'view': 'auto'}, T, [], 'main')


if __name__ == '__main__':
    unittest.main()
