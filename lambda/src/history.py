"""GET /rooms/history?building=main&floor=1F: 층 전력 시간별 평균(kW)과 사용량(kWh), 오늘 0시~현재와 어제 0~23시

- 시간마다 0, 15, 30, 45분 4회 상태 평균, 현재 시간은 지난 분만 반영
- 스케줄은 생성 시각 이후 구간에만 적용(저장 전후 비교가 그래프에 표시되도록)
"""
import datetime as dt

import buildings
import common
import sim

SAMPLE_MINUTES = (0, 15, 30, 45)


def handler(event, context):
    try:
        b = common.building(event)
    except ValueError as e:
        return common.bad_building(e)
    floor = (event.get('queryStringParameters') or {}).get('floor')
    t, schedules = sim.now(), common.list_schedules()
    rooms = [r for r in buildings.rooms(b['id']) if not floor or r['floor'] == floor]
    today = t.replace(hour=0, minute=0, second=0)
    return common.resp(200, {
        'generatedAt': t.isoformat(), 'floor': floor or 'all', 'virtual': True,
        'today': hourly(rooms, today, t.hour + 1, schedules, t),
        'yesterday': hourly(rooms, today - dt.timedelta(days=1), 24, schedules, t),
    })


def hourly(rooms, day, hours, schedules, until):
    out = []
    for h in range(hours):
        start = day.replace(hour=h)
        stamps = [start.replace(minute=m) for m in SAMPLE_MINUTES if start.replace(minute=m) <= until]
        kw = sum(sim.state(r, ts, _active(schedules, ts))['powerKw'] for ts in stamps for r in rooms) / len(stamps)
        elapsed = min(3600.0, (until - start).total_seconds()) / 3600
        out.append({'hour': h, 'kw': round(kw, 1), 'kwh': round(kw * elapsed, 1)})
    return out


def _active(schedules, ts):
    # createdAt이 없는 항목(테스트·이전 데이터)은 항상 적용
    at = ts.isoformat()
    return [s for s in schedules if s.get('createdAt', '') <= at]
