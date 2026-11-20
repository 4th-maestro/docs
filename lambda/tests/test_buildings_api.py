"""여러 건물 API 테스트: building 쿼리, 알 수 없는 건물 400, 건물별 스케줄 검증, 전체 현황 정렬(python -m unittest discover tests)"""
import datetime as dt
import json
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
# anthropic·boto3 미설치 환경에서도 실행되도록 모듈 대체(test_ws.py와 같은 방식)
sys.modules.setdefault('anthropic', types.SimpleNamespace(AnthropicBedrock=lambda **kw: None))
sys.modules.setdefault('boto3', types.SimpleNamespace(client=None))
import anomalies  # noqa: E402
import buildings  # noqa: E402
import history  # noqa: E402
import portfolio  # noqa: E402
import query  # noqa: E402
import recommend  # noqa: E402
import schedules  # noqa: E402
import sim  # noqa: E402
import status  # noqa: E402
import tools  # noqa: E402

T = dt.datetime(2026, 11, 18, 14, 0, tzinfo=sim.KST)  # 수요일 14시, 난방철
GETS = [status, recommend, anomalies, history]


def get(mod, **params):
    with patch.object(sim, 'now', return_value=T), patch.object(mod.common, 'list_schedules', return_value=[]):
        res = mod.handler({'queryStringParameters': params or None}, None)
    return res['statusCode'], json.loads(res['body'])


def ids(bid):
    return {r['id'] for r in buildings.rooms(bid)}


class BuildingParamTest(unittest.TestCase):
    def test_default_is_main(self):
        code, body = get(status)
        self.assertEqual((code, body['building']['id'], body['floors']), (200, 'main', ['1F', '2F']))
        self.assertEqual({r['id'] for r in body['rooms']}, ids('main'))

    def test_status_of_virtual_building(self):
        code, body = get(status, building='office', floor='3F')
        self.assertEqual(code, 200)
        self.assertEqual(body['floors'], ['1F', '2F', '3F'])
        self.assertTrue(body['building']['virtual'])
        self.assertTrue(body['rooms'] and all(r['floor'] == '3F' and r['id'] in ids('office') for r in body['rooms']))

    def test_panels_use_building_rooms(self):
        for bid in ('edu', 'lab'):
            _, rec = get(recommend, building=bid)
            _, ano = get(anomalies, building=bid)
            self.assertTrue({i['roomId'] for i in rec['items'] + ano['items']} <= ids(bid), bid)
        _, edu = get(history, building='edu')
        _, main = get(history, building='main')
        self.assertNotEqual(edu['today'], main['today'])

    def test_unknown_building_400(self):
        for mod in GETS:
            code, body = get(mod, building='nope')
            self.assertEqual(code, 400, mod.__name__)
            self.assertIn('알 수 없는 건물', body['error'])
        res = schedules.handler({'requestContext': {'http': {'method': 'GET'}}, 'queryStringParameters': {'building': 'nope'}}, None)
        self.assertEqual(res['statusCode'], 400)
        res = query.handler({'body': json.dumps({'text': '전력', 'buildingId': 'nope'})}, None)
        self.assertEqual(res['statusCode'], 400)


class ScheduleBuildingTest(unittest.TestCase):
    def post(self, **body):
        d = {'action': 'off', 'time': '13:00', 'condition': 'unused', **body}
        with patch.object(schedules.common, 'put_schedule') as put:
            res = schedules.handler({'requestContext': {'http': {'method': 'POST'}}, 'body': json.dumps(d)}, None)
        return res['statusCode'], json.loads(res['body']), put

    def test_rooms_must_belong_to_building(self):
        office = sorted(ids('office'))[:2]
        code, item, put = self.post(buildingId='office', roomIds=office)
        self.assertEqual((code, item['buildingId']), (201, 'office'))
        put.assert_called_once()
        # 본관 호실을 업무동으로, 업무동 호실을 buildingId 없이(main) 저장하면 거부
        for body in ({'buildingId': 'office', 'roomIds': sorted(ids('main'))[:1]}, {'roomIds': office}, {'buildingId': 'office', 'roomIds': [['x']]}):
            code, _, put = self.post(**body)
            self.assertEqual(code, 400, body)
            put.assert_not_called()
        self.assertEqual(self.post(buildingId='nope', roomIds=office)[0], 400)
        self.assertEqual(self.post(roomIds=sorted(ids('main'))[:1])[1]['buildingId'], 'main')

    def test_list_filters_by_building(self):
        saved = [{'id': 'a', 'roomIds': []}, {'id': 'b', 'buildingId': 'office', 'roomIds': []}, {'id': 'c', 'buildingId': 'main', 'roomIds': []}]
        for bid, want in ((None, ['a', 'c']), ('office', ['b']), ('lab', [])):
            with patch.object(schedules.common, 'list_schedules', return_value=saved):
                res = schedules.handler({'requestContext': {'http': {'method': 'GET'}}, 'queryStringParameters': bid and {'building': bid}}, None)
            self.assertEqual([s['id'] for s in json.loads(res['body'])['schedules']], want, bid)


class ToolsBuildingTest(unittest.TestCase):
    def test_floor_and_use_checked_per_building(self):
        q = {'floor': '3F', 'use': 'all', 'metric': 'powerKw', 'order': 'desc', 'limit': 3}
        _, view = tools.run('query_spaces', q, T, [], 'office')
        self.assertTrue(set(view['highlight']) <= ids('office'))
        with self.assertRaisesRegex(ValueError, '1F, 2F, all'):
            tools.run('query_spaces', q, T, [])
        with self.assertRaises(ValueError):
            tools.run('query_spaces', {**q, 'floor': '1F', 'use': '진료실'}, T, [], 'edu')
        self.assertEqual(tools.FLOORS, ['1F', '2F', '3F'])

    def test_system_prompt_names_building(self):
        p = query.system(buildings.get('office'))
        self.assertIn('업무동', p)
        self.assertIn('1F, 2F, 3F', p)
        self.assertNotIn('진료실', p)

    def test_ws_building_id(self):
        import ws
        sent = []
        api = types.SimpleNamespace(exceptions=types.SimpleNamespace(GoneException=ConnectionAbortedError),
                                    post_to_connection=lambda ConnectionId, Data: sent.append(json.loads(Data)))
        ws.boto3 = types.SimpleNamespace(client=lambda name, endpoint_url: api)
        ctx = {'routeKey': 'ask', 'connectionId': 'c1', 'domainName': 'x', 'stage': 'prod'}
        ask = lambda bid: ws.handler({'requestContext': ctx, 'body': json.dumps({'requestId': 'r', 'text': '전력', 'buildingId': bid})}, None)  # noqa: E731
        with patch.object(query, 'run') as run:
            ask('nope')
            run.assert_not_called()
            ask('edu')
        self.assertEqual(sent[0]['type'], 'error')
        self.assertEqual(run.call_args.args[2], 'edu')


class PortfolioTest(unittest.TestCase):
    def test_order_fields_and_level(self):
        code, body = get(portfolio)
        items = body['buildings']
        self.assertEqual(code, 200)
        self.assertEqual({b['id'] for b in items}, {b['id'] for b in buildings.LIST})
        keys = [(portfolio.LEVELS.index(b['level']), -b['now']['anomaly']) for b in items]
        self.assertEqual(keys, sorted(keys))
        for b in items:
            self.assertEqual(b['level'], portfolio.level(b['now']['anomaly'], b['savingKwh'], b['todayKwh']))
            self.assertGreater(b['todayKwh'], 0)
        # 전체 현황 값과 건물별 API 값 일치
        main = next(b for b in items if b['id'] == 'main')
        _, rec = get(recommend, building='main')
        _, hist = get(history, building='main')
        self.assertEqual(main['savingKwh'], rec['totalSavingKwh'])
        self.assertAlmostEqual(main['todayKwh'], sum(p['kwh'] for p in hist['today']), delta=0.1)

    def test_level_rules(self):
        self.assertEqual(portfolio.level(1, 0, 100), 'alert')
        self.assertEqual(portfolio.level(0, 10, 100), 'warn')
        self.assertEqual(portfolio.level(0, 9.9, 100), 'ok')
        self.assertEqual(portfolio.level(0, 0, 0), 'ok')

    def test_problem_buildings_first(self):
        cards = {'a': ('ok', 0), 'b': ('alert', 1), 'c': ('warn', 0), 'd': ('alert', 3)}
        fake = lambda b, t, s: {'id': b['id'], 'level': cards[b['id']][0], 'now': {'anomaly': cards[b['id']][1]}}  # noqa: E731
        with patch.object(portfolio.buildings, 'LIST', [{'id': k} for k in cards]), patch.object(portfolio, 'card', fake), \
                patch.object(portfolio.common, 'list_schedules', return_value=[]):
            body = json.loads(portfolio.handler({}, None)['body'])
        self.assertEqual([b['id'] for b in body['buildings']], ['d', 'b', 'c', 'a'])


if __name__ == '__main__':
    unittest.main()
