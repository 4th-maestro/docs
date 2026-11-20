"""GET /rooms/history?building=main&floor=1F: 층 전력 시간별 평균(kW)과 사용량(kWh), 오늘 0시~현재와 어제 0~23시

- 시간마다 0, 15, 30, 45분 4회 상태 평균, 현재 시간은 지난 분만 반영
- 스케줄은 생성 시각 이후 구간에만 적용(저장 전후 비교가 그래프에 표시되도록)
"""
import datetime as dt
import json
import functools

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
    # 끝난 시간은 호실 목록·시각·대상 스케줄이 같으면 결과가 같아 캐시, 진행 중인 시간만 매번 계산
    ids = tuple(r['id'] for r in rooms)
    key = common.sched_key(schedules, ids)
    out = []
    for h in range(hours):
        start = day.replace(hour=h)
        done = until >= start + dt.timedelta(hours=1)
        kw = _hour_kw(ids, start.isoformat(), key, buildings.version()) if done else _kw(rooms, start, schedules, until)
        elapsed = min(3600.0, (until - start).total_seconds()) / 3600
        out.append({'hour': h, 'kw': round(kw, 1), 'kwh': round(kw * elapsed, 1)})
    return out


def _kw(rooms, start, schedules, until):
    stamps = [start.replace(minute=m) for m in SAMPLE_MINUTES if start.replace(minute=m) <= until]
    return sum(sim.state(r, ts, _active(schedules, ts))['powerKw'] for ts in stamps for r in rooms) / len(stamps)


@functools.lru_cache(maxsize=4096)
def _hour_kw(ids, start, key, version=None):
    s = dt.datetime.fromisoformat(start)
    return _kw([buildings.BY_ROOM[i] for i in ids], s, json.loads(key), s + dt.timedelta(hours=1))


def _active(schedules, ts):
    # createdAt이 없는 항목(테스트·이전 데이터)은 항상 적용
    at = ts.isoformat()
    return [s for s in schedules if s.get('createdAt', '') <= at]
