"""기업 코드, 가입 전 검사·가입 확인, 소속 검사(403), 판매사 관리 API, /me 테스트(가짜 테이블, 네트워크 없음)"""
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
    """DynamoDB Table 대체: get·put·delete·scan, 보조 인덱스 query(#k = :v)"""

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

    def query(self, IndexName, KeyConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues, **kw):
        a, v = ExpressionAttributeNames['#k'], ExpressionAttributeValues[':v']
        return {'Items': [dict(i) for i in self.items.values() if i.get(a) == v]}


def http(route, sub='u-a', groups='', query=None, body=None, path=None):
    method, p = route.split(' ', 1)
    return {'routeKey': route, 'rawPath': p, 'queryStringParameters': query, 'pathParameters': path,
            'body': json.dumps(body) if body is not None else None,
            'requestContext': {'http': {'method': method}, 'authorizer': {'jwt': {'claims': {'sub': sub, 'cognito:groups': groups}}}}}


def call(event):
    r = api.handler(event, None)
    return r['statusCode'], json.loads(r['body'])


class Tenancy(unittest.TestCase):
    """기업 A(main, office), 기업 B(edu), 소속 없는 lab. u-a는 A 관리자, u-b는 B 운영자"""

    def setUp(self):
        self.t = {'C': FakeTable('companyId'), 'M': FakeTable('sub'), 'O': FakeTable('buildingId'), 'A': FakeTable('companyId', 'at')}
        tenant._tables.clear()
        tenant._tables.update(self.t)
        tenant.forget()
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
        sent = []
        ws.boto3 = types.SimpleNamespace(client=lambda name, endpoint_url: types.SimpleNamespace(
            exceptions=types.SimpleNamespace(GoneException=type('Gone', (Exception,), {})),
            post_to_connection=lambda ConnectionId, Data: sent.append(json.loads(Data))))
        ev = {'requestContext': {'routeKey': 'ask', 'connectionId': 'c1', 'domainName': 'x', 'stage': 'prod', 'authorizer': {'sub': 'u-a', 'groups': ''}},
              'body': json.dumps({'action': 'ask', 'requestId': 'r1', 'text': '전력', 'buildingId': 'edu'})}
        ws.handler(ev, None)
        self.assertEqual(sent, [{'type': 'error', 'message': '이 건물에 접근할 권한이 없습니다.', 'requestId': 'r1'}])
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
        self.assertEqual(call(http('GET /me')), (200, {'email': 'a@ga.com', 'role': 'manager', 'company': {'id': 'co-a', 'name': '가나 기업'}}))
        self.assertEqual(call(http('GET /me', sub='boss', groups='[admin]'))[1], {'email': 'boss@vendor.com', 'role': 'admin', 'company': None})
        self.assertEqual(call(http('GET /me', sub='nobody'))[1], {'email': 'boss@vendor.com', 'role': None, 'company': None})


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
