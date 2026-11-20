"""재실 인원과 실내온도·냉방 에너지 관계 분석(UCI Room Occupancy Estimation, ROBOD)

- 실행: python occupancy_analysis.py <UCI CSV> <ROBOD 폴더>
- 의존성: numpy
- 출력: UCI 인원별 온도 변화율, ROBOD 방별 재실 1명당 실내온도·냉수 에너지 회귀계수와 일 단위 블록 부트스트랩 95% 구간
"""
import csv
import datetime as dt
import statistics as st
import sys
from collections import defaultdict

import numpy as np


def uci(path):
    rows = list(csv.DictReader(open(path)))
    ts = lambda r: dt.datetime.strptime(r['Date'] + ' ' + r['Time'], '%Y/%m/%d %H:%M:%S')
    temp = lambda r: sum(float(r[f'S{i}_Temp']) for i in range(1, 5)) / 4
    slope = defaultdict(list)
    for a, b in zip(rows, rows[1:]):
        sec = (ts(b) - ts(a)).total_seconds()
        # 같은 인원이 이어진 30초 간격 구간만 사용
        if 0 < sec <= 60 and a['Room_Occupancy_Count'] == b['Room_Occupancy_Count']:
            slope[int(a['Room_Occupancy_Count'])].append((temp(b) - temp(a)) / sec * 3600)
    for c in sorted(slope):
        print(f'UCI {c}명 ({c / 27.6:.3f}명/㎡): {st.mean(slope[c]):+.3f}℃/h, n={len(slope[c])}')


def robod(folder, boot=200):
    rng = np.random.default_rng(0)
    for k in range(1, 6):
        rows = []
        for r in csv.DictReader(open(f'{folder}/combined_Room{k}.csv')):
            try:
                v = [float(r[c]) for c in ('occupant_count [number]', 'air_temperature [Celsius]', 'dry_bulb_temp [Celsius]', 'chilled_water_energy [kWh]')]
            except ValueError:
                continue
            h = int(r['timestamp'][11:13])
            if 8 <= h < 20:
                rows.append((r['timestamp'][:10], *v, h))
        days = sorted({x[0] for x in rows})
        byday = {d: [x for x in rows if x[0] == d] for d in days}

        def fit(sel, col):
            # 실내온도 또는 냉수 에너지 ~ 재실 인원 + 외기온도 + 시각 고정효과
            X = np.array([[1, x[1], x[3]] + [x[5] == j for j in range(9, 20)] for x in sel], float)
            return np.linalg.lstsq(X, np.array([x[col] for x in sel]), rcond=None)[0][1]

        for col, name in ((2, '실내온도 ℃/명'), (4, '냉수 kWh/5분/명')):
            est = fit(rows, col)
            bs = [fit([x for d in rng.choice(days, len(days)) for x in byday[d]], col) for _ in range(boot)]
            print(f'ROBOD Room{k} {name}: {est:+.4f} [{np.percentile(bs, 2.5):+.4f}, {np.percentile(bs, 97.5):+.4f}], 일수 {len(days)}')


if __name__ == '__main__':
    uci(sys.argv[1])
    robod(sys.argv[2])
