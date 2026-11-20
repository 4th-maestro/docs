"""운영 패널 API 테스트: 추천 규칙, 이상 감지 상세, 전력 추이, 스케줄 취소(python -m unittest discover tests)"""
import datetime as dt
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import anomalies  # noqa: E402
import history  # noqa: E402
import recommend  # noqa: E402
import schedules  # noqa: E402
import sim  # noqa: E402

T = dt.datetime(2026, 11, 18, 14, 0, tzinfo=sim.KST)  # 수요일 14시, 난방철
ROOM = sim.ROOMS[0]
DRAFT_KEYS = {'roomIds', 'roomNames', 'floor', 'use', 'action', 'time', 'condition', 'setpoint', 'estimatedSavingKwh'}


def fake_state(fn):
    # fn(t) -> (운전, 재실, 설정온도, 모드): 규칙 판정에 쓰는 필드만 구성한 상태
    def state(room, t, schedules=()):
        on, occ, sp, mode = fn(t)
        return {'onOff': on, 'occupants': occ, 'setpoint': sp, 'mode': mode, 'powerKw': 2.0 if on else 0.0}
    return patch.object(recommend.sim, 'state', state)


class RuleTest(unittest.TestCase):
    def setUp(self):
        recommend._after_hours.cache_clear()

    def test_idle_fires_after_30_minutes_empty(self):
        with fake_state(lambda t: (True, 0, 20, 'heating')):
            self.assertEqual(recommend._rule(ROOM, T, [])[0], 'idle')

    def test_idle_needs_all_three_samples_empty(self):
        # 15분 전 재실 2명, 과거 날짜는 정지라 빈 공간·업무 외 모두 미해당
        with fake_state(lambda t: (t.date() == T.date(), 2 if t == T - dt.timedelta(minutes=15) else 0, 20, 'heating')):
            self.assertIsNone(recommend._rule(ROOM, T, []))

    def test_after_hours_fires_on_evening_runs(self):
        # 지금은 재실 중, 과거 평일 19시마다 재실 없이 운전
        with fake_state(lambda t: (t.date() == T.date() or t.hour == 19, 3 if t.date() == T.date() else 0, 20, 'heating')):
            rule, _, reason, draft = recommend._rule(ROOM, T, [])
        self.assertEqual(rule, 'after_hours')
        self.assertIn('7일', reason)
        self.assertEqual((draft['action'], draft['condition']), ('off', 'unused'))

    def test_overset_heating_and_cooling(self):
        with fake_state(lambda t: (t.date() == T.date(), 3, 24, 'heating')):
            rule, _, _, draft = recommend._rule(ROOM, T, [])
        self.assertEqual((rule, draft['action'], draft['setpoint']), ('overset', 'setpoint', 20))
        with fake_state(lambda t: (t.date() == T.date(), 3, 22, 'cooling')):
            self.assertEqual(recommend._rule(ROOM, T, [])[3]['setpoint'], 26)
        with fake_state(lambda t: (t.date() == T.date(), 3, 20, 'heating')):
            self.assertIsNone(recommend._rule(ROOM, T, []))


class RecommendTest(unittest.TestCase):
    def test_saving_non_negative_sorted_one_per_room(self):
        items = recommend.recommend(sim.ROOMS, T, [])
        savings = [i['savingKwhDay'] for i in items]
        self.assertTrue(items)
        self.assertEqual(savings, sorted(savings, reverse=True))
        self.assertTrue(all(s > 0 for s in savings))
        self.assertEqual(len({i['roomId'] for i in items}), len(items))
        self.assertEqual({i['rule'] for i in items}, {'idle', 'after_hours', 'overset'})
        self.assertTrue(all(set(i['draft']) == DRAFT_KEYS and i['draft']['estimatedSavingKwh'] == i['savingKwhDay'] for i in items))

    def test_saved_draft_removes_recommendation(self):
        for rule in ('idle', 'after_hours', 'overset'):
            item = next(i for i in recommend.recommend(sim.ROOMS, T, []) if i['rule'] == rule)
            room = next(r for r in sim.ROOMS if r['id'] == item['roomId'])
            self.assertEqual(recommend.recommend([room], T, [item['draft']]), [], rule)


class AnomalyTest(unittest.TestCase):
    def test_fault_rooms_have_expected_and_causes(self):
        items = anomalies.anomalies(None, T, [])
        self.assertTrue(items)
        for a in items:
            self.assertEqual(a['gap'], round(a['temp'] - a['setpoint'], 1))
            self.assertGreaterEqual(abs(a['gap']), 3)
            self.assertGreater(a['peerCount'], 0)
            self.assertTrue(0 <= a['durationMin'] <= 14 * 60)
            self.assertTrue(2 <= len(a['causes']) <= 3)
            self.assertTrue(all(c['likelihood'] in ('high', 'medium', 'low') for c in a['causes']))

    def test_floor_filter(self):
        self.assertTrue(all(a['floor'] == '2F' for a in anomalies.anomalies('2F', T, [])))


class HistoryTest(unittest.TestCase):
    def test_lengths_and_partial_hour(self):
        body = json.loads(history_at(T.replace(minute=30))['body'])
        self.assertEqual(len(body['today']), T.hour + 1)
        self.assertEqual(len(body['yesterday']), 24)
        last = body['today'][-1]
        self.assertAlmostEqual(last['kwh'], last['kw'] * 0.5, delta=0.1)
        self.assertGreater(sum(p['kwh'] for p in body['yesterday']), 0)

    def test_schedule_applies_only_after_created(self):
        rooms = [r for r in sim.ROOMS if r['floor'] == '1F']
        off = {'roomIds': [r['id'] for r in rooms], 'action': 'off', 'time': '00:00', 'condition': 'always', 'createdAt': T.replace(hour=12).isoformat()}
        day = T.replace(hour=0, minute=0)
        with_off = history.hourly(rooms, day, 15, [off], T)
        base = history.hourly(rooms, day, 15, [], T)
        self.assertEqual(with_off[11], base[11])
        self.assertEqual(with_off[13]['kw'], 0)


def history_at(t):
    with patch.object(history.sim, 'now', return_value=t), patch.object(history.common, 'list_schedules', return_value=[]):
        return history.handler({'queryStringParameters': {'floor': '1F'}}, None)


class DeleteTest(unittest.TestCase):
    def call(self, sid):
        return schedules.handler({'requestContext': {'http': {'method': 'DELETE'}}, 'pathParameters': {'id': sid}}, None)

    def test_rejects_bad_id_without_db(self):
        with patch.object(schedules.common, 'delete_schedule') as delete:
            self.assertEqual(self.call('../etc')['statusCode'], 400)
            self.assertEqual(self.call('')['statusCode'], 400)
            delete.assert_not_called()

    def test_missing_404_and_found_200(self):
        sid = '3f1c2a9e-8b7d-4c6e-9f00-1234567890ab'
        with patch.object(schedules.common, 'delete_schedule', return_value=False):
            self.assertEqual(self.call(sid)['statusCode'], 404)
        with patch.object(schedules.common, 'list_schedules', return_value=[{'id': sid}]), patch.object(schedules.common, 'delete_schedule', return_value=True):
            self.assertEqual(self.call(sid)['statusCode'], 200)


if __name__ == '__main__':
    unittest.main()
