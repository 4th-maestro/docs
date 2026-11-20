"""챗봇 자동 운영 조회와 실행 초안. 이 모듈은 DynamoDB에 쓰지 않는다."""
import datetime as dt
import functools
import os
from collections import Counter

import chat
import sim

DONE = {'applied', 'accepted', 'rejected', 'reverted', 'expired'}


@functools.lru_cache(maxsize=4)
def _resource():
    import boto3
    return boto3.resource('dynamodb')


def _settings(name, bid):
    return _resource().Table(name).get_item(Key={'buildingId': bid}).get('Item') or {}


def _recent(name, bid, since):
    from boto3.dynamodb.conditions import Key
    pages = _resource().meta.client.get_paginator('query').paginate(
        TableName=name,
        KeyConditionExpression=Key('buildingId').eq(bid) & Key('decisionId').gte(since.strftime('%Y%m%dT%H%M')),
        ScanIndexForward=False,
    )
    return [chat._plain(item) for page in pages for item in page.get('Items', [])]


def _timestamp(value):
    t = dt.datetime.fromisoformat(value)
    return t if t.tzinfo else t.replace(tzinfo=sim.KST)


def _integer(args, key, default, upper):
    value = args.get(key, default)
    if type(value) is not int or not 1 <= value <= upper:
        raise ValueError(f'{key}는 1~{upper} 정수')
    return value


def run(name, args, t, bid):
    hours = _integer(args, 'hours', 24, 24) if name == 'list_operations' else 24
    limit = _integer(args, 'limit', 10, 20) if name == 'list_operations' else None
    status = args.get('status', 'pending')
    action, scope = args.get('action'), args.get('scope', 'latest')
    if name == 'list_operations' and status not in ('pending', 'done', 'alert', 'all'):
        raise ValueError('status는 pending, done, alert, all 중 하나')
    if name == 'operations_action' and (action not in ('accept', 'reject', 'undo') or scope not in ('latest', 'all')):
        raise ValueError('action은 accept, reject, undo / scope는 latest, all 중 하나')
    decisions, settings = os.environ.get('DECISIONS_TABLE'), os.environ.get('OPS_SETTINGS_TABLE')
    if not decisions or not settings:
        return {'available': False, 'message': '자동 운영 정보를 사용할 수 없음'}, {}
    t = t.astimezone(sim.KST)
    since = t - dt.timedelta(hours=hours)
    rows = []
    for item in _recent(decisions, bid, since):
        if item.get('status') == 'skipped':
            continue
        # 정렬 키는 분 단위이므로 경계의 초 단위는 createdAt으로 확인한다.
        if not since <= _timestamp(item['createdAt']) <= t:
            continue
        if args.get('floor', 'all') not in ('all', item.get('floor')) or args.get('use', 'all') not in ('all', item.get('use')):
            continue
        item = dict(item)
        if item['status'] == 'pending' and item.get('expiresAt') and _timestamp(item['expiresAt']) <= t:
            item['status'] = 'expired'
        rows.append(item)
    rows.sort(key=lambda r: (r['createdAt'], r['decisionId']), reverse=True)
    if name == 'operations_action':
        eligible = {'applied', 'accepted'} if action == 'undo' else {'pending'}
        rows = [r for r in rows if r['status'] in eligible]
        if scope == 'latest':
            rows = rows[:1]
        if not rows:
            return {'count': 0, 'message': '되돌릴 수 있는 조치가 없어요' if action == 'undo' else '응답 대기 중인 제안이 없어요'}, {}
        draft = {'action': action, 'buildingId': bid, 'decisionIds': [r['decisionId'] for r in rows], 'rooms': [r['roomName'] for r in rows]}
        return {'count': len(rows), 'rooms': draft['rooms'], 'executed': False, 'message': '초안입니다. 화면 카드에서 실행을 확인하세요.'}, {'opsDraft': draft, 'highlight': list(dict.fromkeys(r['roomId'] for r in rows))}
    pending = sum(r['status'] == 'pending' for r in rows)
    rows = [r for r in rows if status == 'all' or (r['status'] in DONE if status == 'done' else r['status'] == status)]
    counts = dict(Counter(r['status'] for r in rows))
    items = []
    for r in rows[:limit]:
        item = {k: r[k] for k in ('decisionId', 'roomId', 'floor', 'use', 'status', 'message', 'createdAt')}
        if r.get('decidedAt'):
            item['decidedAt'] = r['decidedAt']
        item['room'] = r['roomName']
        item['facts'] = r.get('evidence', {}).get('facts', {})
        if r.get('jev'):
            item['jev'] = {**r['jev'], 'emptyProb': (r['jev'].get('probabilities') or {}).get('empty')}
        if r['status'] == 'pending' and r.get('expiresAt'):
            item['expiresInMin'] = max(0, int((_timestamp(r['expiresAt']) - t).total_seconds() // 60))
        items.append(item)
    return {'available': True, 'autoApply': bool(_settings(settings, bid).get('autoApply', False)), 'pendingCount': pending,
            'totalCount': len(rows), 'statusCounts': counts,
            'todayStatusCounts': dict(Counter(r['status'] for r in rows if _timestamp(r.get('decidedAt') or r['createdAt']).astimezone(sim.KST).date() == t.date())), 'hours': hours, 'since': since.isoformat(),
            'truncated': len(rows) > limit, 'items': items}, {'highlight': list(dict.fromkeys(r['roomId'] for r in items))}
