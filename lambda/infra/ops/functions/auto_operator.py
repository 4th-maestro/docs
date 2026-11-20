"""③ 자동 운영 판단(5분 주기): 빈 방 운전·이상 후보 → Jev 판단 → 건물 스위치에 따라 자동 조치 또는 제안

- 후보(빈 방 운전, kind=idle): 지금·15분 전·30분 전 모두 재실 0명으로 운전(src/recommend.py 'idle' 규칙과 같은 기준, src/sim.py로 계산)
- 후보(이상, kind=anomaly): 지금 설정온도 미도달(sim.state anomaly). Jev 없이 알림(status=alert)
- 후보(설정온도, kind=setpoint, ⑤ 규칙 기반 제어): 운전 중이고 빈 방 후보가 아닌 호실의 과냉·과열 설정
  - 기준: src/recommend.py 'overset'과 같음(냉방 COOL_MIN 26℃ 미만, 난방 HEAT_MAX 20℃ 초과 → 그 값으로 조정)
    recommend.recommend()는 호실당 1건이라 업무 외 운전(after_hours)이 먼저 잡히면 설정 추천이 빠지므로 기준값만 가져와 직접 판정
  - 절감량: recommend.saving()과 같은 계산(00:00 초안을 적용한 하루 전력 차이, 가상). 0이면 제안 안 함
  - Jev 없이 결정: 스위치 ON → 설정온도 스케줄 저장, applied / OFF → pending 제안. 건물당 실행마다 MAX_SETPOINT_PER_BUILDING(기본 5)건, 절감량 큰 방부터
- Jev 판단(빈 방): room_empty = empty / occupied / uncertain + 확신도·선택지별 확률. 키·호출 실패 시 판단 없음으로 제안(폴백)
  - 입력: 건물·호실 정보, 0·15·30분 전 상태, 파생 사실(facts: 운영 시간 안팎·종료 후 경과, 빈 채 운전 지속 시간,
    오늘 마지막 재실·사용 구간 수, 최근 7일 같은 시각 사용 일수, 빈 채 운전 전력량). 판단 문구 없이 사실만
  - 파생 사실 추가 근거(2026-11-20 실측): 사실 없이 보내면 확신도 0.16(empty 0.41·uncertain 0.44), 추가하면 0.86(empty 0.91)
- 결정 게이트(빈 방)
  - Jev가 occupied를 확신도 기준(AUTO_APPLY_CONFIDENCE, 기본 0.8) 이상으로 선택 → skipped(조치·제안 없음, 쿨다운 동안 다시 묻지 않음)
  - 스위치 ON + empty 선택 + 확신도 기준 이상 + empty 확률(AUTO_APPLY_EMPTY_PROB, 기본 0.9) 이상 → 끄기 스케줄 저장, applied(되돌리기 가능)
    - Jev 확신도는 1위 확률보다 낮게 나옴(1·2위 차이 반영으로 보임, 확률 0.91에 확신도 0.86) → 확률과 확신도를 함께 사용
  - 그 외 → pending 제안(SUGGESTION_TTL_MIN, 기본 30분 뒤 만료)
- 중복 방지: 진행 중(pending·applied·accepted) 호실, 쿨다운(COOLDOWN_MIN, 기본 120분) 안의 거절·되돌림·재실 판단·알림 호실은 건너뜀
- Jev 호출 상한: 실행당 MAX_JEV_PER_RUN(기본 10)건, 넘는 후보는 다음 실행으로 미룸(deferred)
  - 배분: 건물마다 한 건씩 돌아가며 선택(한 건물이 상한을 독차지하지 않게), 시작 건물은 5분 실행마다 한 칸씩 이동
  - 건물 안 순서: 빈 채 운전 전력량(facts.idleEnergyKwh) 큰 방부터 → 상한으로 밀려도 절감 효과 큰 방이 먼저 제안됨
  - 다른 건물 후보가 없으면 한 건물이 상한을 모두 사용(남는 호출을 버리지 않음)
- 만료: 응답 기한이 지난 pending을 expired로 바꿈
- 로컬 확인(Lambda 폴더에서, DynamoDB·Jev 호출 없음): python -X utf8 infra/ops/functions/auto_operator.py --dry-run
"""
import datetime as dt
import json
import logging
import os
import time
import urllib.request

import ops_common as oc

log = logging.getLogger()
log.setLevel(logging.INFO)

JEV_URL = 'https://api.typesafe.ai/v1/systemone'
IDLE_MINUTES = (0, 15, 30)
STEP = 15            # 파생 사실 계산 간격(분)
IDLE_LOOKBACK = 180  # 빈 채 운전 지속 시간 최대 조회(분)
QUESTIONS = {
    'room_empty': {
        'type': 'choice',
        'instructions': ('건물 운영 디지털트윈의 호실 기록을 보고, 지금 이 호실이 실제로 비어 있어 냉난방을 꺼도 되는지 판단하라. '
                         'recent는 0·15·30분 전 상태이고, facts는 같은 기록에서 계산한 사실이다(재실은 센서 인원, 운전은 실내기 상태). '
                         'facts의 운영 시간 안팎, 빈 채 운전 지속 시간, 오늘 마지막 재실, 평소 같은 시각 사용 여부를 근거로 판단하라.'),
        'criteria': {
            'empty': '30분 동안 재실이 없었고 곧 사용할 정황도 없어 꺼도 됨',
            'occupied': '센서상 0명이어도 곧 사용하거나 사용 중일 가능성이 높아 끄면 안 됨',
            'uncertain': '근거가 부족해 사람이 확인해야 함',
        },
    },
}

_key = {'value': None}


def at_minute(event=None):
    import sim
    raw = (event or {}).get('time')
    t = dt.datetime.fromisoformat(raw.replace('Z', '+00:00')).astimezone(sim.KST) if raw else sim.now()
    return t.replace(second=0, microsecond=0)


def is_idle(room, t, schedules):
    import sim
    return all(s['onOff'] and s['occupants'] == 0
               for s in (sim.state(room, t - dt.timedelta(minutes=m), schedules) for m in IDLE_MINUTES))


def hours_facts(room, b, t):
    """운영 시간 안팎과 경계까지의 분. 주말 미운영 건물의 주말은 하루 전체가 운영 시간 밖"""
    h0, h1 = room.get('hours', (9, 18))
    workday = t.weekday() < 5 or bool(b.get('weekend'))
    start = t.replace(hour=h0, minute=0)
    end = t.replace(hour=0, minute=0) + dt.timedelta(hours=h1)  # 24시 운영 종료도 처리
    inside = workday and start <= t < end
    minutes = lambda a, z: int((z - a).total_seconds() // 60)  # noqa: E731
    return {
        'workday': workday,
        'inOperatingHours': inside,
        'minutesSinceClose': minutes(end, t) if workday and t >= end else None,
        'minutesUntilOpen': minutes(t, start) if workday and t < start else None,
        'minutesUntilClose': minutes(t, end) if inside else None,
    }


def usage_facts(room, t, schedules):
    """오늘 0시~지금(15분 간격)과 최근 7일 같은 시각의 재실·운전 기록에서 계산한 사실"""
    import sim
    day0 = t.replace(hour=0, minute=0)
    slots = []
    s_t = t
    while s_t >= day0:
        slots.append((s_t, sim.state(room, s_t, schedules)))
        s_t -= dt.timedelta(minutes=STEP)
    # slots[0]이 지금, 뒤로 갈수록 과거
    idle_slots = 0
    for s_t, s in slots:
        if not (s['onOff'] and s['occupants'] == 0) or (t - s_t).total_seconds() / 60 > IDLE_LOOKBACK:
            break
        idle_slots += 1
    last = next(((s_t, s) for s_t, s in slots if s['occupants'] > 0), None)
    week = sum(sim.state(room, t - dt.timedelta(days=d), schedules)['occupants'] > 0 for d in range(1, 8))
    return {
        'idleOnMinutes': (idle_slots - 1) * STEP if idle_slots else 0,
        'idleOnCapped': idle_slots * STEP > IDLE_LOOKBACK,
        'idleEnergyKwh': round(sum(s['powerKw'] for _, s in slots[:idle_slots]) * STEP / 60, 2),
        'lastOccupiedAt': last[0].strftime('%H:%M') if last else None,
        'minutesSinceLastOccupied': int((t - last[0]).total_seconds() // 60) if last else None,
        'occupiedSlotsToday': sum(s['occupants'] > 0 for _, s in slots),
        'slotsToday': len(slots),
        'usedAtThisTimeLast7Days': int(week),
    }


def jev_state(b, room, t, schedules, facts=True):
    """Jev에 넘기는 근거(사실만, 판단 문구 없음). facts=False는 파생 사실 없는 이전 형식(비교 실험용)"""
    import sim
    recent = []
    for m in IDLE_MINUTES:
        s = sim.state(room, t - dt.timedelta(minutes=m), schedules)
        recent.append({'minutesAgo': m, 'occupants': s['occupants'], 'onOff': s['onOff'], 'powerKw': s['powerKw'],
                       'temp': s['temp'], 'setpoint': s['setpoint']})
    h0, h1 = room.get('hours', (9, 18))
    out = {
        'building': {'name': b['name'], 'use': b['use'], 'operatingHours': f'{h0:02d}~{h1:02d}시', 'weekendOperation': bool(b.get('weekend'))},
        'now': t.isoformat(), 'weekday': '월화수목금토일'[t.weekday()],
        'room': {'name': room['name'], 'use': room['use'], 'floor': room['floor'], 'areaM2': room['areaM2']},
        'recent': recent,
    }
    if facts:
        out['facts'] = {**hours_facts(room, b, t), **usage_facts(room, t, schedules), 'sampleMinutes': STEP}
    return out


def _api_key():
    if _key['value'] is None:
        import boto3
        raw = boto3.client('secretsmanager').get_secret_value(SecretId=os.environ['JEV_SECRET_ID'])['SecretString'].strip()
        if raw.startswith('{'):
            d = json.loads(raw)
            raw = d.get('apiKey') or d.get('key') or ''
        _key['value'] = raw.strip()
    return _key['value']


def ask_jev(state):
    """{'choice', 'confidence', 'probabilities'}. 실패는 예외(호출 측에서 폴백)"""
    body = {'model': os.environ.get('JEV_MODEL', 'jev-latest'), 'state': state, 'questions': QUESTIONS}
    req = urllib.request.Request(os.environ.get('JEV_URL', JEV_URL), json.dumps(body, ensure_ascii=False).encode(),
                                 {'Authorization': f'Bearer {_api_key()}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        a = json.loads(r.read(1_000_000)).get('answers', {}).get('room_empty') or {}
    if a.get('choice') not in QUESTIONS['room_empty']['criteria']:
        raise ValueError('Jev 응답에 room_empty 선택 없음')
    probs = {k: float(v) for k, v in (a.get('probabilities') or {}).items() if k in QUESTIONS['room_empty']['criteria']}
    return {'choice': a['choice'], 'confidence': float(a.get('confidence') or 0), 'probabilities': probs}


def judge(state, ask=None):
    """Jev 판단 또는 None(키 없음·호출 실패·응답 이상). 키·응답 원문은 로그에 남기지 않음"""
    try:
        return (ask or ask_jev)(state)
    except Exception as e:  # noqa: BLE001
        log.warning(json.dumps({'jev': 'failed', 'reason': type(e).__name__}))
        return None


def gate(answer, auto_apply, conf_min, empty_min):
    """빈 방 후보의 결정: 'skipped' · 'applied' · 'pending'
    - applied: empty 선택 + 확신도 ≥ conf_min + empty 확률 ≥ empty_min(확률이 없으면 자동 조치 안 함)
    """
    if answer and answer['choice'] == 'occupied' and answer['confidence'] >= conf_min:
        return 'skipped'
    if (auto_apply and answer and answer['choice'] == 'empty' and answer['confidence'] >= conf_min
            and (answer.get('probabilities') or {}).get('empty', 0) >= empty_min):
        return 'applied'
    return 'pending'


def setpoint_candidate(room, st, t, schedules):
    """과냉·과열 설정 근거 또는 None(recommend.py 'overset' 기준·절감량 계산 재사용)"""
    import recommend
    if not st['onOff']:
        return None
    sp = st['setpoint']
    if st['mode'] == 'cooling' and sp < recommend.COOL_MIN:
        target = recommend.COOL_MIN
    elif st['mode'] == 'heating' and sp > recommend.HEAT_MAX:
        target = recommend.HEAT_MAX
    else:
        return None
    # 저장할 스케줄과 같은 초안으로 절감량 계산(recommend.saving: 초안 시각~24시 전력 차이)
    saving = recommend.saving(room, t, schedules, oc.setpoint_schedule('', room['id'], target, t, ''))
    if saving <= 0:
        return None
    return {'mode': st['mode'], 'setpoint': sp, 'target': target, 'savingKwhDay': saving,
            'temp': st['temp'], 'powerKw': st['powerKw'], 'occupants': st['occupants'], 'rule': 'overset'}


def _base(bid, room, t, ttl):
    return {'buildingId': bid, 'roomId': room['id'], 'roomName': room['name'], 'floor': room['floor'], 'use': room['use'],
            'createdAt': t.isoformat(), 'ttl': ttl}


def rotation(t, n):
    """시작 건물 위치: 5분 실행마다 한 칸씩 이동(같은 건물이 늘 먼저 판단받지 않게)"""
    return int(t.timestamp() // 300) % n if n else 0


def fair_order(queues, start, limit):
    """건물별 대기열에서 한 건씩 돌아가며 limit건 선택: ([(건물, 후보)], [미룬 (건물, 후보)])
    - 건물 순서는 queues 순서를 start만큼 회전, 각 건물 안은 대기열 순서(전력량 큰 방부터)
    - 다른 건물 후보가 없으면 한 건물이 상한을 모두 써도 됨(남는 호출을 버리지 않음)
    """
    order = list(queues)
    order = order[start:] + order[:start]
    picked, idx = [], {b: 0 for b in order}
    while len(picked) < limit and any(idx[b] < len(queues[b]) for b in order):
        for b in order:
            if len(picked) >= limit:
                break
            if idx[b] < len(queues[b]):
                picked.append((b, queues[b][idx[b]]))
                idx[b] += 1
    deferred = [(b, c) for b in order for c in queues[b][idx[b]:]]
    return picked, deferred


def run(t, schedules, ask=None, write=True):
    """전 건물 1회 판단. write=False면 저장 없이 결정 목록만 반환(로컬 dry-run)"""
    import buildings
    import sim
    conf_min = oc.env_float('AUTO_APPLY_CONFIDENCE', 0.8)
    empty_min = oc.env_float('AUTO_APPLY_EMPTY_PROB', 0.9)
    ttl_min = oc.env_int('SUGGESTION_TTL_MIN', 30)
    cooldown = oc.env_int('COOLDOWN_MIN', 120)
    max_jev = oc.env_int('MAX_JEV_PER_RUN', 10)
    max_sp = oc.env_int('MAX_SETPOINT_PER_BUILDING', 5)
    since = t - dt.timedelta(minutes=max(cooldown, ttl_min) + 5)
    ttl = int((t + dt.timedelta(days=oc.HISTORY_DAYS)).timestamp())
    out, counts = [], {'pending': 0, 'applied': 0, 'skipped': 0, 'alert': 0, 'expired': 0, 'deferred': 0, 'setpoint': 0}
    buildings.forget()
    # 1) 건물별 후보 수집: 이상은 바로 알림, 빈 방 운전은 Jev 판단 대기열(빈 채 운전 전력량 큰 방부터)
    queues, ctx = {}, {}
    for b in buildings.LIST:
        bid = b['id']
        settings = oc.get_settings(bid) if write else {'autoApply': False}
        recent = oc.recent_decisions(bid, since) if write else []
        for d in recent:
            if oc.is_expired(d, t) and oc.update_status(bid, d['decisionId'], 'expired', t):
                d['status'] = 'expired'
                counts['expired'] += 1
        blocked = oc.blocked_rooms(recent, t, cooldown)
        ctx[bid] = (b, settings)
        setpoints = []
        for room in buildings.rooms(bid):
            if room.get('active') is False:
                continue
            rid = room['id']
            st = sim.state(room, t, schedules)
            if st['anomaly'] and ('anomaly', rid) not in blocked:
                out.append({**_base(bid, room, t, ttl), 'decisionId': oc.new_decision_id(t), 'kind': 'anomaly', 'status': 'alert',
                            'message': oc.anomaly_message(room, st),
                            'evidence': {k: st[k] for k in ('temp', 'setpoint', 'mode', 'onOff', 'anomaly')}})
                counts['alert'] += 1
            if is_idle(room, t, schedules):
                # 빈 방 운전은 끄기가 우선(recommend.py와 같은 순서): 설정온도 후보로 보지 않음
                if ('idle', rid) not in blocked:
                    queues.setdefault(bid, []).append((room, st, jev_state(b, room, t, schedules)))
                continue
            if ('setpoint', rid) not in blocked:
                ev = setpoint_candidate(room, st, t, schedules)
                if ev:
                    setpoints.append((room, ev))
        # 설정온도 제안: Jev 없이 규칙으로 결정, 건물당 절감량 큰 방부터 상한까지
        setpoints.sort(key=lambda c: (-c[1]['savingKwhDay'], c[0]['id']))
        for room, ev in setpoints[:max_sp]:
            status = 'applied' if settings['autoApply'] else 'pending'
            item = {**_base(bid, room, t, ttl), 'decisionId': oc.new_decision_id(t), 'kind': 'setpoint', 'status': status,
                    'autoApply': settings['autoApply'], 'evidence': ev}
            if status == 'applied':
                sched = oc.setpoint_schedule(bid, room['id'], ev['target'], t,
                                             f"{room['floor']} {room['name']} 설정온도 {ev['setpoint']:g}→{ev['target']:g}℃")
                if write:
                    oc.save_schedule(sched)
                item.update(scheduleId=sched['id'], message=oc.setpoint_applied_message(room, ev), decidedAt=t.isoformat(), decidedBy=oc.SOURCE)
            else:
                item.update(message=oc.setpoint_message(room, ev), expiresAt=(t + dt.timedelta(minutes=ttl_min)).isoformat())
            out.append(item)
            counts[status] += 1
            counts['setpoint'] += 1
    for q in queues.values():
        q.sort(key=lambda c: (-c[2]['facts']['idleEnergyKwh'], c[0]['id']))
    # 2) Jev 호출 상한을 건물별로 한 건씩 돌아가며 배분, 시작 건물은 실행마다(5분 단위) 바뀜
    picked, deferred = fair_order(queues, rotation(t, len(queues)), max_jev)
    counts['deferred'] = len(deferred)
    # 3) 판단·결정
    for bid, (room, st, state) in picked:
        b, settings = ctx[bid]
        answer = judge(state, ask)
        status = gate(answer, settings['autoApply'], conf_min, empty_min)
        minutes = max(IDLE_MINUTES[-1], state['facts']['idleOnMinutes'])
        label = oc.duration(minutes, state['facts']['idleOnCapped'])
        item = {**_base(bid, room, t, ttl), 'decisionId': oc.new_decision_id(t), 'kind': 'idle', 'status': status, 'jev': answer,
                'autoApply': settings['autoApply'], 'evidence': {'recent': state['recent'], 'facts': state['facts']}}
        if status == 'applied':
            sched = oc.off_schedule(bid, room['id'], t, f"{room['floor']} {room['name']} {label} 재실 0명")
            if write:
                oc.save_schedule(sched)
            item.update(scheduleId=sched['id'], message=oc.applied_message(room, label), decidedAt=t.isoformat(), decidedBy=oc.SOURCE)
        elif status == 'pending':
            item.update(message=oc.idle_message(room, label, st['powerKw']),
                        expiresAt=(t + dt.timedelta(minutes=ttl_min)).isoformat())
        else:
            item.update(message=None, decidedAt=t.isoformat(), decidedBy='Jev')
        out.append(item)
        counts[status] += 1
    jev_calls = len(picked)
    if write:
        for item in out:
            oc.put_decision({k: v for k, v in item.items() if v is not None})
    return out, counts, jev_calls


def handler(event, context):
    import common
    t0 = time.monotonic()
    t = at_minute(event)
    _, counts, calls = run(t, common.list_schedules())
    summary = {'at': t.isoformat(), **counts, 'jevCalls': calls, 'ms': round((time.monotonic() - t0) * 1000)}
    log.info(json.dumps(summary))
    return summary


if __name__ == '__main__':
    import argparse
    import pathlib
    import sys

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / 'src'))
    a = argparse.ArgumentParser(description='auto-operator 로컬 실행(저장·Jev 호출 없음)')
    a.add_argument('--dry-run', action='store_true', required=True)
    a.add_argument('--at', help='기준 시각 ISO(KST), 기본 현재')
    args = a.parse_args()
    if not sys.flags.utf8_mode:
        sys.exit('python -X utf8 로 실행하십시오(팀 모듈의 JSON 읽기가 시스템 인코딩을 따름)')
    import sim
    t = (dt.datetime.fromisoformat(args.at).replace(tzinfo=sim.KST) if args.at else sim.now()).replace(second=0, microsecond=0)
    os.environ.setdefault('MAX_JEV_PER_RUN', '1000')
    t1 = time.monotonic()
    out, counts, calls = run(t, [], ask=lambda s: {'choice': 'uncertain', 'confidence': 0.5}, write=False)
    print(f'기준 {t.isoformat()} 결정 {len(out)}건 {counts} 판단 대상 {calls} 계산 {round((time.monotonic() - t1) * 1000)}ms')
    for item in out[:5]:
        print(' ', item['kind'], item['status'], item.get('message'))
