"""고객사 설정 API(판매사·고객사 구조 4단계)

- 기업 코드 가입: POST /me/join {code}. 로그인했고 소속 기업이 없는 사용자(admin 제외)
- 기업: GET /company(구성원 전체, 코드·구성원 목록은 manager만), PATCH /company(manager, status 제외)
- 구성원: PATCH·DELETE /company/members/{sub}(manager), 관리자(manager) 최소 1명
- 변경 이력: GET /company/audit?limit=(구성원 전체, 최신순)
- 건물 정보: PATCH /buildings/{id}(admin 또는 소속 기업 manager) {name, use, hours, weekend} 일부. 도면·층·호실은 수정 대상 아님
- 중지 기업: /company*, PATCH /buildings는 403(code COMPANY_SUSPENDED, tenant.require_active)
"""
import admin
import buildings
import common
import signup
import tenant

NO_COMPANY = '소속된 기업이 없습니다.'
MANAGER_ONLY = '고객사 관리자만 사용할 수 있습니다.'
# 건물 정보 문자열 필드: (최대 글자 수, 이름)
TEXT = {'name': (40, '건물 이름'), 'use': (20, '건물 용도')}


def join(event, ctx):
    if ctx['role'] == tenant.ADMIN:
        return common.resp(403, {'error': '판매사 총관리자 계정은 기업에 가입할 수 없습니다.'})
    members = tenant.table('MEMBERS_TABLE')
    # 캐시(60초) 대신 테이블을 직접 읽어 방금 해제된 구성원도 다시 가입 가능
    if members.get_item(Key={'sub': ctx['sub']}).get('Item'):
        return common.resp(409, {'error': '이미 소속된 기업이 있습니다.'})
    req = common.body(event)
    c = tenant.company_by_code(req.get('code') if isinstance(req, dict) else None)
    if not c:
        return common.resp(400, {'error': signup.INVALID})
    cid, email = c['companyId'], str(ctx['email'] or tenant.email(ctx['sub']) or '').lower()
    # shortcut: 가입 확인 트리거와 같이 첫 구성원 동시 가입 시 manager 2명 가능, 가입이 잦아지면 조건부 쓰기로 교체
    m = {'sub': ctx['sub'], 'companyId': cid, 'email': email,
         'role': 'operator' if tenant.company_members(cid) else 'manager', 'joinedAt': tenant.stamp()}
    members.put_item(Item=m)
    tenant.forget()
    tenant.audit(cid, m, 'member.join', m['sub'], {'email': email, 'role': m['role']})
    return common.resp(200, {'company': {'id': cid, 'name': c['name'], 'status': c.get('status', 'active')}, 'role': m['role']})


def get_company(event, ctx):
    c = tenant.company(ctx['companyId'])
    if not c:
        return common.resp(403, {'error': NO_COMPANY})
    out = admin.detail(c, admin.CARD + ('hours', 'weekend'))
    if ctx['role'] != 'manager':
        out.pop('members')
        for k in ('code', 'codeExpiresAt'):
            out['company'].pop(k)
    return common.resp(200, out)


def update_company(event, ctx):
    req = common.body(event)
    if isinstance(req, dict) and 'status' in req:
        return common.resp(400, {'error': '기업 상태는 판매사만 변경할 수 있습니다.'})
    return admin.update_company(event, ctx['companyId'])


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


def update_building(event, ctx):
    try:
        b = buildings.get((event.get('pathParameters') or {}).get('id'))
    except ValueError as e:
        return common.bad_building(e)
    if not tenant.can_edit(ctx, b['id']):
        return common.resp(403, {'error': '건물 정보를 수정할 권한이 없습니다.'})
    fields, err = building_fields(common.body(event))
    if err:
        return common.resp(400, {'error': err})
    changed = {k: v for k, v in fields.items() if b[k] != v}
    if changed:
        owners = tenant.table('OWNERS_TABLE')
        # 소속 없는 건물(admin 수정)은 수정 정보만 있는 항목 생성
        item = owners.get_item(Key={'buildingId': b['id']}).get('Item') or {'buildingId': b['id']}
        item['overrides'] = {**(item.get('overrides') or {}), **changed}
        owners.put_item(Item=item)
        buildings.forget()
        # 변경 이력은 기업별이라 소속 없는 건물은 기록 안 함
        if item.get('companyId'):
            tenant.audit(item['companyId'], admin.actor(event), 'building.update', b['id'],
                         {'before': {k: b[k] for k in changed}, 'after': changed})
    return common.resp(200, {'building': buildings.summary(buildings.get(b['id']))})


def _sub(event):
    return (event.get('pathParameters') or {}).get('sub')


# 경로 → (처리 함수, manager 전용 여부)
ROUTES = {
    'GET /company': (get_company, False),
    'PATCH /company': (update_company, True),
    'PATCH /company/members/{sub}': (lambda e, ctx: admin.set_role(e, ctx['companyId'], _sub(e)), True),
    'DELETE /company/members/{sub}': (lambda e, ctx: admin.remove_member(e, ctx['companyId'], _sub(e)), True),
    'GET /company/audit': (lambda e, ctx: admin.audit_list(e, ctx['companyId']), False),
}


def handler(event, context):
    key, ctx = event.get('routeKey', ''), tenant.caller(event)
    if key == 'POST /me/join':
        return join(event, ctx)
    if key == 'PATCH /buildings/{id}':
        return update_building(event, ctx)
    fn, manager_only = ROUTES.get(key, (None, False))
    if not fn:
        return common.resp(404, {'error': '없는 경로입니다.'})
    if ctx['role'] not in admin.ROLES or not ctx['companyId']:
        return common.resp(403, {'error': NO_COMPANY})
    tenant.require_active(ctx)
    if manager_only and ctx['role'] != 'manager':
        return common.resp(403, {'error': MANAGER_ONLY})
    return fn(event, ctx)
