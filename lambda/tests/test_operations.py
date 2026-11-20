"""자동 운영 도구: 읽기 전용 조회, 만료·범위 필터, 초안과 응답 전달 검증."""
import datetime as dt
import json
import os
import pathlib
import sys
import types
import unittest
from decimal import Decimal
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'src'))
import operations
import sim
import tools

T = dt.datetime(2026, 11, 21, 1, 30, 15, tzinfo=sim.KST)


def decision(n, status='pending', floor='1F', minutes=10, **extra):
    created = T - dt.timedelta(minutes=minutes)
    return {'decisionId': f'{created:%Y%m%dT%H%M}-{n}', 'buildingId': 'main',
            'roomId': f'r{n}', 'roomName': f'Room {n}', 'floor': floor, 'use': '회의실',
            'status': status, 'message': '끄기 제안', 'createdAt': created.isoformat(),
            'expiresAt': (T + dt.timedelta(minutes=10)).isoformat(),
            'evidence': {'facts': {'idleOnMinutes': Decimal('60')}},
            'jev': {'choice': 'empty', 'confidence': Decimal('0.92'), 'probabilities': {'empty': Decimal('0.95')}}, **extra}


class FakeKey:
    def __init__(self, name):
        self.values = [name]

    def eq(self, value):
        self.values.append(value)
        return self

    gte = eq

    def __and__(self, other):
        self.values += other.values
        return self

    def get_expression(self):
        return {'values': self.values}


class OperationsTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'DECISIONS_TABLE': 'decisions', 'OPS_SETTINGS_TABLE': 'settings'})
        self.env.start()
        self.conditions = patch.dict(sys.modules, {'boto3.dynamodb.conditions': types.SimpleNamespace(Key=FakeKey)})
        self.conditions.start()
        self.resource = MagicMock()
        self.resource.Table.return_value.get_item.return_value = {}
        self.resource.meta.client.get_paginator.return_value.paginate.return_value = [
            {'Items': [decision(1), decision(2, expiresAt=T.isoformat()), decision(3, 'skipped')]},
            {'Items': [decision(4, 'applied', minutes=120), decision(5, 'accepted', floor='2F'), decision(6, 'alert')]},
        ]
        self.resource_patch = patch.object(operations, '_resource', return_value=self.resource)
        self.resource_patch.start()

    def tearDown(self):
        self.resource_patch.stop()
        self.env.stop()
        self.conditions.stop()

    def run_tool(self, name='list_operations', **args):
        return tools.run(name, args, T, [], 'main')

    def test_pages_expiry_decimal_and_highlight(self):
        out, view = self.run_tool(status='all')
        self.assertFalse(out['autoApply'])
        self.assertEqual(out['pendingCount'], 1)
        self.assertEqual(out['totalCount'], 5)
        statuses = {r['decisionId']: r['status'] for r in out['items']}
        self.assertEqual(statuses[decision(2)['decisionId']], 'expired')
        self.assertNotIn(decision(3)['decisionId'], statuses)
        self.assertEqual(len(view['highlight']), 5)
        self.assertEqual(out['items'][0]['jev']['emptyProb'], .95)
        json.dumps(out)
        self.resource.meta.client.get_paginator.assert_called_once_with('query')
        condition = self.resource.meta.client.get_paginator.return_value.paginate.call_args.kwargs['KeyConditionExpression']
        self.assertIn('main', str(condition.get_expression()['values']))
        self.resource.Table.return_value.put_item.assert_not_called()
        self.resource.Table.return_value.update_item.assert_not_called()

    def test_done_counts_distinguish_today_and_truncation(self):
        out, _ = self.run_tool(status='done', limit=1)
        self.assertEqual(out['totalCount'], 3)
        self.assertTrue(out['truncated'])
        self.assertEqual(out['statusCounts']['applied'], 1)
        self.assertNotIn('applied', out['todayStatusCounts'])
        self.assertEqual(out['todayStatusCounts']['accepted'], 1)

    def test_today_counts_use_decision_time_across_kst_midnight(self):
        now = T.replace(hour=0, minute=10, second=0)
        yesterday = (now - dt.timedelta(minutes=15)).isoformat()
        for status in ('accepted', 'applied'):
            with self.subTest(status=status):
                item = decision(1, status, createdAt=yesterday,
                                decidedAt=(now - dt.timedelta(minutes=5)).isoformat())
                self.resource.meta.client.get_paginator.return_value.paginate.return_value = [{'Items': [item]}]
                out, _ = tools.run('list_operations', {'status': 'done'}, now, [], 'main')
                self.assertEqual(out['todayStatusCounts'], {status: 1})
                self.assertEqual(out['items'][0]['decidedAt'], item['decidedAt'])

    def test_today_counts_convert_decision_time_to_kst(self):
        item = decision(1, 'accepted', minutes=120,
                        decidedAt='2026-11-20T15:05:00+00:00')
        self.resource.meta.client.get_paginator.return_value.paginate.return_value = [{'Items': [item]}]
        out, _ = self.run_tool(status='done')
        self.assertEqual(out['todayStatusCounts'], {'accepted': 1})

    def test_today_counts_fall_back_to_created_at_for_legacy_records(self):
        self.resource.meta.client.get_paginator.return_value.paginate.return_value = [{'Items': [
            decision(1, 'accepted'), decision(2, 'applied', minutes=120)]}]
        out, _ = self.run_tool(status='done')
        self.assertEqual(out['todayStatusCounts'], {'accepted': 1})

    def test_filters_and_pending_exclude_expired(self):
        out, view = self.run_tool(status='pending', floor='1F', use='회의실')
        self.assertEqual(len(out['items']), 1)
        self.assertEqual(view['highlight'], ['r1'])
        out, _ = self.run_tool(status='alert', floor='2F')
        self.assertEqual(out['items'], [])

    def test_accept_reject_only_live_pending(self):
        for action in ('accept', 'reject'):
            out, view = self.run_tool('operations_action', action=action, floor='1F', scope='all')
            self.assertFalse(out['executed'])
            self.assertEqual(view['opsDraft']['decisionIds'], [decision(1)['decisionId']])
            self.assertEqual(view['opsDraft']['buildingId'], 'main')
            self.resource.Table.return_value.put_item.assert_not_called()

    def test_undo_latest_and_all(self):
        _, view = self.run_tool('operations_action', action='undo', scope='latest')
        self.assertEqual(view['opsDraft']['rooms'], ['Room 5'])
        _, view = self.run_tool('operations_action', action='undo', scope='all')
        self.assertEqual(len(view['opsDraft']['decisionIds']), 2)

    def test_no_target_returns_no_draft(self):
        out, view = self.run_tool('operations_action', action='accept', floor='2F', scope='all')
        self.assertEqual(out['count'], 0)
        self.assertEqual(view, {})

    def test_missing_environment_does_not_read(self):
        with patch.dict(os.environ, {'DECISIONS_TABLE': ''}):
            out, view = self.run_tool()
        self.assertFalse(out['available'])
        self.assertEqual(view, {})
        self.assertEqual(self.resource.mock_calls, [])

    def test_bad_arguments_fail_before_read(self):
        for args in ({'floor': '99F'}, {'hours': 25}, {'limit': 0}, {'hours': True}, {'status': 'skipped'}):
            with self.assertRaises(ValueError):
                self.run_tool(**args)
        with self.assertRaises(ValueError):
            self.run_tool('operations_action', action='toggle', scope='all')
        self.assertEqual(self.resource.mock_calls, [])

    def test_time_window_excludes_boundary_seconds_and_future(self):
        self.resource.meta.client.get_paginator.return_value.paginate.return_value = [{'Items': [
            decision(1, minutes=1440, createdAt=(T-dt.timedelta(hours=24, seconds=1)).isoformat()),
            decision(2, minutes=-1), decision(3)]}]
        out, _ = self.run_tool(status='all')
        self.assertEqual(out['totalCount'], 1)


if __name__ == '__main__':
    unittest.main()
