"""사용 빈도 테스트: usage.py 계산, 추천 근거(frequency), 챗봇 usage_frequency 도구(python -m unittest discover tests)"""
import datetime as dt
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import buildings  # noqa: E402
import recommend  # noqa: E402
import sim  # noqa: E402
import tools  # noqa: E402
import usage  # noqa: E402

T = dt.datetime(2026, 11, 20, 14, 0, tzinfo=sim.KST)  # 금요일 14시
ROOM = buildings.rooms('main')[0]
ARGS = {'floor': 'all', 'use': 'all', 'weekday': 'today', 'hour': -1, 'focus': 'rooms', 'order': 'asc', 'limit': 5}


class UsageTest(unittest.TestCase):
    def setUp(self):
        usage._day.cache_clear()

    def test_profile_matches_sim(self):
        p = usage.profile(ROOM, T, [])
        days = [T.replace(hour=0) - dt.timedelta(days=7 * w) for w in range(1, 5)]
        self.assertTrue(all(d.weekday() == T.weekday() for d in days))
        for h in range(24):
            states = [sim.state(ROOM, d.replace(hour=h, minute=30), []) for d in days]
            self.assertEqual(p['usedWeeks'][h], sum(s['occupants'] > 0 for s in states))
            self.assertEqual(p['idleOnWeeks'][h], sum(s['onOff'] and s['occupants'] == 0 for s in states))
            self.assertEqual(p['usageRate'][h], round(p['usedWeeks'][h] / 4, 2))
        self.assertEqual(p['weekday'], '금')

    def test_excludes_today(self):
        # 오늘 재실이 바뀌어도 결과는 같음(지난 같은 요일만 사용)
        before = usage.profile(ROOM, T, [])['usedWeeks']
        usage._day.cache_clear()
        real = sim.occupants
        with patch.object(sim, 'occupants', lambda r, t: 99 if t.date() == T.date() else real(r, t)):
            self.assertEqual(usage.profile(ROOM, T, [])['usedWeeks'], before)
        usage._day.cache_clear()
        with patch.object(sim, 'occupants', lambda r, t: 99 if t.date() == T.date() else 0):
            self.assertEqual(sum(usage.profile(ROOM, T, [])['usedWeeks']), 0)

    def test_schedule_changes_idle_rate(self):
        # 하루 종일 끄기 스케줄을 넣으면 빈 채 운전이 0(캐시 키에 스케줄 포함)
        off = [{'id': 's1', 'roomIds': [ROOM['id']], 'action': 'off', 'time': '00:00', 'condition': 'always'}]
        self.assertEqual(sum(usage.profile(ROOM, T, off)['idleOnWeeks']), 0)

    def test_at_and_sentence(self):
        f = usage.at(ROOM, T, [])
        self.assertEqual((f['hour'], f['weeks'], f['weekday']), (14, 4, '금'))
        s = usage.sentence(f)
        self.assertIn('최근 4주 같은 요일(금) 14시대에 사용한 날', s)
        self.assertIn(f"{f['usedWeeks']}/4회", s)
        self.assertEqual(usage.sentence({**f, 'idleOnWeeks': 0}).count('빈 채'), 0)

    def test_baseline_matches_sim(self):
        days = [T.replace(hour=0) - dt.timedelta(days=7 * w) for w in range(1, 5)]
        on = [s for s in (sim.state(ROOM, d.replace(hour=14, minute=30), []) for d in days) if s['onOff']]
        b = usage.baseline(ROOM, T, [])
        self.assertEqual(b['onWeeks'], len(on))
        self.assertEqual(b['onAvgKw'], round(sum(s['powerKw'] for s in on) / len(on), 2) if on else None)
        self.assertEqual(b['onMaxOccupants'], max((s['occupants'] for s in on), default=0))
        self.assertEqual(usage.baseline(ROOM, T, [], hour=3)['onWeeks'], 0)  # 새벽은 평소 꺼짐

    def test_baseline_ignores_schedules_created_later(self):
        # 오늘 만든 켜기 스케줄은 지난 같은 요일에 없던 것으로 계산(sim은 스케줄을 날짜 구분 없이 적용)
        on = {'id': 's1', 'roomIds': [ROOM['id']], 'action': 'on', 'time': '00:00', 'condition': 'always'}
        self.assertEqual(usage.baseline(ROOM, T, [{**on, 'createdAt': T.isoformat()}], hour=3)['onWeeks'], 0)
        self.assertEqual(usage.baseline(ROOM, T, [{**on, 'createdAt': '2026-09-01T00:00:00+09:00'}], hour=3)['onWeeks'], 4)
        self.assertEqual(usage.baseline(ROOM, T, [on], hour=3)['onWeeks'], 4)  # createdAt 없으면 예전부터 있던 것으로 봄

    def test_busy_and_peak_hours(self):
        rates = [0] * 24
        rates[9:12] = [0.75, 1.0, 0.5]
        rates[15] = 0.25
        rates[23] = 0.5
        self.assertEqual(usage.busy_hours(rates), [{'from': 9, 'to': 12}, {'from': 23, 'to': 24}])
        self.assertEqual(usage.peak_hours(rates), [9, 10, 11])
        self.assertEqual(usage.peak_hours([0] * 24), [])


class RecommendFrequencyTest(unittest.TestCase):
    def test_items_have_frequency_reason(self):
        items = recommend.recommend(buildings.rooms('main'), T, [])
        self.assertGreater(len(items), 0)
        for i in items:
            f = i['frequency']
            self.assertEqual(f, usage.at(buildings.BY_ROOM[i['roomId']], T, []))
            self.assertTrue(i['reason'].endswith(usage.sentence(f) + '.'))


class ToolTest(unittest.TestCase):
    def run_tool(self, **kw):
        return tools.run('usage_frequency', {**ARGS, **kw}, T, [], 'main')

    def test_defined_with_strict_schema(self):
        d = next(x for x in tools.definitions() if x['name'] == 'usage_frequency')
        self.assertTrue(d['strict'])
        self.assertEqual(d['input_schema']['properties']['weekday']['enum'], ['today'] + list('월화수목금토일'))

    def test_rooms_ascending(self):
        out, view = self.run_tool(limit=5)
        rates = [x['usageRate'] for x in out['items']]
        self.assertEqual(rates, sorted(rates))
        self.assertEqual((out['hour'], out['weekday'], out['weeks']), (14, '금', 4))
        self.assertEqual(len(view['highlight']), 5)
        self.assertEqual(view['chart']['unit'], '%')
        name = out['items'][0]['name']
        room = next(r for r in buildings.rooms('main') if r['name'] == name)
        self.assertEqual(out['items'][0]['usedWeeks'], usage.profile(room, T, [])['usedWeeks'][14])

    def test_rooms_descending_floor_filter(self):
        f = buildings.floors('main')[0]
        out, _ = self.run_tool(order='desc', floor=f, hour=10, limit=20)
        self.assertTrue(all(x['floor'] == f for x in out['items']))
        rates = [x['usageRate'] for x in out['items']]
        self.assertEqual(rates, sorted(rates, reverse=True))
        self.assertEqual(out['hour'], 10)

    def test_weekday_goes_back_to_that_day(self):
        out, _ = self.run_tool(weekday='수')  # 금요일 기준 가장 가까운 수요일(이틀 전)
        self.assertEqual(out['weekday'], '수')
        wed = T - dt.timedelta(days=2)
        name = out['items'][0]['name']
        room = next(r for r in buildings.rooms('main') if r['name'] == name)
        self.assertEqual(out['items'][0]['usedWeeks'], usage.profile(room, wed, [])['usedWeeks'][14])

    def test_hours_focus(self):
        out, view = self.run_tool(focus='hours', use='회의실')
        self.assertEqual(len(out['usageRate']), 24)
        self.assertEqual(len(out['buildingAvgKw']), 24)
        self.assertTrue(all(out['usageRate'][h] == 0 for h in range(9)))  # 운영 시간 전은 0
        self.assertEqual(out['peakHours'], usage.peak_hours(out['usageRate']))
        self.assertEqual(view['chart']['kind'], 'line')
        self.assertNotIn('highlight', view)

    def test_bad_args(self):
        for kw in ({'weekday': '월요일'}, {'hour': 24}, {'hour': 1.5}, {'focus': 'days'}, {'order': 'up'}, {'floor': '99F'}):
            with self.subTest(kw=kw), self.assertRaises(ValueError):
                self.run_tool(**kw)

    def test_chips(self):
        chips = tools.chips('usage_frequency', {**ARGS, 'weekday': '금', 'hour': 19})
        self.assertIn('최근 4주 사용 빈도', chips)
        self.assertIn('금요일', chips)
        self.assertIn('19시', chips)


if __name__ == '__main__':
    unittest.main()
