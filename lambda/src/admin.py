"""판매사 관리 API(Cognito admin 그룹 전용)

- 기업: GET·POST /admin/companies, GET·PATCH·DELETE /admin/companies/{id}, POST /admin/companies/{id}/code(코드 재발급)
- 구성원: PATCH·DELETE /admin/companies/{id}/members/{sub}(역할 변경, 소속 해제), 관리자(manager) 최소 1명
- 변경 이력: GET /admin/companies/{id}/audit?limit=(최신순, 기본 50, 최대 200)
- 건물 소속: GET /admin/buildings(소속 없는 건물 포함), PUT /admin/buildings/{id}/company {companyId | null}
- 건물 관리: POST /admin/companies/{id}/buildings(등록), PUT /buildings/{id}/twin(트윈·도면·호실 확정 저장, twin 함수),
  PATCH /admin/buildings/{id}(이름, 용도, 운영 시간, 주말 운영), DELETE /admin/buildings/{id}(영구 삭제, 변경 이력만 남김)
- 사용자: GET /admin/users(가입한 사용자 이메일, 상태, 관리자 여부, 가입일)
- 관리자 판정: 액세스 토큰 cognito:groups 클레임에 admin 포함(HTTP API JWT 권한 부여자가 서명 검증)
- 공용 함수: 기업 상세, 변경 이력 조회, 건물 정보 수정은 고객사 설정 API(customer.py)도 사용
- 변경 이력 action: company.create, company.update, company.delete, company.code, building.assign, building.create, building.update,
  building.plan, building.delete, member.join, member.role, member.remove
"""
import json
import math
import os
import re
import secrets
import string
from decimal import Decimal

import buildings
import common
import plan
import sim
import tenant

POOL_ID = os.environ.get('USER_POOL_ID', '')
EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$')
# 기업 정보 입력 필드별 최대 글자 수(name은 필수)
FIELDS = {'name': 60, 'contactName': 60, 'contactEmail': 254, 'phone': 30, 'address': 200}
STATUSES = ('active', 'suspended')
ROLES = ('manager', 'operator')
# 건물 카드 필드: 기업 상세, 고객사 기업 정보, 건물 등록·교체 응답 공통
CARD = ('id', 'name', 'use', 'floors', 'roomCount', 'hours', 'weekend')
# 건물 정보 문자열 필드: (최대 글자 수, 이름)
TEXT = {'name': (40, '건물 이름'), 'use': (20, '건물 용도')}
NO_COMPANY = '없는 기업입니다.'
NO_MEMBER = '없는 구성원입니다.'
VENDOR_ONLY = '판매사 관리자만 변경할 수 있습니다.'
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


def card(b):
    s = buildings.summary(b)
    return {k: s[k] for k in CARD}


def detail(c):
    """기업 상세: {company, buildings: [건물 카드], members: [가입일 순]}"""
    out = []
    for bid in tenant.company_buildings(c['companyId']):
        try:
            out.append(card(buildings.get(bid)))
        except ValueError:
            continue  # 건물 테이블에서 삭제된 건물
    members = sorted(tenant.company_members(c['companyId']), key=lambda m: m.get('joinedAt', ''))
    return {'company': view(c), 'buildings': out, 'members': [member_view(m) for m in members]}


def get_company(event):
    c = tenant.company(path_id(event))
    if not c:
        return common.resp(404, {'error': NO_COMPANY})
    out, twins = detail(c), plan.twin_ids()
    for b in out['buildings']:
        b['hasTwin'] = b['id'] in twins
    return common.resp(200, out)


def update_company(event):
    c = tenant.company(path_id(event))
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
    twins = plan.twin_ids()
    return common.resp(200, {'buildings': [
        {'id': b['id'], 'name': b['name'], 'companyId': owners.get(b['id']), 'companyName': names.get(owners.get(b['id'])),
         'hours': b['hours'], 'weekend': b['weekend'], 'hasTwin': b['id'] in twins}
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


# 건물 정보 수정
# - 대상: name(1~40자), use(1~20자), hours([시작, 종료] 0~24 정수), weekend. 층·호실은 트윈 확정 저장(PUT /buildings/{id}/twin)으로 변경
# - 저장: BuildingOwnersTable 항목의 overrides(트윈 Buildings 항목은 적재 스크립트가 덮어씀), 소속 없는 건물은 overrides만 있는 항목

def building_fields(req):
    """건물 정보 입력 검증: (정리한 필드, 오류 문구). 그 밖의 키는 무시"""
    if not isinstance(req, dict):
        return None, '요청 본문이 JSON 객체가 아닙니다.'
    out = {}
    for k, (limit, label) in TEXT.items():
        if k in req:
            v = req[k].strip() if isinstance(req[k], str) else ''
            if not 1 <= len(v) <= limit:
                return None, f'{label}은 1~{limit}자로 입력하십시오.'
            out[k] = v
    if 'hours' in req:
        h = req['hours']
        if not (isinstance(h, list) and len(h) == 2 and all(type(x) is int and 0 <= x <= 24 for x in h) and h[0] < h[1]):
            return None, '운영 시간은 [시작, 종료] 0~24 정수이고 시작이 종료보다 빨라야 합니다.'
        out['hours'] = h
    if 'weekend' in req:
        if not isinstance(req['weekend'], bool):
            return None, '주말 운영 여부는 true 또는 false입니다.'
        out['weekend'] = req['weekend']
    if not out:
        return None, '수정할 항목이 없습니다.'
    return out, None


def update_building(event):
    try:
        b = buildings.get(path_id(event))
    except ValueError as e:
        return common.bad_building(e)
    fields, err = building_fields(common.body(event))
    if err:
        return common.resp(400, {'error': err})
    changed = {k: v for k, v in fields.items() if b[k] != v}
    if changed:
        owners = tenant.table('OWNERS_TABLE')
        item = owners.get_item(Key={'buildingId': b['id']}).get('Item') or {'buildingId': b['id']}
        item['overrides'] = {**(item.get('overrides') or {}), **changed}
        owners.put_item(Item=item)
        buildings.forget()
        # 변경 이력은 기업별이라 소속 없는 건물은 기록 안 함
        if item.get('companyId'):
            tenant.audit(item['companyId'], actor(event), 'building.update', b['id'],
                         {'before': {k: b[k] for k in changed}, 'after': changed})
    return common.resp(200, {'building': buildings.summary(buildings.get(b['id']))})


# 건물 등록·트윈 확정 저장(교체)·삭제
# - 본문: {twin(트윈 파이프라인 building.json), rooms: [{id, name, floor, use, areaM2, idu}], plan: {floors: {층: {elevation?, bounds, rooms: [{id, polys, hvac}]}}}}
#   등록은 name, use, hours, weekend 필수와 선택 id(b- + 소문자·숫자 8자리), 교체는 이 4개 필드 무시
# - 검사: 본문 5MB 이하(413), 호실 1개 이상, 호실 id·실내기 id 중복 없음, 호실 층은 도면 층, 도면 호실은 rooms에 있음, 숫자는 유한값
# - 호실 id 전역 고유: BY_ROOM과 시뮬레이터 스케줄 매칭이 호실 id만 비교하므로 다른 건물과 겹치면 409
# - 저장: 도면 버킷 plans/<건물>/ 아래 트윈 building.json + building-v<번호>.json, 도면 current.json + v<번호>.json(같은 번호)
#   트윈 테이블 Rooms·Equipment(호실당 실내기 1대)·Buildings
# - 교체: 빠진 호실의 Rooms·Equipment·State 행 삭제. 삭제: plans/<건물>/ 전체, 테이블 행, 소속 항목, 건물 스케줄 전체 삭제
# - 캐시: 같은 실행 환경은 즉시(buildings.forget, tenant.forget), 다른 실행 환경은 60초 안에 반영
# - shortcut: 단계별 기록이라 중간 실패 시 일부만 반영, 같은 요청 재시도로 복구. 트랜잭션은 건물 관리가 잦아지면 검토

MAX_BODY = 5 * 1024 * 1024
BUILDING_ID = re.compile(r'b-[a-z0-9]{8}')
ROOM_TEXT = ('id', 'name', 'floor', 'use', 'idu')
ROOM_FIELDS = ('name', 'floor', 'use', 'areaM2', 'idu')
# 판매사 등록·교체 건물의 Buildings 항목 출처 필드(가상 건물 생성 규칙 floors 매핑·remap·mirror 미사용)
PIPELINE = {'virtual': False, 'basis': '트윈 파이프라인(판매사 등록)', 'remap': {}, 'mirror': False}
STORES = ('BUILDINGS_TABLE', 'ROOMS_TABLE', 'EQUIPMENT_TABLE', 'STATE_TABLE', 'PLANS_BUCKET')


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _finite(v):
    # 중첩 값 전체 확인(JSON NaN·Infinity·1e999 거부), 깊은 중첩도 재귀 없이 처리
    stack = [v]
    while stack:
        x = stack.pop()
        if isinstance(x, float) and not math.isfinite(x):
            return False
        if isinstance(x, dict):
            stack += x.values()
        elif isinstance(x, list):
            stack += x
    return True


def _points(v):
    return isinstance(v, list) and all(isinstance(p, list) and len(p) == 2 and all(_num(x) for x in p) for p in v)


def _plan_error(floors, rooms):
    for f, fl in floors.items():
        b = fl.get('bounds') if isinstance(fl, dict) else None
        if not (1 <= len(f) <= 20 and isinstance(b, list) and len(b) == 4 and all(_num(x) for x in b)
                and ('elevation' not in fl or _num(fl['elevation'])) and isinstance(fl.get('rooms'), list)):
            return f'도면 층 {f}은 bounds [x0, y0, x1, y1], rooms 목록, elevation(선택, 숫자)입니다.'
        for r in fl['rooms']:
            if not (isinstance(r, dict) and isinstance(r.get('polys'), list) and all(_points(g) for g in r['polys']) and _points(r.get('hvac'))):
                return f'도면 층 {f}의 호실은 id, polys(다각형 목록), hvac(점 목록)입니다.'
            if r.get('id') not in rooms:
                return f"도면 호실 {r.get('id')}이 rooms에 없습니다."
    return None


def _upload_error(req, create):
    """등록·교체 본문 오류 문구(통과하면 None). 등록은 name·use를 앞뒤 공백 제거 값으로 바꿈"""
    if not isinstance(req, dict):
        return '요청 본문이 JSON 객체가 아닙니다.'
    if create:
        if not all(k in req for k in (*TEXT, 'hours', 'weekend')):
            return '건물 이름, 용도, 운영 시간, 주말 운영 여부를 모두 입력하십시오.'
        if 'id' in req and not (isinstance(req['id'], str) and BUILDING_ID.fullmatch(req['id'])):
            return '건물 id는 b- 뒤 소문자·숫자 8자리입니다.'
        fields, err = building_fields(req)
        if err:
            return err
        req.update(fields)
    if not _finite(req):
        return '숫자는 유한한 값이어야 합니다.'
    if not isinstance(req.get('twin'), dict):
        return 'twin은 트윈 파이프라인 building.json 객체입니다.'
    floors = req['plan'].get('floors') if isinstance(req.get('plan'), dict) else None
    if not (isinstance(floors, dict) and floors):
        return 'plan.floors는 층 이름별 도면 객체이고 1개 이상입니다.'
    rooms = req.get('rooms')
    if not (isinstance(rooms, list) and rooms):
        return 'rooms는 호실 1개 이상 목록입니다.'
    if not all(isinstance(r, dict) and all(isinstance(r.get(k), str) and 1 <= len(r[k]) <= 100 for k in ROOM_TEXT)
               and _num(r.get('areaM2')) and r['areaM2'] >= 0 for r in rooms):
        return '호실은 id, name, floor, use, idu(1~100자 문자열)와 areaM2(0 이상 숫자)입니다.'
    for k in ('id', 'idu'):
        if len({r[k] for r in rooms}) != len(rooms):
            return f'호실 {k}가 중복됩니다.'
    if off := next((r for r in rooms if r['floor'] not in floors), None):
        return f"호실 {off['id']}의 층 {off['floor']}이 도면에 없습니다."
    return _plan_error(floors, {r['id'] for r in rooms})


def _upload(event, create):
    """등록·교체 본문 검증: (본문, None) 또는 (None, 오류 응답)"""
    if len((event.get('body') or '').encode()) > MAX_BODY:
        return None, common.resp(413, {'error': '요청 본문은 5MB 이하입니다.'})
    req = common.body(event)
    err = _upload_error(req, create)
    return (None, common.resp(400, {'error': err})) if err else (req, None)


def _clash(bid, rooms):
    """다른 건물에 이미 있는 호실 id(최대 5개)"""
    by_room = buildings.BY_ROOM
    return sorted(r['id'] for r in rooms if r['id'] in by_room and by_room[r['id']]['building'] != bid)[:5]


def _ddb(v):
    # DynamoDB 숫자는 Decimal(float 불가)
    return json.loads(json.dumps(v, ensure_ascii=False), parse_float=Decimal)


def _sync(env, sort, bid, rows=(), keep=None):
    """건물 항목을 rows로 덮어쓰고 키가 keep(기본 rows의 키)에 없는 기존 항목 삭제. 기존 키 집합 반환"""
    keep = {r[sort] for r in rows} if keep is None else keep
    old = {i[sort] for i in tenant.query(env, None, 'buildingId', bid)}
    with tenant.table(env).batch_writer() as w:
        for r in rows:
            w.put_item(Item=_ddb(r))
        for k in old - keep:
            w.delete_item(Key={'buildingId': bid, sort: k})
    return old


def _save(bid, req):
    """트윈·도면 파일과 Rooms·Equipment 기록, 빠진 호실의 State 삭제: (버전, 기존 호실 id 집합)"""
    # 버전 번호: 도면 v<n>, 트윈 building-v<n> 중 가장 큰 값 + 1(다른 경로가 한쪽만 저장해도 덮어쓰지 않음)
    pat = re.compile(rf'plans/{re.escape(bid)}/(?:building-)?v(\d+)\.json')
    n = 1 + max((int(m.group(1)) for k in plan.keys(f'plans/{bid}/') if (m := pat.fullmatch(k))), default=0)
    for key, body in ((f'building-v{n}', req['twin']), ('building', req['twin']), (f'v{n}', req['plan']), ('current', req['plan'])):
        plan.put(f'plans/{bid}/{key}.json', body)
    rooms = req['rooms']
    old = _sync('ROOMS_TABLE', 'roomId', bid, [{'buildingId': bid, 'roomId': r['id'], **{k: r[k] for k in ROOM_FIELDS}} for r in rooms])
    _sync('EQUIPMENT_TABLE', 'equipmentId', bid, [{'buildingId': bid, 'equipmentId': r['idu'], 'roomId': r['id'], 'floor': r['floor'],
                                                   'type': 'IDU', 'ratedKw': sim.rated(r)} for r in rooms])
    _sync('STATE_TABLE', 'roomId', bid, keep={r['id'] for r in rooms})
    return n, old


def _floors(req):
    return {f: f for f in sorted(req['plan']['floors'], key=buildings._floor_key)}


def _refresh():
    buildings.forget()
    tenant.forget()


def _stored(fn):
    # 건물 쓰기 경로: 트윈 테이블·도면 버킷이 없으면(로컬) 503, 건물 id·호실 id 검사는 최신 테이블 기준
    def run(*args):
        if not all(os.environ.get(k) for k in STORES):
            return common.resp(503, {'error': '건물 저장소가 설정되지 않았습니다.'})
        buildings.forget()
        return fn(*args)
    return run


def create_building(event, cid, _sub):
    req, bad = _upload(event, create=True)
    if bad:
        return bad
    # shortcut: 생성 id는 중복 확인 안 함(약 2.8조 가지), 건물 수가 수십만을 초과하면 생성 시 확인 추가
    bid = req.get('id') or 'b-' + ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(8))
    if bid in {b['id'] for b in buildings.LIST}:
        return common.resp(409, {'error': '이미 있는 건물 id입니다.'})
    if clash := _clash(bid, req['rooms']):
        return common.resp(409, {'error': f"다른 건물과 호실 id가 겹칩니다: {', '.join(clash)}"})
    _save(bid, req)
    # 소속 항목을 건물 항목보다 먼저 기록: 중간 실패 후 같은 id로 재시도 가능
    tenant.table('OWNERS_TABLE').put_item(Item={'buildingId': bid, 'companyId': cid})
    tenant.table('BUILDINGS_TABLE').put_item(Item=_ddb({
        'buildingId': bid, **{k: req[k] for k in (*TEXT, 'hours', 'weekend')}, 'floors': _floors(req), 'waste': 0.15, **PIPELINE}))
    _refresh()
    tenant.audit(cid, actor(event), 'building.create', bid, {'name': req['name'], 'rooms': len(req['rooms']), 'floors': list(_floors(req))})
    return common.resp(201, {'building': card(buildings.get(bid))})


def replace_twin(event):
    try:
        bid = buildings.get(path_id(event))['id']
    except ValueError as e:
        return common.bad_building(e)
    req, bad = _upload(event, create=False)
    if bad:
        return bad
    if clash := _clash(bid, req['rooms']):
        return common.resp(409, {'error': f"다른 건물과 호실 id가 겹칩니다: {', '.join(clash)}"})
    n, old = _save(bid, req)
    # 이름·용도·운영 시간·낭비 비율은 유지, 층과 출처 필드만 새 도면 기준
    item = buildings._plain(tenant.table('BUILDINGS_TABLE').get_item(Key={'buildingId': bid}).get('Item') or {'buildingId': bid})
    tenant.table('BUILDINGS_TABLE').put_item(Item=_ddb(item | PIPELINE | {'floors': _floors(req)}))
    _refresh()
    ids = {r['id'] for r in req['rooms']}
    if owner := tenant.owners().get(bid):
        tenant.audit(owner, actor(event), 'building.plan', bid, {'version': n, 'rooms': len(ids), 'added': len(ids - old), 'removed': len(old - ids)})
    return common.resp(200, {'building': card(buildings.get(bid)), 'version': n})


def delete_building(event):
    try:
        b = buildings.get(path_id(event))
    except ValueError as e:
        return common.bad_building(e)
    bid = b['id']
    # 하위 데이터 먼저 삭제, 건물 항목은 마지막: 중간 실패 시 같은 요청으로 재시도 가능
    plan.delete(f'plans/{bid}/')  # 도면·트윈 현재 파일과 모든 버전
    rooms = len(_sync('ROOMS_TABLE', 'roomId', bid))
    for env, sort in (('EQUIPMENT_TABLE', 'equipmentId'), ('STATE_TABLE', 'roomId')):
        _sync(env, sort, bid)
    # 이전 항목(buildingId 없음)은 main으로 취급(schedules.py와 같은 규칙)
    gone = [s['id'] for s in common.list_schedules() if s.get('buildingId', buildings.DEFAULT) == bid]
    for sid in gone:
        common.delete_schedule(sid)
    owners = tenant.table('OWNERS_TABLE')
    owner = (owners.get_item(Key={'buildingId': bid}).get('Item') or {}).get('companyId')
    owners.delete_item(Key={'buildingId': bid})
    tenant.table('BUILDINGS_TABLE').delete_item(Key={'buildingId': bid})
    _refresh()
    # 변경 이력은 기업별이라 소속 없던 건물은 기록 안 함
    if owner:
        tenant.audit(owner, actor(event), 'building.delete', bid, {'name': b['name'], 'rooms': rooms, 'schedules': len(gone)})
    return common.resp(200, {'deleted': True})


def twin(event, context):
    """GET·PUT /buildings/{id}/twin: 조회는 plan.handler(소속 기업 구성원 허용), 확정 저장은 판매사 전용"""
    if event.get('routeKey', '').startswith('GET '):
        return plan.handler(event, context)
    if tenant.caller(event)['role'] != tenant.ADMIN:
        return common.resp(403, {'error': VENDOR_ONLY})
    return _stored(replace_twin)(event)


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
    'POST /admin/companies/{id}/buildings': _with_company(_stored(create_building)),
    'PATCH /admin/buildings/{id}': update_building,
    'DELETE /admin/buildings/{id}': _stored(delete_building),
}


def handler(event, context):
    if tenant.caller(event)['role'] != tenant.ADMIN:
        return common.resp(403, {'error': '관리자만 사용할 수 있습니다.'})
    fn = ROUTES.get(event.get('routeKey', ''))
    if not fn:
        return common.resp(404, {'error': '없는 경로입니다.'})
    return fn(event)
