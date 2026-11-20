"""HTTP 응답과 일정 저장소(DynamoDB) 공통 함수"""
import json
import os

TABLE_NAME = os.environ.get('SCHEDULES_TABLE')


def resp(status, body):
    return {'statusCode': status, 'headers': {'content-type': 'application/json'}, 'body': json.dumps(body, ensure_ascii=False, default=str)}


def body(event):
    try:
        return json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return None


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
