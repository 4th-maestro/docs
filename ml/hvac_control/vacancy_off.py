"""공실 OFF 규칙 실행: 규칙 기반 + 공실 OFF(사용 N분 전 재가동)를 JEV 기반과 같은 조건으로 비교

- 실행: python3 vacancy_off.py --season cooling --start 2026-08-03 --days 14 --lead 30 60 90
- 규칙: 재실 중이거나 다음 사용까지 N분 이내면 운전 모드·재실 설정, 그 외 OFF. OFF 중에는 설정값을 재실 설정으로 옮겨 두어 재가동 즉시 재실 설정으로 운전
- run.py, control.py는 수정하지 않음. run.simulate의 규칙 기반 경로가 호출하는 control.rule만 교체(2026-11-20 대안 A 비교)
- 출력: runs/<계절>-vacoff<N>-<시작>-<일수>d/(steps.csv, summary.json), results/에 summary 사본
"""
import argparse
import csv
import datetime as dt
import json
import pathlib
import shutil

import control as C
import run as R

HERE = pathlib.Path(__file__).resolve().parent


def vacancy_off(lead_min):
    def rule(season, z):
        c = C.SEASON[season]
        occ = z['people'] > 0 or (z['next_use'] is not None and z['next_use']['in_min'] <= lead_min)
        sp = C.step_toward(z['setpoint_c'], c['occ_sp'])
        return (c['mode'], sp) if occ else ('OFF', sp)
    return rule


def periods(rows):
    # 시간대별 전력량: 평일 08~19시, 평일 야간, 주말(HVAC 제어 방식 비교 표 5.2와 같은 구분)
    out = {'weekday_day_kwh': 0.0, 'weekday_night_kwh': 0.0, 'weekend_kwh': 0.0}
    for r in rows:
        t = dt.datetime.strptime(r['time'], '%Y-%m-%d %H:%M')
        k = 'weekend_kwh' if t.weekday() >= 5 else 'weekday_day_kwh' if 8 <= t.hour < 19 else 'weekday_night_kwh'
        out[k] += r['hvac_kwh']
    return {k: round(v, 1) for k, v in out.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', choices=list(C.SEASON), required=True)
    ap.add_argument('--start', type=dt.date.fromisoformat, required=True)
    ap.add_argument('--days', type=int, default=14)
    ap.add_argument('--lead', type=int, nargs='+', default=[30, 60, 90], help='사용 시작 몇 분 전에 재가동할지')
    a = ap.parse_args()
    original = C.rule
    for n in a.lead:
        C.rule = vacancy_off(n)
        try:
            out = HERE / 'runs' / f'{a.season}-vacoff{n}-{a.start}-{a.days}d'
            rows, _ = R.simulate('rule', a.season, a.start, a.days, out)
        finally:
            C.rule = original
        with open(out / 'steps.csv', 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        summary = {'controller': f'vacoff{n}', 'lead_min': n, 'season': a.season, 'start': str(a.start), 'days': a.days, 'steps': len(rows),
                   **R.score(rows, a.season), 'periods': periods(rows)}
        (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        shutil.copy(out / 'summary.json', HERE / 'results' / f'{a.season}-vacoff{n}-{a.start}-{a.days}d.json')
        print(json.dumps({k: v for k, v in summary.items() if k != 'zones'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
