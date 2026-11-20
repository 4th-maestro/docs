"""가상 데이터와 도구 검증 테스트(python -m unittest discover tests)"""
import datetime as dt
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import sim  # noqa: E402
import tools  # noqa: E402

T = dt.datetime(2026, 11, 18, 14, 0, tzinfo=sim.KST)  # 수요일 14시, 난방철
MEETING = next(r for r in sim.ROOMS if r['use'] == '회의실')


class SimTest(unittest.TestCase):
    def test_same_input_same_output(self):
        self.assertEqual(sim.state(MEETING, T), sim.state(MEETING, T))

    def test_off_schedule_applies_after_time(self):
        s = {'roomIds': [MEETING['id']], 'action': 'off', 'time': '13:00', 'condition': 'always'}
        st = sim.state(MEETING, T, [s])
        self.assertFalse(st['onOff'])
        self.assertEqual(st['powerKw'], 0.0)
        self.assertTrue(sim.state(MEETING, T.replace(hour=12), [s]) == sim.state(MEETING, T.replace(hour=12)))

    def test_live_values_vary_within_range(self):
        on = next(r for r in sim.ROOMS if sim.state(r, T)['onOff'])
        base = sim.state(on, T)
        vals = [sim.state(on, T + dt.timedelta(seconds=5 * i)) for i in range(20)]
        self.assertGreater(len({v['temp'] for v in vals}), 1)
        self.assertTrue(all(abs(v['powerKw'] - base['powerKw']) <= base['powerKw'] * 0.17 + 0.01 for v in vals))
        self.assertTrue(all(v['onOff'] == base['onOff'] for v in vals))

    def test_weekend_no_occupants(self):
        self.assertEqual(sim.occupants(MEETING, T + dt.timedelta(days=3)), 0)


class BuildingsTest(unittest.TestCase):
    def test_main_keeps_ifc_ids(self):
        import buildings
        self.assertEqual([r['id'] for r in buildings.rooms('main')], [r['id'] for r in sim.ROOMS])

    def test_rooms_unique_and_profiled(self):
        import buildings
        ids = [r['id'] for b in buildings.LIST for r in buildings.rooms(b['id'])]
        self.assertEqual(len(ids), len(set(ids)))
        office = buildings.rooms('office')
        self.assertEqual({r['floor'] for r in office}, {'1F', '2F', '3F'})
        self.assertNotIn('진료실', {r['use'] for r in office})
        with self.assertRaises(ValueError):
            buildings.get('nope')

    def test_unclassified_room_varies_in_hours(self):
        # 미분류 호실(기타): 운영 시간 안에는 시간대별로 사용·비사용이 섞이고, 운영 시간 밖은 0명
        rooms = [{'id': f'x.{i}', 'use': '기타', 'areaM2': 20, 'hours': (9, 18)} for i in range(40)]
        day = T.replace(hour=0, minute=0)
        noon = [sim.occupants(r, day.replace(hour=13)) for r in rooms]
        self.assertTrue(0 < sum(o > 0 for o in noon) < len(rooms))
        self.assertTrue(all(o in (0, 1, 2) for o in noon))
        self.assertEqual(sum(sim.occupants(r, day.replace(hour=20)) for r in rooms), 0)
        # 가운데 시간대 사용 확률이 시작 시간대보다 높음(40호실 × 평일 5일)
        days = [day + dt.timedelta(days=d) for d in range(7) if (day + dt.timedelta(days=d)).weekday() < 5]
        used = lambda h: sum(sim.occupants(r, d.replace(hour=h)) > 0 for r in rooms for d in days)
        self.assertGreater(used(13), used(9))

    def test_weekend_building_has_weekend_occupants(self):
        import buildings
        sat = T + dt.timedelta(days=3)
        self.assertTrue(any(sim.occupants(r, sat) for r in buildings.rooms('edu')))
        self.assertFalse(any(sim.occupants(r, sat) for r in buildings.rooms('main')))


class ToolsTest(unittest.TestCase):
    def test_query_sorts_and_limits(self):
        out, view = tools.run('query_spaces', {'floor': '1F', 'use': 'all', 'metric': 'powerKw', 'order': 'desc', 'limit': 3}, T, [])
        vals = [r['powerKw'] for r in out['rooms']]
        self.assertEqual(vals, sorted(vals, reverse=True))
        self.assertEqual(len(view['highlight']), 3)

    def test_schedule_draft_targets_only_matching_rooms(self):
        args = {'floor': '2F', 'use': '회의실', 'action': 'off', 'time': '13:00', 'condition': 'unused', 'setpoint': 0}
        _, view = tools.run('create_schedule', args, T, [])
        rooms = {r['id']: r for r in sim.ROOMS}
        self.assertTrue(all(rooms[i]['floor'] == '2F' and rooms[i]['use'] == '회의실' for i in view['draft']['roomIds']))

    def test_rejects_unknown_floor_and_bad_time(self):
        with self.assertRaises(ValueError):
            tools.run('query_spaces', {'floor': '6F', 'use': 'all', 'metric': 'temp', 'order': 'desc', 'limit': 3}, T, [])
        with self.assertRaises(ValueError):
            tools.run('create_schedule', {'floor': '1F', 'use': 'all', 'action': 'off', 'time': '25:00', 'condition': 'always', 'setpoint': 0}, T, [])


class RoomNamePickTest(unittest.TestCase):
    """create_schedule 호실 이름 선택: 도면 등록 건물처럼 용도가 모두 '기타'이고 이름만 다른 호실"""
    def setUp(self):
        base = [r for r in sim.ROOMS if r['floor'] == '1F'][:3] + [r for r in sim.ROOMS if r['floor'] == '2F'][:2]
        names = [('회의실 A', '1F'), ('회의실 B', '1F'), ('Lounge', '1F'), ('회의실 A', '2F'), ('대회의실', '2F')]
        self.rooms = [{**r, 'name': n, 'floor': f, 'use': '기타'} for r, (n, f) in zip(base, names)]
        patcher = mock.patch.object(tools.buildings, 'rooms', return_value=self.rooms)
        patcher.start()
        self.addCleanup(patcher.stop)

    def draft(self, rooms, floor='all'):
        args = {'floor': floor, 'use': 'all', 'rooms': rooms, 'action': 'off', 'time': '13:00', 'condition': 'unused', 'setpoint': 0}
        return tools.run('create_schedule', args, T, [])[1]['draft']

    def ids(self, *idx):
        return [self.rooms[i]['id'] for i in idx]

    def test_exact_names_on_floor(self):
        d = self.draft(['회의실 A', '회의실 B'], '1F')
        self.assertEqual(d['roomIds'], self.ids(0, 1))
        self.assertEqual((d['floor'], d['use'], d['pick'], d['roomNames']), ('1F', 'all', 'rooms', ['회의실 A', '회의실 B']))

    def test_ignores_whitespace_and_case(self):
        self.assertEqual(self.draft(['회의실a', ' LOUNGE '], '1F')['roomIds'], self.ids(0, 2))

    def test_unique_contains_match_sets_single_floor(self):
        d = self.draft(['대회의'])
        self.assertEqual((d['roomIds'], d['floor']), (self.ids(4), '2F'))

    def test_floor_restricts_same_name(self):
        self.assertEqual(self.draft(['회의실 A'], '2F')['roomIds'], self.ids(3))
        d = self.draft(['회의실 A', '회의실A'])  # 층 미지정: 같은 이름 전부, 중복 제거
        self.assertEqual((d['roomIds'], d['floor']), (self.ids(0, 3), 'all'))

    def test_not_found_lists_candidates_on_floor(self):
        with self.assertRaises(ValueError) as e:
            self.draft(['회의실 A', '회의실 C'], '1F')
        msg = str(e.exception)
        self.assertIn('회의실 C', msg)
        self.assertIn('회의실 B', msg)
        self.assertNotIn('대회의실', msg)

    def test_ambiguous_contains_lists_matches(self):
        with self.assertRaises(ValueError) as e:
            self.draft(['회의실'], '1F')
        self.assertIn('후보: 회의실 A, 회의실 B', str(e.exception))

    def test_empty_rooms_keeps_group_pick(self):
        args = {'floor': '1F', 'use': '기타', 'rooms': [], 'action': 'off', 'time': '13:00', 'condition': 'unused', 'setpoint': 0}
        d = tools.run('create_schedule', args, T, [])[1]['draft']
        self.assertEqual((d['roomIds'], d['pick'], d['use']), (self.ids(0, 1, 2), 'group', '기타'))

    def test_rejects_non_list_rooms(self):
        with self.assertRaises(ValueError):
            self.draft('회의실 A')

    def test_chips_show_room_names(self):
        chips = tools.chips('create_schedule', {'floor': '1F', 'use': 'all', 'rooms': ['회의실 A', '회의실 B', 'Lounge', 'x'], 'action': 'off', 'time': '13:00'})
        self.assertIn('회의실 A, 회의실 B, Lounge 외 1곳', chips)


if __name__ == '__main__':
    unittest.main()


class ComfortToolTest(unittest.TestCase):
    def test_comfort_index_sorted_with_assumptions(self):
        out, view = tools.run('comfort_index', {'floor': 'all', 'use': 'all', 'order': 'desc', 'limit': 5}, T, [])
        dis = [r['di'] for r in out['rooms']]
        self.assertEqual(dis, sorted(dis, reverse=True))
        self.assertEqual(len(view['highlight']), 5)
        self.assertIn('1.0clo', out['assumptions'])
        self.assertTrue({'di', 'diStage', 'pmv', 'ppd'} <= set(out['rooms'][0]))
