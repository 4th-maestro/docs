"""GET /energy/compare, /energy/trend, /energy/heatmap, /energy/breakdown: 건물별 전력 사용량 분석(가상 데이터)

- 표본: 시간마다 HH:30 상태 1회 × 1시간, 현재 시간은 경과 구간의 중간 시각 × 경과 시간. 재실·운전은 시간 단위로 고정이라 오차 원인은 전력 변동(±8%, 평균 0)과 외기온도 곡선뿐
- 표본 오차: 5분 간격 12회 평균 대비 건물 일 합계 최대 0.82%, 건물 시간 값 최대 5.3%(3일 × 건물 4개, architecture.md 11절)
- 스케줄: 시각을 HH:30 표본으로 판정하므로 시간 중간에 시작하는 스케줄은 해당 시간 전체에 반영되거나 빠짐(호실당 하루 최대 1시간)
- 캐시: 지난 날짜의 (건물, 날짜, 적용 스케줄)별 층·용도 시간별 kWh를 모듈 메모리에 보관, 오늘은 요청마다 계산
- 전기요금: 일반용(갑)I 고압A 선택I 전력량요금 연평균 + 기후환경요금 + 연료비조정요금(docs/human/explanation/research/electricity-tariff.md)
"""
import calendar
import datetime as dt
import functools
import json

import buildings
import common
import sim

# 전기요금 단가(원/kWh)
# - 전력량요금 연평균 120.2: 여름 142.6 × 3개월, 봄·가을 98.6 × 5개월, 겨울 130.3 × 4개월(2023-05-16 요금표, 2026-11 동결 확인)
# - 기후환경요금 9.0, 연료비조정요금 5.0 추가
# - 기본요금(계약전력 기준), 부가가치세 10%, 전력산업기반기금 제외: 사용량 비교용 단가라 사용량과 무관한 항목 제외
UNIT_PRICE_KRW = 134.2
PRICE_BASIS = '일반용(갑)I 고압A 선택I 전력량요금 연평균 120.2원 + 기후환경요금 9.0원 + 연료비조정요금 5.0원, 기본요금·부가가치세·전력산업기반기금 제외'
WEEKDAYS = '월화수목금토일'
_PROBE = dt.date(2026, 11, 16)  # 월요일


def _idle_on(room):
    # 재실 0명이어도 운전하는 시간(빈 공간 운전 호실): 운영 시작 1시간 전은 재실 0명이라 그 시각 운전 여부로 판별
    # shortcut: 시간 범위(운영 시작 1시간 전 ~ 종료 3시간 후)는 sim.state 규칙 복제, sim.py 규칙 변경 시 test_energy SkipTest로 확인
    h0, h1 = room.get('hours', (9, 18))
    on = sim.state(room, dt.datetime.combine(_PROBE, dt.time(h0 - 1, 30), sim.KST))['onOff']
    return frozenset(range(h0 - 1, h1 + 3)) if on else frozenset()


_ROOMS = {b['id']: buildings.rooms(b['id']) for b in buildings.LIST}
_IDLE_ON = {r['id']: _idle_on(r) for rs in _ROOMS.values() for r in rs}
_GROUPS = {bid: sorted({(r['floor'], r['use']) for r in rs}) for bid, rs in _ROOMS.items()}


def _compute(bid, day, schedules, until=None):
    # (층, 용도)별 시간 kWh 24칸. until이 있으면 그 시각까지(현재 시간은 경과분만)
    # - 재실 0명이고 빈 공간 운전 시간 밖이며 스케줄 대상이 아닌 호실은 sim.state 결과가 정지(0kW)라 호출 생략(1주 기준 호출 67% 감소)
    out = {g: [0.0] * 24 for g in _GROUPS[bid]}
    for h in range(24):
        t0 = dt.datetime.combine(day, dt.time(h), sim.KST)
        frac = 1.0 if until is None else min(1.0, (until - t0).total_seconds() / 3600)
        if frac <= 0:
            break
        ts = t0 + dt.timedelta(seconds=1800 * frac)
        at = ts.isoformat()
        active = [s for s in schedules if s.get('createdAt', '') <= at]
        targeted = {i for s in active for i in s['roomIds']}
        for r in _ROOMS[bid]:
            if h not in _IDLE_ON[r['id']] and r['id'] not in targeted and sim.occupants(r, ts) == 0:
                continue
            out[(r['floor'], r['use'])][h] += sim.state(r, ts, active)['powerKw'] * frac
    return {g: tuple(v) for g, v in out.items()}


@functools.lru_cache(maxsize=1024)
def _past(bid, day, key):
    # 건물 4개 × (이번 달 + 지난달 62일 + 히트맵 최대 56일) 이내라 1024개면 재계산 없음
    return _compute(bid, day, json.loads(key))


def _groups(bid, day, schedules, now):
    # 지난 날짜는 캐시, 오늘은 현재 시각까지 계산, 미래는 0
    if day > now.date():
        return {g: (0.0,) * 24 for g in _GROUPS[bid]}
    mine = [s for s in schedules if s.get('buildingId', buildings.DEFAULT) == bid]
    if day == now.date():
        return _compute(bid, day, mine, now)
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(), sim.KST).isoformat()
    return _past(bid, day, json.dumps([s for s in mine if s.get('createdAt', '') < end], sort_keys=True, default=str))


def _hourly(bid, day, schedules, now):
    return [sum(v) for v in zip(*_groups(bid, day, schedules, now).values())]


def _upto(hourly, now):
    # 같은 시각까지의 합: 현재 시간은 경과 비율만큼(시간 안의 사용량은 균등 가정)
    return sum(hourly[:now.hour]) + hourly[now.hour] * (now.minute * 60 + now.second) / 3600


def _days(start, end):
    return [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]


def _prev_month(day):
    first = (day.replace(day=1) - dt.timedelta(days=1)).replace(day=1)
    return first, calendar.monthrange(first.year, first.month)[1]


def _period(q, allowed):
    p = q.get('period') or allowed[0]
    if p not in allowed:
        raise ValueError(f"period는 {', '.join(allowed)} 중 하나입니다.")
    return p


def _building(q):
    return buildings.get(q.get('building') or buildings.DEFAULT)['id']


def _span(period, now):
    # 기간별 (이번 기간 날짜, 지난 기간 날짜, 지난 기간의 같은 시점 계산용 (지난 날짜 목록, 같은 시각 날짜))
    today = now.date()
    if period == 'day':
        y = today - dt.timedelta(days=1)
        return [today], [y], ([], y)
    if period == 'week':
        mon = today - dt.timedelta(days=today.weekday())
        prev = _days(mon - dt.timedelta(days=7), mon - dt.timedelta(days=1))
        return _days(mon, today), prev, (prev[:today.weekday()], prev[today.weekday()])
    first, n = _prev_month(today)
    prev = _days(first, first.replace(day=n))
    return _days(today.replace(day=1), today), prev, (prev[:today.day - 1], prev[today.day - 1] if today.day <= n else None)


def _same_point(bid, same, schedules, now):
    full, partial = same
    total = sum(sum(_hourly(bid, d, schedules, now)) for d in full)
    return total + (_upto(_hourly(bid, partial, schedules, now), now) if partial else 0)


def compare(q, now):
    period = _period(q, ('day', 'month'))
    schedules = common.list_schedules()
    cur, _, same = _span(period, now)
    items = []
    for b in buildings.LIST:
        kwh = round(sum(sum(_hourly(b['id'], d, schedules, now)) for d in cur), 1)
        area = buildings.summary(b)['areaM2']
        items.append({
            'buildingId': b['id'], 'name': b['name'], 'areaM2': area, 'kwh': kwh,
            'prevKwh': round(_same_point(b['id'], same, schedules, now), 1),
            'kwhPerM2': round(kwh / area, 3), 'costKrw': round(kwh * UNIT_PRICE_KRW),
        })
    return {'period': period, 'unitPriceKrw': UNIT_PRICE_KRW, 'priceBasis': PRICE_BASIS, 'items': items}


def trend(q, now):
    bid, period = _building(q), _period(q, ('day', 'week', 'month'))
    schedules = common.list_schedules()
    cur, prev, same = _span(period, now)
    if period == 'day':
        def points(day, n):
            return [{'label': f'{h}시', 'kwh': round(v, 1)} for h, v in enumerate(_hourly(bid, day, schedules, now)[:n])]
        current, previous = points(cur[0], now.hour + 1), points(prev[0], 24)
    else:
        def points(days):
            label = (lambda d: WEEKDAYS[d.weekday()]) if period == 'week' else (lambda d: f'{d.day}일')
            return [{'label': label(d), 'kwh': round(sum(_hourly(bid, d, schedules, now)), 1)} for d in days]
        current, previous = points(cur), points(prev)
    return {
        'building': bid, 'period': period, 'unit': 'kWh', 'current': current, 'previous': previous,
        'totalKwh': round(sum(p['kwh'] for p in current), 1), 'prevTotalKwh': round(sum(p['kwh'] for p in previous), 1),
        'prevSameKwh': round(_same_point(bid, same, schedules, now), 1),
    }


def heatmap(q, now):
    bid, weeks = _building(q), q.get('weeks') or '4'
    if not (weeks.isdigit() and 1 <= int(weeks) <= 8):
        raise ValueError('weeks는 1~8 정수입니다.')
    weeks, schedules = int(weeks), common.list_schedules()
    sums = [[0.0] * 24 for _ in range(7)]
    # 오늘을 제외한 최근 weeks×7일: 요일마다 weeks번씩 포함, 시간 kWh(1시간) = 그 시간 평균 kW
    for i in range(1, weeks * 7 + 1):
        day = now.date() - dt.timedelta(days=i)
        for h, v in enumerate(_hourly(bid, day, schedules, now)):
            sums[day.weekday()][h] += v
    cells = [[round(v / weeks, 1) for v in row] for row in sums]
    b = buildings.get(bid)
    return {
        'building': bid, 'weeks': weeks, 'unit': 'kW', 'cells': cells, 'max': max(map(max, cells)),
        'hours': list(b['hours']), 'weekend': b['weekend'],
    }


def breakdown(q, now):
    bid, period = _building(q), _period(q, ('day', 'week', 'month'))
    schedules = common.list_schedules()
    sums = {}
    for d in _span(period, now)[0]:
        for g, v in _groups(bid, d, schedules, now).items():
            sums[g] = sums.get(g, 0.0) + sum(v)
    floors = []
    for f in buildings.floors(bid):
        uses = sorted(((u, v) for (fl, u), v in sums.items() if fl == f), key=lambda x: -x[1])
        floors.append({'floor': f, 'kwh': round(sum(v for _, v in uses), 1), 'uses': [{'use': u, 'kwh': round(v, 1)} for u, v in uses]})
    return {
        'building': bid, 'name': buildings.get(bid)['name'], 'period': period, 'unit': 'kWh',
        'totalKwh': round(sum(sums.values()), 1), 'floors': floors,
    }


ROUTES = {'/energy/compare': compare, '/energy/trend': trend, '/energy/heatmap': heatmap, '/energy/breakdown': breakdown}


def handler(event, context):
    fn = ROUTES.get(event.get('routeKey', '').rsplit(' ', 1)[-1])
    if not fn:
        return common.resp(404, {'error': '없는 경로입니다.'})
    now = sim.now()
    try:
        body = fn(event.get('queryStringParameters') or {}, now)
    except ValueError as e:  # 잘못된 building, period, weeks
        return common.resp(400, {'error': str(e)})
    return common.resp(200, {'generatedAt': now.isoformat(), 'virtual': True, **body})
