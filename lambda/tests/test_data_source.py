"""건물 데이터 출처(DynamoDB)와 도면 API 테스트(가짜 테이블·가짜 S3, 네트워크 없음)"""
import io
import os
import pathlib
import sys
import types
import unittest
from decimal import Decimal

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import api  # noqa: E402
import buildings  # noqa: E402
import plan  # noqa: E402
import tenant  # noqa: E402


class FakeTable:
    def __init__(self, items, page=2):
        self.items, self.page = items, page

    def scan(self, **kw):
        i = kw.get('ExclusiveStartKey', 0)
        out = {'Items': self.items[i:i + self.page]}
        if i + self.page < len(self.items):
            out['LastEvaluatedKey'] = i + self.page
        return out


class DataSourceTest(unittest.TestCase):
    def setUp(self):
        files = buildings._from_files()
        self.expected = files
        lst, rooms = files
        b_items = [{'buildingId': b['id'], **{k: v for k, v in b.items() if k != 'id'}} for b in reversed(lst)]
        r_items = [{'buildingId': bid, 'roomId': r['id'], **{k: (Decimal(str(r[k])) if k == 'areaM2' else r[k]) for k in ('name', 'floor', 'use', 'areaM2', 'idu')}}
                   for bid, rs in rooms.items() for r in reversed(rs)]
        tables = {'B': FakeTable(b_items), 'R': FakeTable(r_items, page=50)}
        fake = types.SimpleNamespace(resource=lambda name: types.SimpleNamespace(Table=lambda n: tables[n]))
        self._boto3 = sys.modules.get('boto3')
        sys.modules['boto3'] = fake
        os.environ.update(BUILDINGS_TABLE='B', ROOMS_TABLE='R')
        buildings._cache['data'] = None
        tenant._tables.clear()  # 테이블 이름별 캐시(tenant.table) 비움

    def tearDown(self):
        os.environ.pop('BUILDINGS_TABLE'); os.environ.pop('ROOMS_TABLE')
        if self._boto3 is not None:
            sys.modules['boto3'] = self._boto3
        buildings._cache['data'] = None
        tenant._tables.clear()

    def test_tables_match_files_in_rooms_and_order(self):
        lst, rooms = self.expected
        self.assertEqual(buildings.LIST[0]['id'], 'main')  # 기본 건물 먼저
        for b in lst:
            got = buildings.rooms(b['id'])
            self.assertEqual([r['id'] for r in got], [r['id'] for r in rooms[b['id']]])
            self.assertEqual(got[0]['areaM2'], rooms[b['id']][0]['areaM2'])
            self.assertEqual(got[0]['hours'], b['hours'])  # 운영 프로필은 건물에서 채움
        self.assertEqual(buildings.floors('office'), ['1F', '2F', '3F'])
        self.assertIn('office.1F.' + rooms['main'][0]['id'], buildings.BY_ROOM)

    def test_version_changes_with_content(self):
        v1 = buildings.version()
        buildings._cache['data']['list'][0]['name'] = '바뀐 이름'
        buildings._cache['data'] = buildings._load()  # 다시 읽으면 원래 내용
        self.assertEqual(buildings.version(), v1)


class PlanTest(unittest.TestCase):
    def setUp(self):
        class NoSuchKey(Exception):
            pass
        store = {'plans/main/current.json': b'{"floors": {}}'}

        def get_object(Bucket, Key):
            if Key not in store:
                raise NoSuchKey()
            return {'Body': io.BytesIO(store[Key])}
        plan._s3 = types.SimpleNamespace(get_object=get_object, exceptions=types.SimpleNamespace(NoSuchKey=NoSuchKey))
        os.environ['PLANS_BUCKET'] = 'bucket'

    def tearDown(self):
        os.environ.pop('PLANS_BUCKET'); plan._s3 = None

    def call(self, bid):
        return api.handler({'routeKey': 'GET /buildings/{id}/plan', 'pathParameters': {'id': bid}}, None)

    def test_plan_route_returns_stored_json(self):
        self.assertIs(api.route('/buildings/main/plan'), plan.handler)
        self.assertIsNot(api.route('/buildings'), plan.handler)
        r = self.call('main')
        self.assertEqual((r['statusCode'], r['body']), (200, '{"floors": {}}'))

    def test_missing_plan_and_unknown_building(self):
        self.assertEqual(self.call('office')['statusCode'], 404)
        self.assertEqual(self.call('nope')['statusCode'], 400)



class CacheMissTest(unittest.TestCase):
    """다른 실행 환경에서 등록한 건물: 캐시에 없으면 한 번 다시 읽고, 다시 읽기는 5초에 1회"""

    def setUp(self):
        self.real = buildings._load
        base = self.real()
        self.calls = 0

        def load():
            self.calls += 1
            d = dict(base)
            if self.calls >= 2:  # 두 번째 읽기부터 새 건물 포함
                d['by_id'] = {**base['by_id'], 'b-new00001': {'id': 'b-new00001', 'name': '새 건물'}}
            return d
        buildings._load = load
        buildings.forget()
        buildings._miss['at'] = -buildings.MISS_RELOAD_S

    def tearDown(self):
        buildings._load = self.real
        buildings.forget()
        buildings._miss['at'] = -buildings.MISS_RELOAD_S

    def test_reload_once_on_miss(self):
        buildings.get('main')
        self.assertEqual(self.calls, 1)
        self.assertEqual(buildings.get('b-new00001')['name'], '새 건물')
        self.assertEqual(self.calls, 2)

    def test_unknown_reload_rate_limited(self):
        buildings.get('main')
        for _ in range(3):
            with self.assertRaises(ValueError):
                buildings.get('b-none0000')
        self.assertEqual(self.calls, 2)

if __name__ == '__main__':
    unittest.main()
