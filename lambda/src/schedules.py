"""GET /schedules?building=main, POST /schedules, DELETE /schedules/{id}: 운영자가 확인한 스케줄 초안 저장·조회·취소(시뮬레이션에만 반영)

- 건물 구분: 항목의 buildingId, 값이 없는 이전 항목은 main으로 취급
- 시뮬레이터는 호실 id로 스케줄을 매칭(건물 간 호실 id 중복 없음)하므로 상태 계산에는 전체 목록 사용
"""
import datetime as dt
import logging
import re
import uuid

import buildings
import chat
import common
import sim

SCHEDULE_ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method')
    if method == 'GET':
        try:
            b = common.building(event)
        except ValueError as e:
            return common.bad_building(e)
        return common.resp(200, {'schedules': [s for s in common.list_schedules() if s.get('buildingId', buildings.DEFAULT) == b['id']]})
    if method == 'DELETE':
        sid = str((event.get('pathParameters') or {}).get('id', ''))
        if not SCHEDULE_ID.fullmatch(sid):
            return common.resp(400, {'error': 'id는 UUID 형식'})
        if not common.delete_schedule(sid):
            return common.resp(404, {'error': '없는 스케줄'})
        return common.resp(200, {'id': sid, 'deleted': True})
    d = common.body(event) or {}
    try:
        b = buildings.get(d.get('buildingId'))
    except ValueError as e:
        return common.bad_building(e)
    ids = d.get('roomIds') or []
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids) or not set(ids) <= {r['id'] for r in buildings.rooms(b['id'])}:
        return common.resp(400, {'error': f"roomIds가 비었거나 {b['name']}에 없는 호실 포함"})
    if d.get('action') not in ('off', 'on', 'setpoint') or d.get('condition') not in ('unused', 'always'):
        return common.resp(400, {'error': 'action 또는 condition 값 오류'})
    if not re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', str(d.get('time'))):
        return common.resp(400, {'error': 'time은 HH:MM 형식'})
    if d['action'] == 'setpoint' and not (isinstance(d.get('setpoint'), (int, float)) and 16 <= d['setpoint'] <= 30):
        return common.resp(400, {'error': 'setpoint는 16~30'})
    item = {
        'id': str(uuid.uuid4()), 'buildingId': b['id'], 'roomIds': ids, 'action': d['action'], 'time': d['time'],
        'condition': d['condition'], 'createdAt': dt.datetime.now(sim.KST).isoformat(), 'sourceText': str(d.get('sourceText', ''))[:500],
    }
    if d['action'] == 'setpoint':
        item['setpoint'] = float(d['setpoint'])
    common.put_schedule(item)
    # 대화 메모리에 마지막 저장 스케줄 기록: "방금 것 취소해" 같은 후속 질문 해석용
    sub = chat.user(event)
    try:
        mem = chat.get_memory(sub, b['id']) or {}
        chat.put_memory(sub, b['id'], {**mem, 'lastSchedule': {k: item.get(k) for k in ('id', 'action', 'time', 'condition', 'setpoint')} | {'targets': len(ids)}})
    except Exception:
        logging.exception('대화 메모리 갱신 실패')
    return common.resp(201, item)
