"""GET /rooms/status?building=main&floor=1F: 건물 호실별 가상 HVAC 상태와 층 요약"""
import buildings
import common
import sim


def handler(event, context):
    try:
        b = common.building(event)
    except ValueError as e:
        return common.bad_building(e)
    floor = (event.get('queryStringParameters') or {}).get('floor')
    t, schedules = sim.now(), common.list_schedules()
    rooms = [sim.state(r, t, schedules) for r in buildings.rooms(b['id']) if not floor or r['floor'] == floor]
    return common.resp(200, {
        'generatedAt': t.isoformat(), 'refreshSeconds': sim.LIVE_SECONDS, 'virtual': True,
        'building': buildings.summary(b), 'outdoorTemp': sim.outdoor_temp(t), 'floors': buildings.floors(b['id']),
        'summary': summarize(rooms), 'rooms': rooms,
    })


def summarize(states):
    return {
        'on': sum(s['onOff'] for s in states), 'off': sum(not s['onOff'] for s in states),
        'anomaly': sum(bool(s['anomaly']) for s in states), 'powerKw': round(sum(s['powerKw'] for s in states), 1),
    }
