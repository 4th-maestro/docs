"""③ 자동 운영 공용: 설정·결정 저장소, 스케줄 저장, 제안 문구

- 설정(OPS_SETTINGS_TABLE, 키 buildingId): {autoApply(bool, 기본 False), updatedAt, updatedBy}
- 결정(DECISIONS_TABLE, 키 buildingId / decisionId): 제안·자동 조치·알림 기록, ttl 30일
  - decisionId: "<YYYYMMDDTHHMM>-<8자리 hex>"(시각순 정렬, URL 안전)
  - kind: idle(빈 방 운전) · setpoint(과냉·과열 설정, 규칙 기반 설정온도 조정) · anomaly(설정온도 미도달)
          · power(평소 같은 요일·시각 대비 전력 이상: unusual_hours, power_high)
  - status: pending(제안, 응답 대기) · applied(자동 조치) · accepted(제안 수락) · rejected(거절) · reverted(자동 조치 되돌림)
            · expired(응답 없이 만료) · skipped(Jev가 재실로 판단, 조치 없음) · alert(이상 알림)
- 스케줄: SchedulesTable(maestro 스택)에 schedules.py POST와 같은 형식으로 저장, sourceText 앞머리 "자동 운영"으로 사람이 만든 스케줄과 구분
"""
import datetime as dt
import os
import uuid
from decimal import Decimal

HISTORY_DAYS = 30
ACTIVE = ('pending', 'applied', 'accepted')
COOLDOWN = ('rejected', 'reverted', 'skipped', 'alert')
SOURCE = '자동 운영'

_tables = {}


def table(env):
    name = os.environ[env]
    if name not in _tables:
        import boto3
        _tables[name] = boto3.resource('dynamodb').Table(name)
    return _tables[name]


def env_int(name, default):
    return int(os.environ.get(name, default))


def env_float(name, default):
    return float(os.environ.get(name, default))


def ddb(v):
    # DynamoDB 숫자는 Decimal(float 불가). dict·list 안쪽까지 변환
    if isinstance(v, float):
        return Decimal(str(v))
    if isinstance(v, dict):
        return {k: ddb(x) for k, x in v.items()}
    if isinstance(v, list):
        return [ddb(x) for x in v]
    return v


def plain(v):
    # Decimal → int·float(JSON 응답용)
    if isinstance(v, Decimal):
        return int(v) if v == int(v) else float(v)
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [plain(x) for x in v]
    return v


def new_decision_id(t):
    return f"{t.strftime('%Y%m%dT%H%M')}-{uuid.uuid4().hex[:8]}"


def id_from(t):
    """이 시각 이후 결정만 조회할 때 쓰는 정렬 키 하한"""
    return t.strftime('%Y%m%dT%H%M')


# 설정

def get_settings(bid):
    item = table('OPS_SETTINGS_TABLE').get_item(Key={'buildingId': bid}).get('Item') or {}
    return {'buildingId': bid, 'autoApply': bool(item.get('autoApply', False)),
            'updatedAt': item.get('updatedAt'), 'updatedBy': item.get('updatedBy')}


def put_settings(bid, auto_apply, by, t):
    item = {'buildingId': bid, 'autoApply': bool(auto_apply), 'updatedAt': t.isoformat(), 'updatedBy': by}
    table('OPS_SETTINGS_TABLE').put_item(Item=item)
    return item


# 결정

def recent_decisions(bid, since):
    """since 이후 생성된 결정(오래된 순)"""
    t = table('DECISIONS_TABLE')
    kw = {'KeyConditionExpression': '#b = :b AND #d >= :d',
          'ExpressionAttributeNames': {'#b': 'buildingId', '#d': 'decisionId'},
          'ExpressionAttributeValues': {':b': bid, ':d': id_from(since)}}
    items = []
    while True:
        r = t.query(**kw)
        items += r['Items']
        if 'LastEvaluatedKey' not in r:
            return [plain(i) for i in items]
        kw['ExclusiveStartKey'] = r['LastEvaluatedKey']


def get_decision(bid, did):
    item = table('DECISIONS_TABLE').get_item(Key={'buildingId': bid, 'decisionId': did}).get('Item')
    return plain(item) if item else None


def put_decision(item):
    table('DECISIONS_TABLE').put_item(Item=ddb(item))


def update_status(bid, did, status, t, by=None, extra=None, expect='pending'):
    """조건부 상태 변경(동시에 두 명이 수락·거절해도 한 번만 반영). 실패하면 False"""
    from botocore.exceptions import ClientError
    fields = {'status': status, 'decidedAt': t.isoformat(), **({'decidedBy': by} if by else {}), **(extra or {})}
    names = {f'#k{i}': k for i, k in enumerate(fields)}
    values = {f':v{i}': ddb(v) for i, v in enumerate(fields.values())}
    try:
        table('DECISIONS_TABLE').update_item(
            Key={'buildingId': bid, 'decisionId': did},
            UpdateExpression='SET ' + ', '.join(f'#k{i} = :v{i}' for i in range(len(fields))),
            ConditionExpression='#s0 = :expect',
            ExpressionAttributeNames={**names, '#s0': 'status'},
            ExpressionAttributeValues={**values, ':expect': expect})
        return True
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return False
        raise


def is_expired(d, t):
    return d.get('status') == 'pending' and d.get('expiresAt') and d['expiresAt'] <= t.isoformat()


def blocked_rooms(decisions, t, cooldown_min):
    """새 제안을 만들지 않을 호실: 진행 중(pending 미만료·applied·accepted) 또는 쿨다운 중(거절·되돌림·재실 판단·알림)"""
    edge = (t - dt.timedelta(minutes=cooldown_min)).isoformat()
    out = set()
    for d in decisions:
        s = d.get('status')
        if s in ACTIVE and not is_expired(d, t):
            out.add((d['kind'], d['roomId']))
        elif s in COOLDOWN and (d.get('decidedAt') or d.get('createdAt', '')) >= edge:
            out.add((d['kind'], d['roomId']))
    return out


# 스케줄

def off_schedule(bid, room_id, t, reason):
    """빈 방 끄기 스케줄(schedules.py POST 형식). condition=unused: 재실이 생기면 적용 안 됨"""
    return {
        'id': str(uuid.uuid4()), 'buildingId': bid, 'roomIds': [room_id], 'action': 'off', 'time': t.strftime('%H:%M'),
        'condition': 'unused', 'createdAt': t.isoformat(), 'sourceText': f'{SOURCE}: {reason}'[:500],
    }


def setpoint_schedule(bid, room_id, target, t, reason):
    """설정온도 조정 스케줄(schedules.py POST 형식). recommend.py 'overset' 초안과 같이 00:00·always: 매일 하루 전체 적용"""
    return {
        'id': str(uuid.uuid4()), 'buildingId': bid, 'roomIds': [room_id], 'action': 'setpoint', 'setpoint': float(target),
        'time': '00:00', 'condition': 'always', 'createdAt': t.isoformat(), 'sourceText': f'{SOURCE}: {reason}'[:500],
    }


def decision_schedule(d, t, reason):
    """결정 종류에 맞는 스케줄: setpoint는 근거의 목표 설정온도, 그 외(idle)는 끄기"""
    if d.get('kind') == 'setpoint':
        return setpoint_schedule(d['buildingId'], d['roomId'], d['evidence']['target'], t, reason)
    return off_schedule(d['buildingId'], d['roomId'], t, reason)


def save_schedule(item):
    import common
    common.put_schedule(item)


def delete_schedule(sid):
    import common
    return common.delete_schedule(sid)


# 문구

def duration(minutes, capped=False):
    """'30분째', '1시간 15분째', 조회 상한을 넘으면 '3시간 넘게'"""
    if capped:
        return f'{minutes // 60}시간 넘게'
    h, m = divmod(minutes, 60)
    return f"{h}시간 {m}분째" if h and m else f"{h}시간째" if h else f"{m}분째"


def idle_message(room, label, power_kw):
    return f"{room['floor']} {room['name']}: {label} 재실 0명인데 냉난방이 켜져 있어요({power_kw}kW). 끌까요?"


def applied_message(room, label):
    return f"{room['floor']} {room['name']}: {label} 재실 0명이라 냉난방을 껐어요. 필요하면 되돌릴 수 있어요."


MODE_LABEL = {'cooling': '냉방', 'heating': '난방'}


def _num(v):
    return f'{v:g}'


def setpoint_message(room, ev):
    mode, sp, target = MODE_LABEL.get(ev['mode'], ev['mode']), ev['setpoint'], ev['target']
    side = '낮아요' if ev['mode'] == 'cooling' else '높아요'
    return (f"{room['floor']} {room['name']}: {mode} 설정온도 {_num(sp)}℃는 권장 기준({_num(target)}℃)보다 {side}. "
            f"{_num(target)}℃로 바꾸면 하루 약 {_num(ev['savingKwhDay'])}kWh 줄어요. 바꿀까요?")


def setpoint_applied_message(room, ev):
    mode = MODE_LABEL.get(ev['mode'], ev['mode'])
    return (f"{room['floor']} {room['name']}: {mode} 설정온도를 {_num(ev['setpoint'])}℃에서 {_num(ev['target'])}℃로 바꿨어요"
            f"(하루 약 {_num(ev['savingKwhDay'])}kWh 절감). 필요하면 되돌릴 수 있어요.")


def power_message(room, ev):
    where = f"{room['floor']} {room['name']}"
    when = f"{ev['weekday']}요일 {ev['hour']}시"
    if ev['rule'] == 'unusual_hours':
        return (f"{where}: 최근 {ev['weeks']}주 {when}에는 꺼져 있던 방인데 재실 0명으로 켜져 있어요({_num(ev['powerKw'])}kW). "
                '켜 둔 채 나갔는지 확인해 주세요.')
    return (f"{where}: 최근 {ev['weeks']}주 {when} 평균 {_num(ev['onAvgKw'])}kW보다 {_num(ev['excessKw'])}kW 많이 쓰고 있어요"
            f"(지금 {_num(ev['powerKw'])}kW, 재실은 평소 수준). 설비 점검이 필요할 수 있어요.")


def anomaly_message(room, st):
    return (f"{room['floor']} {room['name']}: 설정온도 {st['setpoint']}℃인데 실내 {st['temp']}℃로 도달하지 못하고 있어요. "
            '실내기 점검이 필요할 수 있어요.')
