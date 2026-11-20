"""판매사 관리 API(Cognito admin 그룹 전용)

- 기업: GET·POST /admin/companies, GET·PATCH·DELETE /admin/companies/{id}, POST /admin/companies/{id}/code(코드 재발급)
- 구성원: PATCH·DELETE /admin/companies/{id}/members/{sub}(역할 변경, 소속 해제), 관리자(manager) 최소 1명
- 변경 이력: GET /admin/companies/{id}/audit?limit=(최신순, 기본 50, 최대 200)
- 건물 소속: GET /admin/buildings(소속 없는 건물 포함), PUT /admin/buildings/{id}/company {companyId | null}
- 사용자: GET /admin/users(가입한 사용자 이메일, 상태, 관리자 여부, 가입일)
- 관리자 판정: 액세스 토큰 cognito:groups 클레임에 admin 포함(HTTP API JWT 권한 부여자가 서명 검증)
- 공용 함수: 기업 상세, 구성원 역할 변경·해제, 변경 이력 조회는 고객사 설정 API(customer.py)도 사용
- 변경 이력 action: company.create, company.update, company.delete, company.code, building.assign, building.update, member.join, member.role, member.remove
"""
import os
import re

import buildings
import common
import tenant

POOL_ID = os.environ.get('USER_POOL_ID', '')
EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$')
# 기업 정보 입력 필드별 최대 글자 수(name은 필수)
FIELDS = {'name': 60, 'contactName': 60, 'contactEmail': 254, 'phone': 30, 'address': 200}
STATUSES = ('active', 'suspended')
ROLES = ('manager', 'operator')
# 기업 상세의 건물 카드 필드
CARD = ('id', 'name', 'use', 'floors', 'roomCount')
NO_COMPANY = '없는 기업입니다.'
NO_MEMBER = '없는 구성원입니다.'
LAST_MANAGER = '관리자는 최소 1명이어야 합니다.'
AUDIT_LIMIT, AUDIT_MAX = 50, 200
_idp = None


def _client():
    global _idp
    if _idp is None:
        import boto3
        _idp = boto3.client('cognito-idp')
    return _idp


def users():
    admins, out, kw = set(), [], {'UserPoolId': POOL_ID, 'Limit': 60}
    gk = {'UserPoolId': POOL_ID, 'GroupName': tenant.ADMIN, 'Limit': 60}
    while True:
        r = _client().list_users_in_group(**gk)
        admins |= {u['Username'] for u in r['Users']}
        if 'NextToken' not in r:
            break
        gk['NextToken'] = r['NextToken']
    while True:
        r = _client().list_users(**kw)
        for u in r['Users']:
            attrs = {a['Name']: a['Value'] for a in u.get('Attributes', [])}
            out.append({'email': attrs.get('email', ''), 'status': u['UserStatus'], 'enabled': u['Enabled'],
                        'admin': u['Username'] in admins, 'createdAt': u['UserCreateDate'].isoformat()})
        if 'PaginationToken' not in r:
            return sorted(out, key=lambda x: x['createdAt'], reverse=True)
        kw['PaginationToken'] = r['PaginationToken']


def view(c):
    """저장 항목 → 응답 Company 객체"""
    return {'id': c['companyId'], **{k: c.get(k, '') for k in FIELDS}, 'status': c.get('status', 'active'),
            'code': c.get('code', ''), 'codeExpiresAt': c.get('codeExpiresAt', ''), 'createdAt': c.get('createdAt', '')}


def member_view(m):
    return {k: m.get(k, '') for k in ('sub', 'email', 'role', 'joinedAt')}


def clean(req, required):
    """입력 검증: (정리한 필드, 오류 문구). 문자열만 허용, 앞뒤 공백 제거"""
    out = {}
    for k, limit in FIELDS.items():
        if k not in req:
            continue
        v = req[k] if req[k] is not None else ''
        if not isinstance(v, str) or len(v.strip()) > limit:
            return None, f'{k}는 {limit}자 이하 문자열입니다.'
        out[k] = v.strip()
    if (required or 'name' in out) and not out.get('name'):
        return None, '기업 이름은 1~60자로 입력하십시오.'
    if out.get('contactEmail') and not EMAIL.match(out['contactEmail']):
        return None, '담당자 이메일 형식이 잘못되었습니다.'
    if 'status' in req:
        if req['status'] not in STATUSES:
            return None, 'status는 active 또는 suspended입니다.'
        out['status'] = req['status']
    return out, None


def days(v):
    # 코드 유효 기간(일): 없으면 30, 1~365 정수
    if v is None:
        return tenant.CODE_DAYS
    return v if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 365 else None


def actor(event):
    ctx = tenant.caller(event)
    return ctx | {'email': ctx['email'] or tenant.email(ctx['sub'])}


def path_id(event):
    return str((event.get('pathParameters') or {}).get('id', ''))


def list_companies(event):
    count_b, count_m = {}, {}
    for o in tenant.scan('OWNERS_TABLE'):
        if o.get('companyId'):
            count_b[o['companyId']] = count_b.get(o['companyId'], 0) + 1
    for m in tenant.scan('MEMBERS_TABLE'):
        if not m['sub'].startswith(tenant.PENDING):
            count_m[m['companyId']] = count_m.get(m['companyId'], 0) + 1
    items = sorted(tenant.scan('COMPANIES_TABLE'), key=lambda c: c.get('createdAt', ''), reverse=True)
    return common.resp(200, {'companies': [view(c) | {'buildingCount': count_b.get(c['companyId'], 0), 'memberCount': count_m.get(c['companyId'], 0)} for c in items]})


def create_company(event):
    req = common.body(event)
    if not isinstance(req, dict):
        return common.resp(400, {'error': '요청 본문이 JSON 객체가 아닙니다.'})
    # 생성 시 상태는 항상 active
    fields, err = clean({k: v for k, v in req.items() if k != 'status'}, required=True)
    n = days(req.get('codeDays'))
    if err or n is None:
        return common.resp(400, {'error': err or 'codeDays는 1~365 정수입니다.'})
    c = {'companyId': tenant.new_company_id(), **{k: '' for k in FIELDS}, **fields, 'status': 'active',
         **tenant.code_fields(n), 'createdAt': tenant.stamp()}
    tenant.table('COMPANIES_TABLE').put_item(Item=c)
    tenant.audit(c['companyId'], actor(event), 'company.create', c['companyId'], {'name': c['name']})
    return common.resp(201, {'company': view(c)})


def detail(c, card=CARD):
    """기업 상세: {company, buildings: [건물 카드], members: [가입일 순]}"""
    out = []
    for bid in tenant.company_buildings(c['companyId']):
        try:
            s = buildings.summary(buildings.get(bid))
        except ValueError:
            continue  # 건물 테이블에서 삭제된 건물
        out.append({k: s[k] for k in card})
    members = sorted(tenant.company_members(c['companyId']), key=lambda m: m.get('joinedAt', ''))
    return {'company': view(c), 'buildings': out, 'members': [member_view(m) for m in members]}


def get_company(event):
    c = tenant.company(path_id(event))
    if not c:
        return common.resp(404, {'error': NO_COMPANY})
    return common.resp(200, detail(c))


def update_company(event, cid=None):
    c = tenant.company(cid or path_id(event))
    if not c:
        return common.resp(404, {'error': NO_COMPANY})
    req = common.body(event)
    fields, err = clean(req, required=False) if isinstance(req, dict) else (None, '요청 본문이 JSON 객체가 아닙니다.')
    if err or not fields:
        return common.resp(400, {'error': err or '수정할 항목이 없습니다.'})
    changed = {k: v for k, v in fields.items() if c.get(k) != v}
    c.update(fields)
    tenant.table('COMPANIES_TABLE').put_item(Item=c)
    tenant.forget()  # 중지·재개를 같은 실행 환경에 즉시 반영
    tenant.audit(c['companyId'], actor(event), 'company.update', c['companyId'], changed)
    return common.resp(200, {'company': view(c)})


def delete_company(event):
    c = tenant.company(path_id(event))
    if not c:
        return common.resp(404, {'error': NO_COMPANY})
    if tenant.company_buildings(c['companyId']):
        return common.resp(409, {'error': '건물이 남아 있는 기업은 삭제할 수 없습니다.'})
    members = tenant.table('MEMBERS_TABLE')
    # 가입 대기 항목도 같은 기업 보조 인덱스에 있어 함께 삭제
    for m in tenant.query('MEMBERS_TABLE', 'company-index', 'companyId', c['companyId']):
        members.delete_item(Key={'sub': m['sub']})
    tenant.table('COMPANIES_TABLE').delete_item(Key={'companyId': c['companyId']})
    tenant.forget()
    tenant.audit(c['companyId'], actor(event), 'company.delete', c['companyId'], {'name': c.get('name', '')})
    return common.resp(200, {'deleted': True})


def regenerate_code(event):
    c = tenant.company(path_id(event))
    if not c:
        return common.resp(404, {'error': NO_COMPANY})
    req = common.body(event)
    n = days(req.get('days')) if isinstance(req, dict) else None
    if n is None:
        return common.resp(400, {'error': 'days는 1~365 정수입니다.'})
    c.update(tenant.code_fields(n))
    tenant.table('COMPANIES_TABLE').put_item(Item=c)
    tenant.audit(c['companyId'], actor(event), 'company.code', c['companyId'], {'codeExpiresAt': c['codeExpiresAt']})
    return common.resp(200, {'company': view(c)})


# 구성원 관리
# - 대상: 같은 기업의 구성원(가입 대기 항목 제외), 다른 기업 구성원은 404
# - 관리자 최소 1명: 마지막 manager의 operator 변경·해제는 409
# - 소속 해제: 구성원 항목만 삭제, Cognito 계정은 유지(기업 코드로 다시 가입 가능)

def _target(cid, sub):
    m = tenant.table('MEMBERS_TABLE').get_item(Key={'sub': str(sub or '')}).get('Item')
    return m if m and m.get('companyId') == cid and not m['sub'].startswith(tenant.PENDING) else None


def _last_manager(cid, m):
    # shortcut: 관리자 2명이 동시에 서로를 변경·해제하면 0명 가능, 구성원 관리가 잦아지면 기업 항목 조건부 쓰기로 교체
    return m.get('role') == 'manager' and sum(x.get('role') == 'manager' for x in tenant.company_members(cid)) <= 1


def set_role(event, cid, sub):
    m = _target(cid, sub)
    if not m:
        return common.resp(404, {'error': NO_MEMBER})
    req = common.body(event)
    role = req.get('role') if isinstance(req, dict) else None
    if role not in ROLES:
        return common.resp(400, {'error': 'role은 manager 또는 operator입니다.'})
    if role != m.get('role'):
        if _last_manager(cid, m):
            return common.resp(409, {'error': LAST_MANAGER})
        prev, m['role'] = m.get('role'), role
        tenant.table('MEMBERS_TABLE').put_item(Item=m)
        tenant.forget()
        tenant.audit(cid, actor(event), 'member.role', m['sub'], {'email': m.get('email', ''), 'from': prev, 'to': role})
    return common.resp(200, {'member': member_view(m)})


def remove_member(event, cid, sub):
    m = _target(cid, sub)
    if not m:
        return common.resp(404, {'error': NO_MEMBER})
    if _last_manager(cid, m):
        return common.resp(409, {'error': LAST_MANAGER})
    tenant.table('MEMBERS_TABLE').delete_item(Key={'sub': m['sub']})
    tenant.forget()
    tenant.audit(cid, actor(event), 'member.remove', m['sub'], {'email': m.get('email', ''), 'role': m.get('role', '')})
    return common.resp(200, {'deleted': True})


def audit_list(event, cid):
    """변경 이력 최신순: limit 기본 50, 200 초과는 200, 1 미만·정수 아님은 400"""
    raw = str((event.get('queryStringParameters') or {}).get('limit') or AUDIT_LIMIT)
    if not raw.isdigit() or int(raw) < 1:
        return common.resp(400, {'error': f'limit은 1~{AUDIT_MAX} 정수입니다.'})
    r = tenant.table('AUDIT_TABLE').query(
        KeyConditionExpression='#k = :v', ExpressionAttributeNames={'#k': 'companyId'}, ExpressionAttributeValues={':v': cid},
        ScanIndexForward=False, Limit=min(int(raw), AUDIT_MAX))
    return common.resp(200, {'items': [{
        'at': a['at'].split('#')[0], 'actor': {k: (a.get('actor') or {}).get(k, '') for k in ('email', 'role')},
        'action': a['action'], 'target': a.get('target', ''), 'detail': buildings._plain(a.get('detail') or {}),
    } for a in r['Items']]})


def _with_company(fn):
    # /admin/companies/{id}/... 경로: 기업 존재 확인 후 (event, 기업 id, 구성원 sub) 전달
    def run(event):
        c = tenant.company(path_id(event))
        if not c:
            return common.resp(404, {'error': NO_COMPANY})
        return fn(event, c['companyId'], (event.get('pathParameters') or {}).get('sub'))
    return run


def list_buildings(event):
    owners = {o['buildingId']: o.get('companyId') for o in tenant.scan('OWNERS_TABLE')}
    names = {c['companyId']: c.get('name', '') for c in tenant.scan('COMPANIES_TABLE')}
    return common.resp(200, {'buildings': [
        {'id': b['id'], 'name': b['name'], 'companyId': owners.get(b['id']), 'companyName': names.get(owners.get(b['id']))}
        for b in buildings.LIST]})


def assign_building(event):
    try:
        bid = buildings.get(path_id(event))['id']
    except ValueError as e:
        return common.bad_building(e)
    req = common.body(event)
    if not isinstance(req, dict) or 'companyId' not in req:
        return common.resp(400, {'error': 'companyId(기업 id 또는 null)를 입력하십시오.'})
    cid = req['companyId']
    if cid is not None and not (isinstance(cid, str) and tenant.company(cid)):
        return common.resp(404, {'error': NO_COMPANY})
    owners = tenant.table('OWNERS_TABLE')
    item = owners.get_item(Key={'buildingId': bid}).get('Item') or {'buildingId': bid}
    prev = item.pop('companyId', None)
    # 건물 수정 정보(overrides)가 있으면 소속 해제 후에도 항목 유지
    if cid or item.get('overrides'):
        owners.put_item(Item=item | ({'companyId': cid} if cid else {}))
    else:
        owners.delete_item(Key={'buildingId': bid})
    tenant.forget()
    # 이력은 새 소속 기업(해제는 이전 기업) 기준
    if cid or prev:
        tenant.audit(cid or prev, actor(event), 'building.assign', bid, {'from': prev, 'to': cid})
    return common.resp(200, {'buildingId': bid, 'companyId': cid})


ROUTES = {
    'GET /admin/users': lambda e: common.resp(200, {'users': users()}),
    'GET /admin/companies': list_companies,
    'POST /admin/companies': create_company,
    'GET /admin/companies/{id}': get_company,
    'PATCH /admin/companies/{id}': update_company,
    'DELETE /admin/companies/{id}': delete_company,
    'POST /admin/companies/{id}/code': regenerate_code,
    'PATCH /admin/companies/{id}/members/{sub}': _with_company(set_role),
    'DELETE /admin/companies/{id}/members/{sub}': _with_company(remove_member),
    'GET /admin/companies/{id}/audit': _with_company(lambda e, cid, sub: audit_list(e, cid)),
    'GET /admin/buildings': list_buildings,
    'PUT /admin/buildings/{id}/company': assign_building,
}


def handler(event, context):
    if tenant.caller(event)['role'] != tenant.ADMIN:
        return common.resp(403, {'error': '관리자만 사용할 수 있습니다.'})
    fn = ROUTES.get(event.get('routeKey', ''))
    if not fn:
        return common.resp(404, {'error': '없는 경로입니다.'})
    return fn(event)
