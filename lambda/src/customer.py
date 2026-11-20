"""고객사 설정 API(판매사·고객사 구조 4단계, 2026-11-20 권한 분리)

- 기업 코드 가입: POST /me/join {code}. 로그인했고 소속 기업이 없는 사용자(admin 제외)
- 조회(구성원 전체): GET /company(기업 정보와 건물 카드, 기업 코드·구성원 목록 제외), GET /company/audit?limit=(최신순)
- 변경 차단: PATCH /company, PATCH·DELETE /company/members/{sub}, PATCH /buildings/{id}는 구성원에게 403(PUT /buildings/{id}/twin은 admin.twin)
  - 관리는 판매사 관리 API(admin.py)로 이동. 이전 화면 호환을 위해 경로는 유지
  - admin의 PATCH /buildings/{id}는 PATCH /admin/buildings/{id}와 같은 처리
- 구성원 허용 운영: AI 질의(query.py, ws.py), 대화 기록 조회·삭제(chat.py), 스케줄 저장·취소(schedules.py). 소속 건물 검사만 적용
- 중지 기업: /company*는 403(code COMPANY_SUSPENDED, tenant.require_active)
"""
import admin
import common
import signup
import tenant

NO_COMPANY = '소속된 기업이 없습니다.'
WRITES = ('PATCH /company', 'PATCH /company/members/{sub}', 'DELETE /company/members/{sub}', 'PATCH /buildings/{id}')


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
    out = admin.detail(c)
    return common.resp(200, {'company': {k: out['company'][k] for k in ('id', *admin.FIELDS, 'status')}, 'buildings': out['buildings']})


ROUTES = {
    'GET /company': get_company,
    'GET /company/audit': lambda e, ctx: admin.audit_list(e, ctx['companyId']),
}


def handler(event, context):
    key, ctx = event.get('routeKey', ''), tenant.caller(event)
    if key == 'POST /me/join':
        return join(event, ctx)
    if key in WRITES:
        if ctx['role'] != tenant.ADMIN:
            return common.resp(403, {'error': admin.VENDOR_ONLY})
        # admin은 소속 기업이 없어 기업·구성원 경로는 403, 기업 관리는 /admin/companies/{id}
        return admin.update_building(event) if key == 'PATCH /buildings/{id}' else common.resp(403, {'error': NO_COMPANY})
    fn = ROUTES.get(key)
    if not fn:
        return common.resp(404, {'error': '없는 경로입니다.'})
    if ctx['role'] not in admin.ROLES or not ctx['companyId']:
        return common.resp(403, {'error': NO_COMPANY})
    tenant.require_active(ctx)
    return fn(event, ctx)
