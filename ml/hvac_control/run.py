"""EnergyPlus 26.2 실행: 규칙 기반·JEV 기반 HVAC 설정온도 제어 비교

- 실행: python3 run.py --controller rule|jev --season cooling|heating --start 2026-08-03 --days 14
- 모델: EnergyPlus 예제 VariableRefrigerantFlow_5Zone(VRF 실외기 1대, 실내기 5대). 위치·설계일·기상은 부산 TMYx로 교체
- 15분 시간 간격마다 pyenergyplus 콜백으로 제어기 실행, 공간별 설정온도·실내기 가용·재실 인원 액추에이터 변경
- 출력: runs/<계절>-<제어기>-<시작일>-<일수>d/steps.csv(15분 기록), summary.json(지표)
"""
import argparse
import csv
import datetime as dt
import json
import os
import pathlib
import shutil
import subprocess
import sys

import control as C

HERE = pathlib.Path(__file__).resolve().parent
EP_DIR = pathlib.Path(os.environ.get('ENERGYPLUS_DIR', pathlib.Path.home() / '.local/opt/EnergyPlus-26.2.0-4bd7a1f26f-Darwin-macOS14.0-arm64'))
EPW = pathlib.Path(os.environ.get('EPW', pathlib.Path.home() / '.local/opt/epw-busan/KOR_PU_Busan-Daecheongdong.WS.471590_TMYx.2009-2023.epw'))
DESIGN_DAYS = ('Ann Clg .4% Condns DB=>MWB', 'Ann Htg 99.6% Condns DB')
HEIGHT_M = 2.44
NO_HEAT, NO_COOL = 5, 45  # 해당 코일을 쓰지 않을 때의 설정온도


def to_json(src, work):
    # EnergyPlus 변환 도구로 IDF·DDY를 epJSON으로 변환(DDY는 Version 객체가 없어 오류 종료하지만 변환 결과는 생성됨)
    dst, out = work / f'{src.stem}.idf', work / f'{src.stem}.epJSON'
    if not out.exists():  # 같은 작업 폴더의 반복 실행(DDPG 에피소드)은 변환 결과 재사용
        shutil.copy(src, dst)
        subprocess.run([str(EP_DIR / 'energyplus'), '--convert-only', '-d', str(work), str(dst)], capture_output=True)
    return json.loads(out.read_text())


def build(start, days, work):
    m = to_json(EP_DIR / 'ExampleFiles' / 'VariableRefrigerantFlow_5Zone.idf', work)
    ddy = to_json(EPW.with_suffix('.ddy'), work)
    m['Site:Location'] = ddy['Site:Location']
    m['SizingPeriod:DesignDay'] = {k: v for k, v in ddy['SizingPeriod:DesignDay'].items() if k.endswith(DESIGN_DAYS)}
    assert len(m['SizingPeriod:DesignDay']) == 2, '부산 설계일 2개(냉방 0.4%, 난방 99.6%)를 찾지 못함'
    m['SimulationControl']['SimulationControl 1']['run_simulation_for_sizing_periods'] = 'No'
    end = start + dt.timedelta(days=days - 1)
    m['RunPeriod'] = {'eval': {
        'begin_year': start.year, 'begin_month': start.month, 'begin_day_of_month': start.day,
        'end_year': end.year, 'end_month': end.month, 'end_day_of_month': end.day,
        'use_weather_file_daylight_saving_period': 'No', 'use_weather_file_holidays_and_special_days': 'No',
        'use_weather_file_rain_indicators': 'Yes', 'use_weather_file_snow_indicators': 'Yes', 'apply_weekend_holiday_rule': 'No'}}
    # 실내기별 정지 제어: 공용 가용 스케줄을 실내기별 상수 스케줄로 분리, 예제의 야간 순환 운전 관리자 제거
    for info in C.ZONES.values():
        tu = m['ZoneHVAC:TerminalUnit:VariableRefrigerantFlow'][info['tu']]
        tu.pop('availability_manager_list_name', None)
        m.setdefault('Schedule:Constant', {})[f'{info["tu"]} Avail'] = {'hourly_value': 1, 'schedule_type_limits_name': 'Fraction'}
        tu['terminal_unit_availability_schedule'] = f'{info["tu"]} Avail'
    m['Fan:SystemModel']['TU1 VRF Supply Fan']['availability_schedule_name'] = 'VRFAvailSched'  # 예제는 야간 순환 시연용 07~17시 스케줄
    for k in ('AvailabilityManager:NightCycle', 'AvailabilityManagerAssignmentList', 'Output:Variable', 'Output:Meter',
              'Output:Meter:MeterFileOnly', 'Output:Surfaces:Drawing', 'Output:VariableDictionary'):
        m.pop(k, None)
    path = work / 'in.epJSON'
    path.write_text(json.dumps(m))
    return path


def sensors():
    out = {'oat': ('Site Outdoor Air Drybulb Temperature', 'Environment'), 'orh': ('Site Outdoor Air Relative Humidity', 'Environment'),
           'dir': ('Site Direct Solar Radiation Rate per Area', 'Environment'), 'dif': ('Site Diffuse Solar Radiation Rate per Area', 'Environment'),
           'hvac_w': ('Facility Total HVAC Electricity Demand Rate', 'Whole Building')}
    for z, info in C.ZONES.items():
        out |= {f'{z}.temp': ('Zone Mean Air Temperature', z), f'{z}.rh': ('Zone Air Relative Humidity', z),
                f'{z}.lights_w': ('Zone Lights Electricity Rate', z), f'{z}.equip_w': ('Zone Electric Equipment Electricity Rate', z),
                f'{z}.cool_w': ('Zone VRF Air Terminal Total Cooling Rate', info['tu']), f'{z}.heat_w': ('Zone VRF Air Terminal Total Heating Rate', info['tu'])}
    return out


def score(rows, season):
    """지표: HVAC 전력량(kWh), 최대 15분 평균 전력(kW), 재실 중 쾌적 범위(허용 오차 포함) 이탈 시간·온도시간"""
    lo, hi = C.SEASON[season]['comfort']
    h = C.STEP_MIN / 60
    out = {'energy_kwh': round(sum(r['hvac_kwh'] for r in rows), 2), 'peak_kw': round(max(r['hvac_kwh'] for r in rows) / h, 2),
           'occupied_zone_h': 0.0, 'discomfort_zone_h': 0.0, 'discomfort_degree_h': 0.0, 'zones': {}}
    any_occ = [any(r[f'{z}.people'] > 0 for z in C.ZONES) for r in rows]
    out['energy_kwh_occupied'] = round(sum(r['hvac_kwh'] for r, o in zip(rows, any_occ) if o), 2)
    out['energy_kwh_vacant'] = round(out['energy_kwh'] - out['energy_kwh_occupied'], 2)
    for z in C.ZONES:
        occ = [r[f'{z}.temp'] for r in rows if r[f'{z}.people'] > 0]
        dev = [max(lo - C.TOL - t, t - hi - C.TOL, 0) for t in occ]
        zs = {'occupied_h': len(dev) * h, 'discomfort_h': sum(d > 0 for d in dev) * h, 'discomfort_degree_h': round(sum(dev) * h, 2),
              'cold_h': sum(t < lo - C.TOL for t in occ) * h, 'hot_h': sum(t > hi + C.TOL for t in occ) * h}
        out['zones'][z] = zs
        for k in ('occupied', 'discomfort', 'cold', 'hot'):
            out[f'{k}_zone_h'] = out.get(f'{k}_zone_h', 0) + zs[f'{k}_h']
        out['discomfort_degree_h'] = round(out['discomfort_degree_h'] + zs['discomfort_degree_h'], 2)
    out['discomfort_pct'] = round(100 * out['discomfort_zone_h'] / out['occupied_zone_h'], 1) if out['occupied_zone_h'] else 0
    return out


def simulate(controller, season, start, days, out):
    sys.path.insert(0, str(EP_DIR))
    from pyenergyplus.api import EnergyPlusAPI
    api = EnergyPlusAPI()
    ex = api.exchange
    s0 = api.state_manager.new_state()
    api.runtime.set_console_output_status(s0, False)
    work = out / 'eplus'
    work.mkdir(parents=True, exist_ok=True)
    model = build(start, days, work)
    sen = sensors()
    for name, key in sen.values():
        ex.request_variable(s0, name, key)
    c = C.SEASON[season]
    # controller: 'rule', 'jev', 또는 decide(state)·stats를 가진 판단 객체(ddpg.py). 판단 객체는 JEV와 같은 상태를 받음
    jev = C.Jev(season) if controller == 'jev' else None if controller == 'rule' else controller
    h, act, err, rows = {}, {}, [], []
    cur = {z: (c['mode'], c['vac_sp']) for z in C.ZONES}  # 두 제어기 모두 공실 설정으로 시작
    changed = {z: None for z in C.ZONES}
    st = {'t': None, 'j': 0.0, 'zs': None, 'raw': None}
    v = lambda s, k: ex.get_variable_value(s, h[k])  # noqa: E731

    def ready(s):
        if not h:
            if not ex.api_data_fully_ready(s):
                return False
            h.update({k: ex.get_variable_handle(s, n, key) for k, (n, key) in sen.items()})
            for z, info in C.ZONES.items():
                act[z] = {'heat': ex.get_actuator_handle(s, 'Zone Temperature Control', 'Heating Setpoint', z),
                          'cool': ex.get_actuator_handle(s, 'Zone Temperature Control', 'Cooling Setpoint', z),
                          'avail': ex.get_actuator_handle(s, 'Schedule:Constant', 'Schedule Value', f'{info["tu"]} Avail'),
                          'people': ex.get_actuator_handle(s, 'People', 'Number of People', f'{z} People 1')}
            bad = [k for k, x in h.items() if x < 0] + [f'{z}.{k}' for z, a in act.items() for k, x in a.items() if x < 0]
            if bad:
                err.append(f'핸들 없음: {bad}')
                api.runtime.stop_simulation(s)
                return False
        return ex.kind_of_sim(s) == 3  # 기상 파일 실행 기간만(설계일 크기 산정 제외)

    def now(s):
        return dt.datetime(start.year, ex.month(s), ex.day_of_month(s)) + dt.timedelta(minutes=ex.hour(s) * 60 + (ex.zone_time_step_number(s) - 1) * C.STEP_MIN)

    def apply(s, z, mode, sp):
        a = act[z]
        ex.set_actuator_value(s, a['avail'], 0 if mode == 'OFF' else 1)  # FAN은 가용 1, 두 설정온도를 넓혀 코일 정지(예제 팬은 연속 운전)
        ex.set_actuator_value(s, a['heat'], sp if mode == 'HEAT' else NO_HEAT)
        ex.set_actuator_value(s, a['cool'], sp if mode == 'COOL' else NO_COOL)

    def zone_now(s, z, zs):
        recent = rows[-4:]
        hist = [r[f'{z}.temp'] for r in recent]
        temp, (lo, hi) = v(s, f'{z}.temp'), c['comfort']
        # 2차(조정 1회): 재실 여부, 쾌적 범위 차이, 외기-실내 차를 앞에 명시
        return {'occupied_now': zs['people'] > 0, 'comfort_gap_c': round(temp - hi if temp > hi else temp - lo if temp < lo else 0, 2),
                'outdoor_minus_indoor_c': round(v(s, 'oat') - temp, 1), 'use': C.ZONES[z]['use'], 'area_m2': C.ZONES[z]['area_m2'], 'height_m': HEIGHT_M, 'window': C.ZONES[z]['window'],
                'exterior_wall': C.ZONES[z]['exterior_wall'], 'hvac': C.ZONES[z]['hvac'], 'temp_c': round(v(s, f'{z}.temp'), 2), 'rh_pct': round(v(s, f'{z}.rh')),
                'people_now': zs['people'], 'lights_kw': round(v(s, f'{z}.lights_w') / 1000, 2), 'equip_kw': round(v(s, f'{z}.equip_w') / 1000, 2),
                'mode': zs['mode'], 'setpoint_c': zs['setpoint_c'],
                'hvac_output_kw': round((v(s, f'{z}.cool_w') if c['mode'] == 'COOL' else v(s, f'{z}.heat_w')) / 1000, 2),
                'temp_change_c_per_h': round((hist[-1] - hist[0]) / ((len(hist) - 1) * C.STEP_MIN / 60), 2) if len(hist) > 1 else None,
                'min_since_setting_change': int((now(s) - changed[z]).total_seconds() // 60) if changed[z] else None,
                'recent_15min': [{'time': r['time'][-5:], 'temp_c': r[f'{z}.temp'], 'mode': r[f'{z}.mode'], 'setpoint_c': r[f'{z}.sp']} for r in recent],
                'next_use': zs['next_use']}

    def jev_state(s, t, zs):
        lo, hi = c['comfort']
        return {'time': f'{t:%Y-%m-%d %H:%M}({"월화수목금토일"[t.weekday()]})', 'season': c['name'],
                'goal': {'comfort_c': [lo, hi], 'tolerance_c': C.TOL, 'priority': '재실 중 쾌적 우선, 그다음 절전',
                         'setpoint_range_c': list(c['sp_range']), 'max_setpoint_change_c': 1, 'step_min': C.STEP_MIN},
                'outdoor': {'temp_c': round(v(s, 'oat'), 1), 'rh_pct': round(v(s, 'orh')), 'solar_w_m2': round(v(s, 'dir') + v(s, 'dif'))},
                'hvac_system': 'VRF 히트펌프 실외기 1대, 공간별 실내기 1대(연속 팬, 외기 도입)',
                'building_hvac_kw_last_15min': round(rows[-1]['hvac_kwh'] * 4, 2) if rows else None,
                'zones': {z: zone_now(s, z, x) for z, x in zs.items()}}

    def on_begin(s):
        if not ready(s):
            return
        t = now(s)
        if t == st['t'] and not ex.warmup_flag(s):
            return  # 같은 15분 구간의 시스템 하위 시간 간격
        zs = {}
        for z in C.ZONES:
            people, nxt = C.occupancy(z, t)
            ex.set_actuator_value(s, act[z]['people'], people)
            zs[z] = {'people': people, 'next_use': nxt, 'mode': cur[z][0], 'setpoint_c': cur[z][1]}
        if ex.warmup_flag(s):
            for z in C.ZONES:
                apply(s, z, *cur[z])
            return
        st['t'] = t
        if jev:
            decided, st['raw'] = jev.decide(jev_state(s, t, zs))
        else:
            decided = {z: C.rule(season, x) for z, x in zs.items()}
        for z, (mode, sp) in decided.items():
            if (mode, sp) != cur[z]:
                changed[z] = t
            cur[z] = (mode, sp)
            apply(s, z, mode, sp)
        st['zs'] = zs

    def on_end_system(s):
        if ready(s) and not ex.warmup_flag(s) and st['t'] is not None:
            st['j'] += v(s, 'hvac_w') * ex.system_time_step(s) * 3600

    def on_end_zone(s):
        if not ready(s) or ex.warmup_flag(s) or st['t'] is None:
            return
        row = {'time': st['t'].strftime('%Y-%m-%d %H:%M'), 'outdoor_c': round(v(s, 'oat'), 2), 'hvac_kwh': round(st['j'] / 3.6e6, 4)}
        st['j'] = 0.0
        for z in C.ZONES:
            raw = (st['raw'] or {}).get(z) or {}
            row |= {f'{z}.temp': round(v(s, f'{z}.temp'), 2), f'{z}.people': st['zs'][z]['people'],
                    f'{z}.mode': cur[z][0], f'{z}.sp': cur[z][1], f'{z}.conf': raw.get('confidence')}
        rows.append(row)
        if isinstance(jev, C.Jev) and len(rows) % 96 == 0:
            print(f'{row["time"]} JEV 호출 {jev.stats["calls"]}회, 오류 {jev.stats["errors"]}회', flush=True)

    api.runtime.callback_begin_system_timestep_before_predictor(s0, on_begin)
    api.runtime.callback_end_system_timestep_after_hvac_reporting(s0, on_end_system)
    api.runtime.callback_end_zone_timestep_after_zone_reporting(s0, on_end_zone)
    code = api.runtime.run_energyplus(s0, ['-d', str(work), '-w', str(EPW), str(model)])
    api.state_manager.delete_state(s0)  # 실행마다 약 90MB 누적 방지(DDPG 1일 에피소드 반복)
    if err or code != 0 or not rows:
        raise SystemExit(f'EnergyPlus 실행 실패(종료 코드 {code}): {err or "기록 없음"}, 로그 {work / "eplusout.err"}')
    return rows, jev


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--controller', choices=['rule', 'jev'], required=True)
    ap.add_argument('--season', choices=list(C.SEASON), required=True)
    ap.add_argument('--start', type=dt.date.fromisoformat, required=True)
    ap.add_argument('--days', type=int, default=7)
    a = ap.parse_args()
    out = HERE / 'runs' / f'{a.season}-{a.controller}-{a.start}-{a.days}d'
    rows, jev = simulate(a.controller, a.season, a.start, a.days, out)
    with open(out / 'steps.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    summary = {'controller': a.controller, 'season': a.season, 'start': str(a.start), 'days': a.days, 'steps': len(rows), **score(rows, a.season)}
    if jev:
        conf = [x for x in jev.stats.pop('confidence') if x is not None]
        summary['jev'] = {**jev.stats, 'model': jev.model, 'sec': round(jev.stats['sec'], 1),
                          'confidence_mean': round(sum(conf) / len(conf), 3) if conf else None,
                          'confidence_below_0_8': sum(x < 0.8 for x in conf)}
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps({k: x for k, x in summary.items() if k != 'zones'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
