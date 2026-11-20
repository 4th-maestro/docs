"""가상 데이터와 도구 검증 테스트(python -m unittest discover tests)"""
import datetime as dt
import pathlib
import sys
import unittest

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


if __name__ == '__main__':
    unittest.main()
