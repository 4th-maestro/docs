"""simulator 오프라인 테스트(DynamoDB 없이, 파일 출처 건물·호실)

실행(Lambda 폴더에서): python -X utf8 -m unittest discover -s infra/twin/tests
"""
import datetime as dt
import os
import pathlib
import sys
import unittest
from decimal import Decimal
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'src'))
sys.path.insert(0, str(ROOT / 'infra' / 'twin' / 'functions'))
for k in ('BUILDINGS_TABLE', 'ROOMS_TABLE', 'OWNERS_TABLE', 'SCHEDULES_TABLE', 'MEMBERS_TABLE'):
    os.environ.pop(k, None)

import buildings  # noqa: E402
import sim  # noqa: E402
import simulator  # noqa: E402

T = dt.datetime(2026, 11, 18, 14, 0, tzinfo=sim.KST)  # 수요일 14시


class SimulatorTest(unittest.TestCase):
    def test_all_rooms_computed(self):
        rows = simulator.compute(T)
        self.assertEqual(len(rows), sum(len(buildings.rooms(b['id'])) for b in buildings.LIST))
        self.assertEqual({bid for bid, _ in rows}, {b['id'] for b in buildings.LIST})

    def test_same_as_sim_state(self):
        # 조회 API(sim.state 직접 계산)와 같은 값을 기록
        bid, s = simulator.compute(T)[0]
        room = buildings.rooms(bid)[0]
        self.assertEqual(s, sim.state(room, T))

    def test_inactive_room_skipped(self):
        room = dict(buildings.rooms('main')[0], active=False)
        with mock.patch.object(buildings, 'rooms', lambda bid=None: [room]):
            self.assertEqual(simulator.compute(T), [])

    def test_schedule_applied(self):
        bid, s = simulator.compute(T)[0]
        off = {'roomIds': [s['id']], 'action': 'off', 'time': '13:00', 'condition': 'always'}
        rows = dict((r[1]['id'], r[1]) for r in simulator.compute(T, [off]))
        self.assertFalse(rows[s['id']]['onOff'])

    def test_items_keys_and_decimal(self):
        rows = simulator.compute(T)[:3]
        out = simulator.items(rows, T, history=True)
        st, ts, occ = out['state'][0], out['timeseries'][0], out['occupancy'][0]
        self.assertEqual((st['buildingId'], st['roomId']), (rows[0][0], rows[0][1]['id']))
        self.assertEqual(ts['pk'], f"{rows[0][0]}#{rows[0][1]['id']}")
        self.assertEqual(ts['ts'], T.isoformat())
        self.assertEqual(occ['occupants'], rows[0][1]['occupants'])
        self.assertEqual(ts['ttl'], int((T + dt.timedelta(days=30)).timestamp()))
        for item in (st, ts):
            self.assertFalse(any(isinstance(v, float) for v in item.values()))
            self.assertIsInstance(item['temp'], Decimal)

    def test_no_history_items_when_off(self):
        out = simulator.items(simulator.compute(T)[:3], T, history=False)
        self.assertEqual(len(out['state']), 3)
        self.assertEqual(out['timeseries'], [])
        self.assertEqual(out['occupancy'], [])

    def test_history_minute(self):
        self.assertTrue(simulator.is_history_minute(T.replace(minute=10), 5))
        self.assertFalse(simulator.is_history_minute(T.replace(minute=11), 5))
        self.assertFalse(simulator.is_history_minute(T, 0))

    def test_event_time_to_kst_minute(self):
        t = simulator.at_minute({'time': '2026-11-20T06:41:37Z'})
        self.assertEqual(t.isoformat(), '2026-11-20T15:41:00+09:00')

    ENV = {'STATE_TABLE': 'S', 'TIMESERIES_TABLE': 'T', 'OCCUPANCY_TABLE': 'O', 'HISTORY_EVERY_MIN': '5', 'CLEANUP_EVERY_MIN': '10'}

    def _run(self, utc, existing=()):
        """handler 1회 실행: (결과, 테이블별 쓰기 건수, 삭제 키, 스캔 여부)"""
        writes, deleted, scanned = {}, [], []
        with mock.patch.dict(os.environ, self.ENV), \
                mock.patch.object(simulator, '_write', lambda name, rows, keys: writes.__setitem__(name, len(rows))), \
                mock.patch.object(simulator, '_scan_keys', lambda name: scanned.append(name) or list(existing)), \
                mock.patch.object(simulator, '_delete', lambda name, keys: deleted.extend(keys)):
            r = simulator.handler({'time': utc}, None)
        return r, writes, deleted, scanned

    def test_handler_writes_tables(self):
        r, writes, _, _ = self._run('2026-11-20T06:45:00Z')  # 15:45 KST: 이력 기록, 정리 안 함
        n = r['rooms']
        self.assertTrue(r['history'])
        self.assertEqual(writes, {'S': n, 'T': n, 'O': n})
        r, writes, _, scanned = self._run('2026-11-20T06:41:00Z')
        self.assertFalse(r['history'])
        self.assertEqual(set(writes), {'S'})
        self.assertEqual(scanned, [])

    def test_cache_cleared_each_run(self):
        # 매 실행 건물 캐시를 비워 삭제된 건물을 다시 기록하지 않음
        with mock.patch.object(buildings, 'forget') as forget:
            self._run('2026-11-20T06:41:00Z')
        forget.assert_called_once()

    def test_cleanup_removes_only_stale_rows(self):
        live = ('main', buildings.rooms('main')[0]['id'])
        existing = [live, ('b-deleted1', 'r-1'), ('main', 'removed-room')]
        r, _, deleted, scanned = self._run('2026-11-20T06:40:00Z', existing)  # 15:40 KST: 정리 분
        self.assertEqual(scanned, ['S'])
        self.assertEqual(sorted(deleted), [('b-deleted1', 'r-1'), ('main', 'removed-room')])
        self.assertEqual(r['removed'], 2)

    def test_stale_keys_guard_when_no_rows(self):
        # 계산 대상이 0건(건물 테이블 읽기 이상 등)이면 State를 지우지 않음
        self.assertEqual(simulator.stale_keys([('main', 'x')], []), [])

    def test_inactive_room_state_removed(self):
        rows = simulator.compute(T)
        bid, s = rows[0]
        self.assertEqual(simulator.stale_keys([(bid, s['id'])], rows[1:]), [(bid, s['id'])])


if __name__ == '__main__':
    unittest.main()
