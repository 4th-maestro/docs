"""기업 소속 검사와 기업·구성원 저장소(판매사·고객사 구조 2단계)

- 호출자: HTTP API는 JWT 권한 부여자 claims(sub, cognito:groups), WebSocket은 REQUEST 권한 부여자 context(sub, groups)
- 역할: admin(판매사 총관리자, Cognito admin 그룹, 모든 건물), manager(고객사 관리자), operator(운영자). 고객사 역할은 MembersTable에서 읽음
- 건물 소속: BuildingOwnersTable(buildingId → companyId). 소속 기업이 없는 건물은 admin만 접근
- 캐시: 실행 환경별 60초(구성원, 건물 소속, 기업 상태). 역할·소속·상태 변경은 최대 60초 뒤 다른 실행 환경에 반영
- 중지 기업: 기업 status가 suspended면 구성원의 건물 API·/company API는 403(code COMPANY_SUSPENDED), GET /me는 허용, admin은 검사 안 함
- 검사 해제: 환경 변수 MEMBERS_TABLE이 없으면(로컬·테스트) 모든 건물 허용
- 가입 대기: MembersTable 키 pending#<소문자 이메일>, {companyId, ttl 2일}. 가입 전 검사가 쓰고 가입 확인 트리거가 구성원으로 전환
"""
import datetime as dt
import os
import re
import secrets
import string
import time
import uuid

TTL = 60
KST = dt.timezone(dt.timedelta(hours=9))
ADMIN = 'admin'
PENDING = 'pending#'
CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
CODE_DAYS = 30
FORBIDDEN = '이 건물에 접근할 권한이 없습니다.'
SUSPENDED = '서비스가 중지된 기업입니다. 판매사에 문의하십시오.'
_tables, _members, _owners, _emails, _status = {}, {}, {'at': 0.0, 'map': None}, {}, {}
_idp = None


class Forbidden(Exception):
    def __init__(self, message=FORBIDDEN, code=None):
        super().__init__(message)
        self.code = code

    def body(self):
        return {'error': str(self)} | ({'code': self.code} if self.code else {})


# 저장소 접근
# - 테이블 이름: 환경 변수(COMPANIES_TABLE, MEMBERS_TABLE, OWNERS_TABLE, AUDIT_TABLE), 테스트는 _tables에 가짜 테이블 등록

def enabled():
    return bool(os.environ.get('MEMBERS_TABLE'))


def table(env):
    name = os.environ[env]
    if name not in _tables:
        import boto3
        _tables[name] = boto3.resource('dynamodb').Table(name)
    return _tables[name]


def _all(op, **kw):
    out = []
    while True:
        r = op(**kw)
        out += r['Items']
        if 'LastEvaluatedKey' not in r:
            return out
        kw['ExclusiveStartKey'] = r['LastEvaluatedKey']


def scan(env):
    return _all(table(env).scan)


def query(env, index, attr, value):
    return _all(table(env).query, IndexName=index, KeyConditionExpression='#k = :v',
                ExpressionAttributeNames={'#k': attr}, ExpressionAttributeValues={':v': value})


def now():
    return dt.datetime.now(KST)


def stamp(t=None):
    return (t or now()).isoformat(timespec='seconds')


def company(cid):
    return table('COMPANIES_TABLE').get_item(Key={'companyId': str(cid or '')}).get('Item')


def company_members(cid):
    # 기업 보조 인덱스에는 가입 대기 항목도 포함되어 제외
    return [m for m in query('MEMBERS_TABLE', 'company-index', 'companyId', cid) if not m['sub'].startswith(PENDING)]


def company_buildings(cid):
    return [o['buildingId'] for o in query('OWNERS_TABLE', 'company-index', 'companyId', cid)]


def audit(cid, actor, action, target, detail=None):
    # 정렬 키 at: 밀리초 단위 시각(같은 초 안의 변경도 순서 유지) + uuid
    table('AUDIT_TABLE').put_item(Item={
        'companyId': cid, 'at': f"{now().isoformat(timespec='milliseconds')}#{uuid.uuid4()}",
        'actor': {k: actor.get(k) or '' for k in ('sub', 'email', 'role')},
        'action': action, 'target': target, 'detail': detail or {},
    })


# 기업 코드
# - 형식: EGE-XXXX-XXXX, 32자(혼동 문자 0·1·I·O 제외) 8자리, 약 1조 가지
# - 입력 정리: 대문자 변환, 공백·하이픈 제거 후 형식 확인
# - shortcut: 발급 시 기존 코드와 중복 확인 안 함(1조 가지 중 기업 수만큼), 기업 수가 수십만을 초과하면 발급 시 code-index 조회 추가

def new_code():
    s = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f'EGE-{s[:4]}-{s[4:]}'


def normalize_code(raw):
    s = re.sub(r'[\s-]', '', str(raw or '')).upper()
    return f'EGE-{s[3:7]}-{s[7:]}' if re.fullmatch(f'EGE[{CODE_ALPHABET}]{{8}}', s) else None


def new_company_id():
    return 'co-' + ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(8))


def code_fields(days=CODE_DAYS):
    return {'code': new_code(), 'codeExpiresAt': stamp(now() + dt.timedelta(days=days))}


def company_by_code(raw):
    """가입 가능한 기업: 코드 존재, 상태 active, 만료 전. 아니면 None"""
    code = normalize_code(raw)
    c = next(iter(query('COMPANIES_TABLE', 'code-index', 'code', code)), None) if code else None
    if not c or c.get('status') != 'active' or dt.datetime.fromisoformat(c['codeExpiresAt']) <= now():
        return None
    return c


# 호출자와 소속 검사

def _groups(raw):
    # HTTP API는 배열 클레임을 "[admin other]" 문자열로 전달, WebSocket context는 "admin other"
    return raw if isinstance(raw, list) else str(raw or '').strip('[]').replace(',', ' ').split()


def member(sub):
    if not (sub and enabled()):
        return None
    hit = _members.get(sub)
    if not hit or time.monotonic() - hit[0] > TTL:
        hit = _members[sub] = (time.monotonic(), table('MEMBERS_TABLE').get_item(Key={'sub': sub}).get('Item'))
    return hit[1]


def owners():
    """건물 → 소속 기업(60초 캐시)
    - shortcut: 테이블 전체 조회(건물 수십 개 규모), 건물이 수천 개를 초과하면 기업 보조 인덱스 조회로 교체
    """
    if _owners['map'] is None or time.monotonic() - _owners['at'] > TTL:
        # 소속 없이 수정 정보(overrides)만 있는 항목은 제외
        _owners.update(at=time.monotonic(), map={o['buildingId']: o['companyId'] for o in scan('OWNERS_TABLE') if o.get('companyId')})
    return _owners['map']


def company_status(cid):
    hit = _status.get(cid)
    if not hit or time.monotonic() - hit[0] > TTL:
        hit = _status[cid] = (time.monotonic(), (company(cid) or {}).get('status'))
    return hit[1]


def forget():
    """관리 API가 소속·구성원·기업 상태를 바꾼 뒤 같은 실행 환경의 캐시 비움"""
    _members.clear()
    _status.clear()
    _owners['map'] = None


def caller(event):
    """{sub, role(admin·manager·operator·None), companyId, email}"""
    a = (event.get('requestContext') or {}).get('authorizer') or {}
    c = (a.get('jwt') or {}).get('claims') or {}
    sub = c.get('sub') or a.get('sub')
    if ADMIN in _groups(c.get('cognito:groups') if c else a.get('groups')):
        return {'sub': sub, 'role': ADMIN, 'companyId': None, 'email': None}
    m = member(sub) or {}
    return {'sub': sub, 'role': m.get('role'), 'companyId': m.get('companyId'), 'email': m.get('email')}


def require_active(ctx):
    """소속 기업이 중지 상태면 Forbidden(COMPANY_SUSPENDED). admin과 소속 없는 사용자는 통과"""
    if ctx['role'] != ADMIN and ctx['companyId'] and company_status(ctx['companyId']) == 'suspended':
        raise Forbidden(SUSPENDED, 'COMPANY_SUSPENDED')


def allowed_buildings(ctx):
    """접근 가능한 건물 id 집합. None은 전체(admin, 검사 해제). 중지 기업 구성원은 Forbidden"""
    if not enabled() or ctx['role'] == ADMIN:
        return None
    if not ctx['companyId']:
        return set()
    require_active(ctx)
    return {b for b, c in owners().items() if c == ctx['companyId']}


def require_building(event, bid):
    allowed = allowed_buildings(caller(event))
    if allowed is not None and bid not in allowed:
        raise Forbidden()


def can_edit(ctx, bid):
    """건물·도면 수정 권한: admin, 또는 소속 기업의 고객사 관리자"""
    if not enabled() or ctx['role'] == ADMIN:
        return True
    require_active(ctx)
    return ctx['role'] == 'manager' and bool(ctx['companyId']) and owners().get(bid) == ctx['companyId']


def email(sub):
    """Cognito 이메일(액세스 토큰에 이메일 클레임 없음). 사용자 풀이 없으면 None"""
    pool = os.environ.get('USER_POOL_ID')
    if not (sub and pool):
        return None
    if sub not in _emails:
        global _idp
        if _idp is None:
            import boto3
            _idp = boto3.client('cognito-idp')
        users = _idp.list_users(UserPoolId=pool, Filter=f'sub = "{sub}"', Limit=1)['Users']
        _emails[sub] = next((a['Value'] for u in users for a in u.get('Attributes', []) if a['Name'] == 'email'), None)
    return _emails[sub]


def me(event, context):
    """GET /me: {email, role, company: {id, name, status} | None}. 중지 기업 구성원도 조회 가능"""
    # 가입 트리거 함수가 common·buildings를 불러오지 않도록 함수 안에서 import
    import common
    ctx = caller(event)
    c = company(ctx['companyId']) if ctx['companyId'] else None
    return common.resp(200, {
        'email': ctx['email'] or email(ctx['sub']), 'role': ctx['role'],
        'company': {'id': c['companyId'], 'name': c['name'], 'status': c.get('status', 'active')} if c else None,
    })
