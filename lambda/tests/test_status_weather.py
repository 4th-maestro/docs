"""외기 관측 표시, 장애 대체, 실행 환경별 5분 캐시 검증."""
import datetime as dt
from decimal import Decimal
import json
import os
import pathlib
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import status
import sim

T = dt.datetime(2026, 11, 20, 20, 0, tzinfo=sim.KST)


class WeatherStatusTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'WEATHER_TABLE': 'maestro-Weather'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.cache = patch.object(status, '_weather_cache', {
            'table': None, 'expires': 0.0, 'item': None,
        })
        self.cache.start()
        self.addCleanup(self.cache.stop)
        # 기존 API 테스트는 boto3를 빈 모듈로 대체합니다. SDK 없이도 조회 계약을 검증합니다.
        self.key = Mock()
        conditions = types.ModuleType('boto3.dynamodb.conditions')
        conditions.Key = self.key
        self.sdk = patch.dict(sys.modules, {'boto3.dynamodb.conditions': conditions})
        self.sdk.start()
        self.addCleanup(self.sdk.stop)
        self.table = Mock()
        self.table.query.return_value = {'Items': [self.observation()]}
        self.factory = patch.object(status, '_weather_table', return_value=self.table)
        self.factory_mock = self.factory.start()
        self.addCleanup(self.factory.stop)
        self.clock = patch.object(status.time, 'monotonic', return_value=1000.0)
        self.monotonic = self.clock.start()
        self.addCleanup(self.clock.stop)

    def observation(self, at=None, temp=Decimal('3.8')):
        return {'location': '98,77', 'ts': (at or T - dt.timedelta(hours=1)).isoformat(), 'tempC': temp}

    def assert_sim(self, t=T):
        self.assertEqual(status.outdoor(t), {
            'outdoorTemp': sim.outdoor_temp(t), 'outdoorSource': 'sim', 'outdoorObservedAt': None,
        })

    def test_handler_returns_numeric_observation_and_preserves_room_simulation(self):
        with patch.object(status.sim, 'now', return_value=T), patch.object(status.common, 'list_schedules', return_value=[]):
            response = status.handler({}, None)
        self.assertEqual(response['statusCode'], 200)
        body = json.loads(response['body'])
        self.assertEqual(body['outdoorTemp'], 3.8)
        self.assertIsInstance(body['outdoorTemp'], float)
        self.assertEqual(body['outdoorSource'], 'kma')
        self.assertEqual(body['outdoorObservedAt'], '2026-11-20T19:00:00+09:00')
        expected = [sim.state(r, T, []) for r in status.buildings.rooms('main')]
        self.assertEqual(body['rooms'], expected)
        self.assertEqual(body['summary'], status.summarize(expected))
        self.factory_mock.assert_called_once_with('maestro-Weather')
        self.key.assert_called_once_with('location')
        self.key.return_value.eq.assert_called_once_with('98,77')
        self.table.query.assert_called_once_with(
            KeyConditionExpression=self.key.return_value.eq.return_value, ScanIndexForward=False, Limit=1,
        )

    def test_missing_env_does_not_read_dynamodb_even_with_cache(self):
        status.outdoor(T)
        self.factory_mock.reset_mock()
        del os.environ['WEATHER_TABLE']
        self.assert_sim()
        self.factory_mock.assert_not_called()

    def test_old_and_empty_observations_use_simulation(self):
        for items in ([], [self.observation(T - dt.timedelta(hours=2, seconds=1))]):
            with self.subTest(items=items):
                status._weather_cache['expires'] = 0
                self.table.query.return_value = {'Items': items}
                self.assert_sim()

    def test_read_error_logs_and_caches_fallback(self):
        self.table.query.side_effect = RuntimeError('read failed')
        with self.assertLogs(status._log, level='WARNING'):
            self.assert_sim()
        self.assert_sim()
        self.table.query.assert_called_once()

    def test_cache_refreshes_at_five_minutes(self):
        self.assertEqual(status.outdoor(T)['outdoorTemp'], 3.8)
        self.table.query.return_value = {'Items': [self.observation(temp=Decimal('4.2'))]}
        self.monotonic.return_value = 1299.99
        self.assertEqual(status.outdoor(T)['outdoorTemp'], 3.8)
        self.monotonic.return_value = 1300.0
        self.assertEqual(status.outdoor(T)['outdoorTemp'], 4.2)
        self.assertEqual(self.table.query.call_count, 2)

    def test_empty_cache_retries_after_five_minutes(self):
        self.table.query.return_value = {'Items': []}
        self.assert_sim()
        self.table.query.return_value = {'Items': [self.observation()]}
        self.assert_sim()
        self.table.query.assert_called_once()
        self.monotonic.return_value = 1300.0
        self.assertEqual(status.outdoor(T)['outdoorSource'], 'kma')

    def test_cached_observation_stops_being_used_after_two_hours(self):
        self.table.query.return_value = {'Items': [self.observation(T - dt.timedelta(hours=2))]}
        self.assertEqual(status.outdoor(T)['outdoorSource'], 'kma')
        self.assert_sim(T + dt.timedelta(seconds=1))
        self.table.query.assert_called_once()

    def test_invalid_observations_do_not_break_response(self):
        for item in ({'ts': 'bad', 'tempC': 3.8}, {'ts': T.isoformat()},
                     {'ts': '2026-11-20T19:00:00', 'tempC': 3.8},
                     self.observation(temp=Decimal('NaN'))):
            with self.subTest(item=item), self.assertLogs(status._log, level='WARNING'):
                status._weather_cache['expires'] = 0
                self.table.query.return_value = {'Items': [item]}
                self.assert_sim()

    def test_future_observation_is_not_used(self):
        self.table.query.return_value = {'Items': [self.observation(T + dt.timedelta(hours=1))]}
        self.assert_sim()

    def test_table_change_does_not_reuse_previous_observation(self):
        status.outdoor(T)
        os.environ['WEATHER_TABLE'] = 'other-Weather'
        self.table.query.return_value = {'Items': []}
        self.assert_sim()
        self.factory_mock.assert_called_with('other-Weather')


if __name__ == '__main__':
    unittest.main()
