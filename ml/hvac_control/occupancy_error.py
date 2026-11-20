"""재실 오차 비교: 실제 재실이 사용 일정과 다를 때 공실 OFF, JEV, 공실 OFF + JEV 보조 비교

- 실행: python3 occupancy_error.py --season cooling --start 2026-08-03 --days 14 --controllers vacoff30 hybrid jev
- 재실 오차(고정 시드): 일정 1건마다 불참 확률 p_noshow, 평일 공간마다 일정 외 사용(60~120분) 확률 p_extra
- 제어기는 현재 재실(실제)과 다음 사용(일정)만 받음. 불참과 일정 외 사용은 미리 알 수 없음
- hybrid: 일정과 실제 재실이 다른 공간(일정 있음·실제 없음, 일정 없음·실제 있음)만 JEV에 요청, 나머지는 공실 OFF 30분
- run.py, control.py는 수정하지 않음. control.occupancy, control.rule, control.Jev만 실행 중 교체(2026-11-20 사용자 결정 "공실 OFF 기본 + JEV 보조" 검증)
- 출력: runs/<계절>-occerr-<제어기>-<시작>-<일수>d/, results/에 summary 사본
"""
import argparse
import csv
import datetime as dt
import json
import pathlib
import random
import shutil

import control as C
import run as R
from vacancy_off import periods, vacancy_off

HERE = pathlib.Path(__file__).resolve().parent
SCHEDULE = C.occupancy  # 원래 함수: 일정상 재실
EXTRA_STARTS = ('07:00', '08:00', '12:00', '18:00', '19:00', '20:00')


def actual_occupancy(seed, p_noshow, p_extra):
    def at(day, hhmm):
        return dt.datetime.combine(day, dt.time.fromisoformat(hhmm))

    def occ(zone, t):
        people, nxt = SCHEDULE(zone, t)
        day = t.date()
        for days, s, e, n in C.USES[zone]:
            if day.weekday() in days and at(day, s) <= t < at(day, e) and random.Random(f'{seed}|noshow|{zone}|{day}|{s}').random() < p_noshow:
                people -= n
        r = random.Random(f'{seed}|extra|{zone}|{day}')
        if day.weekday() < 5 and r.random() < p_extra:
            start, minutes = at(day, r.choice(EXTRA_STARTS)), r.choice((60, 90, 120))
            if start <= t < start + dt.timedelta(minutes=minutes):
                people += max(2, max(n for *_, n in C.USES[zone]) // 2)
        return max(0, people), nxt
    return occ


class HybridJev(C.Jev):
    """일정과 실제 재실이 다른 공간만 JEV, 나머지는 공실 OFF 30분. 불일치 공간이 없으면 호출하지 않음"""
    base = staticmethod(vacancy_off(30))

    def decide(self, state):
        t = dt.datetime.strptime(state['time'][:16], '%Y-%m-%d %H:%M')
        odd = {z: s for z, s in state['zones'].items() if (s['people_now'] > 0) != (SCHEDULE(z, t)[0] > 0)}
        self.stats['mismatch_zone_steps'] = self.stats.get('mismatch_zone_steps', 0) + len(odd)
        out = {z: self.base(self.season, {'people': s['people_now'], 'next_use': s['next_use'], 'setpoint_c': s['setpoint_c']})
               for z, s in state['zones'].items() if z not in odd}
        raw = None
        if odd:
            picked, raw = super().decide({**state, 'zones': odd})
            out |= picked
        return out, raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', choices=list(C.SEASON), required=True)
    ap.add_argument('--start', type=dt.date.fromisoformat, required=True)
    ap.add_argument('--days', type=int, default=14)
    ap.add_argument('--controllers', nargs='+', default=['vacoff30', 'hybrid', 'jev'], choices=['rule', 'vacoff30', 'hybrid', 'jev'])
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--p-noshow', type=float, default=0.2)
    ap.add_argument('--p-extra', type=float, default=0.2)
    a = ap.parse_args()
    saved = C.occupancy, C.rule, C.Jev
    for name in a.controllers:
        C.occupancy = actual_occupancy(a.seed, a.p_noshow, a.p_extra)
        if name == 'vacoff30':
            C.rule = vacancy_off(30)
        if name == 'hybrid':
            C.Jev = HybridJev
        try:
            out = HERE / 'runs' / f'{a.season}-occerr-{name}-{a.start}-{a.days}d'
            rows, jev = R.simulate('jev' if name in ('hybrid', 'jev') else 'rule', a.season, a.start, a.days, out)
        finally:
            C.occupancy, C.rule, C.Jev = saved
        with open(out / 'steps.csv', 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        summary = {'controller': name, 'season': a.season, 'start': str(a.start), 'days': a.days, 'steps': len(rows),
                   'occupancy_error': {'seed': a.seed, 'p_noshow': a.p_noshow, 'p_extra': a.p_extra}, **R.score(rows, a.season), 'periods': periods(rows)}
        if jev:
            conf = [x for x in jev.stats.pop('confidence') if x is not None]
            summary['jev'] = {**jev.stats, 'model': jev.model, 'sec': round(jev.stats['sec'], 1),
                              'confidence_mean': round(sum(conf) / len(conf), 3) if conf else None}
        (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        shutil.copy(out / 'summary.json', HERE / 'results' / f'{a.season}-occerr-{name}-{a.start}-{a.days}d.json')
        print(json.dumps({k: v for k, v in summary.items() if k != 'zones'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
