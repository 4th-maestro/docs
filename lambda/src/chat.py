"""대화 기록과 대화 메모리(DynamoDB CHAT_TABLE, 키 pk·sk)

- 기록: pk=chat#<사용자>#<건물>, sk=<ISO 시각>#<순번>, 90일 뒤 자동 삭제(ttl)
- 메모리: pk=mem#<사용자>#<건물>, sk=mem, 24시간 뒤 자동 삭제. 원문 대화 대신 모델에 넘기는 요약(최근 10턴, 8KB 이하)
- GET /chat?building=: 최근 30개(오래된 순), DELETE /chat?building=: 기록과 메모리 삭제
"""
import datetime as dt
import json
import os
import time
from decimal import Decimal

import buildings
import common
import tenant

TABLE = os.environ.get('CHAT_TABLE')
HISTORY_DAYS = 90
MEMORY_HOURS = 24
MEMORY_TURNS = 10  # 되묻기가 여러 턴 이어져도 처음 요청 유지(2026-11-20)
MEMORY_BYTES = 8192  # 턴당 질문 100자·답변 150자(한글 3바이트) × 10턴 + 조건·초안
LIMIT = 30
_table = None


def _t():
    # boto3는 Lambda 런타임 기본 포함, 로컬 테스트(boto3 없음)에서는 호출되지 않음
    global _table
    if _table is None and TABLE:
        import boto3
        _table = boto3.resource('dynamodb').Table(TABLE)
    return _table


def _key(pk):
    from boto3.dynamodb.conditions import Key
    return Key('pk').eq(pk)


def user(event):
    # 사용자 sub: HTTP API는 JWT 권한 부여자 claims, WebSocket은 REQUEST 권한 부여자 context
    a = (event.get('requestContext') or {}).get('authorizer') or {}
    return (a.get('jwt') or {}).get('claims', {}).get('sub') or a.get('sub')


def _dec(v):
    return json.loads(json.dumps(v), parse_float=Decimal)


def _plain(v):
    return json.loads(json.dumps(v, default=lambda d: int(d) if d == int(d) else float(d)))


def append(sub, bid, messages):
    # messages: [{role: 'user'|'assistant', text, steps?, highlight?, draft?}]
    if not (sub and _t()):
        return
    ttl = int(time.time()) + HISTORY_DAYS * 86400
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')
    with _t().batch_writer() as w:
        for i, m in enumerate(messages):
            w.put_item(Item={'pk': f'chat#{sub}#{bid}', 'sk': f'{now}#{i}', 'ttl': ttl, **_dec(m)})


def history(sub, bid, limit=LIMIT):
    if not (sub and _t()):
        return []
    r = _t().query(KeyConditionExpression=_key(f'chat#{sub}#{bid}'), ScanIndexForward=False, Limit=limit)
    return [_plain({k: v for k, v in it.items() if k not in ('pk', 'ttl')}) for it in reversed(r['Items'])]


def get_memory(sub, bid):
    if not (sub and _t()):
        return None
    it = _t().get_item(Key={'pk': f'mem#{sub}#{bid}', 'sk': 'mem'}).get('Item')
    # TTL 삭제는 최대 수십 분 지연되므로 만료 시각을 직접 확인
    return _plain(it['memory']) if it and it['ttl'] > time.time() else None


def put_memory(sub, bid, memory):
    if sub and _t():
        _t().put_item(Item={'pk': f'mem#{sub}#{bid}', 'sk': 'mem', 'ttl': int(time.time()) + MEMORY_HOURS * 3600, 'memory': _dec(memory)})


def make_memory(prev, text, result):
    # 질의 결과로 메모리 갱신: 최근 10턴 질문·답변 앞부분, 마지막 조건·대상 호실·초안
    prev = prev or {}
    query = next((s for s in result.get('steps') or [] if s.get('id') == 'query'), {})
    d = result.get('draft')
    # 이전 형식(lastQuestion·lastAnswer, 2026-11-20 이전) 메모리는 첫 턴으로 이어받음
    turns = prev.get('turns') or ([{'q': prev['lastQuestion'], 'a': prev.get('lastAnswer', '')}] if prev.get('lastQuestion') else [])
    mem = {
        'turns': (turns + [{'q': text[:100], 'a': (result.get('answer') or '')[:150]}])[-MEMORY_TURNS:],
        'conditions': query.get('chips') or prev.get('conditions') or [],
        'targetRoomIds': (result.get('highlight') or [])[:30],
        # 되묻기 턴(초안 없음)은 직전 초안 유지: "15:30" 같은 짧은 답을 초안 수정으로 해석
        # 호실 이름 선택 초안은 이름(최대 10개)도 보관: "15:30으로" 같은 수정 요청에서 같은 호실로 재호출
        'draft': {k: d[k] for k in ('floor', 'use', 'action', 'time', 'condition', 'setpoint')} | {'targets': len(d['roomIds'])}
                 | ({'rooms': d['roomNames']} if d.get('pick') == 'rooms' else {}) if d else prev.get('draft'),
        'lastSchedule': prev.get('lastSchedule'),
    }
    # 8KB 상한: 대상 호실 → 오래된 턴 순으로 축소
    size = lambda: len(json.dumps(mem, ensure_ascii=False).encode())  # noqa: E731
    while size() > MEMORY_BYTES and mem['targetRoomIds']:
        mem['targetRoomIds'] = mem['targetRoomIds'][: len(mem['targetRoomIds']) // 2]
    while size() > MEMORY_BYTES and len(mem['turns']) > 1:
        mem['turns'].pop(0)
    return mem


def clear(sub, bid):
    if not (sub and _t()):
        return 0
    n = 0
    for pk in (f'chat#{sub}#{bid}', f'mem#{sub}#{bid}'):
        kw = {'KeyConditionExpression': _key(pk), 'ProjectionExpression': 'pk, sk'}
        while True:
            r = _t().query(**kw)
            with _t().batch_writer() as w:
                for it in r['Items']:
                    w.delete_item(Key={'pk': it['pk'], 'sk': it['sk']})
                    n += 1
            if 'LastEvaluatedKey' not in r:
                break
            kw['ExclusiveStartKey'] = r['LastEvaluatedKey']
    return n


def handler(event, context):
    sub = user(event)
    if not sub:
        return common.resp(401, {'error': '로그인이 필요합니다.'})
    bid = (event.get('queryStringParameters') or {}).get('building') or buildings.DEFAULT
    try:
        buildings.get(bid)
    except ValueError as e:
        return common.resp(400, {'error': str(e)})
    tenant.require_building(event, bid)
    if event['requestContext']['http']['method'] == 'DELETE':
        return common.resp(200, {'deleted': clear(sub, bid)})
    return common.resp(200, {'building': bid, 'messages': history(sub, bid), 'memory': get_memory(sub, bid)})
