"""사용자 관리 API(관리자 그룹 전용)

- GET /admin/allow: 허용 목록, POST /admin/allow {entry, note}: 추가, DELETE /admin/allow/{entry}: 삭제
- GET /admin/users: 가입한 사용자(이메일, 상태, 관리자 여부, 가입일)
- 관리자 판정: 액세스 토큰 cognito:groups 클레임에 admin 포함(HTTP API JWT 권한 부여자가 서명 검증)
"""
import datetime as dt
import os
import urllib.parse

import allow
import common

POOL_ID = os.environ.get('USER_POOL_ID', '')
ADMIN = 'admin'
_idp = None


def _client():
    global _idp
    if _idp is None:
        import boto3
        _idp = boto3.client('cognito-idp')
    return _idp


def claims(event):
    return ((event.get('requestContext') or {}).get('authorizer') or {}).get('jwt', {}).get('claims', {})


def is_admin(event):
    # HTTP API는 배열 클레임을 "[admin other]" 문자열로 전달
    raw = claims(event).get('cognito:groups', '')
    groups = raw if isinstance(raw, list) else str(raw).strip('[]').replace(',', ' ').split()
    return ADMIN in groups


def users():
    admins, out, kw = set(), [], {'UserPoolId': POOL_ID, 'Limit': 60}
    gk = {'UserPoolId': POOL_ID, 'GroupName': ADMIN, 'Limit': 60}
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


def handler(event, context):
    if not is_admin(event):
        return common.resp(403, {'error': '관리자만 사용할 수 있습니다.'})
    method = event['requestContext']['http']['method']
    path = event.get('rawPath', '')
    if path.endswith('/admin/users'):
        return common.resp(200, {'users': users()})
    if method == 'GET':
        return common.resp(200, {'entries': allow.items()})
    if method == 'POST':
        req = common.body(event) or {}
        entry = allow.normalize(req.get('entry'))
        if not entry:
            return common.resp(400, {'error': '이메일(kim@company.com) 또는 도메인(@company.com) 형식으로 입력하십시오.'})
        note = str(req.get('note') or '')[:100]
        at = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec='seconds')
        allow.put(entry, note, claims(event).get('username', ''), at)
        return common.resp(201, {'entry': entry, 'note': note, 'addedAt': at})
    if method == 'DELETE':
        entry = allow.normalize(urllib.parse.unquote((event.get('pathParameters') or {}).get('entry', '')))
        if not entry:
            return common.resp(400, {'error': '삭제할 항목 형식이 잘못되었습니다.'})
        if not allow.delete(entry):
            return common.resp(404, {'error': '허용 목록에 없는 항목입니다.'})
        return common.resp(200, {'entry': entry, 'deleted': True})
    return common.resp(405, {'error': '지원하지 않는 요청입니다.'})
