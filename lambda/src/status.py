"""GET /rooms/status?floor=1F: 호실별 가상 HVAC 상태와 층 요약"""
import common
import sim


def handler(event, context):
    floor = (event.get('queryStringParameters') or {}).get('floor')
    t, schedules = sim.now(), common.list_schedules()
    rooms = [sim.state(r, t, schedules) for r in sim.ROOMS if not floor or r['floor'] == floor]
    return common.resp(200, {
        'generatedAt': t.isoformat(), 'refreshSeconds': sim.LIVE_SECONDS, 'virtual': True,
        'outdoorTemp': sim.outdoor_temp(t), 'floors': sorted({r['floor'] for r in sim.ROOMS}),
        'summary': {
            'on': sum(s['onOff'] for s in rooms), 'off': sum(not s['onOff'] for s in rooms),
            'anomaly': sum(bool(s['anomaly']) for s in rooms), 'powerKw': round(sum(s['powerKw'] for s in rooms), 1),
        },
        'rooms': rooms,
    })
