"""에너지 분석 API 테스트: 응답 형식·길이, 합계 일치, 요금 계산, 잘못된 인자 400, 캐시, 정지 시간 생략, 표본 오차"""
import datetime as dt
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import buildings  # noqa: E402
import energy  # noqa: E402
import sim  # noqa: E402

NOW = dt.datetime(2026, 11, 20, 15, 10, tzinfo=sim.KST)  # 금요일 15:10, 지난달은 31일


def call(path, now=NOW, schedules=(), **q):
    with patch.object(sim, 'now', return_value=now), patch.object(energy.common, 'list_schedules', return_value=list(schedules)):
        r = energy.handler({'routeKey': f'GET {path}', 'queryStringParameters': q or None}, None)
    return r['statusCode'], json.loads(r['body'])


class CompareTest(unittest.TestCase):
    def test_shape_cost_and_area(self):
        for period in ('day', 'month'):
            code, body = call('/energy/compare', period=period)
            self.assertEqual(code, 200)
            self.assertEqual((body['period'], body['virtual'], body['unitPriceKrw']), (period, True, energy.UNIT_PRICE_KRW))
            self.assertEqual([i['buildingId'] for i in body['items']], [b['id'] for b in buildings.LIST])
            for i in body['items']:
                self.assertGreater(i['kwh'], 0)
                self.assertGreater(i['prevKwh'], 0)
                self.assertEqual(i['costKrw'], round(i['kwh'] * energy.UNIT_PRICE_KRW))
                self.assertEqual(i['kwhPerM2'], round(i['kwh'] / i['areaM2'], 3))

    def test_month_covers_day(self):
        day = {i['buildingId']: i['kwh'] for i in call('/energy/compare', period='day')[1]['items']}
        for i in call('/energy/compare', period='month')[1]['items']:
            self.assertGreater(i['kwh'], day[i['buildingId']])


class TrendTest(unittest.TestCase):
    def test_lengths_and_labels(self):
        cases = {'day': (16, 24, '0시'), 'week': (5, 7, '월'), 'month': (20, 31, '1일')}
        for period, (n_cur, n_prev, first) in cases.items():
            code, body = call('/energy/trend', building='office', period=period)
            self.assertEqual(code, 200)
            self.assertEqual((len(body['current']), len(body['previous'])), (n_cur, n_prev))
            self.assertEqual((body['current'][0]['label'], body['unit']), (first, 'kWh'))
            self.assertAlmostEqual(body['totalKwh'], sum(p['kwh'] for p in body['current']), delta=0.05)
            self.assertAlmostEqual(body['prevTotalKwh'], sum(p['kwh'] for p in body['previous']), delta=0.05)
            self.assertLess(body['prevSameKwh'], body['prevTotalKwh'])
        self.assertEqual([p['label'] for p in call('/energy/trend', period='week')[1]['previous']], list('월화수목금토일'))

    def test_default_building_is_main(self):
        self.assertEqual(call('/energy/trend')[1]['building'], 'main')


class HeatmapTest(unittest.TestCase):
    def test_grid_and_hours(self):
        code, body = call('/energy/heatmap', building='main')
        self.assertEqual(code, 200)
        self.assertEqual((len(body['cells']), {len(r) for r in body['cells']}), (7, {24}))
        self.assertEqual((body['weeks'], body['unit'], body['hours'], body['weekend']), (4, 'kW', [9, 18], False))
        self.assertEqual(body['max'], max(map(max, body['cells'])))
        # 평일 운영 시간 평균이 새벽 3시보다 큼
        self.assertGreater(body['cells'][2][10], body['cells'][2][3])


class BreakdownTest(unittest.TestCase):
    def test_sums_match_total(self):
        for period in ('day', 'week', 'month'):
            code, body = call('/energy/breakdown', building='office', period=period)
            self.assertEqual(code, 200)
            self.assertEqual([f['floor'] for f in body['floors']], buildings.floors('office'))
            self.assertAlmostEqual(sum(f['kwh'] for f in body['floors']), body['totalKwh'], delta=0.05 * len(body['floors']))
            for f in body['floors']:
                self.assertAlmostEqual(sum(u['kwh'] for u in f['uses']), f['kwh'], delta=0.05 * len(f['uses']))
                self.assertEqual(f['uses'], sorted(f['uses'], key=lambda u: -u['kwh']))

    def test_day_total_matches_trend(self):
        trend = call('/energy/trend', building='edu', period='day')[1]['totalKwh']
        self.assertAlmostEqual(call('/energy/breakdown', building='edu', period='day')[1]['totalKwh'], trend, delta=1.2)


class ParamTest(unittest.TestCase):
    def test_bad_params_400(self):
        for path, q in [('/energy/trend', {'building': 'nope'}), ('/energy/trend', {'period': 'year'}),
                        ('/energy/compare', {'period': 'week'}), ('/energy/breakdown', {'period': 'hour'}),
                        ('/energy/heatmap', {'weeks': '0'}), ('/energy/heatmap', {'weeks': '9'}), ('/energy/heatmap', {'weeks': 'x'})]:
            code, body = call(path, **q)
            self.assertEqual(code, 400, (path, q))
            self.assertTrue(body['error'])

    def test_unknown_route_404(self):
        self.assertEqual(call('/energy/nope')[0], 404)


class CacheTest(unittest.TestCase):
    def test_cache_returns_same_values(self):
        energy._past.cache_clear()
        first = call('/energy/trend', building='lab', period='month')[1]
        hits = energy._past.cache_info().hits
        second = call('/energy/trend', building='lab', period='month')[1]
        self.assertEqual(first, second)
        self.assertGreaterEqual(energy._past.cache_info().hits - hits, 50)

    def test_schedule_applies_after_created_and_to_its_building(self):
        rooms = [r['id'] for r in buildings.rooms('main')]
        off = {'id': 's1', 'roomIds': rooms, 'action': 'off', 'time': '00:00', 'condition': 'always', 'createdAt': '2026-11-19T12:00:00+09:00'}
        d18, d19 = dt.date(2026, 11, 18), dt.date(2026, 11, 19)
        self.assertEqual(energy._hourly('main', d18, [off], NOW), energy._hourly('main', d18, [], NOW))
        after = energy._hourly('main', d19, [off], NOW)
        self.assertEqual(sum(after[12:]), 0)
        self.assertGreater(sum(after[:12]), 0)
        other = {**off, 'buildingId': 'office'}
        self.assertEqual(energy._hourly('main', d19, [other], NOW), energy._hourly('main', d19, [], NOW))


class SkipTest(unittest.TestCase):
    def test_skipped_rooms_are_really_off(self):
        # 정지 시간 생략 규칙(sim.state 운전 규칙 복제)이 전체 호출 결과와 같은지 확인: 평일과 일요일
        for bid, rooms in energy._ROOMS.items():
            for day in (dt.date(2026, 11, 18), dt.date(2026, 11, 22)):
                fast = energy._compute(bid, day, [])
                full = {g: [0.0] * 24 for g in fast}
                for h in range(24):
                    ts = dt.datetime.combine(day, dt.time(h, 30), sim.KST)
                    for r in rooms:
                        full[(r['floor'], r['use'])][h] += sim.state(r, ts)['powerKw']
                for g in fast:
                    for a, b in zip(fast[g], full[g]):
                        self.assertAlmostEqual(a, b, places=9, msg=(bid, day, g))


class SamplingTest(unittest.TestCase):
    def test_half_hour_sample_within_1pct_of_5min(self):
        day, rooms = dt.date(2026, 11, 18), energy._ROOMS['main']
        fast = sum(map(sum, energy._compute('main', day, []).values()))
        ref = sum(sim.state(r, dt.datetime.combine(day, dt.time(h, m), sim.KST))['powerKw']
                  for h in range(24) for m in range(0, 60, 5) for r in rooms) / 12
        self.assertAlmostEqual(fast / ref, 1, delta=0.01)


if __name__ == '__main__':
    unittest.main()
