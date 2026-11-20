"""가입 허용 목록(DynamoDB ALLOW_TABLE, 키 entry)

- entry: 개별 이메일(kim@company.com) 또는 도메인(@company.com), 모두 소문자
- 가입 전 검사(signup.py)와 관리자 API(admin.py) 공용
"""
import os
import re

TABLE = os.environ.get('ALLOW_TABLE')
EMAIL = re.compile(r'^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$')
DOMAIN = re.compile(r'^@[a-z0-9.-]+\.[a-z]{2,}$')
_table = None


def _t():
    # boto3는 Lambda 런타임 기본 포함, 로컬 테스트(boto3 없음)에서는 테이블 함수를 대체해 사용
    global _table
    if _table is None and TABLE:
        import boto3
        _table = boto3.resource('dynamodb').Table(TABLE)
    return _table


def normalize(entry):
    """입력값 검증: 소문자로 바꾼 이메일 또는 @도메인, 형식이 아니면 None"""
    e = str(entry or '').strip().lower()
    return e if len(e) <= 254 and (EMAIL.match(e) or DOMAIN.match(e)) else None


def candidates(email):
    """이메일이 허용되는 항목 후보: 이메일 자체와 그 도메인"""
    e = str(email or '').strip().lower()
    return [e, '@' + e.rsplit('@', 1)[-1]] if EMAIL.match(e) else []


def allowed(email, lookup=None):
    keys = candidates(email)
    if not keys:
        return False
    lookup = lookup or (lambda k: 'Item' in _t().get_item(Key={'entry': k}))
    return any(lookup(k) for k in keys)


def items():
    t, out, kw = _t(), [], {}
    while True:
        r = t.scan(**kw)
        out += r['Items']
        if 'LastEvaluatedKey' not in r:
            return sorted(out, key=lambda x: (not x['entry'].startswith('@'), x['entry']))
        kw['ExclusiveStartKey'] = r['LastEvaluatedKey']


def put(entry, note, by, at):
    _t().put_item(Item={'entry': entry, 'note': note, 'addedBy': by, 'addedAt': at})


def delete(entry):
    return 'Attributes' in _t().delete_item(Key={'entry': entry}, ReturnValues='ALL_OLD')
