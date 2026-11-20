"""기업 코드, 가입 전 검사·가입 확인, 소속 검사(403), 중지 기업, 판매사 관리 API, 고객사 설정 API, /me 테스트(가짜 테이블, 네트워크 없음)"""
import datetime as dt
import json
import os
import pathlib
import re
import sys
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
# anthropic·boto3 미설치 환경에서도 실행되도록 모듈 대체(test_ws.py와 같은 방식)
sys.modules.setdefault('anthropic', types.SimpleNamespace(AnthropicBedrock=lambda **kw: None))
sys.modules.setdefault('boto3', types.SimpleNamespace(client=None))
import admin  # noqa: E402
import api  # noqa: E402
import buildings  # noqa: E402
import confirm  # noqa: E402
import query  # noqa: E402
import signup  # noqa: E402
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
        for p in self.patches:
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

    def test_can_edit(self):
        ctx = lambda ev: tenant.caller(ev)  # noqa: E731
        self.assertTrue(tenant.can_edit(ctx(http('GET /x', sub='boss', groups='[admin]')), 'lab'))
        self.assertTrue(tenant.can_edit(ctx(http('GET /x')), 'main'))
        self.assertFalse(tenant.can_edit(ctx(http('GET /x')), 'edu'))
        self.assertFalse(tenant.can_edit(ctx(http('GET /x', sub='u-b')), 'edu'))  # 운영자


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
        self.assertEqual(set(body['buildings'][0]), {'id', 'name', 'use', 'floors', 'roomCount'})
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
        self.assertEqual(bs['main'], {'id': 'main', 'name': bs['main']['name'], 'companyId': 'co-a', 'companyName': '가나 기업'})
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
LAST_MANAGER = (409, {'error': '관리자는 최소 1명이어야 합니다.'})


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
                          ('GET /company', {}), ('PATCH /company', {'body': {'phone': '1'}}), ('GET /company/audit', {}),
                          ('PATCH /company/members/{sub}', {'path': {'sub': 'u-a'}, 'body': {'role': 'operator'}}),
                          ('DELETE /company/members/{sub}', {'path': {'sub': 'u-a'}}),
                          ('PATCH /buildings/{id}', {'path': {'id': 'main'}, 'body': {'name': '바뀐 이름'}})):
            self.assertEqual(call(http(route, **kw)), self.BLOCKED, route)
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
    """u-a(관리자), u-a2(운영자)는 기업 A"""

    def setUp(self):
        super().setUp()
        self.t['M'].put_item({'sub': 'u-a2', 'companyId': 'co-a', 'email': 'a2@ga.com', 'role': 'operator', 'joinedAt': '2026-11-20T11:00:00+09:00'})

    def test_get_company_by_role(self):
        code, body = call(http('GET /company'))
        self.assertEqual((code, body['company']['code'], body['company']['status']), (200, 'EGE-AAAA-BBBB', 'active'))
        self.assertIn('codeExpiresAt', body['company'])
        self.assertEqual([m['sub'] for m in body['members']], ['u-a', 'u-a2'])
        self.assertEqual([b['id'] for b in body['buildings']], ['main', 'office'])
        self.assertEqual(set(body['buildings'][0]), {'id', 'name', 'use', 'floors', 'roomCount', 'hours', 'weekend'})
        self.assertEqual((body['buildings'][0]['hours'], body['buildings'][0]['weekend']), ([9, 18], False))
        code, body = call(http('GET /company', sub='u-a2'))
        self.assertEqual((code, 'members' in body, 'code' in body['company'], 'codeExpiresAt' in body['company']), (200, False, False, False))
        self.assertEqual(len(body['buildings']), 2)
        for kw in ({'sub': 'nobody'}, {'sub': 'boss', 'groups': '[admin]'}):
            self.assertEqual(call(http('GET /company', **kw)), (403, {'error': '소속된 기업이 없습니다.'}))

    def test_patch_company_manager_only(self):
        self.assertEqual(call(http('PATCH /company', sub='u-a2', body={'phone': '1'})), (403, {'error': '고객사 관리자만 사용할 수 있습니다.'}))
        for body in ({}, {'status': 'active'}, {'name': ''}, {'contactEmail': 'bad'}, {'address': 'x' * 201}, {'phone': 1}):
            self.assertEqual(call(http('PATCH /company', body=body))[0], 400, body)
        code, body = call(http('PATCH /company', body={'phone': '051-1', 'name': ' 새 이름 ', 'code': 'EGE-2222-3333'}))
        self.assertEqual((code, body['company']['phone'], body['company']['name'], body['company']['code']), (200, '051-1', '새 이름', 'EGE-AAAA-BBBB'))
        a = self.audits('company.update')
        self.assertEqual((len(a), a[0]['companyId'], a[0]['detail']), (1, 'co-a', {'phone': '051-1', 'name': '새 이름'}))
        self.assertEqual(a[0]['actor'], {'sub': 'u-a', 'email': 'a@ga.com', 'role': 'manager'})
        self.assertEqual(self.t['C'].items['co-b']['name'], '다라 기업')

    def test_member_role_and_last_manager(self):
        route = 'PATCH /company/members/{sub}'
        self.assertEqual(call(http(route, sub='u-a2', path={'sub': 'u-a2'}, body={'role': 'manager'}))[0], 403)
        self.t['M'].put_item({'sub': 'pending#p@ga.com', 'companyId': 'co-a', 'ttl': 1})
        for sub in ('u-b', 'pending#p@ga.com', 'nobody'):
            self.assertEqual(call(http(route, path={'sub': sub}, body={'role': 'manager'}))[0], 404, sub)
        for body in ({'role': 'admin'}, {}, None):
            self.assertEqual(call(http(route, path={'sub': 'u-a2'}, body=body))[0], 400, body)
        self.assertEqual(call(http(route, path={'sub': 'u-a'}, body={'role': 'operator'})), LAST_MANAGER)
        self.assertEqual(call(http(route, path={'sub': 'u-a2'}, body={'role': 'manager'})),
                         (200, {'member': {'sub': 'u-a2', 'email': 'a2@ga.com', 'role': 'manager', 'joinedAt': '2026-11-20T11:00:00+09:00'}}))
        # 관리자 2명이면 자신을 운영자로 변경 가능, 같은 실행 환경에서 바로 관리자 전용 정보 제외
        self.assertEqual(call(http(route, path={'sub': 'u-a'}, body={'role': 'operator'}))[1]['member']['role'], 'operator')
        self.assertNotIn('members', call(http('GET /company'))[1])
        details = sorted((a['target'], a['detail']['from'], a['detail']['to']) for a in self.audits('member.role'))
        self.assertEqual(details, [('u-a', 'manager', 'operator'), ('u-a2', 'operator', 'manager')])
        self.assertTrue(all(a['actor']['email'] and a['actor']['role'] for a in self.audits('member.role')))

    def test_remove_member(self):
        route = 'DELETE /company/members/{sub}'
        self.assertEqual(call(http(route, sub='u-a2', path={'sub': 'u-a'}))[0], 403)
        self.assertEqual(call(http(route, path={'sub': 'u-a'})), LAST_MANAGER)
        self.assertEqual(call(http(route, path={'sub': 'u-b'}))[0], 404)
        self.assertEqual(call(http(route, path={'sub': 'u-a2'})), (200, {'deleted': True}))
        self.assertNotIn('u-a2', self.t['M'].items)
        self.assertIn('u-b', self.t['M'].items)
        self.assertEqual(self.audits('member.remove')[0]['detail'], {'email': 'a2@ga.com', 'role': 'operator'})
        # 해제된 사용자는 같은 실행 환경에서 바로 접근 거부, 기업 코드로 다시 가입 가능
        self.assertEqual(call(http('GET /rooms/status', sub='u-a2', query={'building': 'main'}))[0], 403)
        self.assertEqual(join('EGE-AAAA-BBBB', 'u-a2')[1]['role'], 'operator')

    def test_audit_order_and_limit(self):
        from decimal import Decimal
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
    DENIED = (403, {'error': '건물 정보를 수정할 권한이 없습니다.'})

    def patch_b(self, bid, body, **kw):
        return call(http('PATCH /buildings/{id}', path={'id': bid}, body=body, **kw))

    def test_manager_updates_owned_building(self):
        floors = buildings.floors('main')
        code, body = self.patch_b('main', {'name': ' 본관 A ', 'hours': [8, 20], 'weekend': True, 'floors': {}, 'rooms': []})
        b = body['building']
        self.assertEqual((code, b['id'], b['name'], b['use'], b['hours'], b['weekend']), (200, 'main', '본관 A', '의료', [8, 20], True))
        self.assertEqual(self.t['O'].items['main'], {'buildingId': 'main', 'companyId': 'co-a', 'overrides': {'name': '본관 A', 'hours': [8, 20], 'weekend': True}})
        # 층·호실은 바뀌지 않고, 호실 운영 프로필과 기업 상세에 반영
        self.assertEqual(buildings.floors('main'), floors)
        self.assertEqual((buildings.rooms('main')[0]['hours'], buildings.rooms('main')[0]['weekend']), ([8, 20], True))
        self.assertEqual(call(http('GET /company'))[1]['buildings'][0]['name'], '본관 A')
        a = self.audits('building.update')
        self.assertEqual((len(a), a[0]['companyId'], a[0]['target'], a[0]['actor']['role']), (1, 'co-a', 'main', 'manager'))
        self.assertEqual(a[0]['detail'], {'before': {'name': '본관', 'hours': [9, 18], 'weekend': False}, 'after': {'name': '본관 A', 'hours': [8, 20], 'weekend': True}})
        # 같은 값은 기록 안 함, 일부 변경은 이전 수정 정보 유지
        self.assertEqual(self.patch_b('main', {'name': '본관 A'})[0], 200)
        self.assertEqual(len(self.audits('building.update')), 1)
        self.patch_b('main', {'use': '병원'})
        self.assertEqual(self.t['O'].items['main']['overrides'], {'name': '본관 A', 'hours': [8, 20], 'weekend': True, 'use': '병원'})
        # 캐시가 만료된 다른 실행 환경도 같은 값
        buildings.forget()
        self.assertEqual((buildings.get('main')['name'], buildings.get('main')['use']), ('본관 A', '병원'))

    def test_validation(self):
        for body in ({}, {'rooms': []}, {'name': ''}, {'name': '  '}, {'name': 'x' * 41}, {'name': 3}, {'use': 'x' * 21},
                     {'hours': [18, 9]}, {'hours': [9, 9]}, {'hours': [0, 25]}, {'hours': [-1, 9]}, {'hours': [9]}, {'hours': ['9', 18]},
                     {'hours': [True, 18]}, {'hours': [9.5, 18]}, {'hours': '9-18'}, {'weekend': 'yes'}, {'weekend': 1}, ['x']):
            self.assertEqual(self.patch_b('main', body)[0], 400, body)
        self.assertNotIn('overrides', self.t['O'].items['main'])
        self.assertEqual(self.patch_b('nope', {'name': 'a'})[0], 400)
        self.assertEqual(self.patch_b('main', {'name': 'x' * 40, 'use': 'y' * 20, 'hours': [0, 24]})[0], 200)

    def test_permission(self):
        self.t['M'].put_item({'sub': 'u-b2', 'companyId': 'co-b', 'email': 'b2@da.com', 'role': 'manager', 'joinedAt': '2026-11-20T10:00:00+09:00'})
        self.assertEqual(self.patch_b('main', {'name': 'x'}, sub='u-b2'), self.DENIED)  # 다른 기업 관리자
        self.assertEqual(self.patch_b('edu', {'name': 'x'}, sub='u-b'), self.DENIED)  # 운영자
        self.assertEqual(self.patch_b('lab', {'name': 'x'}), self.DENIED)  # 소속 없는 건물
        self.assertEqual(self.patch_b('main', {'name': 'x'}, sub='nobody'), self.DENIED)
        self.assertNotIn('overrides', self.t['O'].items['main'])
        self.assertEqual(self.patch_b('edu', {'name': '교육관 B'}, sub='u-b2')[1]['building']['name'], '교육관 B')

    def test_admin_unowned_building_keeps_overrides_across_assignment(self):
        boss = {'sub': 'boss', 'groups': '[admin]'}
        self.assertEqual(self.patch_b('lab', {'weekend': False}, **boss)[1]['building']['weekend'], False)
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
        self.patch_b('edu', {'use': '학원'}, **boss)
        a = self.audits('building.update')[0]
        self.assertEqual((a['companyId'], a['actor']), ('co-b', {'sub': 'boss', 'email': 'boss@vendor.com', 'role': 'admin'}))


class AdminMemberTest(Tenancy):
    def test_role_remove_and_audit(self):
        role, delete = 'PATCH /admin/companies/{id}/members/{sub}', 'DELETE /admin/companies/{id}/members/{sub}'
        a = lambda sub: {'id': 'co-a', 'sub': sub}  # noqa: E731
        self.assertEqual(adm(role, path=a('u-a'), body={'role': 'operator'}), LAST_MANAGER)
        self.assertEqual(adm(delete, path=a('u-a')), LAST_MANAGER)
        self.assertEqual(adm(role, path={'id': 'co-x', 'sub': 'u-a'}, body={'role': 'operator'}), (404, {'error': '없는 기업입니다.'}))
        self.assertEqual(adm(delete, path=a('u-b')), (404, {'error': '없는 구성원입니다.'}))
        self.assertEqual(adm(role, path={'id': 'co-b', 'sub': 'u-b'}, body={'role': 'manager'})[1]['member']['role'], 'manager')
        self.t['M'].put_item({'sub': 'u-a2', 'companyId': 'co-a', 'email': 'a2@ga.com', 'role': 'operator', 'joinedAt': '2026-11-20T11:00:00+09:00'})
        self.assertEqual(adm(role, path=a('u-a2'), body={'role': 'manager'})[0], 200)
        self.assertEqual(adm(delete, path=a('u-a')), (200, {'deleted': True}))
        self.assertNotIn('u-a', self.t['M'].items)
        code, body = adm('GET /admin/companies/{id}/audit', path={'id': 'co-a'})
        self.assertEqual(sorted(i['action'] for i in body['items']), ['member.remove', 'member.role'])
        self.assertEqual(body['items'][0]['actor'], {'email': 'boss@vendor.com', 'role': 'admin'})
        self.assertEqual(len(adm('GET /admin/companies/{id}/audit', path={'id': 'co-a'}, query={'limit': '1'})[1]['items']), 1)
        self.assertEqual(adm('GET /admin/companies/{id}/audit', path={'id': 'co-x'})[0], 404)
        self.assertEqual(call(http('GET /admin/companies/{id}/audit', path={'id': 'co-a'}))[0], 403)


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
