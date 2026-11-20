"""② 디지털 트윈 주기 계산: 1분마다 전 건물 호실 상태를 계산해 State·Timeseries·Occupancy 테이블에 기록

- 계산: src/sim.py의 state()를 그대로 사용(5R1C 교체 전 단계). 건물·호실은 src/buildings.py(DynamoDB 출처, 고객사 수정 정보 반영)
- src/ 모듈은 Lambda Layer(infra/twin/template.yaml TwinSrcLayer)로 import만 함. 팀 코드 수정 없음
- 스케줄: SCHEDULES_TABLE(maestro 스택)이 있으면 저장된 스케줄을 반영(sim.state의 schedules 인자)
- 기록 주기: State는 매 실행 덮어쓰기, Timeseries·Occupancy는 HISTORY_EVERY_MIN분 정각마다 추가(ttl 30일)
- 기준 시각: EventBridge 이벤트 time(UTC)을 KST 분 단위로 맞춤. 지연 실행·재실행도 같은 분이면 같은 키(중복 없음)
- 비활성 호실(active=false, 도면 수정으로 지운 방)은 계산하지 않음
- 건물 목록: 매 실행 buildings.forget()으로 캐시(60초)를 비우고 다시 읽음. 삭제된 건물을 캐시로 계속 기록하는 문제 방지(#34 미확인 항목)
- 정리: CLEANUP_EVERY_MIN분 정각마다 State에서 이번 계산 대상이 아닌 행(삭제된 건물·호실, 비활성 호실) 삭제. 계산 대상이 0건이면 정리하지 않음
  - Timeseries·Occupancy 이력은 지우지 않음(#34 방침, ttl 30일로 자동 삭제)
- 로컬 확인(Lambda 폴더에서, DynamoDB에 쓰지 않음): python -X utf8 infra/twin/functions/simulator.py --dry-run
"""
import datetime as dt
import json
import logging
import os
import time
from decimal import Decimal

log = logging.getLogger()
log.setLevel(logging.INFO)

HISTORY_DAYS = 30
FIELDS = ('idu', 'name', 'floor', 'use', 'areaM2', 'occupants', 'onOff', 'mode', 'setpoint', 'temp', 'humidity', 'powerKw', 'anomaly')


def at_minute(event=None):
    """실행 기준 시각(KST, 초 0). 이벤트 time이 없으면(직접 호출) 현재 시각"""
    import sim
    raw = (event or {}).get('time')
    t = dt.datetime.fromisoformat(raw.replace('Z', '+00:00')).astimezone(sim.KST) if raw else sim.now()
    return t.replace(second=0, microsecond=0)


def compute(t, schedules=()):
    """[(buildingId, state dict)] 전 건물·전 호실(비활성 제외)"""
    import buildings
    import sim
    rows = []
    for b in buildings.LIST:
        for r in buildings.rooms(b['id']):
            if r.get('active') is False:
                continue
            rows.append((b['id'], sim.state(r, t, schedules)))
    return rows


def _ddb(v):
    # DynamoDB 숫자는 Decimal(float 불가)
    if isinstance(v, float):
        return Decimal(str(v))
    return v


def items(rows, t, history):
    """테이블별 기록 항목 {'state': [...], 'timeseries': [...], 'occupancy': [...]}"""
    ts = t.isoformat()
    ttl = int((t + dt.timedelta(days=HISTORY_DAYS)).timestamp())
    out = {'state': [], 'timeseries': [], 'occupancy': []}
    for bid, s in rows:
        fields = {k: _ddb(s[k]) for k in FIELDS}
        out['state'].append({'buildingId': bid, 'roomId': s['id'], **fields, 'updatedAt': ts})
        if history:
            pk = f"{bid}#{s['id']}"
            out['timeseries'].append({'pk': pk, 'ts': ts, **fields, 'ttl': ttl})
            out['occupancy'].append({'pk': pk, 'ts': ts, 'occupants': s['occupants'], 'ttl': ttl})
    return out


def is_history_minute(t, every):
    return every > 0 and t.minute % every == 0


def stale_keys(existing, rows):
    """State에 있지만 이번 계산 대상이 아닌 키 [(buildingId, roomId)]. 계산 대상이 비면 빈 목록(전체 삭제 방지)"""
    if not rows:
        return []
    live = {(bid, s['id']) for bid, s in rows}
    return sorted(k for k in existing if k not in live)


def _write(table_name, rows, keys):
    import boto3
    table = boto3.resource('dynamodb').Table(table_name)
    with table.batch_writer(overwrite_by_pkeys=keys) as w:
        for row in rows:
            w.put_item(Item=row)


def _scan_keys(table_name):
    """State 테이블의 전체 키 [(buildingId, roomId)]"""
    import boto3
    table = boto3.resource('dynamodb').Table(table_name)
    keys, kw = [], {'ProjectionExpression': 'buildingId, roomId'}
    while True:
        r = table.scan(**kw)
        keys += [(i['buildingId'], i['roomId']) for i in r['Items']]
        if 'LastEvaluatedKey' not in r:
            return keys
        kw['ExclusiveStartKey'] = r['LastEvaluatedKey']


def _delete(table_name, keys):
    import boto3
    table = boto3.resource('dynamodb').Table(table_name)
    with table.batch_writer() as w:
        for bid, rid in keys:
            w.delete_item(Key={'buildingId': bid, 'roomId': rid})


def handler(event, context):
    import buildings
    import common
    t0 = time.monotonic()
    t = at_minute(event)
    history = is_history_minute(t, int(os.environ.get('HISTORY_EVERY_MIN', '5')))
    cleanup = is_history_minute(t, int(os.environ.get('CLEANUP_EVERY_MIN', '10')))
    buildings.forget()  # 삭제·교체된 건물을 60초 캐시로 다시 기록하지 않도록 매번 새로 읽음
    rows = compute(t, common.list_schedules())
    out = items(rows, t, history)
    _write(os.environ['STATE_TABLE'], out['state'], ['buildingId', 'roomId'])
    if history:
        _write(os.environ['TIMESERIES_TABLE'], out['timeseries'], ['pk', 'ts'])
        _write(os.environ['OCCUPANCY_TABLE'], out['occupancy'], ['pk', 'ts'])
    removed = 0
    if cleanup:
        stale = stale_keys(_scan_keys(os.environ['STATE_TABLE']), rows)
        if stale:
            _delete(os.environ['STATE_TABLE'], stale)
            log.info(json.dumps({'removedState': [f'{b}#{r}' for b, r in stale[:20]], 'count': len(stale)}, ensure_ascii=False))
        removed = len(stale)
    summary = {'at': t.isoformat(), 'rooms': len(rows), 'history': history, 'removed': removed, 'ms': round((time.monotonic() - t0) * 1000)}
    log.info(json.dumps(summary))
    return summary


if __name__ == '__main__':
    import argparse
    import pathlib
    import sys

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / 'src'))
    a = argparse.ArgumentParser(description='simulator 로컬 실행')
    a.add_argument('--dry-run', action='store_true', help='DynamoDB에 쓰지 않고 건수·예시만 출력(현재는 이 모드만 지원)')
    a.add_argument('--every', type=int, default=5, help='이력 기록 주기(분)')
    args = a.parse_args()
    if not args.dry_run:
        sys.exit('로컬에서는 --dry-run만 지원합니다. 실제 기록은 배포된 Lambda가 합니다.')
    if not sys.flags.utf8_mode:
        sys.exit('python -X utf8 로 실행하십시오(팀 모듈의 JSON 읽기가 시스템 인코딩을 따름)')
    t = at_minute().replace(minute=0)  # 정각 기준: 이력까지 생성
    t1 = time.monotonic()
    rows = compute(t)
    out = items(rows, t, is_history_minute(t, args.every))
    ms = round((time.monotonic() - t1) * 1000)
    print(f'기준 {t.isoformat()} 호실 {len(rows)} 계산 {ms}ms')
    for k, v in out.items():
        print(f'  {k}: {len(v)}건')
    print('[state 예시]', json.dumps(out['state'][0], ensure_ascii=False, default=str))
