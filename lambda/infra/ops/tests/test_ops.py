"""③ 자동 운영 오프라인 테스트(DynamoDB·Jev 없이, 파일 출처 건물·호실, 메모리 저장소)

실행(Lambda 폴더에서): python -X utf8 -m unittest discover -s infra/ops/tests
"""
import datetime as dt
import json
import os
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'src'))
sys.path.insert(0, str(ROOT / 'infra' / 'ops' / 'functions'))
for k in ('BUILDINGS_TABLE', 'ROOMS_TABLE', 'OWNERS_TABLE', 'SCHEDULES_TABLE', 'MEMBERS_TABLE', 'COMPANIES_TABLE'):
    os.environ.pop(k, None)

import auto_operator as op  # noqa: E402
import buildings  # noqa: E402
import ops_api  # noqa: E402
import ops_common as oc  # noqa: E402
import recommend  # noqa: E402
import sim  # noqa: E402
import tenant  # noqa: E402
import usage  # noqa: E402

T = dt.datetime(2026, 11, 20, 19, 0, tzinfo=sim.KST)  # 운영 시간 뒤: 빈 방 운전 후보가 생기는 시각
EMPTY = lambda s: {'choice': 'empty', 'confidence': 0.95, 'probabilities': {'empty': 0.97, 'occupied': 0.01, 'uncertain': 0.02}}  # noqa: E731


def ans(choice, conf, empty=None):
    return {'choice': choice, 'confidence': conf, 'probabilities': {} if empty is None else {'empty': empty}}


class Store:
    """ops_common 저장소 함수를 메모리로 대체"""

    def __init__(self, auto=False):
        self.settings = {}
        self.decisions = {}
        self.schedules = {}
        self.auto = auto

    def patch(self):
        def update_status(bid, did, status, t, by=None, extra=None, expect='pending'):
            d = self.decisions.get((bid, did))
            if not d or d['status'] != expect:
                return False
            d.update(status=status, decidedAt=t.isoformat(), **({'decidedBy': by} if by else {}), **(extra or {}))
            return True
        return mock.patch.multiple(
            oc,
            get_settings=lambda bid: {'buildingId': bid, 'autoApply': self.settings.get(bid, self.auto), 'updatedAt': None, 'updatedBy': None},
            put_settings=lambda bid, v, by, t: self.settings.__setitem__(bid, v) or {'buildingId': bid, 'autoApply': v},
            recent_decisions=lambda bid, since: sorted((dict(d) for (b, _), d in self.decisions.items() if b == bid), key=lambda d: d['decisionId']),
            get_decision=lambda bid, did: dict(self.decisions[(bid, did)]) if (bid, did) in self.decisions else None,
            put_decision=lambda item: self.decisions.__setitem__((item['buildingId'], item['decisionId']), dict(item)),
            update_status=update_status,
            save_schedule=lambda s: self.schedules.__setitem__(s['id'], s),
            delete_schedule=lambda sid: self.schedules.pop(sid, None) is not None,
        )

    def by_status(self, status, kind='idle'):
        """kind=None이면 모든 종류"""
        return [d for d in self.decisions.values() if d['status'] == status and kind in (None, d['kind'])]


class GateTest(unittest.TestCase):
    def test_gate(self):
        g = lambda a, on=True: op.gate(a, on, 0.8, 0.9)  # noqa: E731
        self.assertEqual(g(ans('empty', 0.86, 0.91)), 'applied')          # 2026-11-20 실측 C 사례
        self.assertEqual(g(ans('empty', 0.86, 0.91), on=False), 'pending')  # 스위치 OFF는 항상 제안
        self.assertEqual(g(ans('empty', 0.7, 0.95)), 'pending')            # 확신도 낮으면 제안
        self.assertEqual(g(ans('empty', 0.85, 0.8)), 'pending')            # empty 확률 낮으면 제안
        self.assertEqual(g(ans('empty', 0.95)), 'pending')                 # 확률 없으면 자동 조치 안 함
        self.assertEqual(g(ans('occupied', 0.85)), 'skipped')
        self.assertEqual(g(ans('uncertain', 0.99)), 'pending')
        self.assertEqual(g(None), 'pending')                               # Jev 실패 폴백

    def test_judge_failure_returns_none(self):
        def boom(state):
            raise TimeoutError()
        self.assertIsNone(op.judge({}, boom))

    def test_idle_matches_recommend_rule(self):
        import recommend
        for room in buildings.rooms('main'):
            hit = recommend._rule(room, T, [])
            self.assertEqual(op.is_idle(room, T, []), bool(hit and hit[0] == 'idle'), room['id'])


class BlockTest(unittest.TestCase):
    def d(self, status, minutes_ago, **kw):
        t = T - dt.timedelta(minutes=minutes_ago)
        return {'kind': 'idle', 'roomId': 'r', 'status': status, 'createdAt': t.isoformat(), 'decidedAt': t.isoformat(), **kw}

    def test_blocked_rooms(self):
        exp = lambda m: (T + dt.timedelta(minutes=m)).isoformat()  # noqa: E731
        self.assertIn(('idle', 'r'), oc.blocked_rooms([self.d('pending', 5, expiresAt=exp(25))], T, 120))
        self.assertNotIn(('idle', 'r'), oc.blocked_rooms([self.d('pending', 40, expiresAt=exp(-10))], T, 120))  # 만료
        self.assertIn(('idle', 'r'), oc.blocked_rooms([self.d('rejected', 100)], T, 120))
        self.assertNotIn(('idle', 'r'), oc.blocked_rooms([self.d('rejected', 130)], T, 120))  # 쿨다운 끝
        self.assertIn(('idle', 'r'), oc.blocked_rooms([self.d('applied', 300)], T, 120))  # 자동 조치는 되돌리기 전까지 유지
        self.assertNotIn(('idle', 'r'), oc.blocked_rooms([self.d('expired', 10)], T, 120))


class OperatorTest(unittest.TestCase):
    def run_once(self, store, t=T, ask=EMPTY, env=None):
        with store.patch(), mock.patch.dict(os.environ, env or {}):
            return op.run(t, [], ask=ask)

    def test_switch_off_makes_pending_suggestions(self):
        s = Store(auto=False)
        out, counts, calls = self.run_once(s)
        self.assertGreater(counts['pending'], 0)
        self.assertEqual(counts['applied'], 0)
        self.assertEqual(s.schedules, {})
        p = s.by_status('pending')[0]
        self.assertIn('끌까요?', p['message'])
        self.assertEqual(p['expiresAt'], (T + dt.timedelta(minutes=30)).isoformat())

    def test_switch_on_applies_with_schedule(self):
        s = Store(auto=True)
        _, counts, _ = self.run_once(s)
        self.assertGreater(counts['applied'], 0)
        a = s.by_status('applied')[0]
        sched = s.schedules[a['scheduleId']]
        self.assertEqual((sched['action'], sched['condition'], sched['roomIds'], sched['time']), ('off', 'unused', [a['roomId']], '19:00'))
        self.assertTrue(sched['sourceText'].startswith('자동 운영'))
        self.assertIn('껐어요', a['message'])

    def test_jev_cap_defers(self):
        s = Store()
        _, counts, calls = self.run_once(s, env={'MAX_JEV_PER_RUN': '2'})
        self.assertEqual(calls, 2)
        self.assertEqual(len(s.by_status('pending')), 2)  # 빈 방 제안만(설정온도 제안은 Jev 상한과 무관)
        self.assertGreater(counts['deferred'], 0)

    def test_no_duplicate_next_run(self):
        s = Store()
        first, _, _ = self.run_once(s)
        second, counts, _ = self.run_once(s, t=T + dt.timedelta(minutes=5))
        rooms = lambda out, kind: {d['roomId'] for d in out if d['kind'] == kind}  # noqa: E731
        # 응답 대기 중인 호실은 다시 묻지 않음(두 번째 실행은 상한으로 미뤄진 호실만)
        self.assertFalse(rooms(first, 'idle') & rooms(second, 'idle'))
        self.assertEqual(counts['alert'], 0)  # 알림도 쿨다운

    def test_expired_then_resuggested(self):
        s = Store()
        self.run_once(s)
        _, counts, _ = self.run_once(s, t=T + dt.timedelta(minutes=35))
        self.assertGreater(counts['expired'], 0)
        self.assertGreater(len(s.by_status('expired')), 0)

    def test_occupied_skipped(self):
        s = Store(auto=True)
        _, counts, _ = self.run_once(s, ask=lambda st: {'choice': 'occupied', 'confidence': 0.95})
        self.assertGreater(counts['skipped'], 0)
        self.assertEqual(len(s.by_status('applied')) + len(s.by_status('pending')), 0)

    def test_jev_state_has_no_judgement(self):
        room = buildings.rooms('main')[0]
        st = op.jev_state(buildings.get('main'), room, T, [])
        self.assertEqual([r['minutesAgo'] for r in st['recent']], [0, 15, 30])
        self.assertNotIn('rule', st)
        self.assertNotIn('facts', op.jev_state(buildings.get('main'), room, T, [], facts=False))  # 이전 형식


class FairOrderTest(unittest.TestCase):
    Q = {'A': ['a1', 'a2', 'a3', 'a4', 'a5'], 'B': ['b1', 'b2'], 'C': ['c1']}

    def test_round_robin(self):
        picked, deferred = op.fair_order(self.Q, 0, 5)
        self.assertEqual([c for _, c in picked], ['a1', 'b1', 'c1', 'a2', 'b2'])
        self.assertEqual([c for _, c in deferred], ['a3', 'a4', 'a5'])

    def test_rotation_changes_first_building(self):
        self.assertEqual(op.fair_order(self.Q, 1, 3)[0][0], ('B', 'b1'))
        self.assertEqual(op.fair_order(self.Q, 2, 3)[0][0], ('C', 'c1'))
        t5 = T + dt.timedelta(minutes=5)
        self.assertEqual((op.rotation(t5, 3) - op.rotation(T, 3)) % 3, 1)  # 5분마다 한 칸 이동
        self.assertEqual(op.rotation(T, 0), 0)

    def test_leftover_calls_not_wasted(self):
        picked, deferred = op.fair_order({'A': ['a1', 'a2', 'a3'], 'B': ['b1']}, 0, 10)
        self.assertEqual(len(picked), 4)  # 상한보다 후보가 적으면 전부 판단
        self.assertEqual(deferred, [])
        picked, _ = op.fair_order({'A': list('123456789'), 'B': []}, 1, 5)
        self.assertEqual(len(picked), 5)  # 한 건물만 후보가 있으면 상한을 모두 사용

    def test_run_spreads_buildings_and_orders_by_energy(self):
        s = Store()
        with s.patch(), mock.patch.dict(os.environ, {'MAX_JEV_PER_RUN': '4'}):
            out, counts, calls = op.run(T, [], ask=EMPTY)
        idle = [d for d in out if d['kind'] == 'idle']
        self.assertEqual(calls, 4)
        cands = {b['id'] for b in buildings.LIST if any(op.is_idle(r, T, []) for r in buildings.rooms(b['id']))}
        self.assertEqual(len({d['buildingId'] for d in idle}), min(4, len(cands)))  # 건물마다 한 건씩
        # 같은 건물 안에서는 빈 채 운전 전력량 내림차순
        by_b = {}
        for d in idle:
            by_b.setdefault(d['buildingId'], []).append(d['evidence']['facts']['idleEnergyKwh'])
        for kwh in by_b.values():
            self.assertEqual(kwh, sorted(kwh, reverse=True))

    def test_first_pick_is_max_energy_room(self):
        s = Store()
        with s.patch(), mock.patch.dict(os.environ, {'MAX_JEV_PER_RUN': '100'}):
            out, _, _ = op.run(T, [], ask=EMPTY)
        main = [d['evidence']['facts']['idleEnergyKwh'] for d in out if d['kind'] == 'idle' and d['buildingId'] == 'main']
        self.assertEqual(main[0], max(main))


class FactsTest(unittest.TestCase):
    B = {'weekend': False}

    def test_hours_facts(self):
        room = {'hours': (9, 18)}
        h = op.hours_facts(room, self.B, T)  # 금 19:00
        self.assertEqual((h['inOperatingHours'], h['minutesSinceClose'], h['minutesUntilOpen']), (False, 60, None))
        h = op.hours_facts(room, self.B, T.replace(hour=13, minute=30))
        self.assertEqual((h['inOperatingHours'], h['minutesUntilClose']), (True, 270))
        h = op.hours_facts(room, self.B, T.replace(hour=7))
        self.assertEqual((h['inOperatingHours'], h['minutesUntilOpen']), (False, 120))
        sat = T + dt.timedelta(days=1)
        self.assertFalse(op.hours_facts(room, self.B, sat)['workday'])          # 주말 미운영
        self.assertTrue(op.hours_facts(room, {'weekend': True}, sat)['workday'])
        self.assertTrue(op.hours_facts({'hours': (8, 24)}, self.B, T.replace(hour=23))['inOperatingHours'])  # 24시 종료

    def test_usage_facts_consistent_with_sim(self):
        room = next(r for r in buildings.rooms('main') if op.is_idle(r, T, []))
        f = op.usage_facts(room, T, [])
        self.assertGreaterEqual(f['idleOnMinutes'], 30)  # 후보 조건(30분)과 일치
        self.assertEqual(f['slotsToday'], 19 * 4 + 1)    # 00:00~19:00, 15분 간격
        occ = [sim.state(room, T.replace(hour=0, minute=0) + dt.timedelta(minutes=15 * i), [])['occupants'] for i in range(77)]
        self.assertEqual(f['occupiedSlotsToday'], sum(o > 0 for o in occ))
        if f['lastOccupiedAt']:
            hh, mm = map(int, f['lastOccupiedAt'].split(':'))
            self.assertGreater(sim.state(room, T.replace(hour=hh, minute=mm), [])['occupants'], 0)
        self.assertLessEqual(f['usedAtThisTimeLast7Days'], 7)

    def test_never_occupied_room(self):
        # sim은 #61부터 '기타' 용도에도 가상 재실을 주므로 재실 0명을 직접 고정
        room = buildings.rooms('main')[0]
        with mock.patch.object(sim, 'occupants', lambda r, t: 0):
            f = op.usage_facts(room, T, [])
        self.assertEqual((f['lastOccupiedAt'], f['minutesSinceLastOccupied'], f['occupiedSlotsToday']), (None, None, 0))


def event(method, bid='main', body=None, **path):
    return {'requestContext': {'http': {'method': method}, 'authorizer': {'jwt': {'claims': {'sub': 'u1'}}}},
            'pathParameters': {'id': bid, **path}, 'body': json.dumps(body) if body is not None else None}


class ApiTest(unittest.TestCase):
    def call(self, store, ev, role='operator'):
        with store.patch(), mock.patch.object(tenant, 'caller', lambda e: {'sub': 'u1', 'role': role, 'companyId': 'c1', 'email': None}), \
                mock.patch.object(ops_api, '_now', lambda: T + dt.timedelta(minutes=1)):
            r = ops_api.handler(ev, None)
        return r['statusCode'], json.loads(r['body'])

    def seeded(self, auto=False):
        s = Store(auto=auto)
        with s.patch():
            op.run(T, [], ask=EMPTY)
        return s

    def test_overview(self):
        s = self.seeded()
        code, body = self.call(s, event('GET'))
        self.assertEqual(code, 200)
        self.assertFalse(body['settings']['autoApply'])
        self.assertEqual(body['pendingCount'], len([d for d in s.by_status('pending', kind=None) if d['buildingId'] == 'main']))
        self.assertNotIn('ttl', body['decisions'][0])

    def test_switch_roles(self):
        s = Store()
        self.assertEqual(self.call(s, event('PUT', body={'autoApply': True}), role='operator')[0], 403)
        self.assertEqual(self.call(s, event('PUT', body={'autoApply': True}), role='manager')[0], 200)
        self.assertEqual(self.call(s, event('PUT', body={'autoApply': True}), role='admin')[0], 200)
        self.assertEqual(self.call(s, event('PUT', body={'autoApply': 'yes'}), role='manager')[0], 400)
        self.assertTrue(s.settings['main'])

    def test_accept_saves_schedule_once(self):
        s = self.seeded()
        did = s.by_status('pending')[0]['decisionId']
        code, body = self.call(s, event('POST', decisionId=did, action='accept'))
        self.assertEqual(code, 200)
        self.assertEqual(body['status'], 'accepted')
        self.assertIn(body['scheduleId'], s.schedules)
        self.assertEqual(self.call(s, event('POST', decisionId=did, action='accept'))[0], 409)  # 두 번째 수락

    def test_reject(self):
        s = self.seeded()
        did = s.by_status('pending')[0]['decisionId']
        self.assertEqual(self.call(s, event('POST', decisionId=did, action='reject'))[1]['status'], 'rejected')
        self.assertEqual(s.schedules, {})

    def test_undo_applied(self):
        s = self.seeded(auto=True)
        a = s.by_status('applied')[0]
        code, body = self.call(s, event('POST', decisionId=a['decisionId'], action='undo'))
        self.assertEqual((code, body['status']), (200, 'reverted'))
        self.assertNotIn(a['scheduleId'], s.schedules)
        self.assertEqual(self.call(s, event('POST', decisionId=a['decisionId'], action='undo'))[0], 409)

    def test_expired_cannot_accept(self):
        s = self.seeded()
        did = s.by_status('pending')[0]['decisionId']
        with mock.patch.object(ops_api, '_now', lambda: T + dt.timedelta(minutes=31)):
            with s.patch(), mock.patch.object(tenant, 'caller', lambda e: {'sub': 'u1', 'role': 'operator', 'companyId': 'c1', 'email': None}):
                r = ops_api.handler(event('POST', decisionId=did, action='accept'), None)
        self.assertEqual(r['statusCode'], 409)

    def test_bad_action_and_unknown(self):
        s = self.seeded()
        self.assertEqual(self.call(s, event('POST', decisionId='x', action='delete'))[0], 400)
        self.assertEqual(self.call(s, event('POST', decisionId='nope', action='accept'))[0], 404)
        self.assertEqual(self.call(s, event('GET', bid='no-such'))[0], 404)

    def test_forbidden_building(self):
        s = Store()
        with s.patch(), mock.patch.object(tenant, 'require_building', mock.Mock(side_effect=tenant.Forbidden())):
            r = ops_api.handler(event('GET'), None)
        self.assertEqual(r['statusCode'], 403)


class SetpointTest(unittest.TestCase):
    """⑤ 규칙 기반 설정온도 제안(kind=setpoint): recommend.py 'overset' 기준, Jev 없이 결정"""

    def run_once(self, store, t=T, env=None, ask=EMPTY):
        with store.patch(), mock.patch.dict(os.environ, env or {}):
            return op.run(t, [], ask=ask)

    def sp(self, store, status):
        return store.by_status(status, kind='setpoint')

    def test_candidate_rule(self):
        room = buildings.rooms('main')[0]
        st = lambda mode, sp, on=True: {'mode': mode, 'setpoint': sp, 'onOff': on, 'temp': 23.0, 'powerKw': 1.0, 'occupants': 2}  # noqa: E731
        with mock.patch.object(recommend, 'saving', lambda *a: 2.5):
            c = op.setpoint_candidate(room, st('cooling', 22), T, [])
            self.assertEqual((c['target'], c['savingKwhDay'], c['rule']), (recommend.COOL_MIN, 2.5, 'overset'))
            self.assertEqual(op.setpoint_candidate(room, st('heating', 24), T, [])['target'], recommend.HEAT_MAX)
            self.assertIsNone(op.setpoint_candidate(room, st('cooling', recommend.COOL_MIN), T, []))  # 기준 이상은 정상
            self.assertIsNone(op.setpoint_candidate(room, st('heating', recommend.HEAT_MAX), T, []))
            self.assertIsNone(op.setpoint_candidate(room, st('heating', 24, on=False), T, []))      # 꺼진 방은 제안 안 함
        with mock.patch.object(recommend, 'saving', lambda *a: 0.0):
            self.assertIsNone(op.setpoint_candidate(room, st('heating', 24), T, []))                # 절감 0이면 제안 안 함

    def test_switch_off_makes_pending(self):
        s = Store(auto=False)
        _, counts, _ = self.run_once(s)
        p = self.sp(s, 'pending')
        self.assertGreater(len(p), 0)
        self.assertEqual(counts['setpoint'], len(p))
        self.assertEqual(s.schedules, {})
        d = p[0]
        self.assertEqual(d['evidence']['target'], recommend.HEAT_MAX)  # 11월은 난방
        self.assertGreater(d['evidence']['setpoint'], recommend.HEAT_MAX)
        self.assertGreater(d['evidence']['savingKwhDay'], 0)
        self.assertNotIn('jev', d)
        self.assertIn('바꿀까요?', d['message'])
        self.assertEqual(d['expiresAt'], (T + dt.timedelta(minutes=30)).isoformat())

    def test_matches_recommend_and_skips_idle(self):
        s = Store()
        out, _, _ = self.run_once(s)
        for d in (x for x in out if x['kind'] == 'setpoint'):
            room = buildings.BY_ROOM[d['roomId']]
            st = sim.state(room, T, [])
            self.assertTrue(st['onOff'])
            self.assertGreater(st['setpoint'], recommend.HEAT_MAX)
            self.assertFalse(op.is_idle(room, T, []))  # 빈 방 운전 호실은 끄기 우선

    def test_switch_on_applies_setpoint_schedule(self):
        s = Store(auto=True)
        self.run_once(s)
        a = self.sp(s, 'applied')[0]
        sched = s.schedules[a['scheduleId']]
        self.assertEqual((sched['action'], sched['setpoint'], sched['time'], sched['condition'], sched['roomIds']),
                         ('setpoint', float(a['evidence']['target']), '00:00', 'always', [a['roomId']]))
        self.assertTrue(sched['sourceText'].startswith('자동 운영'))
        self.assertIn('바꿨어요', a['message'])
        self.assertEqual(sim.state(buildings.BY_ROOM[a['roomId']], T, [sched])['setpoint'], a['evidence']['target'])

    def test_cap_per_building_keeps_largest_saving(self):
        full, capped = Store(), Store()
        self.run_once(full, env={'MAX_SETPOINT_PER_BUILDING': '100'})
        self.run_once(capped, env={'MAX_SETPOINT_PER_BUILDING': '1'})
        by_b = {}
        for d in self.sp(full, 'pending'):
            by_b.setdefault(d['buildingId'], []).append(d['evidence']['savingKwhDay'])
        got = {d['buildingId']: d['evidence']['savingKwhDay'] for d in self.sp(capped, 'pending')}
        self.assertEqual(len(got), len(self.sp(capped, 'pending')))  # 건물당 1건
        self.assertEqual(got, {b: max(v) for b, v in by_b.items()})

    def test_no_duplicate_and_independent_of_jev(self):
        s = Store()
        first, _, _ = self.run_once(s, env={'MAX_JEV_PER_RUN': '0'})  # Jev 호출 0건이어도 설정온도 제안은 생김
        self.assertGreater(len(self.sp(s, 'pending')), 0)
        second, _, _ = self.run_once(s, t=T + dt.timedelta(minutes=5))
        rooms = lambda out: {d['roomId'] for d in out if d['kind'] == 'setpoint'}  # noqa: E731
        self.assertFalse(rooms(first) & rooms(second))

    def test_api_accept_and_undo(self):
        s = Store()
        self.run_once(s)
        d = self.sp(s, 'pending')[0]
        call = ApiTest.call
        code, body = call(self, s, event('POST', bid=d['buildingId'], decisionId=d['decisionId'], action='accept'))
        self.assertEqual((code, body['status']), (200, 'accepted'))
        sched = s.schedules[body['scheduleId']]
        self.assertEqual((sched['action'], sched['setpoint']), ('setpoint', float(d['evidence']['target'])))
        code, body = call(self, s, event('POST', bid=d['buildingId'], decisionId=d['decisionId'], action='undo'))
        self.assertEqual((code, body['status']), (200, 'reverted'))
        self.assertEqual(s.schedules, {})

    def test_reject_cooldown(self):
        s = Store()
        self.run_once(s)
        d = self.sp(s, 'pending')[0]
        ApiTest.call(self, s, event('POST', bid=d['buildingId'], decisionId=d['decisionId'], action='reject'))
        later, _, _ = self.run_once(s, t=T + dt.timedelta(minutes=40))  # 만료 뒤에도 거절 쿨다운(120분) 동안 다시 제안 안 함
        self.assertNotIn(d['roomId'], {x['roomId'] for x in later if x['kind'] == 'setpoint'})


class PowerTest(unittest.TestCase):
    """④ 전력 이상(kind=power): 최근 4주 같은 요일·시각(usage.baseline) 대비, Jev 없이 알림"""
    T_DAY = dt.datetime(2026, 11, 20, 14, 10, tzinfo=sim.KST)    # 금요일 14:10(운영 시간)
    T_NIGHT = dt.datetime(2026, 11, 20, 22, 10, tzinfo=sim.KST)  # 금요일 22:10(운영 시간 뒤)

    def setUp(self):
        usage._day.cache_clear()

    def st(self, power=2.5, occ=3, on=True, anomaly=None):
        return {'onOff': on, 'occupants': occ, 'powerKw': power, 'anomaly': anomaly}

    def check(self, st, base, idle=False):
        b = {'weekday': '금', 'hour': 14, 'weeks': 4, **base}
        with mock.patch.object(usage, 'baseline', lambda *a, **k: b):
            return op.power_anomaly(buildings.rooms('main')[0], st, self.T_DAY, [], idle)

    def test_rules(self):
        usual = {'onWeeks': 3, 'onAvgKw': 1.0, 'onMaxOccupants': 5}
        ev = self.check(self.st(2.5, 3), usual)
        self.assertEqual((ev['rule'], ev['excessKw']), ('power_high', 1.5))
        self.assertIsNone(self.check(self.st(2.5, 6), usual))                                  # 사람이 더 와서 늘어난 전력은 정상
        self.assertIsNone(self.check(self.st(1.2, 3), usual))                                  # 1.3배 미만
        self.assertIsNone(self.check(self.st(1.4, 3), {**usual, 'onAvgKw': 0.5}))              # 차이 1kW 미만
        self.assertIsNone(self.check(self.st(2.5, 3), {**usual, 'onWeeks': 1}))                # 평소 운전 주 부족
        self.assertIsNone(self.check(self.st(2.5, 3, anomaly='setpoint_unreached'), usual))    # 미도달 알림과 중복 안 함
        self.assertIsNone(self.check(self.st(0, 0, on=False), usual))
        never = {'onWeeks': 0, 'onAvgKw': None, 'onMaxOccupants': 0}
        self.assertEqual(self.check(self.st(2.0, 0), never)['rule'], 'unusual_hours')
        self.assertIsNone(self.check(self.st(2.0, 0), never, idle=True))                       # 30분 넘으면 끄기 제안으로
        self.assertIsNone(self.check(self.st(2.0, 2), never))                                  # 사람이 있으면 사용 중

    def night_room(self):
        # 평소 금요일 22시에 꺼져 있는 호실
        return next(r for r in buildings.rooms('main') if not sim.state(r, self.T_NIGHT, [])['onOff']
                    and usage.baseline(r, self.T_NIGHT, [])['onWeeks'] == 0)

    def run_once(self, store, t, schedules):
        with store.patch():
            return op.run(t, schedules, ask=EMPTY)

    def test_unusual_hours_from_new_schedule(self):
        room = self.night_room()
        sched = {'id': 's-on', 'buildingId': 'main', 'roomIds': [room['id']], 'action': 'on', 'time': '22:00', 'condition': 'always',
                 'createdAt': self.T_NIGHT.replace(hour=21).isoformat()}
        out, counts, _ = self.run_once(Store(), self.T_NIGHT, [sched])
        alerts = [d for d in out if d['kind'] == 'power' and d['roomId'] == room['id']]
        self.assertEqual(len(alerts), 1)
        a = alerts[0]
        self.assertEqual((a['status'], a['evidence']['rule'], a['evidence']['onWeeks']), ('alert', 'unusual_hours', 0))
        self.assertIn('꺼져 있던 방인데', a['message'])
        self.assertGreaterEqual(counts['power'], 1)
        # 같은 스케줄이 4주 전부터 있었다면 평소 운전이라 알림 없음
        old = {**sched, 'createdAt': '2026-09-01T00:00:00+09:00'}
        usage._day.cache_clear()
        out, _, _ = self.run_once(Store(), self.T_NIGHT, [old])
        self.assertFalse([d for d in out if d['kind'] == 'power' and d['roomId'] == room['id']])
        # 30분 뒤에는 빈 방 운전 후보(끄기 제안)로 넘어가고 전력 알림은 쿨다운
        s = Store()
        self.run_once(s, self.T_NIGHT, [sched])
        later, _, _ = self.run_once(s, self.T_NIGHT + dt.timedelta(minutes=30), [sched])
        self.assertIn(room['id'], {d['roomId'] for d in later if d['kind'] == 'idle'})
        self.assertNotIn(room['id'], {d['roomId'] for d in later if d['kind'] == 'power'})

    def test_power_high_in_run_and_cooldown(self):
        s = Store()
        first, _, _ = self.run_once(s, self.T_DAY, [])
        high = [d for d in first if d['kind'] == 'power']
        self.assertGreater(len(high), 0)
        for d in high:
            ev = d['evidence']
            self.assertEqual(ev['rule'], 'power_high')
            self.assertGreaterEqual(ev['powerKw'], ev['onAvgKw'] * 1.3)
            self.assertLessEqual(ev['occupants'], ev['onMaxOccupants'])
            self.assertIn('설비 점검', d['message'])
        second, _, _ = self.run_once(s, self.T_DAY + dt.timedelta(minutes=5), [])
        self.assertFalse({d['roomId'] for d in high} & {d['roomId'] for d in second if d['kind'] == 'power'})


if __name__ == '__main__':
    unittest.main()
