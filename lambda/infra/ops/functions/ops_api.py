"""③ 자동 운영 API(기존 maestro HTTP API에 경로 추가, Cognito JWT 인가 공유)

- GET  /buildings/{id}/operations
    → {settings, decisions}. decisions: 응답 대기 제안(pending, 미만료), 최근 24시간 자동 조치·알림·처리 결과(최신순)
- PUT  /buildings/{id}/operations/settings  body {autoApply: bool}
    → 자동 운영 스위치. 판매사 admin·고객사 manager만
- POST /buildings/{id}/operations/decisions/{decisionId}/{action}   action: accept · reject · undo
    - accept: pending 제안 수락 → 끄기 스케줄 저장(simulator 다음 계산부터 반영) → accepted
    - reject: pending 제안 거절 → rejected(쿨다운 동안 같은 호실 제안 안 함)
    - undo:   자동 조치(applied)·수락(accepted) 되돌림 → 저장한 스케줄 삭제 → reverted
    - 고객사 operator 포함 건물 접근 권한이 있는 구성원 모두
- 권한: src/tenant.py(Layer) 그대로 사용. 건물 접근은 tenant.require_building, 중지 기업은 403
- 동시 처리: 상태 변경은 조건부 쓰기(이미 처리된 제안은 409)
"""
import datetime as dt
import logging

import ops_common as oc

SWITCH_ROLES = ('admin', 'manager')
ACTIONS = ('accept', 'reject', 'undo')
RECENT_HOURS = 24


def _now():
    import sim
    return sim.now()


def handler(event, context):
    import common
    import tenant
    try:
        return _route(event)
    except tenant.Forbidden as e:
        return common.resp(403, e.body())
    except Exception:  # noqa: BLE001
        logging.exception('자동 운영 API 오류')
        return common.resp(500, {'error': '자동 운영 처리 중 오류가 발생했습니다.'})


def _route(event):
    import buildings
    import common
    import tenant
    method = event.get('requestContext', {}).get('http', {}).get('method') or event.get('httpMethod')
    p = event.get('pathParameters') or {}
    bid = p.get('id')
    try:
        buildings.get(bid)
    except ValueError as e:
        return common.resp(404, {'error': str(e)})
    tenant.require_building(event, bid)
    ctx = tenant.caller(event)
    t = _now()
    if method == 'GET':
        return common.resp(200, overview(bid, t))
    if method == 'PUT':
        if ctx['role'] not in SWITCH_ROLES:
            return common.resp(403, {'error': '자동 운영 설정은 고객사 관리자만 바꿀 수 있습니다.'})
        d = common.body(event)
        if not isinstance(d, dict) or not isinstance(d.get('autoApply'), bool):
            return common.resp(400, {'error': 'autoApply(true/false)가 필요합니다.'})
        return common.resp(200, oc.put_settings(bid, d['autoApply'], ctx['sub'], t))
    if method == 'POST':
        action = p.get('action')
        if action not in ACTIONS:
            return common.resp(400, {'error': f'action은 {", ".join(ACTIONS)} 중 하나'})
        return act(bid, p.get('decisionId'), action, ctx, t)
    return common.resp(405, {'error': '지원하지 않는 메서드'})


def overview(bid, t):
    since = t - dt.timedelta(hours=RECENT_HOURS)
    items = []
    for d in reversed(oc.recent_decisions(bid, since)):
        if d.get('status') == 'skipped':
            continue  # Jev가 재실로 판단해 아무 조치도 없던 기록은 화면에 보이지 않음
        if oc.is_expired(d, t):
            d['status'] = 'expired'
        items.append({k: v for k, v in d.items() if k not in ('ttl', 'buildingId')})
    return {'settings': oc.get_settings(bid), 'decisions': items,
            'pendingCount': sum(1 for d in items if d['status'] == 'pending')}


def act(bid, did, action, ctx, t):
    import common
    d = oc.get_decision(bid, did or '')
    if not d:
        return common.resp(404, {'error': '없는 제안입니다.'})
    if action in ('accept', 'reject'):
        if d['status'] != 'pending' or oc.is_expired(d, t):
            return common.resp(409, {'error': '이미 처리됐거나 만료된 제안입니다.', 'status': 'expired' if oc.is_expired(d, t) else d['status']})
        if action == 'reject':
            if not oc.update_status(bid, did, 'rejected', t, ctx['sub']):
                return common.resp(409, {'error': '이미 처리된 제안입니다.'})
            return common.resp(200, {**d, 'status': 'rejected'})
        sched = oc.off_schedule(bid, d['roomId'], t, f"{d['floor']} {d['roomName']} 제안 수락")
        if not oc.update_status(bid, did, 'accepted', t, ctx['sub'], {'scheduleId': sched['id']}):
            return common.resp(409, {'error': '이미 처리된 제안입니다.'})
        oc.save_schedule(sched)
        return common.resp(200, {**d, 'status': 'accepted', 'scheduleId': sched['id'], 'schedule': sched})
    # undo
    if d['status'] not in ('applied', 'accepted') or not d.get('scheduleId'):
        return common.resp(409, {'error': '되돌릴 수 있는 조치가 아닙니다.', 'status': d['status']})
    if not oc.update_status(bid, did, 'reverted', t, ctx['sub'], expect=d['status']):
        return common.resp(409, {'error': '이미 처리된 조치입니다.'})
    oc.delete_schedule(d['scheduleId'])
    return common.resp(200, {**d, 'status': 'reverted'})
