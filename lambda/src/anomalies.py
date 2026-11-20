"""GET /anomalies?building=main&floor=1F: 설정온도 미도달 HVAC 상세(architecture.md 9절)

- 기대 온도: 같은 건물에서 같은 용도·같은 모드로 운전 중인 정상 HVAC의 (실내온도 - 설정온도) 평균을 이 호실 설정온도에 더한 값
- 잔차: 실내온도 - 기대 온도
- 감지 시각: 오늘 00:00부터 5분 간격으로 처음 미도달이 판정된 시각
- 원인 후보: 규칙 기반 추정(causeBasis=rule), 진단 결과가 아님
"""
import datetime as dt

import buildings
import common
import sim

STEP = dt.timedelta(minutes=5)


def handler(event, context):
    try:
        b = common.building(event)
    except ValueError as e:
        return common.bad_building(e)
    floor = (event.get('queryStringParameters') or {}).get('floor')
    t, schedules = sim.now(), common.list_schedules()
    return common.resp(200, {'generatedAt': t.isoformat(), 'virtual': True, 'causeBasis': 'rule', 'items': anomalies(floor, t, schedules, b['id'])})


def anomalies(floor, t, schedules, bid=None):
    rooms = buildings.rooms(bid)
    states = {r['id']: sim.state(r, t, schedules) for r in rooms}
    items = []
    for room in rooms:
        s = states[room['id']]
        if s['anomaly'] != 'setpoint_unreached' or (floor and room['floor'] != floor):
            continue
        healthy = [p for p in states.values() if p['onOff'] and not p['anomaly'] and p['mode'] == s['mode']]
        peers = [p for p in healthy if p['use'] == s['use']] or healthy
        expected = s['setpoint'] + (sum(p['temp'] - p['setpoint'] for p in peers) / len(peers) if peers else 0)
        since = _first_detected(room, t, schedules)
        minutes = int((t - since).total_seconds() // 60)
        items.append({
            'roomId': room['id'], 'roomName': room['name'], 'idu': room['idu'], 'floor': room['floor'], 'use': room['use'],
            'mode': s['mode'], 'setpoint': s['setpoint'], 'temp': s['temp'], 'gap': round(s['temp'] - s['setpoint'], 1),
            'expectedTemp': round(expected, 1), 'residual': round(s['temp'] - expected, 1), 'peerCount': len(peers),
            'powerKw': s['powerKw'], 'occupants': s['occupants'],
            'detectedAt': since.isoformat(), 'durationMin': minutes, 'causes': causes(room, s, minutes),
        })
    return sorted(items, key=lambda i: -abs(i['residual']))


def _first_detected(room, t, schedules):
    ts = t.replace(hour=0, minute=0, second=0)
    while ts < t and not sim.state(room, ts, schedules)['anomaly']:
        ts += STEP
    return min(ts, t)


def causes(room, s, minutes):
    # 출력 비율은 100%에서 자름: 실시간 변동(±8%)으로 정격을 넘는 값은 전부하 운전과 같음
    load = min(1.0, s['powerKw'] / sim.rated(room))
    density = s['occupants'] / room['areaM2']
    return [
        {'label': '압축기·냉매 계통 성능 저하', 'likelihood': 'high' if load >= 0.9 else 'medium',
         'evidence': f'정격 대비 {round(load * 100)}% 출력으로 운전 중입니다.'},
        {'label': '필터·열교환기 오염에 따른 풍량 저하', 'likelihood': 'medium' if minutes >= 60 else 'low',
         'evidence': f'미도달 상태가 {minutes // 60}시간 {minutes % 60}분 지속 중입니다.'},
        {'label': '재실 인원 대비 용량 부족', 'likelihood': 'medium' if density >= 0.15 else 'low',
         'evidence': f"재실 {s['occupants']}명, 면적 {room['areaM2']}㎡입니다."},
    ]
