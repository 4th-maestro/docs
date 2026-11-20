"""기업 코드, 가입 전 검사·가입 확인, 소속 검사(403), 중지 기업, 판매사 관리 API, 고객사 설정 API, /me 테스트(가짜 테이블, 네트워크 없음)"""
import contextlib
import datetime as dt
import io
import json
import os
import pathlib
import re
import sys
import time
import types
import unittest
from decimal import Decimal
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
# anthropic·boto3 미설치 환경에서도 실행되도록 모듈 대체(test_ws.py와 같은 방식)
sys.modules.setdefault('anthropic', types.SimpleNamespace(AnthropicBedrock=lambda **kw: None))
sys.modules.setdefault('boto3', types.SimpleNamespace(client=None))
import admin  # noqa: E402
import api  # noqa: E402
import buildings  # noqa: E402
import confirm  # noqa: E402
import plan  # noqa: E402
import query  # noqa: E402
import signup  # noqa: E402
import sim  # noqa: E402
import tenant  # noqa: E402
import ws  # noqa: E402

ENV = {'COMPANIES_TABLE': 'C', 'MEMBERS_TABLE': 'M', 'OWNERS_TABLE': 'O', 'AUDIT_TABLE': 'A'}
CODE_RE = re.compile(f'^EGE-[{tenant.CODE_ALPHABET}]{{4}}-[{tenant.CODE_ALPHABET}]{{4}}$')
FUTURE = (tenant.now() + dt.timedelta(days=10)).isoformat()
PAST = (tenant.now() - dt.timedelta(seconds=1)).isoformat()


class FakeTable:
    """DynamoDB Table 대체: get·put·delete·scan, query(#k = :v, 보조 인덱스 또는 기본 키, 정렬 방향, 개수)"""

    def __init__(self, key, sort=None):
        self.key, self.sort, self.items = key, sort, {}

    def _k(self, d):
        return (d[self.key], d[self.sort]) if self.sort else d[self.key]

    def get_item(self, Key):
        it = self.items.get(self._k(Key))
        return {'Item': dict(it)} if it else {}

    def put_item(self, Item):
        self.items[self._k(Item)] = dict(Item)

    def delete_item(self, Key, **kw):
        self.items.pop(self._k(Key), None)
        return {}

    def batch_writer(self, **kw):
        return contextlib.nullcontext(self)

    def scan(self, **kw):
        return {'Items': [dict(i) for i in self.items.values()]}

    def query(self, KeyConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues, IndexName=None, ScanIndexForward=True, Limit=None, **kw):
        a, v = ExpressionAttributeNames['#k'], ExpressionAttributeValues[':v']
        items = [dict(i) for i in self.items.values() if i.get(a) == v]
        if not IndexName and self.sort:
            items.sort(key=lambda i: i[self.sort], reverse=not ScanIndexForward)
        return {'Items': items[:Limit]}


def http(route, sub='u-a', groups='', query=None, body=None, path=None):
    method, p = route.split(' ', 1)
    return {'routeKey': route, 'rawPath': p, 'queryStringParameters': query, 'pathParameters': path,
            'body': json.dumps(body) if body is not None else None,
            'requestContext': {'http': {'method': method}, 'authorizer': {'jwt': {'claims': {'sub': sub, 'cognito:groups': groups}}}}}


def call(event):
    r = api.handler(event, None)
    return r['statusCode'], json.loads(r['body'])


def ws_ask(sub, building):
    """WebSocket ask 이벤트 처리 후 연결로 보낸 이벤트 목록"""
    sent = []
    ws.boto3 = types.SimpleNamespace(client=lambda name, endpoint_url: types.SimpleNamespace(
        exceptions=types.SimpleNamespace(GoneException=type('Gone', (Exception,), {})),
        post_to_connection=lambda ConnectionId, Data: sent.append(json.loads(Data))))
    ws.handler({'requestContext': {'routeKey': 'ask', 'connectionId': 'c1', 'domainName': 'x', 'stage': 'prod', 'authorizer': {'sub': sub, 'groups': ''}},
                'body': json.dumps({'action': 'ask', 'requestId': 'r1', 'text': '전력', 'buildingId': building})}, None)
    return sent


class Tenancy(unittest.TestCase):
    """기업 A(main, office), 기업 B(edu), 소속 없는 lab. u-a는 A 관리자, u-b는 B 운영자"""

    def setUp(self):
        self.t = {'C': FakeTable('companyId'), 'M': FakeTable('sub'), 'O': FakeTable('buildingId'), 'A': FakeTable('companyId', 'at')}
        tenant._tables.clear()
        tenant._tables.update(self.t)
        tenant.forget()
        buildings.forget()  # 건물 수정 정보(가짜 소속 테이블)를 다시 읽도록 캐시 비움
        self.patches = [patch.dict(os.environ, ENV), patch.object(tenant, 'email', return_value='boss@vendor.com')]
        for p in self.patches:
            p.start()
        for cid, name, code in (('co-a', '가나 기업', 'EGE-AAAA-BBBB'), ('co-b', '다라 기업', 'EGE-CCCC-DDDD')):
            self.t['C'].put_item({'companyId': cid, 'name': name, 'status': 'active', 'code': code, 'codeExpiresAt': FUTURE, 'createdAt': '2026-11-20T09:00:00+09:00'})
        for bid, cid in (('main', 'co-a'), ('office', 'co-a'), ('edu', 'co-b')):
            self.t['O'].put_item({'buildingId': bid, 'companyId': cid})
        self.t['M'].put_item({'sub': 'u-a', 'companyId': 'co-a', 'email': 'a@ga.com', 'role': 'manager', 'joinedAt': '2026-11-20T10:00:00+09:00'})
        self.t['M'].put_item({'sub': 'u-b', 'companyId': 'co-b', 'email': 'b@da.com', 'role': 'operator', 'joinedAt': '2026-11-20T10:00:00+09:00'})

    def tearDown(self):
        # 시작 역순으로 해제: patch.dict는 시작 시점 환경 변수로 복원
        for p in reversed(self.patches):
            p.stop()
        tenant._tables.clear()
        tenant.forget()
        buildings.forget()

    def audits(self, action):
        return [a for a in self.t['A'].items.values() if a['action'] == action]


class CodeTest(Tenancy):
    def test_format_and_normalize(self):
        codes = {tenant.new_code() for _ in range(50)}
        self.assertTrue(all(CODE_RE.match(c) for c in codes))
        self.assertGreater(len(codes), 45)
        self.assertRegex(tenant.new_company_id(), r'^co-[a-z0-9]{8}$')
        for raw in ('EGE-7KQ2-M9XD', ' ege 7kq2 m9xd ', 'ege7kq2m9xd', 'EGE-7KQ2M9XD'):
            self.assertEqual(tenant.normalize_code(raw), 'EGE-7KQ2-M9XD', raw)
        for bad in (None, 123, '', 'EGE-7KQ2-M9X', 'EGE-0KQ2-M9XD', 'EGE-IKQ2-M9XD', 'ABC-7KQ2-M9XD', 'EGE-7KQ2-M9XDZ'):
            self.assertIsNone(tenant.normalize_code(bad), bad)

    def test_lookup_rejects_expired_suspended_unknown(self):
        self.assertEqual(tenant.company_by_code('ege aaaa bbbb')['companyId'], 'co-a')
        self.assertIsNone(tenant.company_by_code('EGE-2222-3333'))
        self.t['C'].items['co-a']['codeExpiresAt'] = PAST
        self.assertIsNone(tenant.company_by_code('EGE-AAAA-BBBB'))
        self.t['C'].items['co-b']['status'] = 'suspended'
        self.assertIsNone(tenant.company_by_code('EGE-CCCC-DDDD'))

    def test_code_days(self):
        exp = dt.datetime.fromisoformat(tenant.code_fields(7)['codeExpiresAt'])
        self.assertAlmostEqual((exp - tenant.now()).total_seconds(), 7 * 86400, delta=5)


def presignup(source, code=None, email='New@Ga.com'):
    return {'triggerSource': source, 'request': {'userAttributes': {'email': email}, 'clientMetadata': {'companyCode': code} if code else None}}


def confirmed(sub, email, source='PostConfirmation_ConfirmSignUp'):
    return {'triggerSource': source, 'request': {'userAttributes': {'sub': sub, 'email': email}}}


class SignupTest(Tenancy):
    def test_valid_code_writes_pending(self):
        ev = presignup('PreSignUp_SignUp', 'egeaaaabbbb')
        self.assertIs(signup.handler(ev, None), ev)
        p = self.t['M'].items['pending#new@ga.com']
        self.assertEqual(p['companyId'], 'co-a')
        self.assertAlmostEqual(p['ttl'] - time.time(), 2 * 86400, delta=5)

    def test_rejects_bad_expired_missing(self):
        self.t['C'].items['co-b']['codeExpiresAt'] = PAST
        for code in ('EGE-2222-3333', 'EGE-CCCC-DDDD', None):
            with self.assertRaises(Exception) as c:
                signup.handler(presignup('PreSignUp_SignUp', code), None)
            self.assertEqual(str(c.exception), signup.INVALID)
        self.assertNotIn('pending#new@ga.com', self.t['M'].items)

    def test_admin_create_allowed_other_sources_denied(self):
        self.assertIsNotNone(signup.handler(presignup('PreSignUp_AdminCreateUser'), None))
        with self.assertRaises(Exception):
            signup.handler(presignup('PreSignUp_ExternalProvider', 'EGE-AAAA-BBBB'), None)


class ConfirmTest(Tenancy):
    def test_first_member_manager_then_operator(self):
        self.t['C'].put_item({'companyId': 'co-c', 'name': '새 기업', 'status': 'active', 'code': 'EGE-EEEE-FFFF', 'codeExpiresAt': FUTURE})
        for email in ('x@new.com', 'y@new.com'):
            signup.handler(presignup('PreSignUp_SignUp', 'EGE-EEEE-FFFF', email), None)
        confirm.handler(confirmed('s-x', 'X@new.com'), None)
        confirm.handler(confirmed('s-y', 'y@new.com'), None)
        m = self.t['M'].items
        self.assertEqual((m['s-x']['role'], m['s-y']['role']), ('manager', 'operator'))
        self.assertEqual((m['s-x']['companyId'], m['s-x']['email']), ('co-c', 'x@new.com'))
        self.assertFalse([k for k in m if k.startswith('pending#')])
        joins = self.audits('member.join')
        self.assertEqual(sorted(a['target'] for a in joins), ['s-x', 's-y'])
        self.assertEqual(joins[0]['companyId'], 'co-c')

    def test_no_pending_expired_or_other_source(self):
        confirm.handler(confirmed('s-z', 'z@none.com'), None)
        self.t['M'].put_item({'sub': 'pending#old@ga.com', 'companyId': 'co-a', 'ttl': int(time.time()) - 1})
        confirm.handler(confirmed('s-old', 'old@ga.com'), None)
        self.t['M'].put_item({'sub': 'pending#pw@ga.com', 'companyId': 'co-a', 'ttl': int(time.time()) + 100})
        confirm.handler(confirmed('s-pw', 'pw@ga.com', 'PostConfirmation_ConfirmForgotPassword'), None)
        self.assertFalse({'s-z', 's-old', 's-pw'} & set(self.t['M'].items))
        self.assertEqual(self.audits('member.join'), [])


class GuardTest(Tenancy):
    def test_status_by_company(self):
        self.assertEqual(call(http('GET /rooms/status', query={'building': 'main'}))[0], 200)
        code, body = call(http('GET /rooms/status', query={'building': 'edu'}))
        self.assertEqual((code, body), (403, {'error': '이 건물에 접근할 권한이 없습니다.'}))
        self.assertEqual(call(http('GET /rooms/status', sub='boss', groups='[admin]', query={'building': 'edu'}))[0], 200)
        self.assertEqual(call(http('GET /rooms/status', sub='nobody', query={'building': 'main'}))[0], 403)
        self.assertEqual(call(http('GET /rooms/status', query={'building': 'nope'}))[0], 400)

    def test_disabled_without_members_table(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(call(http('GET /rooms/status', sub='nobody', query={'building': 'edu'}))[0], 200)

    def test_schedules_post_and_delete(self):
        with patch.object(api.schedules.common, 'put_schedule') as put:
            self.assertEqual(call(http('POST /schedules', body={'buildingId': 'edu', 'roomIds': ['x']}))[0], 403)
            self.assertEqual(call(http('POST /schedules', body={'buildingId': 'main', 'roomIds': ['x']}))[0], 400)
            put.assert_not_called()
        sid = '3f1c2a9e-8b7d-4c6e-9f00-1234567890ab'
        with patch.object(api.schedules.common, 'list_schedules', return_value=[{'id': sid, 'buildingId': 'edu'}]), \
                patch.object(api.schedules.common, 'delete_schedule', return_value=True) as delete:
            self.assertEqual(call(http('DELETE /schedules/{id}', path={'id': sid}))[0], 403)
            delete.assert_not_called()
            self.assertEqual(call(http('DELETE /schedules/{id}', sub='u-b', path={'id': sid}))[0], 200)

    def test_plan_chat_energy(self):
        self.assertEqual(call(http('GET /buildings/{id}/plan', path={'id': 'edu'}))[0], 403)
        self.assertEqual(call(http('GET /buildings/{id}/plan', path={'id': 'main'}))[0], 404)  # 도면 버킷 없음
        self.assertEqual(call(http('GET /chat', query={'building': 'edu'}))[0], 403)
        self.assertEqual(call(http('GET /chat', query={'building': 'main'}))[0], 200)
        self.assertEqual(call(http('GET /energy/trend', query={'building': 'edu', 'period': 'day'}))[0], 403)
        code, body = call(http('GET /energy/compare', query={'period': 'day'}))
        self.assertEqual((code, [i['buildingId'] for i in body['items']]), (200, ['main', 'office']))

    def test_portfolio_filter(self):
        api.portfolio._cache['key'] = None  # 다른 테스트의 가짜 건물 응답 캐시 제거
        ids =lambda **kw: {c['id'] for c in call(http('GET /buildings', **kw))[1]['buildings']}  # noqa: E731
        self.assertEqual(ids(), {'main', 'office'})
        self.assertEqual(ids(sub='u-b'), {'edu'})
        self.assertEqual(ids(sub='boss', groups='[admin]'), {'main', 'office', 'edu', 'lab'})
        self.assertEqual(ids(sub='nobody'), set())

    def test_query_and_ws_no_model_call(self):
        calls = []
        query.client = types.SimpleNamespace(messages=types.SimpleNamespace(stream=lambda **kw: calls.append(kw)))
        r = query.handler(http('POST /query', body={'text': '전력', 'buildingId': 'edu'}), None)
        self.assertEqual(r['statusCode'], 403)
        self.assertEqual(ws_ask('u-a', 'edu'), [{'type': 'error', 'message': '이 건물에 접근할 권한이 없습니다.', 'requestId': 'r1'}])
        self.assertEqual(calls, [])
        # WebSocket 권한 부여자 context의 groups로 판매사 총관리자 판정
        self.assertIsNone(tenant.allowed_buildings(tenant.caller({'requestContext': {'authorizer': {'sub': 'boss', 'groups': 'admin'}}})))

    def test_members_keep_operations(self):
        # 고객사 구성원(관리자·운영자)은 소속 건물의 스케줄 저장·취소 가능(운영), 관리 API만 판매사 전용
        for sub, bid in (('u-a', 'main'), ('u-b', 'edu')):
            room = buildings.rooms(bid)[0]['id']
            with patch.object(api.schedules.common, 'put_schedule') as put:
                code, item = call(http('POST /schedules', sub=sub, body={'buildingId': bid, 'roomIds': [room], 'action': 'off', 'time': '13:00', 'condition': 'unused'}))
            self.assertEqual((code, item['buildingId']), (201, bid), sub)
            put.assert_called_once()
            with patch.object(api.schedules.common, 'list_schedules', return_value=[item]), \
                    patch.object(api.schedules.common, 'delete_schedule', return_value=True) as delete:
                self.assertEqual(call(http('DELETE /schedules/{id}', sub=sub, path={'id': item['id']})), (200, {'id': item['id'], 'deleted': True}))
            delete.assert_called_once_with(item['id'])


def adm(route, **kw):
    return call(http(route, sub='boss', groups='[admin]', **kw))


class AdminTest(Tenancy):
    def test_admin_group_parsing(self):
        self.assertEqual(tenant.caller(http('GET /x', sub='s', groups='[admin ops]'))['role'], 'admin')
        self.assertEqual(tenant.caller(http('GET /x', sub='s', groups=['admin']))['role'], 'admin')
        self.assertIsNone(tenant.caller(http('GET /x', sub='s', groups='[administrator]'))['role'])

    def test_non_admin_forbidden_everywhere(self):
        for route in admin.ROUTES:
            self.assertEqual(call(http(route, path={'id': 'co-a'}, body={}))[0], 403, route)
        self.assertEqual(self.t['A'].items, {})

    def test_create_validates(self):
        for body in ({}, {'name': ' '}, {'name': 'x' * 61}, {'name': 'a', 'codeDays': 0}, {'name': 'a', 'codeDays': 366},
                     {'name': 'a', 'codeDays': True}, {'name': 'a', 'contactEmail': 'bad'}, {'name': 'a', 'phone': 1}):
            self.assertEqual(adm('POST /admin/companies', body=body)[0], 400, body)
        code, body = adm('POST /admin/companies', body={'name': ' 마바 기업 ', 'contactEmail': 'k@mb.com', 'codeDays': 5, 'status': 'suspended'})
        c = body['company']
        self.assertEqual(code, 201)
        self.assertEqual(set(c), {'id', 'name', 'contactName', 'contactEmail', 'phone', 'address', 'status', 'code', 'codeExpiresAt', 'createdAt'})
        self.assertEqual((c['name'], c['status'], c['phone']), ('마바 기업', 'active', ''))
        self.assertRegex(c['id'], r'^co-[a-z0-9]{8}$')
        self.assertRegex(c['code'], CODE_RE)
        self.assertEqual(tenant.company_by_code(c['code'])['companyId'], c['id'])
        a = self.audits('company.create')[0]
        self.assertEqual((a['companyId'], a['actor']), (c['id'], {'sub': 'boss', 'email': 'boss@vendor.com', 'role': 'admin'}))

    def test_list_and_detail(self):
        self.t['M'].put_item({'sub': 'pending#p@ga.com', 'companyId': 'co-a', 'ttl': 1})
        cs = {c['id']: c for c in adm('GET /admin/companies')[1]['companies']}
        self.assertEqual((cs['co-a']['buildingCount'], cs['co-a']['memberCount']), (2, 1))
        code, body = adm('GET /admin/companies/{id}', path={'id': 'co-a'})
        self.assertEqual([b['id'] for b in body['buildings']], ['main', 'office'])
        self.assertEqual(body['buildings'][0], {'id': 'main', 'name': '본관', 'use': '의료', 'floors': ['1F', '2F'], 'roomCount': len(buildings.rooms('main')),
                                                'hours': [9, 18], 'weekend': False, 'hasTwin': False})
        self.assertEqual(body['members'], [{'sub': 'u-a', 'email': 'a@ga.com', 'role': 'manager', 'joinedAt': '2026-11-20T10:00:00+09:00'}])
        self.assertEqual(adm('GET /admin/companies/{id}', path={'id': 'co-x'})[0], 404)

    def test_patch_and_code(self):
        self.assertEqual(adm('PATCH /admin/companies/{id}', path={'id': 'co-a'}, body={})[0], 400)
        self.assertEqual(adm('PATCH /admin/companies/{id}', path={'id': 'co-a'}, body={'status': 'closed'})[0], 400)
        code, body = adm('PATCH /admin/companies/{id}', path={'id': 'co-a'}, body={'status': 'suspended', 'phone': '051-000'})
        self.assertEqual((code, body['company']['status'], body['company']['name']), (200, 'suspended', '가나 기업'))
        self.assertIsNone(tenant.company_by_code('EGE-AAAA-BBBB'))
        self.assertEqual(adm('POST /admin/companies/{id}/code', path={'id': 'co-b'}, body={'days': 0})[0], 400)
        code, body = adm('POST /admin/companies/{id}/code', path={'id': 'co-b'}, body={'days': 3})
        self.assertNotEqual(body['company']['code'], 'EGE-CCCC-DDDD')
        self.assertIsNone(tenant.company_by_code('EGE-CCCC-DDDD'))  # 재발급 후 이전 코드 무효
        self.assertEqual(tenant.company_by_code(body['company']['code'])['companyId'], 'co-b')
        self.assertEqual([len(self.audits(a)) for a in ('company.update', 'company.code')], [1, 1])

    def test_delete_conflict_and_members_removed(self):
        code, body = adm('DELETE /admin/companies/{id}', path={'id': 'co-a'})
        self.assertEqual((code, body), (409, {'error': '건물이 남아 있는 기업은 삭제할 수 없습니다.'}))
        self.t['O'].delete_item({'buildingId': 'edu'})
        self.t['M'].put_item({'sub': 'pending#q@da.com', 'companyId': 'co-b', 'ttl': 1})
        self.assertEqual(adm('DELETE /admin/companies/{id}', path={'id': 'co-b'}), (200, {'deleted': True}))
        self.assertNotIn('co-b', self.t['C'].items)
        self.assertFalse({'u-b', 'pending#q@da.com'} & set(self.t['M'].items))
        self.assertEqual(len(self.audits('company.delete')), 1)

    def test_buildings_assign(self):
        bs = {b['id']: b for b in adm('GET /admin/buildings')[1]['buildings']}
        self.assertEqual(bs['main'], {'id': 'main', 'name': '본관', 'companyId': 'co-a', 'companyName': '가나 기업', 'hours': [9, 18], 'weekend': False, 'hasTwin': False})
        self.assertEqual((bs['lab']['companyId'], bs['lab']['companyName']), (None, None))
        self.assertEqual(call(http('GET /rooms/status', sub='u-b', query={'building': 'lab'}))[0], 403)
        self.assertEqual(adm('PUT /admin/buildings/{id}/company', path={'id': 'lab'}, body={'companyId': 'co-b'}), (200, {'buildingId': 'lab', 'companyId': 'co-b'}))
        self.assertEqual(call(http('GET /rooms/status', sub='u-b', query={'building': 'lab'}))[0], 200)
        self.assertEqual(adm('PUT /admin/buildings/{id}/company', path={'id': 'lab'}, body={'companyId': None})[1]['companyId'], None)
        self.assertNotIn('lab', self.t['O'].items)
        self.assertEqual(adm('PUT /admin/buildings/{id}/company', path={'id': 'lab'}, body={'companyId': 'co-x'})[0], 404)
        self.assertEqual(adm('PUT /admin/buildings/{id}/company', path={'id': 'lab'}, body={})[0], 400)
        self.assertEqual(adm('PUT /admin/buildings/{id}/company', path={'id': 'nope'}, body={'companyId': None})[0], 400)
        details = [a['detail'] for a in self.audits('building.assign')]
        self.assertEqual(details, [{'from': None, 'to': 'co-b'}, {'from': 'co-b', 'to': None}])

    def test_me(self):
        self.assertEqual(call(http('GET /me')), (200, {'email': 'a@ga.com', 'role': 'manager', 'company': {'id': 'co-a', 'name': '가나 기업', 'status': 'active'}}))
        self.assertEqual(call(http('GET /me', sub='boss', groups='[admin]'))[1], {'email': 'boss@vendor.com', 'role': 'admin', 'company': None})
        self.assertEqual(call(http('GET /me', sub='nobody'))[1], {'email': 'boss@vendor.com', 'role': None, 'company': None})

INVALID = (400, {'error': '기업 코드가 올바르지 않거나 만료되었습니다.'})
VENDOR_ONLY = (403, {'error': '판매사 관리자만 변경할 수 있습니다.'})
ADMIN_ONLY = (403, {'error': '관리자만 사용할 수 있습니다.'})


def join(code, sub='new', **kw):
    return call(http('POST /me/join', sub=sub, body={'code': code}, **kw))


class JoinTest(Tenancy):
    def test_first_member_manager_then_operator(self):
        self.t['C'].put_item({'companyId': 'co-c', 'name': '새 기업', 'status': 'active', 'code': 'EGE-EEEE-FFFF', 'codeExpiresAt': FUTURE})
        self.assertEqual(join(' ege eeee ffff ', 's-1'), (200, {'company': {'id': 'co-c', 'name': '새 기업', 'status': 'active'}, 'role': 'manager'}))
        self.assertEqual(join('EGE-EEEE-FFFF', 's-2')[1]['role'], 'operator')
        m = self.t['M'].items['s-1']
        self.assertEqual((m['companyId'], m['email'], m['role']), ('co-c', 'boss@vendor.com', 'manager'))
        joins = self.audits('member.join')
        self.assertEqual(sorted(a['target'] for a in joins), ['s-1', 's-2'])
        self.assertEqual((joins[0]['companyId'], joins[0]['actor']['role']), ('co-c', 'manager'))

    def test_access_right_after_join(self):
        self.assertEqual(call(http('GET /rooms/status', sub='new', query={'building': 'edu'}))[0], 403)
        self.assertEqual(join('EGE-CCCC-DDDD'), (200, {'company': {'id': 'co-b', 'name': '다라 기업', 'status': 'active'}, 'role': 'operator'}))
        self.assertEqual(call(http('GET /rooms/status', sub='new', query={'building': 'edu'}))[0], 200)

    def test_invalid_expired_suspended_code(self):
        self.t['C'].items['co-b']['codeExpiresAt'] = PAST
        self.t['C'].items['co-a']['status'] = 'suspended'
        for code in ('EGE-2222-3333', 'EGE-CCCC-DDDD', 'EGE-AAAA-BBBB', None, '', 7):
            self.assertEqual(join(code), INVALID, code)
        self.assertEqual(call(http('POST /me/join', sub='new', body=['EGE-AAAA-BBBB']))[0], 400)
        self.assertNotIn('new', self.t['M'].items)

    def test_member_and_admin_rejected(self):
        self.assertEqual(join('EGE-CCCC-DDDD', 'u-a'), (409, {'error': '이미 소속된 기업이 있습니다.'}))
        self.assertEqual(join('EGE-CCCC-DDDD', 'boss', groups='[admin]')[0], 403)
        self.assertEqual(self.t['M'].items['u-a']['companyId'], 'co-a')
        self.assertNotIn('boss', self.t['M'].items)
        self.assertEqual(self.audits('member.join'), [])


class SuspendedTest(Tenancy):
    BLOCKED = (403, {'error': '서비스가 중지된 기업입니다. 판매사에 문의하십시오.', 'code': 'COMPANY_SUSPENDED'})

    def setUp(self):
        super().setUp()
        self.t['C'].items['co-a']['status'] = 'suspended'

    def test_building_and_company_apis_blocked(self):
        for route, kw in (('GET /rooms/status', {'query': {'building': 'main'}}), ('GET /buildings', {}),
                          ('GET /energy/compare', {'query': {'period': 'day'}}), ('GET /buildings/{id}/plan', {'path': {'id': 'main'}}),
                          ('GET /chat', {'query': {'building': 'main'}}), ('POST /schedules', {'body': {'buildingId': 'main', 'roomIds': ['x']}}),
                          ('GET /company', {}), ('GET /company/audit', {})):
            self.assertEqual(call(http(route, **kw)), self.BLOCKED, route)
        # 변경 경로는 중지 여부와 관계없이 판매사 전용
        self.assertEqual(call(http('PATCH /company', body={'phone': '1'})), VENDOR_ONLY)
        r = query.handler(http('POST /query', body={'text': '전력', 'buildingId': 'main'}), None)
        self.assertEqual((r['statusCode'], json.loads(r['body'])), self.BLOCKED)
        self.assertNotIn('phone', self.t['C'].items['co-a'])
        self.assertNotIn('overrides', self.t['O'].items['main'])
        self.assertEqual(self.t['A'].items, {})

    def test_me_admin_and_other_company_allowed(self):
        self.assertEqual(call(http('GET /me'))[1]['company'], {'id': 'co-a', 'name': '가나 기업', 'status': 'suspended'})
        self.assertEqual(call(http('GET /rooms/status', sub='boss', groups='[admin]', query={'building': 'main'}))[0], 200)
        self.assertEqual(call(http('PATCH /buildings/{id}', sub='boss', groups='[admin]', path={'id': 'main'}, body={'use': '병원'}))[0], 200)
        self.assertEqual(call(http('GET /rooms/status', sub='u-b', query={'building': 'edu'}))[0], 200)

    def test_ws_and_admin_resume_suspend(self):
        self.assertEqual(ws_ask('u-a', 'main'), [{'type': 'error', 'message': self.BLOCKED[1]['error'], 'requestId': 'r1'}])
        # 판매사의 재개·중지는 같은 실행 환경에 즉시 반영(다른 실행 환경은 60초 캐시)
        adm('PATCH /admin/companies/{id}', path={'id': 'co-a'}, body={'status': 'active'})
        self.assertEqual(call(http('GET /rooms/status', query={'building': 'main'}))[0], 200)
        adm('PATCH /admin/companies/{id}', path={'id': 'co-a'}, body={'status': 'suspended'})
        self.assertEqual(call(http('GET /rooms/status', query={'building': 'main'})), self.BLOCKED)


class CustomerTest(Tenancy):
    """u-a(관리자), u-a2(운영자)는 기업 A. 고객사 구성원은 조회·운영만, 변경은 판매사 전용"""

    def setUp(self):
        super().setUp()
        self.t['M'].put_item({'sub': 'u-a2', 'companyId': 'co-a', 'email': 'a2@ga.com', 'role': 'operator', 'joinedAt': '2026-11-20T11:00:00+09:00'})

    def test_get_company_same_for_all_roles(self):
        for sub in ('u-a', 'u-a2'):
            code, body = call(http('GET /company', sub=sub))
            self.assertEqual(set(body), {'company', 'buildings'}, sub)
            self.assertEqual(body['company'], {'id': 'co-a', 'name': '가나 기업', 'contactName': '', 'contactEmail': '', 'phone': '', 'address': '', 'status': 'active'})
            self.assertEqual([b['id'] for b in body['buildings']], ['main', 'office'])
            self.assertEqual(set(body['buildings'][0]), {'id', 'name', 'use', 'floors', 'roomCount', 'hours', 'weekend'})
            self.assertEqual((body['buildings'][0]['hours'], body['buildings'][0]['weekend']), ([9, 18], False))
        for kw in ({'sub': 'nobody'}, {'sub': 'boss', 'groups': '[admin]'}):
            self.assertEqual(call(http('GET /company', **kw)), (403, {'error': '소속된 기업이 없습니다.'}))

    def test_member_writes_forbidden(self):
        writes = (('PATCH /company', {'body': {'phone': '051-1'}}),
                  ('PATCH /company/members/{sub}', {'path': {'sub': 'u-a2'}, 'body': {'role': 'manager'}}),
                  ('DELETE /company/members/{sub}', {'path': {'sub': 'u-a2'}}),
                  ('PATCH /buildings/{id}', {'path': {'id': 'main'}, 'body': {'name': '바뀐 이름'}}))
        for sub in ('u-a', 'u-a2', 'u-b', 'nobody'):
            for route, kw in writes:
                self.assertEqual(call(http(route, sub=sub, **kw)), VENDOR_ONLY, (sub, route))
        self.assertNotIn('phone', self.t['C'].items['co-a'])
        self.assertEqual((self.t['M'].items['u-a2']['role'], 'overrides' in self.t['O'].items['main']), ('operator', False))
        self.assertEqual(self.t['A'].items, {})
        # 판매사 총관리자는 소속 기업이 없어 고객사 기업·구성원 경로 대신 /admin/companies/{id} 사용
        self.assertEqual(call(http('PATCH /company', sub='boss', groups='[admin]', body={'phone': '1'})), (403, {'error': '소속된 기업이 없습니다.'}))

    def test_admin_removes_member_then_rejoin(self):
        self.assertEqual(adm('DELETE /admin/companies/{id}/members/{sub}', path={'id': 'co-a', 'sub': 'u-a2'}), (200, {'deleted': True}))
        self.assertNotIn('u-a2', self.t['M'].items)
        # 해제된 사용자는 같은 실행 환경에서 바로 접근 거부, 기업 코드로 다시 가입 가능
        self.assertEqual(call(http('GET /rooms/status', sub='u-a2', query={'building': 'main'}))[0], 403)
        self.assertEqual(join('EGE-AAAA-BBBB', 'u-a2')[1]['role'], 'operator')

    def test_audit_order_and_limit(self):
        actor = {'sub': 'u-a', 'email': 'a@ga.com', 'role': 'manager'}
        for i in range(205):
            self.t['A'].put_item({'companyId': 'co-a', 'at': f'2026-11-19T10:00:00.{i:03d}+09:00#u{i}', 'actor': actor,
                                  'action': 'company.update', 'target': 'co-a', 'detail': {'n': i}})
        self.t['A'].put_item({'companyId': 'co-a', 'at': '2026-11-20T09:00:00.000+09:00#last', 'actor': actor,
                              'action': 'building.update', 'target': 'main', 'detail': {'after': {'hours': [Decimal('8'), Decimal('20')]}}})
        self.t['A'].put_item({'companyId': 'co-b', 'at': '2026-11-21T09:00:00.000+09:00#b', 'actor': actor, 'action': 'company.update', 'target': 'co-b'})
        code, body = call(http('GET /company/audit', sub='u-a2'))  # 운영자도 조회
        self.assertEqual((code, len(body['items'])), (200, 50))
        self.assertEqual(body['items'][0], {'at': '2026-11-20T09:00:00.000+09:00', 'actor': {'email': 'a@ga.com', 'role': 'manager'},
                                            'action': 'building.update', 'target': 'main', 'detail': {'after': {'hours': [8, 20]}}})
        self.assertEqual([i['detail']['n'] for i in body['items'][1:4]], [204, 203, 202])
        self.assertEqual(len(call(http('GET /company/audit', query={'limit': '3'}))[1]['items']), 3)
        self.assertEqual(len(call(http('GET /company/audit', query={'limit': '500'}))[1]['items']), 200)
        for bad in ('0', '-1', 'x', '1.5'):
            self.assertEqual(call(http('GET /company/audit', query={'limit': bad}))[0], 400, bad)
        self.assertEqual(call(http('GET /company/audit', sub='nobody'))[0], 403)


class BuildingUpdateTest(Tenancy):
    def patch_b(self, bid, body, **kw):
        return adm('PATCH /admin/buildings/{id}', path={'id': bid}, body=body, **kw)

    def test_admin_updates_building(self):
        floors = buildings.floors('main')
        code, body = self.patch_b('main', {'name': ' 본관 A ', 'hours': [8, 20], 'weekend': True, 'floors': {}, 'rooms': []})
        b = body['building']
        self.assertEqual((code, b['id'], b['name'], b['use'], b['hours'], b['weekend']), (200, 'main', '본관 A', '의료', [8, 20], True))
        self.assertEqual(self.t['O'].items['main'], {'buildingId': 'main', 'companyId': 'co-a', 'overrides': {'name': '본관 A', 'hours': [8, 20], 'weekend': True}})
        # 층·호실은 바뀌지 않고, 호실 운영 프로필과 고객사 기업 정보에 반영
        self.assertEqual(buildings.floors('main'), floors)
        self.assertEqual((buildings.rooms('main')[0]['hours'], buildings.rooms('main')[0]['weekend']), ([8, 20], True))
        self.assertEqual(call(http('GET /company'))[1]['buildings'][0]['name'], '본관 A')
        a = self.audits('building.update')
        self.assertEqual((len(a), a[0]['companyId'], a[0]['target'], a[0]['actor']['role']), (1, 'co-a', 'main', 'admin'))
        self.assertEqual(a[0]['detail'], {'before': {'name': '본관', 'hours': [9, 18], 'weekend': False}, 'after': {'name': '본관 A', 'hours': [8, 20], 'weekend': True}})
        # 같은 값은 기록 안 함, 일부 변경은 이전 수정 정보 유지
        self.assertEqual(self.patch_b('main', {'name': '본관 A'})[0], 200)
        self.assertEqual(len(self.audits('building.update')), 1)
        self.patch_b('main', {'use': '병원'})
        self.assertEqual(self.t['O'].items['main']['overrides'], {'name': '본관 A', 'hours': [8, 20], 'weekend': True, 'use': '병원'})
        # 캐시가 만료된 다른 실행 환경도 같은 값
        buildings.forget()
        self.assertEqual((buildings.get('main')['name'], buildings.get('main')['use']), ('본관 A', '병원'))
        # 이전 경로(PATCH /buildings/{id})도 판매사 총관리자는 같은 처리
        self.assertEqual(call(http('PATCH /buildings/{id}', sub='boss', groups='[admin]', path={'id': 'main'}, body={'use': '의원'}))[1]['building']['use'], '의원')

    def test_validation(self):
        for body in ({}, {'rooms': []}, {'name': ''}, {'name': '  '}, {'name': 'x' * 41}, {'name': 3}, {'use': 'x' * 21},
                     {'hours': [18, 9]}, {'hours': [9, 9]}, {'hours': [0, 25]}, {'hours': [-1, 9]}, {'hours': [9]}, {'hours': ['9', 18]},
                     {'hours': [True, 18]}, {'hours': [9.5, 18]}, {'hours': '9-18'}, {'weekend': 'yes'}, {'weekend': 1}, ['x']):
            self.assertEqual(self.patch_b('main', body)[0], 400, body)
        self.assertNotIn('overrides', self.t['O'].items['main'])
        self.assertEqual(self.patch_b('nope', {'name': 'a'})[0], 400)
        self.assertEqual(self.patch_b('main', {'name': 'x' * 40, 'use': 'y' * 20, 'hours': [0, 24]})[0], 200)

    def test_members_forbidden(self):
        for sub in ('u-a', 'u-b'):
            self.assertEqual(call(http('PATCH /admin/buildings/{id}', sub=sub, path={'id': 'main'}, body={'name': 'x'})), ADMIN_ONLY)
            self.assertEqual(call(http('PATCH /buildings/{id}', sub=sub, path={'id': 'main'}, body={'name': 'x'})), VENDOR_ONLY)
        self.assertNotIn('overrides', self.t['O'].items['main'])

    def test_unowned_building_keeps_overrides_across_assignment(self):
        self.assertEqual(self.patch_b('lab', {'weekend': False})[1]['building']['weekend'], False)
        self.assertEqual(self.t['O'].items['lab'], {'buildingId': 'lab', 'overrides': {'weekend': False}})
        self.assertEqual(self.audits('building.update'), [])  # 기업별 이력이라 소속 없는 건물은 기록 안 함
        # 수정 정보만 있는 항목은 소속·건물 수 계산에서 제외
        self.assertNotIn('lab', tenant.owners())
        self.assertEqual(call(http('GET /rooms/status', sub='u-b', query={'building': 'lab'}))[0], 403)
        self.assertIsNone({b['id']: b for b in adm('GET /admin/buildings')[1]['buildings']}['lab']['companyId'])
        self.assertEqual({c['id']: c['buildingCount'] for c in adm('GET /admin/companies')[1]['companies']}, {'co-a': 2, 'co-b': 1})
        # 소속 지정·해제 후에도 수정 정보 유지
        adm('PUT /admin/buildings/{id}/company', path={'id': 'lab'}, body={'companyId': 'co-b'})
        self.assertEqual(self.t['O'].items['lab'], {'buildingId': 'lab', 'companyId': 'co-b', 'overrides': {'weekend': False}})
        adm('PUT /admin/buildings/{id}/company', path={'id': 'lab'}, body={'companyId': None})
        self.assertEqual(self.t['O'].items['lab'], {'buildingId': 'lab', 'overrides': {'weekend': False}})
        self.patch_b('edu', {'use': '학원'})
        a = self.audits('building.update')[0]
        self.assertEqual((a['companyId'], a['actor']), ('co-b', {'sub': 'boss', 'email': 'boss@vendor.com', 'role': 'admin'}))


class FakeS3:
    """S3 클라이언트 대체: put·get·delete_objects, list_objects_v2(2개 단위 페이지)"""

    class NoSuchKey(Exception):
        pass

    def __init__(self):
        self.objects, self.exceptions = {}, types.SimpleNamespace(NoSuchKey=self.NoSuchKey)

    def put_object(self, Bucket, Key, Body, ContentType):
        self.objects[Key] = Body

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self.NoSuchKey()
        return {'Body': io.BytesIO(self.objects[Key])}

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken='0'):
        ks, i = sorted(k for k in self.objects if k.startswith(Prefix)), int(ContinuationToken)
        more = i + 2 < len(ks)
        return {'Contents': [{'Key': k} for k in ks[i:i + 2]], 'IsTruncated': more} | ({'NextContinuationToken': str(i + 2)} if more else {})

    def delete_objects(self, Bucket, Delete):
        for o in Delete['Objects']:
            self.objects.pop(o['Key'], None)


TWIN_ENV = {'BUILDINGS_TABLE': 'B', 'ROOMS_TABLE': 'R', 'EQUIPMENT_TABLE': 'E', 'STATE_TABLE': 'S', 'PLANS_BUCKET': 'P'}
NEW = {'name': ' 새 건물 ', 'use': '업무', 'hours': [8, 20], 'weekend': True}


def upload(prefix, n, floors=('1F', '2F')):
    """트윈 파이프라인 결과 형식의 {twin, rooms, plan}: 호실 n개를 층에 번갈아 배치"""
    rooms = [{'id': f'{prefix}.R{i}', 'name': f'호실 {i}', 'floor': floors[i % len(floors)], 'use': '사무실', 'areaM2': 20 + i, 'idu': f'IDU-{i}'} for i in range(n)]
    return {'twin': {'schema': 'test', 'floors': [{'id': f} for f in floors]}, 'rooms': rooms, 'plan': {'floors': {f: {
        'elevation': 0, 'bounds': [0, 0, 10.5, 8], 'rooms': [{'id': r['id'], 'polys': [[[0, 0], [1, 0], [1, 1]]], 'hvac': [[0.5, 0.5]]} for r in rooms if r['floor'] == f],
    } for f in floors}}}


class VendorBuildingTest(Tenancy):
    """판매사 건물 등록·트윈 확정 저장·삭제(트윈 테이블·도면 버킷 가짜), 테이블 초기값은 파일 출처 4개 건물"""

    def setUp(self):
        super().setUp()
        self.t |= {'B': FakeTable('buildingId'), 'R': FakeTable('buildingId', 'roomId'), 'E': FakeTable('buildingId', 'equipmentId'), 'S': FakeTable('buildingId', 'roomId')}
        tenant._tables.update(self.t)
        lst, rooms = buildings._from_files()
        for b in lst:
            self.t['B'].put_item({'buildingId': b['id'], **{k: v for k, v in b.items() if k != 'id'}})
        for bid, rs in rooms.items():
            for r in rs:
                self.t['R'].put_item({'buildingId': bid, 'roomId': r['id'], **{k: r[k] for k in admin.ROOM_FIELDS}})
                self.t['E'].put_item({'buildingId': bid, 'equipmentId': r['idu'], 'roomId': r['id']})
                self.t['S'].put_item({'buildingId': bid, 'roomId': r['id'], 'temp': 20})
        self.s3 = plan._s3 = FakeS3()
        self.s3.objects.update({'plans/office/v1.json': b'{}', 'plans/office/current.json': b'{}'})
        self.patches.append(patch.dict(os.environ, TWIN_ENV))
        self.patches[-1].start()
        buildings.forget()

    def tearDown(self):
        super().tearDown()
        plan._s3 = None

    def create(self, cid='co-a', **body):
        return adm('POST /admin/companies/{id}/buildings', path={'id': cid}, body={**NEW, **body})

    def save(self, bid, body):
        return adm('PUT /buildings/{id}/twin', path={'id': bid}, body=body)

    def rows(self, name, bid):
        return {k[1] for k in self.t[name].items if k[0] == bid}

    def test_plan_job_confirmation_registers_and_replaces_with_existing_rules(self):
        import plan_ingest
        job = {'jobId': 'confirm-1', 'building': 'b-abcd1234', 'kind': 'ifc', 'status': 'review'}
        def put(item, old=None):
            if old and job['status'] != old:
                return False
            job.clear()
            job.update(item)
            return True
        request = {'operation': 'create', 'companyId': 'co-a',
                   'registration': {**NEW, **upload('b-abcd1234', 3)}}
        def confirm(body):
            return adm('POST /plans/jobs/{jobId}/confirm', path={'jobId': 'confirm-1'}, body=body)
        with patch.object(plan_ingest, '_job', side_effect=lambda _: dict(job)), patch.object(plan_ingest, '_put', side_effect=put):
            code, receipt = confirm(request)
            self.assertEqual((code, receipt['status'], receipt['building']['roomCount']), (200, 'done', 3))
            self.assertEqual(self.t['O'].items['b-abcd1234']['companyId'], 'co-a')
            self.assertEqual(self.t['B'].items['b-abcd1234']['virtual'], False)
            self.assertEqual(len(self.rows('R', 'b-abcd1234')), 3)
            self.assertEqual(len(self.rows('E', 'b-abcd1234')), 3)
            self.assertIn('plans/b-abcd1234/building.json', self.s3.objects)
            self.assertIn('plans/b-abcd1234/current.json', self.s3.objects)
            files = dict(self.s3.objects)
            self.assertEqual(confirm(request), (code, receipt))
            self.assertEqual(self.s3.objects, files)
            self.assertEqual(len(self.audits('building.create')), 1)
            # 새 변환 작업으로 기존 건물 보정본을 확정하면 기존 교체 규칙으로 호실·버전 갱신.
            job.clear()
            job.update(jobId='confirm-2', building='b-abcd1234', kind='ifc', status='review')
            code, receipt = confirm({'operation': 'replace', 'registration': upload('b-abcd1234', 2)})
            self.assertEqual((code, receipt['version'], job['status']), (200, 2, 'done'))
            self.assertEqual(len(self.rows('R', 'b-abcd1234')), 2)
            self.assertEqual(len(self.rows('E', 'b-abcd1234')), 2)
            self.assertEqual(len(self.audits('building.plan')), 1)

    def test_create_with_id_visible_to_members(self):
        code, body = self.create(id='b-abcd1234', **upload('b-abcd1234', 3))
        self.assertEqual((code, body), (201, {'building': {'id': 'b-abcd1234', 'name': '새 건물', 'use': '업무', 'floors': ['1F', '2F'], 'roomCount': 3,
                                                            'hours': [8, 20], 'weekend': True}}))
        b = self.t['B'].items['b-abcd1234']
        self.assertEqual({k: b[k] for k in ('floors', 'virtual', 'basis', 'remap', 'mirror')},
                         {'floors': {'1F': '1F', '2F': '2F'}, 'virtual': False, 'basis': '트윈 파이프라인(판매사 등록)', 'remap': {}, 'mirror': False})
        self.assertEqual(b['waste'], Decimal('0.15'))
        self.assertEqual(self.rows('R', 'b-abcd1234'), {'b-abcd1234.R0', 'b-abcd1234.R1', 'b-abcd1234.R2'})
        e = self.t['E'].items[('b-abcd1234', 'IDU-2')]
        self.assertEqual((e['roomId'], e['type'], float(e['ratedKw'])), ('b-abcd1234.R2', 'IDU', sim.rated({'areaM2': 22})))
        self.assertEqual(self.t['O'].items['b-abcd1234'], {'buildingId': 'b-abcd1234', 'companyId': 'co-a'})
        self.assertEqual(sorted(k for k in self.s3.objects if 'b-abcd1234' in k),
                         ['plans/b-abcd1234/building-v1.json', 'plans/b-abcd1234/building.json', 'plans/b-abcd1234/current.json', 'plans/b-abcd1234/v1.json'])
        self.assertEqual(json.loads(self.s3.objects['plans/b-abcd1234/building-v1.json']), upload('b-abcd1234', 3)['twin'])
        a = self.audits('building.create')[0]
        self.assertEqual((a['companyId'], a['target'], a['detail']), ('co-a', 'b-abcd1234', {'name': '새 건물', 'rooms': 3, 'floors': ['1F', '2F']}))
        # 고객사 구성원: 기업 정보, 상태, 도면·트윈 조회 가능. 다른 기업 구성원은 403
        self.assertIn('b-abcd1234', [x['id'] for x in call(http('GET /company'))[1]['buildings']])
        code, st = call(http('GET /rooms/status', query={'building': 'b-abcd1234'}))
        self.assertEqual((code, len(st['rooms'])), (200, 3))
        r = api.handler(http('GET /buildings/{id}/twin', path={'id': 'b-abcd1234'}), None)
        self.assertEqual((r['statusCode'], json.loads(r['body'])), (200, upload('b-abcd1234', 3)['twin']))
        self.assertEqual(json.loads(api.handler(http('GET /buildings/{id}/plan', path={'id': 'b-abcd1234'}), None)['body']), upload('b-abcd1234', 3)['plan'])
        for route in ('GET /buildings/{id}/twin', 'GET /buildings/{id}/plan', 'GET /rooms/status'):
            self.assertEqual(call(http(route, sub='u-b', path={'id': 'b-abcd1234'}, query={'building': 'b-abcd1234'}))[0], 403, route)

    def test_has_twin_in_admin_lists(self):
        self.create(id='b-abcd1234', **upload('b-abcd1234', 1))
        detail = {b['id']: b for b in adm('GET /admin/companies/{id}', path={'id': 'co-a'})[1]['buildings']}
        self.assertEqual({k: v['hasTwin'] for k, v in detail.items()}, {'main': False, 'office': False, 'b-abcd1234': True})
        self.assertEqual(set(detail['b-abcd1234']), {'id', 'name', 'use', 'floors', 'roomCount', 'hours', 'weekend', 'hasTwin'})
        items = {b['id']: b for b in adm('GET /admin/buildings')[1]['buildings']}
        self.assertEqual({k: v['hasTwin'] for k, v in items.items()}, {'main': False, 'office': False, 'edu': False, 'lab': False, 'b-abcd1234': True})
        self.assertEqual((items['b-abcd1234']['companyId'], items['b-abcd1234']['hours'], items['b-abcd1234']['weekend']), ('co-a', [8, 20], True))
        self.assertEqual(call(http('GET /buildings/{id}/twin', path={'id': 'main'})), (404, {'error': '트윈 데이터가 없습니다.'}))

    def test_create_generated_id(self):
        code, body = self.create(**upload('x', 2))
        self.assertEqual(code, 201)
        self.assertRegex(body['building']['id'], r'^b-[a-z0-9]{8}$')
        self.assertIn(body['building']['id'], tenant.owners())

    def test_create_validation_and_conflicts(self):
        good = upload('b-abcd1234', 2)
        bad_room = lambda **kw: {**good, 'rooms': [{**good['rooms'][0], **kw}, good['rooms'][1]]}  # noqa: E731
        floor = good['plan']['floors']['1F']
        bad_plan = lambda **kw: {**good, 'plan': {'floors': {**good['plan']['floors'], '1F': {**floor, **kw}}}}  # noqa: E731
        cases = [{'name': ''}, {'hours': [9, 9]}, {'id': 'b-ABCD1234'}, {'id': 'b-abc'}, {'id': 7}, {'twin': None}, {'twin': []},
                 {'rooms': []}, {'plan': {}}, {'plan': {'floors': {}}},
                 bad_room(id='b-abcd1234.R1'), bad_room(idu='IDU-1'), bad_room(floor='9F'), bad_room(areaM2=-1), bad_room(areaM2=True), bad_room(name=''),
                 bad_plan(bounds=[0, 0, 1]), bad_plan(elevation='0'), bad_plan(rooms=[{'id': 'b-abcd1234.R0', 'polys': [[[0, 0, 0]]], 'hvac': []}]),
                 bad_plan(rooms=[{'id': 'b-abcd1234.R0', 'polys': []}]), bad_plan(rooms=[{'id': 'ghost', 'polys': [], 'hvac': []}])]
        for body in cases:
            self.assertEqual(self.create(**{**good, **body})[0], 400, body)
        missing = {k: v for k, v in {**NEW, **good}.items() if k != 'weekend'}
        self.assertEqual(adm('POST /admin/companies/{id}/buildings', path={'id': 'co-a'}, body=missing)[0], 400)
        ev = http('POST /admin/companies/{id}/buildings', sub='boss', groups='[admin]', path={'id': 'co-a'}, body={**NEW, **good})
        for raw in (ev['body'].replace('10.5', 'NaN'), ev['body'].replace('10.5', '1e999'), '[' * 100000 + ']' * 100000, 'not json'):
            self.assertEqual(call(ev | {'body': raw})[0], 400, raw[:20])
        self.assertEqual(call(ev | {'body': json.dumps({**NEW, **good, 'twin': {'x': 'a' * admin.MAX_BODY}})}), (413, {'error': '요청 본문은 5MB 이하입니다.'}))
        self.assertNotIn('b-abcd1234', self.t['B'].items)
        self.assertEqual(set(self.s3.objects), {'plans/office/v1.json', 'plans/office/current.json'})
        # 건물 id 중복, 다른 건물과 호실 id 겹침은 409, 없는 기업 404, 구성원 403, 저장소 미설정 503
        self.assertEqual(self.create(id='b-abcd1234', **good)[0], 201)
        self.assertEqual(self.create(id='b-abcd1234', **upload('b-abcd1234.v2', 1)), (409, {'error': '이미 있는 건물 id입니다.'}))
        main_room = buildings.rooms('main')[0]['id']
        clash = upload('b-zzzz0000', 2)
        clash['rooms'][0]['id'] = clash['plan']['floors']['1F']['rooms'][0]['id'] = main_room
        self.assertEqual(self.create(id='b-zzzz0000', **clash), (409, {'error': f'다른 건물과 호실 id가 겹칩니다: {main_room}'}))
        self.assertEqual(self.create(cid='co-x', **upload('y', 1))[0], 404)
        self.assertEqual(call(http('POST /admin/companies/{id}/buildings', path={'id': 'co-a'}, body={**NEW, **upload('y', 1)})), ADMIN_ONLY)
        with patch.dict(os.environ, {'PLANS_BUCKET': ''}):
            self.assertEqual(self.create(**upload('y', 1)), (503, {'error': '건물 저장소가 설정되지 않았습니다.'}))
        self.assertNotIn('b-zzzz0000', self.t['B'].items)

    def test_replace_twin_of_seed_building(self):
        old = self.rows('R', 'office')
        code, body = self.save('office', {'name': '무시', **upload('office.n', 2, floors=('1F',))})
        self.assertEqual((code, body['version'], body['building']['name'], body['building']['floors'], body['building']['roomCount']), (200, 2, '업무동', ['1F'], 2))
        self.assertEqual(body['building']['hours'], [8, 19])
        for name in ('R', 'S'):
            self.assertEqual(self.rows(name, 'office'), {'office.n.R0', 'office.n.R1'} if name == 'R' else set(), name)
        self.assertEqual(self.rows('E', 'office'), {'IDU-0', 'IDU-1'})
        self.assertEqual(len(self.rows('R', 'edu')), len(buildings._from_files()[1]['edu']))  # 다른 건물 유지
        b = self.t['B'].items['office']
        self.assertEqual((b['floors'], b['virtual'], b['mirror'], b['remap'], b['waste']), ({'1F': '1F'}, False, False, {}, Decimal('0.18')))
        self.assertTrue({'plans/office/v2.json', 'plans/office/building-v2.json', 'plans/office/building.json'} <= set(self.s3.objects))
        self.assertEqual(json.loads(self.s3.objects['plans/office/current.json']), upload('office.n', 2, floors=('1F',))['plan'])
        self.assertEqual(json.loads(api.handler(http('GET /buildings/{id}/twin', path={'id': 'office'}), None)['body']), upload('office.n', 2, floors=('1F',))['twin'])
        a = self.audits('building.plan')[0]
        self.assertEqual((a['companyId'], a['detail']), ('co-a', {'version': 2, 'rooms': 2, 'added': 2, 'removed': len(old)}))
        # 호실 1개 유지, 1개 추가: 빠진 호실의 상태 행 삭제. 버전은 도면·트윈 버전 파일 중 최댓값 + 1
        self.s3.objects['plans/office/building-v4.json'] = b'{}'
        self.t['S'].put_item({'buildingId': 'office', 'roomId': 'office.n.R1', 'temp': 20})
        nxt = upload('office.n', 2, floors=('1F',))
        nxt['rooms'][0]['id'] = nxt['plan']['floors']['1F']['rooms'][0]['id'] = 'office.n.R9'
        self.assertEqual(self.save('office', nxt)[1]['version'], 5)
        self.assertEqual(self.rows('R', 'office'), {'office.n.R9', 'office.n.R1'})
        self.assertEqual(self.rows('S', 'office'), {'office.n.R1'})
        plans = self.audits('building.plan')
        self.assertEqual((len(plans), plans[-1]['detail']), (2, {'version': 5, 'rooms': 2, 'added': 1, 'removed': 1}))
        self.assertEqual(self.save('nope', nxt)[0], 400)
        self.assertEqual(self.save('office', {**nxt, 'rooms': []})[0], 400)
        # 구성원(소속 기업 관리자 포함)은 확정 저장 403
        for sub in ('u-a', 'u-b', 'nobody'):
            self.assertEqual(call(http('PUT /buildings/{id}/twin', sub=sub, path={'id': 'office'}, body=nxt)), VENDOR_ONLY, sub)
        self.assertEqual(len(self.audits('building.plan')), 2)

    def test_delete_building(self):
        self.create(id='b-abcd1234', **upload('b-abcd1234', 2))
        mine = [{'id': 's1', 'buildingId': 'b-abcd1234'}, {'id': 's2', 'buildingId': 'office'}, {'id': 's3'}]
        with patch.object(api.admin.common, 'list_schedules', return_value=mine), patch.object(api.admin.common, 'delete_schedule') as gone:
            self.assertEqual(call(http('DELETE /admin/buildings/{id}', path={'id': 'b-abcd1234'})), ADMIN_ONLY)
            self.assertEqual(adm('DELETE /admin/buildings/{id}', path={'id': 'b-abcd1234'}), (200, {'deleted': True}))
            gone.assert_called_once_with('s1')
            self.assertEqual(adm('DELETE /admin/buildings/{id}', path={'id': 'main'})[0], 200)
            self.assertEqual([c.args[0] for c in gone.call_args_list], ['s1', 's3'])  # buildingId 없는 이전 스케줄은 main
        for name in ('B', 'O'):
            self.assertFalse({'b-abcd1234', 'main'} & set(self.t[name].items), name)
        for name in ('R', 'E', 'S'):
            self.assertEqual(self.rows(name, 'b-abcd1234') | self.rows(name, 'main'), set(), name)
        self.assertTrue(self.rows('R', 'office'))
        # 남은 키: 다른 건물 도면과 변경 표시(plan.REV_KEY, 삭제 요청이 갱신)
        self.assertEqual(set(self.s3.objects), {'plans/office/v1.json', 'plans/office/current.json', plan.REV_KEY})
        details = {a['target']: (a['companyId'], a['detail']) for a in self.audits('building.delete')}
        self.assertEqual(details['b-abcd1234'], ('co-a', {'name': '새 건물', 'rooms': 2, 'schedules': 1}))
        self.assertEqual(details['main'][1]['schedules'], 1)
        self.assertEqual([b['id'] for b in call(http('GET /company'))[1]['buildings']], ['office'])
        self.assertEqual(call(http('GET /rooms/status', query={'building': 'b-abcd1234'}))[0], 400)
        # 소속 없는 건물 삭제는 변경 이력 없음, 없는 건물 400
        with patch.object(api.admin.common, 'list_schedules', return_value=[]):
            self.assertEqual(adm('DELETE /admin/buildings/{id}', path={'id': 'lab'})[0], 200)
            self.assertEqual(adm('DELETE /admin/buildings/{id}', path={'id': 'lab'})[0], 400)
        self.assertNotIn('lab', {a['target'] for a in self.audits('building.delete')})

    def room(self, rid, body, sub='u-a', bid='b-abcd1234', **kw):
        return call(http('PATCH /buildings/{id}/rooms/{roomId}', sub=sub, path={'id': bid, 'roomId': rid}, body=body, **kw))

    def twin_rooms(self):
        twin = json.loads(self.s3.objects['plans/b-abcd1234/building.json'])
        return {r['id']: r for f in twin['floors'] for r in f['rooms']}

    def create_with_twin_rooms(self):
        body = upload('b-abcd1234', 2)
        body['twin']['floors'] = [{'id': f, 'rooms': [{'id': r['id'], 'name': r['name'], 'type': 'room', 'use': 'office'} for r in body['rooms'] if r['floor'] == f]}
                                  for f in ('1F', '2F')]
        self.assertEqual(self.create(id='b-abcd1234', **body)[0], 201)

    def test_manager_updates_room_name_and_use(self):
        self.create_with_twin_rooms()
        rid = 'b-abcd1234.R0'
        code, body = self.room(rid, {'name': ' 회의실 A ', 'use': 'meeting', 'floor': '9F'})
        self.assertEqual((code, body), (200, {'room': {'id': rid, 'name': '회의실 A', 'use': '회의실'}, 'version': 2}))
        # 트윈: 새 버전과 현재 파일, 호실 use는 키. 다른 호실은 유지
        self.assertEqual(self.s3.objects['plans/b-abcd1234/building-v2.json'], self.s3.objects['plans/b-abcd1234/building.json'])
        rooms = self.twin_rooms()
        self.assertEqual((rooms[rid]['name'], rooms[rid]['use'], rooms['b-abcd1234.R1']['name']), ('회의실 A', 'meeting', '호실 1'))
        # Rooms 행: 이름, 한국어 용도만 변경(층, 면적, 실내기 유지). 상태 API(가상 상태 계산)에 반영
        row = self.t['R'].items[('b-abcd1234', rid)]
        self.assertEqual((row['name'], row['use'], row['floor'], row['idu']), ('회의실 A', '회의실', '1F', 'IDU-0'))
        st = {r['id']: r for r in call(http('GET /rooms/status', query={'building': 'b-abcd1234'}))[1]['rooms']}
        self.assertEqual((st[rid]['name'], st[rid]['use']), ('회의실 A', '회의실'))
        a = self.audits('room.update')
        self.assertEqual((len(a), a[0]['companyId'], a[0]['target'], a[0]['actor']['role'], a[0]['actor']['email']), (1, 'co-a', rid, 'manager', 'a@ga.com'))
        self.assertEqual(a[0]['detail'], {'name': '회의실 A', 'before': {'name': '호실 0', 'use': '사무실'}, 'after': {'name': '회의실 A', 'use': '회의실'}})
        # 같은 값은 기록 안 함. lounge→waiting은 Rooms 용도가 같아도 트윈 키 변경
        self.assertEqual(self.room(rid, {'name': '회의실 A'})[1]['version'], None)
        self.assertNotIn('plans/b-abcd1234/building-v3.json', self.s3.objects)
        self.assertEqual(len(self.audits('room.update')), 1)
        self.assertEqual(self.room(rid, {'use': 'lounge'})[1], {'room': {'id': rid, 'name': '회의실 A', 'use': '대기·휴게'}, 'version': 3})
        self.assertEqual(self.room(rid, {'use': 'waiting'})[1]['version'], 4)
        self.assertEqual((self.twin_rooms()[rid]['use'], self.t['R'].items[('b-abcd1234', rid)]['use']), ('waiting', '대기·휴게'))
        # 판매사 관리자도 변경 가능
        code, body = self.room(rid, {'name': '세미나실'}, sub='boss', groups='[admin]')
        self.assertEqual((code, body['version']), (200, 5))
        self.assertEqual(self.audits('room.update')[-1]['actor']['role'], 'admin')

    def test_room_update_forbidden_and_invalid(self):
        self.create_with_twin_rooms()
        rid = 'b-abcd1234.R0'
        self.t['M'].put_item({'sub': 'u-a2', 'companyId': 'co-a', 'email': 'a2@ga.com', 'role': 'operator'})
        self.t['M'].put_item({'sub': 'u-b2', 'companyId': 'co-b', 'email': 'b2@da.com', 'role': 'manager'})
        files = set(self.s3.objects)
        self.assertEqual(self.room(rid, {'name': 'x'}, sub='u-a2'), (403, {'error': admin.MANAGER_ONLY}))
        for sub in ('u-b', 'u-b2', 'nobody'):
            self.assertEqual(self.room(rid, {'name': 'x'}, sub=sub), (403, {'error': tenant.FORBIDDEN}), sub)
        for body in ({}, {'floor': '1F'}, {'name': ''}, {'name': '  '}, {'name': 'x' * 41}, {'name': 3}, {'use': 'kitchen'}, {'use': '회의실'},
                     {'use': ['meeting']}, {'use': None}, {'name': '좋은 이름', 'use': 'kitchen'}, ['x']):
            self.assertEqual(self.room(rid, body)[0], 400, body)
        self.assertEqual(self.room('b-abcd1234.nope', {'name': 'x'}), (404, {'error': '없는 호실입니다.'}))
        self.assertEqual(self.room('R0', {'name': 'x'})[0], 404)  # 접두어 없는 id는 저장된 호실 id와 다름
        self.assertEqual(self.room(rid, {'name': 'x'}, bid='nope')[0], 400)
        self.assertEqual(self.room(rid, {'name': 'x'}, bid='edu')[0], 403)  # 다른 기업 건물
        self.assertEqual((set(self.s3.objects), self.audits('room.update')), (files, []))
        self.assertEqual(self.room(rid, {'name': 'x' * 40})[0], 200)
        self.assertEqual(self.twin_rooms()[rid]['name'], 'x' * 40)
        # 중지 기업 관리자: 403(COMPANY_SUSPENDED). 고객사 건물 정보 변경 차단은 유지
        self.t['C'].items['co-a']['status'] = 'suspended'
        tenant.forget()
        self.assertEqual(self.room(rid, {'name': 'y'})[1]['code'], 'COMPANY_SUSPENDED')
        self.t['C'].items['co-a']['status'] = 'active'
        tenant.forget()
        self.assertEqual(call(http('PATCH /buildings/{id}', path={'id': 'main'}, body={'name': 'x'})), VENDOR_ONLY)

    def test_room_update_without_twin_file(self):
        # 초기 적재 건물(트윈 파일 없음): Rooms 행만 변경. IFC GUID의 '$'는 %24로 전달 가능
        rid = next(r['id'] for r in buildings.rooms('main') if '$' in r['id'])
        code, body = self.room(rid.replace('$', '%24'), {'use': 'office'}, bid='main')
        self.assertEqual((code, body['room']['use'], body['version']), (200, '연구실', None))
        self.assertEqual(self.t['R'].items[('main', rid)]['use'], '연구실')
        self.assertFalse([k for k in self.s3.objects if k.startswith('plans/main/')])
        self.assertEqual(self.audits('room.update')[0]['companyId'], 'co-a')


class AdminMemberTest(Tenancy):
    def test_role_remove_and_audit(self):
        role, delete = 'PATCH /admin/companies/{id}/members/{sub}', 'DELETE /admin/companies/{id}/members/{sub}'
        a = lambda sub: {'id': 'co-a', 'sub': sub}  # noqa: E731
        # 관리자 최소 인원 제한 없음: 마지막 manager도 운영자로 변경 가능(2026-11-20 해제)
        self.assertEqual(adm(role, path=a('u-a'), body={'role': 'operator'})[1]['member']['role'], 'operator')
        self.assertEqual(adm(role, path={'id': 'co-x', 'sub': 'u-a'}, body={'role': 'operator'}), (404, {'error': '없는 기업입니다.'}))
        self.assertEqual(adm(delete, path=a('u-b')), (404, {'error': '없는 구성원입니다.'}))
        self.assertEqual(adm(role, path={'id': 'co-b', 'sub': 'u-b'}, body={'role': 'manager'})[1]['member']['role'], 'manager')
        self.t['M'].put_item({'sub': 'u-a2', 'companyId': 'co-a', 'email': 'a2@ga.com', 'role': 'operator', 'joinedAt': '2026-11-20T11:00:00+09:00'})
        self.assertEqual(adm(role, path=a('u-a2'), body={'role': 'manager'})[0], 200)
        self.assertEqual(adm(delete, path=a('u-a')), (200, {'deleted': True}))
        self.assertNotIn('u-a', self.t['M'].items)
        code, body = adm('GET /admin/companies/{id}/audit', path={'id': 'co-a'})
        self.assertEqual(sorted(i['action'] for i in body['items']), ['member.remove', 'member.role', 'member.role'])
        self.assertEqual(body['items'][0]['actor'], {'email': 'boss@vendor.com', 'role': 'admin'})
        self.assertEqual(len(adm('GET /admin/companies/{id}/audit', path={'id': 'co-a'}, query={'limit': '1'})[1]['items']), 1)
        self.assertEqual(adm('GET /admin/companies/{id}/audit', path={'id': 'co-x'})[0], 404)
        self.assertEqual(call(http('GET /admin/companies/{id}/audit', path={'id': 'co-a'}))[0], 403)



class VendorAdminTest(Tenancy):
    """판매사 관리자 지정·해제: Cognito admin 그룹이 판정 기준(토큰 클레임 무시), 자기 해제 409, 변경 즉시 반영"""
    BOSS = '11111111-1111-4111-8111-111111111111'
    USER = '22222222-2222-4222-8222-222222222222'

    def setUp(self):
        super().setUp()
        self.group = {self.BOSS}
        idp = types.SimpleNamespace(
            list_users_in_group=lambda **kw: {'Users': [{'Username': f'n-{s}', 'Attributes': [{'Name': 'sub', 'Value': s}]} for s in self.group]},
            list_users=lambda **kw: {'Users': [{'Username': f'n-{s}', 'Attributes': [{'Name': 'sub', 'Value': s}, {'Name': 'email', 'Value': f'{s[:2]}@x.com'}]}
                                               for s in (self.BOSS, self.USER) if 'Filter' not in kw or s in kw['Filter']]},
            admin_add_user_to_group=lambda UserPoolId, Username, GroupName: self.group.add(Username[2:]),
            admin_remove_user_from_group=lambda UserPoolId, Username, GroupName: self.group.discard(Username[2:]))
        self.patches += [patch.dict(os.environ, {'USER_POOL_ID': 'pool'}), patch.object(tenant, '_idp', idp), patch.object(admin, '_idp', idp)]
        for x in self.patches[-3:]:
            x.start()
        tenant.forget()

    def put(self, sub, on, me=None):
        return call(http('PUT /admin/users/{sub}/admin', sub=me or self.BOSS, path={'sub': sub}, body={'admin': on}))

    def test_group_decides_role(self):
        # 토큰에 admin 클레임이 있어도 그룹에 없으면 판매사 관리자 아님, 그룹에 있으면 클레임 없이도 관리자
        self.assertEqual(call(http('GET /admin/users', sub=self.USER, groups='[admin]'))[0], 403)
        self.assertEqual(tenant.caller(http('GET /me', sub=self.BOSS))['role'], 'admin')

    def test_grant_and_revoke_apply_immediately(self):
        self.assertEqual(self.put(self.USER, True), (200, {'sub': self.USER, 'admin': True}))
        self.assertEqual(tenant.caller(http('GET /me', sub=self.USER))['role'], 'admin')
        self.assertEqual(self.put(self.USER, False)[0], 200)
        self.assertNotEqual(tenant.caller(http('GET /me', sub=self.USER))['role'], 'admin')
        # 같은 밀리초 기록은 정렬 키(시각#uuid) 순서가 임의라 순서 없이 비교
        self.assertCountEqual([a['detail']['admin'] for a in self.audits('user.admin')], [True, False])
        self.assertEqual({a['companyId'] for a in self.audits('user.admin')}, {admin.VENDOR_AUDIT})

    def test_self_revoke_blocked_and_validation(self):
        self.assertEqual(self.put(self.BOSS, False)[0], 409)
        self.assertIn(self.BOSS, self.group)
        self.assertEqual(self.put('u-a', True)[0], 400)  # sub 형식 아님
        self.assertEqual(call(http('PUT /admin/users/{sub}/admin', sub=self.BOSS, path={'sub': self.USER}, body={'admin': 'yes'}))[0], 400)
        self.assertEqual(self.put('33333333-3333-4333-8333-333333333333', True)[0], 404)
        self.assertEqual(self.put(self.USER, True, me=self.USER)[0], 403)  # 판매사 관리자가 아니면 지정 불가

    def test_lookup_failure_falls_back_to_token(self):
        def boom(**kw):
            raise RuntimeError('throttled')
        with patch.object(tenant._idp, 'list_users_in_group', boom):
            tenant.forget()
            self.assertEqual(tenant.caller(http('GET /me', sub=self.USER, groups='[admin]'))['role'], 'admin')


class MigrateTest(Tenancy):
    def test_idempotent(self):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'tools'))
        import migrate_tenancy
        self.t['O'].delete_item({'buildingId': 'main'})  # 소속 없음 → 데모 기업
        names = {'CompaniesTable': 'C', 'MembersTable': 'M', 'BuildingOwnersTable': 'O'}
        user = lambda name, sub, email: {'Username': name, 'Attributes': [{'Name': 'sub', 'Value': sub}, {'Name': 'email', 'Value': email}]}  # noqa: E731
        clients = {
            'cloudformation': types.SimpleNamespace(describe_stack_resource=lambda StackName, LogicalResourceId: {'StackResourceDetail': {'PhysicalResourceId': names[LogicalResourceId]}}),
            'cognito-idp': types.SimpleNamespace(
                list_users_in_group=lambda **kw: {'Users': [{'Username': 'boss'}]},
                list_users=lambda **kw: {'Users': [user('boss', 'boss', 'boss@vendor.com'), user('u-a', 'u-a', 'a@ga.com'), user('old', 's-old', 'Old@Ga.com')]}),
        }
        session = types.SimpleNamespace(client=clients.get, resource=lambda name: types.SimpleNamespace(Table=lambda n: self.t[n]))
        fake = types.SimpleNamespace(Session=lambda **kw: session)
        with patch.dict(sys.modules, {'boto3': fake}), patch.object(sys, 'argv', ['m', '--user-pool-id', 'pool']), patch('builtins.print'):
            migrate_tenancy.main()
            first = {k: dict(v.items) for k, v in self.t.items()}
            migrate_tenancy.main()
        self.assertEqual({k: dict(v.items) for k, v in self.t.items()}, first)
        self.assertEqual((self.t['C'].items['co-demo0000']['name'], self.t['C'].items['co-demo0000']['status']), ('데모 기업', 'active'))
        self.assertRegex(self.t['C'].items['co-demo0000']['code'], CODE_RE)
        owners = {b: o['companyId'] for b, o in self.t['O'].items.items()}
        self.assertEqual(owners, {'main': 'co-demo0000', 'office': 'co-a', 'edu': 'co-b', 'lab': 'co-demo0000'})
        m = self.t['M'].items
        self.assertNotIn('boss', m)
        self.assertEqual(m['u-a']['companyId'], 'co-a')  # 기존 구성원 유지
        self.assertEqual((m['s-old']['companyId'], m['s-old']['role'], m['s-old']['email']), ('co-demo0000', 'operator', 'old@ga.com'))


if __name__ == '__main__':
    unittest.main()
