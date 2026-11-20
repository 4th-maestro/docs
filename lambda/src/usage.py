"""호실 사용 빈도(가상 데이터): 최근 weeks주 같은 요일·같은 시각의 재실·빈 채 운전 비율

- 사용률(usageRate): 같은 요일 같은 시간(HH:30 표본)에 재실이 1명 이상이던 주 수 / weeks
- 빈 채 운전률(idleOnRate): 같은 시간에 재실 0명인데 운전 중이던 주 수 / weeks
- 기간: 오늘을 제외한 최근 weeks번의 같은 요일(energy.py heatmap과 같은 기간 정의, 기본 4주)
- 표본: 시간마다 HH:30 상태 1회(energy.py와 같음). 재실은 sim.py에서 시간 단위로 고정이라 표본 오차 없음
- 캐시: 지난 날짜의 (호실, 날짜, 대상 스케줄)별 24시간 표본을 모듈 메모리에 보관(recommend.py after_hours와 같은 방식)
- 쓰는 곳: recommend.py 추천 근거(frequency), tools.py usage_frequency 도구, infra/ops 자동 운영 전력 이상 감지(baseline)
- 평소 기준값(baseline): 같은 요일·같은 시각의 운전 주 수, 운전한 주의 평균 전력·최대 재실(재실로 설명되지 않는 전력 과다 판정용)
"""
import datetime as dt
import functools
import json

import buildings
import common
import sim

WEEKS = 4


@functools.lru_cache(maxsize=16384)
def _day(rid, day, key, version=None):
    # 하루 24시간 표본: (재실 여부, 빈 채 운전 여부, 운전 여부, 재실 인원, 전력 kW)
    room, schedules = buildings.BY_ROOM[rid], json.loads(key)
    d = dt.datetime.fromisoformat(day)
    out = []
    for h in range(24):
        s = sim.state(room, d.replace(hour=h, minute=30), schedules)
        out.append((s['occupants'] > 0, s['onOff'] and s['occupants'] == 0, s['onOff'], s['occupants'], s['powerKw']))
    return tuple(out)


def _days(t, weeks):
    """오늘을 제외한 최근 weeks번의 같은 요일 0시(KST)"""
    base = t.astimezone(sim.KST).replace(hour=0, minute=0, second=0, microsecond=0)
    return [base - dt.timedelta(days=7 * w) for w in range(1, weeks + 1)]


def profile(room, t, schedules=(), weeks=WEEKS):
    """t와 같은 요일의 시간별 사용률·빈 채 운전률(각 24개, 0~1)"""
    key, ver = common.sched_key(schedules, [room['id']]), buildings.version()
    samples = [_day(room['id'], d.isoformat(), key, ver) for d in _days(t, weeks)]
    used = [sum(s[h][0] for s in samples) for h in range(24)]
    idle = [sum(s[h][1] for s in samples) for h in range(24)]
    return {
        'weekday': '월화수목금토일'[t.weekday()], 'weeks': weeks,
        'usedWeeks': used, 'idleOnWeeks': idle,
        'usageRate': [round(n / weeks, 2) for n in used], 'idleOnRate': [round(n / weeks, 2) for n in idle],
    }


def at(room, t, schedules=(), weeks=WEEKS, hour=None):
    """t와 같은 요일, hour(기본 t의 시각) 한 시간의 빈도 요약"""
    h = t.hour if hour is None else hour
    p = profile(room, t, schedules, weeks)
    return {
        'weekday': p['weekday'], 'hour': h, 'weeks': weeks,
        'usedWeeks': p['usedWeeks'][h], 'usageRate': p['usageRate'][h],
        'idleOnWeeks': p['idleOnWeeks'][h], 'idleOnRate': p['idleOnRate'][h],
        'busyHours': busy_hours(p['usageRate']),
    }


def busy_hours(rates, threshold=0.5):
    """사용률 threshold 이상인 시간대를 연속 구간으로: [{'from': 9, 'to': 12}](to는 끝 시각, 미포함)"""
    out, start = [], None
    for h, r in enumerate(list(rates) + [0]):
        if r >= threshold and start is None:
            start = h
        elif r < threshold and start is not None:
            out.append({'from': start, 'to': h})
            start = None
    return out


def baseline(room, t, schedules=(), weeks=WEEKS, hour=None):
    """t와 같은 요일, hour(기본 t의 시각) 한 시간의 평소 운전 기준값
    - onWeeks: 운전한 주 수, onAvgKw: 운전한 주의 평균 전력(운전 주 없으면 None), onMaxOccupants: 운전한 주의 최대 재실
    - 스케줄: 그날 이전에 만든 스케줄만 적용(createdAt 날짜 ≤ 그날, 없으면 적용). sim은 스케줄을 날짜 구분 없이 매일 적용하므로
      그대로 쓰면 오늘 만든 스케줄이 지난주에도 있던 것처럼 계산되어 '평소와 다른 운전'을 찾을 수 없음
    """
    h = t.hour if hour is None else hour
    ver = buildings.version()
    on = []
    for d in _days(t, weeks):
        past = [s for s in schedules if str(s.get('createdAt') or '')[:10] <= d.date().isoformat()]
        s = _day(room['id'], d.isoformat(), common.sched_key(past, [room['id']]), ver)[h]
        if s[2]:
            on.append(s)
    return {
        'weekday': '월화수목금토일'[t.weekday()], 'hour': h, 'weeks': weeks, 'onWeeks': len(on),
        'onAvgKw': round(sum(x[4] for x in on) / len(on), 2) if on else None,
        'onMaxOccupants': max((x[3] for x in on), default=0),
    }


def peak_hours(rates, n=3):
    """사용률 높은 시간 n개(0인 시간 제외, 같으면 이른 시각 먼저), 시각순 정렬"""
    top = sorted((h for h, r in enumerate(rates) if r > 0), key=lambda h: (-rates[h], h))[:n]
    return sorted(top)


def sentence(f):
    """추천 근거 문장: '최근 4주 같은 요일(금) 19시대에 사용한 날 0/4회, 빈 채 운전 3/4회'"""
    s = f"최근 {f['weeks']}주 같은 요일({f['weekday']}) {f['hour']}시대에 사용한 날 {f['usedWeeks']}/{f['weeks']}회"
    return s + (f", 빈 채 운전 {f['idleOnWeeks']}/{f['weeks']}회" if f['idleOnWeeks'] else '')
