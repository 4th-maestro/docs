"""GET /recommendations?building=main&floor=1F: 낭비 규칙 3종 판정, 예상 절감량, 스케줄 초안(architecture.md 8절)

- 빈 공간 운전: 지금, 15분 전, 30분 전 모두 재실 0명으로 운전
- 업무 외 운전: 최근 7일 중 건물 운영 시간(buildings.json hours, 본관 09~18시) 밖에 재실 없이 운전한 날 2일 이상
- 주말: 주말 운영 건물(weekend)은 평일과 같은 운영 시간, 그 외 건물은 하루 전체가 운영 시간 밖
- 과냉·과열 설정: 냉방 설정 26℃ 미만, 난방 설정 20℃ 초과
- 한 호실에 추천 1건: OFF 규칙(빈 공간, 업무 외)이 설정온도 규칙보다 우선이라 합계에 중복 없음
- 초안 시각 00:00: 스케줄은 매일 지정 시각 이후 적용되므로 하루 전체(아침 8시대 운전, 주말 포함)에 적용
- 절감량: 초안을 시뮬레이터에 적용한 전후 전력 차이를 초안 시각부터 24시까지 1시간 간격으로 합산(1일 기준, 가상)
- 규칙 판정에 저장된 스케줄을 적용: 추천을 저장하면 다음 조회부터 해당 추천이 빠짐
"""
import datetime as dt

import buildings
import common
import sim

COOL_MIN, HEAT_MAX = 26, 20
AFTER_HOURS_DAYS = 2


def handler(event, context):
    try:
        b = common.building(event)
    except ValueError as e:
        return common.bad_building(e)
    floor = (event.get('queryStringParameters') or {}).get('floor')
    t, schedules = sim.now(), common.list_schedules()
    items = recommend([r for r in buildings.rooms(b['id']) if not floor or r['floor'] == floor], t, schedules)
    return common.resp(200, {
        'generatedAt': t.isoformat(), 'virtual': True,
        'totalSavingKwh': round(sum(i['savingKwhDay'] for i in items), 1), 'items': items,
    })


def recommend(rooms, t, schedules):
    items = []
    for room in rooms:
        hit = _rule(room, t, schedules)
        if not hit:
            continue
        rule, title, reason, draft = hit
        draft['estimatedSavingKwh'] = saving(room, t, schedules, draft)
        if draft['estimatedSavingKwh'] > 0:
            items.append({
                'id': f"{rule}-{room['id']}", 'roomId': room['id'], 'roomName': room['name'], 'idu': room['idu'],
                'floor': room['floor'], 'use': room['use'], 'rule': rule, 'title': title, 'reason': reason,
                'savingKwhDay': draft['estimatedSavingKwh'], 'draft': draft,
            })
    return sorted(items, key=lambda i: -i['savingKwhDay'])


def _rule(room, t, schedules):
    now = sim.state(room, t, schedules)
    if all(s['onOff'] and s['occupants'] == 0 for s in (sim.state(room, t - dt.timedelta(minutes=m), schedules) for m in (0, 15, 30))):
        return 'idle', '재실 없을 때 운전 OFF', f"최근 30분 동안 재실 0명 상태에서 {now['powerKw']}kW로 운전 중입니다.", _draft(room, 'off', '00:00', 'unused')
    days = after_hours_days(room, t, schedules)
    if days >= AFTER_HOURS_DAYS:
        h0, h1 = room.get('hours', (9, 18))
        return 'after_hours', '재실 없을 때 운전 OFF', f'최근 7일 중 운영 시간({h0:02d}~{h1:02d}시) 밖에 재실 없이 운전한 날은 {days}일입니다.', _draft(room, 'off', '00:00', 'unused')
    sp = now['setpoint']
    if now['mode'] == 'cooling' and sp < COOL_MIN:
        reason, target = f'냉방 설정온도 {sp}℃는 권고 하한 {COOL_MIN}℃보다 {COOL_MIN - sp}℃ 낮습니다.', COOL_MIN
    elif now['mode'] == 'heating' and sp > HEAT_MAX:
        reason, target = f'난방 설정온도 {sp}℃는 권고 상한 {HEAT_MAX}℃보다 {sp - HEAT_MAX}℃ 높습니다.', HEAT_MAX
    else:
        return None
    return 'overset', f'설정온도 {target}℃로 조정', reason, _draft(room, 'setpoint', '00:00', 'always', target)


def after_hours_days(room, t, schedules):
    h0, h1 = room.get('hours', (9, 18))
    days = 0
    for d in range(1, 8):
        day = (t - dt.timedelta(days=d)).replace(hour=0, minute=0, second=0)
        closed = day.weekday() >= 5 and not room.get('weekend')
        hours = range(24) if closed else [h for h in range(24) if not h0 <= h < h1]
        days += any(s['onOff'] and s['occupants'] == 0 for s in (sim.state(room, day.replace(hour=h), schedules) for h in hours))
    return days


def _draft(room, action, time, condition, setpoint=None):
    return {
        'roomIds': [room['id']], 'roomNames': [room['name']], 'floor': room['floor'], 'use': room['use'],
        'action': action, 'time': time, 'condition': condition, 'setpoint': setpoint, 'estimatedSavingKwh': 0,
    }


def saving(room, t, schedules, draft):
    h, m = map(int, draft['time'].split(':'))
    after = list(schedules) + [draft]
    total = 0.0
    for hour in range(h, 24):
        ts = t.replace(hour=hour, minute=m if hour == h else 0, second=0)
        weight = (60 - m) / 60 if hour == h else 1
        total += weight * (sim.state(room, ts, schedules)['powerKw'] - sim.state(room, ts, after)['powerKw'])
    return round(max(0.0, total), 1)
