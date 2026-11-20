"""HTTP 응답과 일정 저장소(DynamoDB) 공통 함수"""
import json
import os

import buildings
import tenant

TABLE_NAME = os.environ.get('SCHEDULES_TABLE')


def sched_key(schedules, room_ids):
    """캐시 키: 대상 호실이 포함된 스케줄만 직렬화. 스케줄 저장·취소 시 키가 바뀌어 자동 재계산"""
    ids = set(room_ids)
    return json.dumps([s for s in schedules if ids & set(s.get('roomIds', []))], sort_keys=True, default=str)


def resp(status, body):
    return {'statusCode': status, 'headers': {'content-type': 'application/json'}, 'body': json.dumps(body, ensure_ascii=False, default=str)}


def body(event):
    try:
        return json.loads(event.get('body') or '{}')
    except (json.JSONDecodeError, RecursionError):  # 깊은 중첩 JSON도 형식 오류로 처리
        return None


def building(event):
    """GET 쿼리 building의 건물. 없으면 main, 알 수 없으면 ValueError(호출 측에서 400), 소속 밖이면 tenant.Forbidden(403)"""
    b = buildings.get((event.get('queryStringParameters') or {}).get('building'))
    tenant.require_building(event, b['id'])
    return b


def bad_building(e):
    return resp(400, {'error': str(e)})


def _table():
    import boto3
    return boto3.resource('dynamodb').Table(TABLE_NAME)


def list_schedules():
    # 로컬 실행처럼 테이블이 없으면 스케줄 없이 동작
    if not TABLE_NAME:
        return []
    items = _table().scan().get('Items', [])
    for s in items:
        if 'setpoint' in s:
            s['setpoint'] = float(s['setpoint'])
    return sorted(items, key=lambda s: s.get('createdAt', ''))


def put_schedule(item):
    from decimal import Decimal
    _table().put_item(Item={k: Decimal(str(v)) if isinstance(v, float) else v for k, v in item.items()})


def delete_schedule(sid):
    # 삭제한 항목이 있으면 True, 테이블이 없는 로컬 실행은 항상 없음
    if not TABLE_NAME:
        return False
    return 'Attributes' in _table().delete_item(Key={'id': sid}, ReturnValues='ALL_OLD')
