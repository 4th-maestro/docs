"""HVAC 설정온도 제어기 2종: 규칙 기반, JEV 기반. EnergyPlus 연결과 평가는 run.py

- 제어 주기 15분, 출력은 공간별 (운전 상태, 설정온도). 운전 상태 OFF, FAN, COOL, HEAT
- 계절별 운전 모드 고정(냉방 시나리오에서 HEAT 없음), 설정온도 변경은 주기당 최대 ±1℃
- JEV: TypeSafe 직접 호출 POST https://api.typesafe.ai/v1/systemone, 공간마다 choice 질문 1개
"""
import datetime as dt
import json
import os
import pathlib
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
STEP_MIN = 15
PRE_MIN = 30  # 사용 시작 30분 전부터 재실 설정
TOL = 0.5  # 쾌적 판정 허용 오차(℃)
SEASON = {
    'cooling': {'name': '냉방', 'mode': 'COOL', 'comfort': (24, 26), 'occ_sp': 26, 'vac_sp': 28, 'sp_range': (23, 28)},
    'heating': {'name': '난방', 'mode': 'HEAT', 'comfort': (20, 22), 'occ_sp': 20, 'vac_sp': 16, 'sp_range': (16, 23)},
}

# EnergyPlus VariableRefrigerantFlow_5Zone 예제의 5구역. 창 방위는 건물 북쪽축 30° 반영, 면적은 창+유리문
# 실내기 용량은 부산 설계일 자동 크기 산정 결과(eplusout.eio)
ZONES = {
    'SPACE1-1': {'tu': 'TU1', 'use': '사무실 A', 'area_m2': 99.2, 'window': '남서 21.8㎡', 'exterior_wall': True, 'hvac': 'VRF 실내기 냉방 8.1kW·난방 8.6kW'},
    'SPACE2-1': {'tu': 'TU2', 'use': '회의실 A', 'area_m2': 42.7, 'window': '남동 9.1㎡', 'exterior_wall': True, 'hvac': 'VRF 실내기 냉방 5.7kW·난방 5.7kW'},
    'SPACE3-1': {'tu': 'TU3', 'use': '교육실', 'area_m2': 96.5, 'window': '북동 20.8㎡', 'exterior_wall': True, 'hvac': 'VRF 실내기 냉방 7.7kW·난방 7.7kW'},
    'SPACE4-1': {'tu': 'TU4', 'use': '회의실 B', 'area_m2': 42.7, 'window': '북서 9.1㎡', 'exterior_wall': True, 'hvac': 'VRF 실내기 냉방 5.5kW·난방 5.5kW'},
    'SPACE5-1': {'tu': 'TU5', 'use': '사무실 B(내부)', 'area_m2': 182.5, 'window': '없음', 'exterior_wall': False, 'hvac': 'VRF 실내기 냉방 10.5kW·난방 10.5kW'},
}
WEEKDAYS = (0, 1, 2, 3, 4)
# 사용 일정: (요일, 시작, 종료, 인원). 요일 0=월. 인원은 예제 모델 설계 인원 이하
USES = {
    'SPACE1-1': [(WEEKDAYS, '09:00', '18:00', 10)],
    'SPACE2-1': [((0, 2, 4), '10:00', '11:30', 5), ((1, 3), '14:00', '16:00', 5)],
    'SPACE3-1': [((0, 2, 4), '13:00', '16:00', 10), ((1,), '09:30', '12:00', 8)],
    'SPACE4-1': [(WEEKDAYS, '15:30', '17:30', 5)],
    'SPACE5-1': [(WEEKDAYS, '08:30', '18:30', 18)],
}


def occupancy(zone, t):
    """t 시작 15분 구간의 재실 인원과 다음 사용(시작까지 분, 인원, 지속 분). 다음 사용이 7일 안에 없으면 None"""
    now, nxt = 0, None
    for d in range(8):
        date = t.date() + dt.timedelta(days=d)
        for days, s, e, n in USES[zone]:
            if date.weekday() not in days:
                continue
            start, end = (dt.datetime.combine(date, dt.time.fromisoformat(x)) for x in (s, e))
            if start <= t < end:
                now += n
            elif start > t and (nxt is None or start < nxt[0]):
                nxt = (start, end, n)
    if nxt is None:
        return now, None
    return now, {'in_min': int((nxt[0] - t).total_seconds() // 60), 'people': nxt[2], 'duration_min': int((nxt[1] - nxt[0]).total_seconds() // 60)}


def step_toward(sp, target):
    return sp + max(-1, min(1, target - sp))


def rule(season, z):
    """규칙 기반: 재실 중이거나 사용 시작 30분 이내면 재실 설정, 아니면 공실 설정. 운전 모드 고정, OFF 없음"""
    c = SEASON[season]
    occ = z['people'] > 0 or (z['next_use'] is not None and z['next_use']['in_min'] <= PRE_MIN)
    return c['mode'], step_toward(z['setpoint_c'], c['occ_sp'] if occ else c['vac_sp'])


def candidates(season, sp):
    """JEV 선택지: OFF, FAN, 운전 모드 × (현재 설정 -1, 0, +1℃). 설정 범위 밖 값 제외"""
    c = SEASON[season]
    lo, hi = c['sp_range']
    # 2차(조정 1회): OFF·FAN의 효과와 부적합 조건을 설명에 명시. 1차는 효과만 기술
    out = {'OFF': ('OFF', sp, '실내기 정지. HVAC 전력 0. 실내온도는 일사·인원·조명 발열로 계속 변함. 재실 중 comfort_gap_c가 0이 아닌 공간에는 부적합'),
           'FAN': ('FAN', sp, f'송풍만 운전. {c["name"]} 없음, 팬 전력 소량. 외기를 도입하므로 outdoor_minus_indoor_c가 음수이면 실내온도를 낮춤')}
    for s in sorted({max(lo, min(hi, sp + d)) for d in (-1, 0, 1)}):
        diff = '현재 설정 유지' if s == sp else f'현재 설정 대비 {s - sp:+d}℃'
        out[f'{c["mode"]}_{s}'] = (c['mode'], s, f'{c["name"]} 설정 {s}℃({diff})')
    return out


INSTRUCTIONS = (
    'state.zones["{zone}"] 공간의 다음 15분 HVAC 운전을 선택하라. '
    '목표는 재실 중 실내온도를 {lo}~{hi}℃(허용 오차 ±{tol}℃) 안에 유지하면서 건물 HVAC 전력을 최소화하는 것이다. '
    '재실 중 쾌적 범위 이탈 방지가 절전보다 우선이다. '
    'occupied_now가 true이고 comfort_gap_c가 0이 아니면 실내온도를 범위 쪽으로 움직이는 선택지를 골라라. {fix} '
    '다음 사용 시작 시각에 실내온도가 범위 안에 있도록 최근 온도 변화율을 보고 미리 운전하라. 설정온도는 15분마다 최대 1℃만 바뀐다. '
    '비어 있고 다음 사용까지 시간이 충분하면 OFF를 선택하라. {save}'
)
FIX = {'cooling': 'comfort_gap_c가 양수이면 가장 낮은 냉방 설정을 고른다.',
       'heating': 'comfort_gap_c가 음수이면 가장 높은 난방 설정, 양수이면 외기가 더 차가울 때 FAN, 아니면 OFF를 고른다.'}
SAVE = {'cooling': '냉방 설정온도가 높을수록 전력이 적다.', 'heating': '난방 설정온도가 낮을수록 전력이 적다.'}


def api_key():
    key = os.environ.get('TYPESAFE_API_KEY')
    env = HERE / '.env'
    if not key and env.exists():
        key = next((ln.split('=', 1)[1].strip() for ln in env.read_text().splitlines() if ln.startswith('TYPESAFE_API_KEY=')), None)
    return key


class Jev:
    URL = 'https://api.typesafe.ai/v1/systemone'

    def __init__(self, season):
        self.season, self.key = season, api_key()
        if not self.key:
            raise SystemExit('TYPESAFE_API_KEY 없음: 환경 변수 또는 ml/hvac_control/.env에 입력하십시오.')
        self.model = os.environ.get('JEV_MODEL', 'jev-latest')
        self.stats = {'calls': 0, 'errors': 0, 'fallback_steps': 0, 'invalid_choices': 0, 'input_tokens': 0, 'sec': 0.0, 'confidence': []}

    def post(self, body):
        req = urllib.request.Request(self.URL, json.dumps(body, ensure_ascii=False).encode(),
                                     {'Authorization': f'Bearer {self.key}', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    def decide(self, state):
        """state: run.py가 만든 건물 상태. 반환 {zone: (mode, sp)}, 실패한 공간은 규칙 기반으로 대체"""
        c = SEASON[self.season]
        cands = {z: candidates(self.season, s['setpoint_c']) for z, s in state['zones'].items()}
        instr = {z: INSTRUCTIONS.format(zone=z, lo=c['comfort'][0], hi=c['comfort'][1], tol=TOL, fix=FIX[self.season], save=SAVE[self.season]) for z in cands}
        body = {'model': self.model, 'state': state,
                'questions': {z: {'type': 'choice', 'instructions': instr[z], 'criteria': {k: v[2] for k, v in cs.items()}} for z, cs in cands.items()}}
        data, t0 = None, time.monotonic()
        for attempt in range(3):
            try:
                data = self.post(body)
                break
            except Exception as e:  # 네트워크·한도 오류는 재시도 후 규칙 기반으로 대체하고 횟수 기록
                self.stats['errors'] += 1
                self.stats['last_error'] = str(e)[:200]
                time.sleep(2 * (attempt + 1))
        self.stats['calls'] += 1
        self.stats['sec'] += time.monotonic() - t0
        if data is None:
            self.stats['fallback_steps'] += 1
            return {z: rule(self.season, s) for z, s in state['zones'].items()}, None
        self.stats['input_tokens'] += (data.get('usage') or {}).get('input_tokens', 0)
        out, raw = {}, {}
        for z, s in state['zones'].items():
            a = (data.get('answers') or {}).get(z) or {}
            pick = cands[z].get(a.get('choice'))
            if pick is None:
                self.stats['invalid_choices'] += 1
                out[z] = rule(self.season, s)
            else:
                out[z] = pick[:2]
                self.stats['confidence'].append(a.get('confidence'))
            raw[z] = {'choice': a.get('choice'), 'confidence': a.get('confidence')}
        return out, raw
