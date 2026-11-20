"""자연어 질의용 도구 정의와 실행(LLM이 만든 인자를 서버에서 검증)

- LLM은 도구 이름과 인자만 생성, 층·용도·동작은 아래 목록 값만 허용
- 층·용도 enum: 전체 건물의 합집합(도구 정의 1개 유지), 질의 건물에 없는 값은 run에서 거부
- create_schedule은 초안만 반환하고 저장은 운영자 확인 후 POST /schedules
"""
import re

import buildings
import sim

FLOORS = sorted({f for b in buildings.LIST for f in b['floors']})
USES = sorted({r['use'] for b in buildings.LIST for r in buildings.rooms(b['id'])})
METRICS = {'powerKw': '전력(kW)', 'temp': '실내온도(℃)', 'humidity': '습도(%)', 'setpoint': '설정온도(℃)'}

TOOLS = [
    {
        'name': 'query_spaces',
        'description': '층·용도로 호실을 골라 현재 지표 순으로 조회한다. 전력·온도·습도·설정온도 질문에 사용한다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['floor', 'use', 'metric', 'order', 'limit'],
            'properties': {
                'floor': {'type': 'string', 'enum': FLOORS + ['all']},
                'use': {'type': 'string', 'enum': USES + ['all']},
                'metric': {'type': 'string', 'enum': list(METRICS)},
                'order': {'type': 'string', 'enum': ['desc', 'asc']},
                'limit': {'type': 'integer'},
            },
        },
    },
    {
        'name': 'create_schedule',
        'description': '층·용도로 대상 호실을 골라 냉난방 제어 스케줄 초안을 만든다. condition=unused는 그 시각 이후 재실이 없을 때만 적용한다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['floor', 'use', 'action', 'time', 'condition', 'setpoint'],
            'properties': {
                'floor': {'type': 'string', 'enum': FLOORS + ['all']},
                'use': {'type': 'string', 'enum': USES + ['all']},
                'action': {'type': 'string', 'enum': ['off', 'on', 'setpoint']},
                'time': {'type': 'string', 'description': '24시간 형식 HH:MM'},
                'condition': {'type': 'string', 'enum': ['unused', 'always']},
                'setpoint': {'type': 'number', 'description': 'action=setpoint일 때 16~30, 그 외 0'},
            },
        },
    },
]


def chips(name, args):
    """도구 인자를 화면 조건 칩(한국어)으로 변환. 검증 전 값이라 없는 키는 건너뜀"""
    out = [args.get('floor') if args.get('floor') != 'all' else '전체 층', args.get('use') if args.get('use') != 'all' else '전체 용도']
    if name == 'query_spaces':
        metric = METRICS.get(args.get('metric'), '').split('(')[0]
        out += [metric and f"{metric} {'낮은' if args.get('order') == 'asc' else '높은'} 순", args.get('limit') and f"{args['limit']}곳"]
    elif name == 'create_schedule':
        action = {'off': '운전 OFF', 'on': '운전 ON'}.get(args.get('action')) or f"설정온도 {args.get('setpoint', 0):g}℃"
        out += [args.get('time') and f"{args['time']} 이후", '재실 없을 때' if args.get('condition') == 'unused' else None, action]
    return [c for c in out if c]


def _pick(rooms, floor, use):
    return [r for r in rooms if floor in ('all', r['floor']) and use in ('all', r['use'])]


def run(name, args, t, schedules, bid=None):
    """(모델에 돌려줄 결과, 화면 반영 정보) 반환. 잘못된 인자는 ValueError(모델이 고칠 수 있게 허용 값 포함)"""
    rooms = buildings.rooms(bid)
    floors, uses = buildings.floors(bid), sorted({r['use'] for r in rooms})
    if args.get('floor') not in floors + ['all']:
        raise ValueError(f"floor는 {', '.join(floors)}, all 중 하나")
    if args.get('use') not in uses + ['all']:
        raise ValueError(f"use는 {', '.join(uses)}, all 중 하나")
    if name == 'query_spaces':
        if args['metric'] not in METRICS or args['order'] not in ('desc', 'asc'):
            raise ValueError('metric 또는 order 값 오류')
        limit = min(20, max(1, int(args['limit'])))
        rows = [sim.state(r, t, schedules) for r in _pick(rooms, args['floor'], args['use'])]
        rows.sort(key=lambda s: s[args['metric']], reverse=args['order'] == 'desc')
        rows = rows[:limit]
        result = [{k: s[k] for k in ('name', 'floor', 'use', 'onOff', 'occupants', args['metric'])} for s in rows]
        return {'metric': METRICS[args['metric']], 'at': t.isoformat(), 'rooms': result}, {'highlight': [s['id'] for s in rows]}
    if name == 'create_schedule':
        if args['action'] not in ('off', 'on', 'setpoint') or args['condition'] not in ('unused', 'always'):
            raise ValueError('action 또는 condition 값 오류')
        if not re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', args['time']):
            raise ValueError('time은 HH:MM 형식')
        if args['action'] == 'setpoint' and not 16 <= args['setpoint'] <= 30:
            raise ValueError('setpoint는 16~30')
        targets = _pick(rooms, args['floor'], args['use'])
        if not targets:
            raise ValueError('대상 호실 없음')
        draft = {
            'roomIds': [r['id'] for r in targets], 'roomNames': [r['name'] for r in targets][:10],
            'floor': args['floor'], 'use': args['use'], 'action': args['action'], 'time': args['time'],
            'condition': args['condition'], 'setpoint': args['setpoint'] if args['action'] == 'setpoint' else None,
            'estimatedSavingKwh': _saving(targets, t, args) if args['action'] == 'off' else 0,
        }
        return {'targets': len(targets), 'rooms': draft['roomNames'], 'estimatedSavingKwh': draft['estimatedSavingKwh']}, {'highlight': draft['roomIds'], 'draft': draft}
    raise ValueError(f'알 수 없는 도구: {name}')


def _saving(rooms, t, args):
    # 오늘 지정 시각부터 21시까지 1시간 간격으로, 꺼질 구간의 전력 합(가상)
    h, m = map(int, args['time'].split(':'))
    total = 0.0
    for hour in range(h, 21):
        ts = t.replace(hour=hour, minute=m if hour == h else 0)
        for r in rooms:
            s = sim.state(r, ts)
            if s['onOff'] and (args['condition'] == 'always' or s['occupants'] == 0):
                total += s['powerKw']
    return round(total, 1)
