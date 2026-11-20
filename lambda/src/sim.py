"""가상 HVAC 상태 생성(재실, 운전, 설정온도, 실내온도, 습도, 전력)

- 재실·운전·설정온도는 같은 호실·같은 시간대면 같은 값(해시 기반)이라 저장소 없이 재현 가능
- 실내온도·습도·전력은 5초 구간마다 범위 안에서 변동(실시간 수신 목업): 온도 ±0.3℃, 습도 ±1.5%, 전력 ±8%
- 재실: 회의실·사무실·진료실·대기·휴게는 용도별 규칙, 그 밖의 용도(판매사 등록 건물의 미분류 호실 포함)는 운영 시간 가운데일수록 사용 확률이 높은 공통 규칙
- 재실 1명당 실내온도 +0.08℃: ROBOD 분석 0.07~0.09℃/명(docs/human/explanation/research/occupancy-thermal-evidence.md)
- 낭비 패턴(빈 공간 운전, 과냉·과열 설정)과 고장(설정온도 미도달)을 일부 호실에 주입해 추천·이상 감지 검증에 사용
"""
import datetime as dt
import hashlib
import json
import math
import pathlib

ROOMS = json.loads((pathlib.Path(__file__).parent / 'rooms.json').read_text())
KST = dt.timezone(dt.timedelta(hours=9))
LIVE_SECONDS = 5


def now():
    return dt.datetime.now(KST).replace(microsecond=0)


def _u(*key):
    # 키별 고정 난수(0~1)
    return int.from_bytes(hashlib.sha256('|'.join(map(str, key)).encode()).digest()[:8], 'big') / 2**64


def outdoor_temp(t):
    # 부산 근사: 냉방철 일평균 27℃, 난방철 12℃, 일교차 ±4℃(15시 최고)
    base = 27 if 5 <= t.month <= 9 else 12
    return round(base + 4 * math.cos((t.hour + t.minute / 60 - 15) / 24 * 2 * math.pi), 1)


def mode(t):
    return 'cooling' if 5 <= t.month <= 9 else 'heating'


def occupants(room, t):
    # 운영 프로필(buildings.py): 운영 시간 hours, 주말 운영 weekend(주말은 60% 시간대 비어 있음)
    h0, h1 = room.get('hours', (9, 18))
    key, area = (room['id'], t.date(), t.hour), room['areaM2']
    if not h0 <= t.hour < h1 or (t.weekday() >= 5 and (not room.get('weekend') or _u(*key, 'wk') < 0.6)):
        return 0
    use = room['use']
    if use == '회의실':
        return 0 if _u(*key, 'resv') > 0.35 else 2 + int(_u(*key, 'n') * max(1, area / 3))
    if use == '사무실':
        return max(1, round(area / 8 * (0.6 + 0.4 * _u(*key, 'n'))))
    if use == '진료실':
        return 0 if _u(*key, 'resv') > 0.6 else 1 + int(_u(*key, 'n') * 3)
    if use == '대기·휴게':
        return int(area / 5 * _u(*key, 'n'))
    # 그 밖의 용도(기타, 트윈 파이프라인 자동 공간 등 미분류): 사용 확률은 운영 시작·끝 35%, 가운데 70%, 인원은 10㎡당 1명 기준(최소 1명)
    p = 0.35 + 0.35 * math.sin(math.pi * (t.hour + 0.5 - h0) / (h1 - h0))
    return 0 if _u(*key, 'resv') > p else max(1, round(area / 10 * (0.5 + 0.5 * _u(*key, 'n'))))


def _scheduled(room, t, occ, schedules):
    # 오늘 지정 시각이 지난 스케줄을 저장 순서대로 모두 적용: 운전 ON·OFF는 마지막 스케줄 우선, 설정온도 변경은 ON·OFF와 별개로 유지
    return [s for s in schedules if room['id'] in s['roomIds'] and t.strftime('%H:%M') >= s['time']
            and not (s.get('condition') == 'unused' and occ > 0)]


def rated(room):
    # 정격 전력(kW): 면적 1㎡당 0.1kW, 최소 1.5kW
    return round(max(1.5, room['areaM2'] * 0.1), 1)


def wasteful(room):
    # 빈 공간 운전 호실: 운영 시작 1시간 전 ~ 종료 3시간 후에는 재실 0명이어도 운전(낭비 패턴 주입, 호실별 고정)
    return _u(room['id'], 'waste') < room.get('waste', 0.12)


def state(room, t, schedules=()):
    m, occ, out = mode(t), occupants(room, t), outdoor_temp(t)
    idle = wasteful(room)
    h0, h1 = room.get('hours', (9, 18))
    overset = _u(room['id'], 'over') < 0.10
    fault = _u(room['id'], 'fault') < 0.03
    on = occ > 0 or (idle and h0 - 1 <= t.hour < h1 + 3)
    sp = (22 if overset else 26) if m == 'cooling' else (24 if overset else 20)
    for s in _scheduled(room, t, occ, schedules):
        if s['action'] == 'off':
            on = False
        elif s['action'] == 'on':
            on = True
        elif s['action'] == 'setpoint':
            sp = s['setpoint']
    live = int(t.timestamp()) // LIVE_SECONDS
    noise = (_u(room['id'], live, 't') - 0.5) * 0.6
    jitter = 1 + (_u(room['id'], live, 'p') - 0.5) * 0.16
    if on:
        temp = sp + occ * 0.08 + noise + ((4 if m == 'cooling' else -4) if fault else 0)
    else:
        temp = (24 if m == 'cooling' else 17) + (out - (27 if m == 'cooling' else 12)) * 0.3 + occ * 0.08 + noise
    load = 1.0 if fault else min(1.0, 0.3 + 0.05 * occ + abs(sp - out) / 40)
    return {
        'id': room['id'], 'idu': room['idu'], 'name': room['name'], 'floor': room['floor'], 'use': room['use'],
        'areaM2': room['areaM2'], 'occupants': occ, 'onOff': on, 'mode': m, 'setpoint': sp,
        'temp': round(temp, 1), 'humidity': round(min(70, max(30, 40 + occ * 0.8 + noise * 5)), 1),
        'powerKw': round(rated(room) * load * jitter, 2) if on else 0.0,
        'anomaly': 'setpoint_unreached' if on and fault else None,
    }
