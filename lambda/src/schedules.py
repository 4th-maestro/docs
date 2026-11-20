"""GET /schedules, POST /schedules: 운영자가 확인한 스케줄 초안 저장·조회(시뮬레이션에만 반영)"""
import datetime as dt
import re
import uuid

import common
import sim

ROOM_IDS = {r['id'] for r in sim.ROOMS}


def handler(event, context):
    if event.get('requestContext', {}).get('http', {}).get('method') == 'GET':
        return common.resp(200, {'schedules': common.list_schedules()})
    d = common.body(event) or {}
    ids = d.get('roomIds') or []
    if not ids or not set(ids) <= ROOM_IDS:
        return common.resp(400, {'error': 'roomIds가 비었거나 없는 호실 포함'})
    if d.get('action') not in ('off', 'on', 'setpoint') or d.get('condition') not in ('unused', 'always'):
        return common.resp(400, {'error': 'action 또는 condition 값 오류'})
    if not re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', str(d.get('time'))):
        return common.resp(400, {'error': 'time은 HH:MM 형식'})
    if d['action'] == 'setpoint' and not (isinstance(d.get('setpoint'), (int, float)) and 16 <= d['setpoint'] <= 30):
        return common.resp(400, {'error': 'setpoint는 16~30'})
    item = {
        'id': str(uuid.uuid4()), 'roomIds': ids, 'action': d['action'], 'time': d['time'], 'condition': d['condition'],
        'createdAt': dt.datetime.now(sim.KST).isoformat(), 'sourceText': str(d.get('sourceText', ''))[:500],
    }
    if d['action'] == 'setpoint':
        item['setpoint'] = float(d['setpoint'])
    common.put_schedule(item)
    return common.resp(201, item)
