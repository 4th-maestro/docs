"""DDPG 기반 HVAC 설정온도 제어: 학습(Gymnasium + Stable-Baselines3)과 평가

- 환경: run.simulate를 별도 스레드에서 실행. 15분마다 JEV와 같은 상태를 받아 정책의 행동을 돌려줌
- 에피소드: 학습 기간에서 무작위로 고른 1일(96단계). 크기 산정·워밍업은 EnergyPlus가 매번 수행
- 관측 23개: 외기온도, 시각(sin, cos), 공간별 실내온도·재실 여부·현재 설정온도·다음 사용까지 남은 시간(명세에 추가, 규칙 기반·JEV와 같은 정보)
- 행동 5개: 공간별 목표 설정온도(냉방 23~28℃, 난방 16~23℃). 15분당 ±1℃ 제한, 운전 모드 고정(OFF 없음)
- 보상: -(15분 HVAC 전력량 / 2.5kWh) - λ × 재실 공간의 쾌적 범위 이탈 온도 합(℃)
- 학습 후 체크포인트마다 검증 기간(JEV 조정 기간과 같음) 평가, 검증 보상이 가장 높은 체크포인트로 평가 기간 지표 산출
- 로컬: python3 ddpg.py --season cooling --steps 500000 --out runs/ddpg-cooling. SageMaker: ml/sagemaker.sh ddpg
"""
import argparse
import datetime as dt
import json
import math
import os
import pathlib
import queue
import shutil
import tarfile
import threading
import urllib.request
import zipfile

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
EP_URL = 'https://github.com/NatLabRockies/EnergyPlus/releases/download/v26.2.0/EnergyPlus-26.2.0-4bd7a1f26f-Linux-AlmaLinux9.6-x86_64.tar.gz'
EPW_URL = 'https://climate.onebuilding.org/WMO_Region_2_Asia/KOR_South_Korea/PU_Busan/KOR_PU_Busan-Daecheongdong.WS.471590_TMYx.2009-2023.zip'
# 학습 기간은 검증·평가 기간과 겹치지 않음. 연도는 요일 계산에만 사용
TRAIN = {'cooling': [('2026-06-01', '2026-07-12')], 'heating': [('2026-01-01', '2026-01-11'), ('2026-12-01', '2026-12-31')]}
VALID = {'cooling': ('2026-07-13', 7), 'heating': ('2026-01-12', 7)}
TEST = {'cooling': ('2026-08-03', 14), 'heating': ('2026-02-02', 14)}
KWH_SCALE = 2.5  # 15분 전력량 정규화(10kW × 0.25h)


def setup_linux(root=pathlib.Path('/opt/hvac')):
    # SageMaker 컨테이너(Ubuntu 22.04, glibc 2.35): AlmaLinux 9.6 빌드(glibc 2.34)와 부산 기상 파일을 내려받아 run.py 환경 변수 설정
    if not (root / 'done').exists():
        root.mkdir(parents=True, exist_ok=True)
        for url, name in ((EP_URL, 'ep.tar.gz'), (EPW_URL, 'epw.zip')):
            urllib.request.urlretrieve(url, root / name)
        with tarfile.open(root / 'ep.tar.gz') as t:
            t.extractall(root, filter='tar')
        with zipfile.ZipFile(root / 'epw.zip') as z:
            z.extractall(root / 'epw')
        (root / 'done').touch()
    os.environ['ENERGYPLUS_DIR'] = str(next(p for p in root.glob('EnergyPlus-*') if p.is_dir()))
    os.environ['EPW'] = str(next((root / 'epw').glob('*.epw')))


def days_in(ranges):
    out = []
    for a, b in ranges:
        d, end = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
        while d <= end:
            out.append(d)
            d += dt.timedelta(days=1)
    return out


def setpoints(action, current, sp_range):
    """행동(-1~1)을 목표 설정온도로 바꾸고 현재 설정 대비 ±1℃로 제한"""
    lo, hi = sp_range
    return [round(min(cur + 1, max(cur - 1, lo + (float(a) + 1) / 2 * (hi - lo))), 2) for a, cur in zip(action, current)]


def reward(kwh, temps_people, comfort, lam):
    """temps_people: [(15분 평균 실내온도, 그 구간 재실 인원)]. 이탈은 허용 오차 없이 쾌적 범위 기준"""
    lo, hi = comfort
    dev = sum(max(lo - t, t - hi, 0) for t, n in temps_people if n > 0)
    return -kwh / KWH_SCALE - lam * dev


def make_env_class():
    import gymnasium as gym
    import control as C
    import run as R

    class Agent:
        """run.simulate가 JEV 자리에서 호출하는 판단 객체. 상태를 환경에 넘기고 행동을 기다림"""
        def __init__(self, env):
            self.env, self.stats = env, {'calls': 0, 'errors': 0}

        def decide(self, state):
            self.stats['calls'] += 1
            self.env.obs_q.put(('step', state))
            return self.env.act_q.get(), None

    class HvacEnv(gym.Env):
        def __init__(self, season, days, lam, work):
            self.season, self.c, self.days, self.lam, self.work = season, C.SEASON[season], days, lam, pathlib.Path(work)
            self.zones = list(C.ZONES)
            self.observation_space = gym.spaces.Box(-10, 10, (3 + 4 * len(self.zones),), np.float32)
            self.action_space = gym.spaces.Box(-1, 1, (len(self.zones),), np.float32)
            self.th, self.state, self.rows = None, None, None

        def _run(self, start, days):
            try:
                rows, _ = R.simulate(Agent(self), self.season, start, days, self.work)
            except BaseException as e:  # EnergyPlus 실패(SystemExit 포함)를 학습 스레드로 전달
                rows = e
            self.obs_q.put(('end', rows))

        def _obs(self, st):
            t = dt.datetime.strptime(st['time'][:16], '%Y-%m-%d %H:%M')
            ang = 2 * math.pi * (t.hour + t.minute / 60) / 24
            mid, spm = sum(self.c['comfort']) / 2, sum(self.c['sp_range']) / 2
            o = [(st['outdoor']['temp_c'] - mid) / 10, math.sin(ang), math.cos(ang)]
            for z in self.zones:
                q, nu = st['zones'][z], st['zones'][z]['next_use']
                o += [(q['temp_c'] - mid) / 5, float(q['people_now'] > 0), (q['setpoint_c'] - spm) / 2.5, min(nu['in_min'], 240) / 240 if nu else 1.0]
            return np.array(o, np.float32)

        def _finish(self):
            # 학습 종료 시 중간에 끝난 에피소드는 현재 설정 유지로 끝까지 실행해 EnergyPlus 스레드 정리
            while self.th is not None and self.th.is_alive():
                self.act_q.put({z: (self.c['mode'], q['setpoint_c']) for z, q in self.state['zones'].items()})
                kind, data = self.obs_q.get()
                if kind == 'end':
                    break
                self.state = data
            self.th = None

        def reset(self, seed=None, options=None):
            super().reset(seed=seed)
            self._finish()
            start, days = (options['start'], options['days']) if options else (self.days[self.np_random.integers(len(self.days))], 1)
            self.obs_q, self.act_q = queue.Queue(), queue.Queue()
            self.th = threading.Thread(target=self._run, args=(start, days), daemon=True)
            self.th.start()
            kind, self.state = self.obs_q.get()
            if kind != 'step':
                raise RuntimeError(f'EnergyPlus 실행 실패: {self.state}')
            return self._obs(self.state), {}

        def step(self, action):
            prev = self.state
            sps = setpoints(action, [prev['zones'][z]['setpoint_c'] for z in self.zones], self.c['sp_range'])
            self.act_q.put({z: (self.c['mode'], sp) for z, sp in zip(self.zones, sps)})
            kind, data = self.obs_q.get()
            if kind == 'end':
                if isinstance(data, BaseException):
                    raise RuntimeError('EnergyPlus 실행 실패') from data
                self.rows, last, self.th = data, data[-1], None
                r = reward(last['hvac_kwh'], [(last[f'{z}.temp'], last[f'{z}.people']) for z in self.zones], self.c['comfort'], self.lam)
                return self._obs(prev), r, True, False, {}
            self.state = data
            r = reward(data['building_hvac_kw_last_15min'] / 4, [(data['zones'][z]['temp_c'], prev['zones'][z]['people_now']) for z in self.zones],
                       self.c['comfort'], self.lam)
            return self._obs(data), r, False, False, {}

        def close(self):
            self._finish()

    return HvacEnv, R


def evaluate(model, HvacEnv, R, season, start, days, lam, work):
    env = HvacEnv(season, [], lam, work)
    obs, _ = env.reset(options={'start': dt.date.fromisoformat(start), 'days': days})
    total, done = 0.0, False
    while not done:
        act, _ = model.predict(obs, deterministic=True)
        obs, r, done, _, _ = env.step(act)
        total += r
    return round(total, 3), R.score(env.rows, season), env.rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', default='cooling')
    ap.add_argument('--steps', type=int, default=500000)
    ap.add_argument('--ckpt', type=int, default=25000)
    ap.add_argument('--lam', type=float, default=1.0)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--out', default=os.environ.get('SM_MODEL_DIR', str(HERE / 'runs' / 'ddpg')))
    a = ap.parse_args()
    if os.environ.get('SM_MODEL_DIR'):
        setup_linux()
    import torch
    from stable_baselines3 import DDPG
    from stable_baselines3.common.callbacks import CheckpointCallback
    from stable_baselines3.common.monitor import Monitor
    from stable_baselines3.common.noise import NormalActionNoise
    torch.set_num_threads(1)  # 측정상 1스레드가 10스레드보다 빠름(1.71ms 대 3.58ms)
    HvacEnv, R = make_env_class()
    out = pathlib.Path(a.out)
    (out / 'ckpt').mkdir(parents=True, exist_ok=True)
    env = Monitor(HvacEnv(a.season, days_in(TRAIN[a.season]), a.lam, out / 'work-train'), str(out / 'train'))
    n = env.action_space.shape[0]
    model = DDPG('MlpPolicy', env, action_noise=NormalActionNoise(np.zeros(n), 0.1 * np.ones(n)), learning_starts=1000, seed=a.seed, device='cpu')
    t0 = dt.datetime.now()
    model.learn(a.steps, callback=CheckpointCallback(a.ckpt, str(out / 'ckpt'), name_prefix='ddpg'))
    train_sec = (dt.datetime.now() - t0).total_seconds()
    env.close()
    model.save(out / 'ckpt' / f'ddpg_{a.steps}_steps')
    # 학습 곡선: 체크포인트별 검증 기간 보상·지표
    curve = []
    for p in sorted((out / 'ckpt').glob('ddpg_*_steps.zip'), key=lambda p: int(p.stem.split('_')[1])):
        r, s, _ = evaluate(DDPG.load(p, device='cpu'), HvacEnv, R, a.season, *VALID[a.season], a.lam, out / 'work-eval')
        curve.append({'steps': int(p.stem.split('_')[1]), 'reward': r, 'energy_kwh': s['energy_kwh'], 'discomfort_zone_h': s['discomfort_zone_h'], 'peak_kw': s['peak_kw']})
        print(json.dumps(curve[-1]), flush=True)
    best = max(curve, key=lambda x: x['reward'])
    r, s, rows = evaluate(DDPG.load(out / 'ckpt' / f'ddpg_{best["steps"]}_steps.zip', device='cpu'), HvacEnv, R, a.season, *TEST[a.season], a.lam,
                          out / 'work-eval')
    start, days = TEST[a.season]
    summary = {'controller': 'ddpg', 'season': a.season, 'start': start, 'days': days, 'steps': len(rows), **s,
               'ddpg': {'train_steps': a.steps, 'best_steps': best['steps'], 'lam': a.lam, 'seed': a.seed, 'train_sec': round(train_sec),
                        'ms_per_step': round(1000 * train_sec / a.steps, 2), 'test_reward': r, 'curve': curve}}
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    with open(out / 'steps.csv', 'w') as f:
        f.write(','.join(rows[0]) + '\n' + '\n'.join(','.join(str(x) for x in r.values()) for r in rows) + '\n')
    for d in ('work-train', 'work-eval'):
        shutil.rmtree(out / d, ignore_errors=True)
    print(json.dumps({k: v for k, v in summary.items() if k not in ('zones', 'ddpg')} | {'best_steps': best['steps'], 'train_sec': round(train_sec)},
                     ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
