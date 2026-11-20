"""자연어 질의용 도구 정의와 실행(LLM이 만든 인자를 서버에서 검증)

- LLM은 도구 이름과 인자만 생성, 층·용도·동작은 아래 목록 값만 허용
- 층·용도 enum: 전체 건물의 합집합(도구 정의 1개 유지), 질의 건물에 없는 값은 run에서 거부
- create_schedule은 초안만 반환하고 저장은 운영자 확인 후 POST /schedules
  - 대상: rooms(호실 이름)가 있으면 이름 선택(pick=rooms, use 무시), 없으면 층·용도 선택(pick=group)
- search_documents: Bedrock Knowledge Base(KB_ID) Retrieve 상위 4개. 화면 근거 목록은 view['sources'](문서별 1건)
- comfort_index: 불쾌지수(기상청 식)와 PMV·PPD(ISO 7730)를 comfort.py로 계산. 가정값은 결과 assumptions에 포함
- usage_frequency: 최근 4주 같은 요일·같은 시각 사용률(usage.py). rooms는 호실 순위, hours는 시간대별 평균 사용률 + 건물 평소 전력(energy.heatmap)
- 그래프: 각 도구가 결과 데이터로 화면용 그래프 정의(chart)를 만듦. 숫자는 항상 도구 결과에서 가져오고 LLM은 view로 표시 방식만 제안
  - bar: {kind, title, unit, items: [{label, sub, value, id?}]}, line: {kind, title, unit, labels, series: [{name, role, values}]}
  - prefer=table이면 화면이 표를 먼저 표시
"""
import datetime as dt
import functools
import os
import re

import buildings
import comfort
import energy
import operations
import sim
import usage

METRICS = {'powerKw': '전력(kW)', 'temp': '실내온도(℃)', 'humidity': '습도(%)', 'setpoint': '설정온도(℃)'}
# 묶음 합계 지표: (표시 이름, 단위, 계산)
AGG = {
    'powerKw': ('전력 합계', 'kW', lambda rs: round(sum(s['powerKw'] for s in rs), 1)),
    'running': ('운전 중 HVAC', '대', lambda rs: sum(s['onOff'] for s in rs)),
    'anomaly': ('이상 감지', '건', lambda rs: sum(bool(s['anomaly']) for s in rs)),
    'temp': ('평균 실내온도', '℃', lambda rs: round(sum(s['temp'] for s in rs) / len(rs), 1)),
}
WEEKDAYS = '월화수목금토일'
PERIODS = {'day': ('오늘', '어제', '시간별'), 'week': ('이번 주', '지난주', '일별'), 'month': ('이번 달', '지난달', '일별')}
VIEW = {'type': 'string', 'enum': ['auto', 'chart', 'table'], 'description': '표시 방식 제안. 보통 auto, 사용자가 표를 원하면 table'}

@functools.lru_cache(maxsize=4)
def _definitions(version):
    # 도구 enum(층·용도)은 전체 건물 합집합: 건물 데이터가 바뀌면(version) 다시 생성
    FLOORS = sorted({f for b in buildings.LIST for f in b['floors']}, key=buildings._floor_key)
    USES = sorted({r['use'] for b in buildings.LIST for r in buildings.rooms(b['id'])})
    return FLOORS, USES, [
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
                'view': VIEW,
            },
        },
    },
    {
        'name': 'aggregate_spaces',
        'description': '층별 또는 용도별로 묶어 합계·평균을 비교한다. "층별 전력", "용도별 운전 대수", "이상 감지가 많은 층" 같은 질문에 사용한다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['floor', 'use', 'group_by', 'metric', 'view'],
            'properties': {
                'floor': {'type': 'string', 'enum': FLOORS + ['all']},
                'use': {'type': 'string', 'enum': USES + ['all']},
                'group_by': {'type': 'string', 'enum': ['floor', 'use']},
                'metric': {'type': 'string', 'enum': list(AGG)},
                'view': VIEW,
            },
        },
    },
    {
        'name': 'energy_trend',
        'description': '건물 전체 전력 사용량(kWh)의 기간 추이를 이전 기간과 비교한다. "오늘 전력 추이", "어제보다 많이 썼나", "이번 주 사용량" 같은 질문에 사용한다. 증감률은 결과의 changePct(이전 기간 같은 시점 대비, %)를 그대로 쓴다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['period', 'view'],
            'properties': {
                'period': {'type': 'string', 'enum': list(PERIODS)},
                'view': VIEW,
            },
        },
    },
    {
        'name': 'create_schedule',
        'description': '층·용도 또는 호실 이름으로 대상 호실을 골라 냉난방 제어 스케줄 초안을 만든다. condition=unused는 그 시각 이후 재실이 없을 때만 적용한다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['floor', 'use', 'rooms', 'action', 'time', 'condition', 'setpoint'],
            'properties': {
                'floor': {'type': 'string', 'enum': FLOORS + ['all']},
                'use': {'type': 'string', 'enum': USES + ['all']},
                'rooms': {'type': 'array', 'items': {'type': 'string'},
                          'description': '사용자가 말한 호실 이름(예: 회의실 A, 101호). 이름으로 고르면 use는 무시, 층·용도로 고르면 빈 배열'},
                'action': {'type': 'string', 'enum': ['off', 'on', 'setpoint']},
                'time': {'type': 'string', 'description': '24시간 형식 HH:MM'},
                'condition': {'type': 'string', 'enum': ['unused', 'always']},
                'setpoint': {'type': 'number', 'description': 'action=setpoint일 때 16~30, 그 외 0'},
            },
        },
    },
    {
        'name': 'list_operations',
        'description': '자동 운영 제안·처리 내역·이상 알림과 자동 운영 ON/OFF 설정을 조회한다. done은 처리된 모든 상태이며, 껐던 방은 applied·accepted만 집계한다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['status', 'floor', 'use', 'hours', 'limit'],
            'properties': {
                'status': {'type': 'string', 'enum': ['pending', 'done', 'alert', 'all']},
                'floor': {'type': 'string', 'enum': FLOORS + ['all']},
                'use': {'type': 'string', 'enum': USES + ['all']},
                'hours': {'type': 'integer', 'description': '최근 1~24시간, 기본 24'},
                'limit': {'type': 'integer', 'description': '1~20개, 기본 10'},
            },
        },
    },
    {
        'name': 'operations_action',
        'description': '자동 운영 제안 수락·거절 또는 조치 되돌리기 초안만 만든다. 실제 실행은 사용자가 화면 카드에서 확인한다. 최근 24시간 중 latest는 가장 최근 대상 1건, all은 조건에 맞는 전부다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['action', 'floor', 'use', 'scope'],
            'properties': {
                'action': {'type': 'string', 'enum': ['accept', 'reject', 'undo']},
                'floor': {'type': 'string', 'enum': FLOORS + ['all']},
                'use': {'type': 'string', 'enum': USES + ['all']},
                'scope': {'type': 'string', 'enum': ['latest', 'all']},
            },
        },
    },
    {
        'name': 'usage_frequency',
        'description': ('최근 4주 같은 요일·같은 시각의 호실 사용 빈도(재실이 있던 주 수)와 빈 채 운전 빈도를 조회한다. 지금 상태가 아니라 평소 사용 패턴 질문에 사용한다. '
                        'focus=rooms는 그 시각 호실별 사용률 순위("이 시간에 잘 안 쓰는 방", "금요일 오후에 자주 쓰는 회의실"), '
                        'focus=hours는 대상 호실 평균의 시간대별 사용률과 건물 평소 전력("3층 회의실은 평소 언제 써?", "사람 많은 시간대")이다.'),
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['floor', 'use', 'weekday', 'hour', 'focus', 'order', 'limit'],
            'properties': {
                'floor': {'type': 'string', 'enum': FLOORS + ['all']},
                'use': {'type': 'string', 'enum': USES + ['all']},
                'weekday': {'type': 'string', 'enum': ['today'] + list(WEEKDAYS), 'description': '요일을 말하지 않으면 today'},
                'hour': {'type': 'integer', 'description': '0~23시. 시각을 말하지 않으면 -1(현재 시각)'},
                'focus': {'type': 'string', 'enum': ['rooms', 'hours']},
                'order': {'type': 'string', 'enum': ['asc', 'desc'], 'description': 'rooms일 때 asc=잘 안 쓰는 순, desc=자주 쓰는 순'},
                'limit': {'type': 'integer', 'description': 'rooms일 때 1~20곳'},
                'view': VIEW,
            },
        },
    },
    {
        'name': 'search_documents',
        'description': '냉난방 기준 온도, 공공기관 에너지 규정, 불쾌지수·PMV 같은 쾌적 지표의 정의와 단계, 설비·요금 기준 문서를 검색한다. 규정·기준·이론 질문에 사용하고 호실 수치 조회에는 쓰지 않는다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False, 'required': ['query'],
            'properties': {'query': {'type': 'string', 'description': '검색 문장(한국어, 200자 이하)'}},
        },
    },
    {
        'name': 'comfort_index',
        'description': '층·용도로 호실을 골라 현재 실내온도·습도로 불쾌지수(기상청 식)와 PMV·PPD(ISO 7730)를 계산해 불쾌지수 순으로 조회한다. "덥고 습한 곳", "불쾌지수", "쾌적도", "PMV" 질문에 사용한다.',
        'strict': True,
        'input_schema': {
            'type': 'object', 'additionalProperties': False,
            'required': ['floor', 'use', 'order', 'limit'],
            'properties': {
                'floor': {'type': 'string', 'enum': FLOORS + ['all']},
                'use': {'type': 'string', 'enum': USES + ['all']},
                'order': {'type': 'string', 'enum': ['desc', 'asc']},
                'limit': {'type': 'integer'},
                'view': VIEW,
            },
        },
    },
    ]


def definitions():
    return _definitions(buildings.version())[2]


def __getattr__(name):
    # 기존 코드 호환: tools.FLOORS, tools.USES, tools.TOOLS
    if name in ('FLOORS', 'USES', 'TOOLS'):
        return _definitions(buildings.version())[('FLOORS', 'USES', 'TOOLS').index(name)]
    raise AttributeError(name)


def chips(name, args):
    """도구 인자를 화면 조건 칩(한국어)으로 변환. 검증 전 값이라 없는 키는 건너뜀"""
    out = [args.get('floor') if args.get('floor') != 'all' else '전체 층', args.get('use') if args.get('use') != 'all' else '전체 용도']
    if name == 'search_documents':
        return ['기준 문서 검색', (args.get('query') or '')[:20]]
    if name == 'energy_trend':
        return [f"{PERIODS.get(args.get('period'), ('',))[0]} 추이", '이전 기간 비교']
    if name == 'query_spaces':
        metric = METRICS.get(args.get('metric'), '').split('(')[0]
        out += [metric and f"{metric} {'낮은' if args.get('order') == 'asc' else '높은'} 순", args.get('limit') and f"{args['limit']}곳"]
    elif name == 'aggregate_spaces':
        out += ['층별' if args.get('group_by') == 'floor' else '용도별', AGG.get(args.get('metric'), ('',))[0]]
    elif name == 'comfort_index':
        out += [f"불쾌지수 {'낮은' if args.get('order') == 'asc' else '높은'} 순", args.get('limit') and f"{args['limit']}곳"]
    elif name == 'usage_frequency':
        wd = args.get('weekday')
        hour = args.get('hour')
        out += ['최근 4주 사용 빈도', f'{wd}요일' if wd and wd != 'today' else '오늘 요일',
                f'{hour}시' if args.get('focus') == 'rooms' and isinstance(hour, int) and hour >= 0 else None,
                '시간대별' if args.get('focus') == 'hours' else ('잘 안 쓰는 순' if args.get('order') == 'asc' else '자주 쓰는 순')]
    elif name == 'list_operations':
        out += ['자동 운영 조회', args.get('status', 'pending')]
    elif name == 'operations_action':
        out += ['자동 운영 초안', {'accept': '수락', 'reject': '거절', 'undo': '되돌리기'}.get(args.get('action'))]
    elif name == 'create_schedule':
        if isinstance(args.get('rooms'), list) and args['rooms']:
            out[1] = _names([str(n) for n in args['rooms']])
        action = {'off': '운전 OFF', 'on': '운전 ON'}.get(args.get('action')) or f"설정온도 {args.get('setpoint', 0):g}℃"
        out += [args.get('time') and f"{args['time']} 이후", '재실 없을 때' if args.get('condition') == 'unused' else None, action]
    return [c for c in out if c]


def _pick(rooms, floor, use):
    return [r for r in rooms if floor in ('all', r['floor']) and use in ('all', r['use'])]


def _norm(s):
    return re.sub(r'\s+', '', str(s)).lower()


def _names(names, n=3):
    return ', '.join(names[:n]) + (f' 외 {len(names) - n}곳' if len(names) > n else '')


def _pick_names(rooms, floor, names):
    """호실 이름 선택: 공백·대소문자 무시 완전 일치(이름 또는 id) 우선, 없으면 포함 일치 1곳. 못 찾거나 여러 곳이면 ValueError(후보 이름 포함)"""
    pool = _pick(rooms, floor, 'all')
    picked, bad, near = {}, [], []
    for q in names:
        key = _norm(q)
        hits = [r for r in pool if key in (_norm(r['name']), _norm(r['id']))] or [r for r in pool if key and key in _norm(r['name'])]
        if hits and (len(hits) == 1 or _norm(hits[0]['name']) == key):
            picked.update((r['id'], r) for r in hits)
        else:
            bad.append(q)
            near += [r['name'] for r in hits]
    if bad:
        where = '' if floor == 'all' else f'{floor} '
        cand = list(dict.fromkeys(near or [r['name'] for r in pool]))[:10]
        raise ValueError(f"{where}호실 이름 확인 필요: {', '.join(bad)}(없거나 여러 곳). 후보: {', '.join(cand) or '없음'}")
    return list(picked.values())


def run(name, args, t, schedules, bid=None):
    """(모델에 돌려줄 결과, 화면 반영 정보) 반환. 잘못된 인자는 ValueError(모델이 고칠 수 있게 허용 값 포함)"""
    if name in ('list_operations', 'operations_action'):
        args = {'floor': 'all', 'use': 'all', **args}
    rooms = buildings.rooms(bid)
    floors, uses = buildings.floors(bid), sorted({r['use'] for r in rooms})
    view = args.get('view', 'auto')
    if name == 'energy_trend':
        return _trend(args, t, bid, view)
    if name == 'search_documents':
        return _search(args)
    if args.get('floor') not in floors + ['all']:
        raise ValueError(f"floor는 {', '.join(floors)}, all 중 하나")
    if args.get('use') not in uses + ['all']:
        raise ValueError(f"use는 {', '.join(uses)}, all 중 하나")
    if name in ('list_operations', 'operations_action'):
        return operations.run(name, args, t, buildings.get(bid)['id'])
    if name == 'usage_frequency':
        return _frequency(args, t, schedules, rooms, bid, view)
    if name == 'query_spaces':
        if args['metric'] not in METRICS or args['order'] not in ('desc', 'asc'):
            raise ValueError('metric 또는 order 값 오류')
        limit = min(20, max(1, int(args['limit'])))
        rows = [sim.state(r, t, schedules) for r in _pick(rooms, args['floor'], args['use'])]
        rows.sort(key=lambda s: s[args['metric']], reverse=args['order'] == 'desc')
        rows = rows[:limit]
        result = [{k: s[k] for k in ('name', 'floor', 'use', 'onOff', 'occupants', args['metric'])} for s in rows]
        label, unit = METRICS[args['metric']].rstrip(')').split('(')
        chart = _prefer(view, {
            'kind': 'bar', 'title': f"{_where(args)} {label} {'낮은' if args['order'] == 'asc' else '높은'} 순 {len(rows)}곳", 'unit': unit,
            'items': [{'id': s['id'], 'label': s['name'], 'sub': f"{s['floor']}, {s['use']}", 'value': s[args['metric']]} for s in rows],
        })
        return {'metric': METRICS[args['metric']], 'at': t.isoformat(), 'rooms': result}, {'highlight': [s['id'] for s in rows], 'chart': chart}
    if name == 'aggregate_spaces':
        if args['group_by'] not in ('floor', 'use') or args['metric'] not in AGG:
            raise ValueError('group_by 또는 metric 값 오류')
        label, unit, fn = AGG[args['metric']]
        states = [sim.state(r, t, schedules) for r in _pick(rooms, args['floor'], args['use'])]
        if not states:
            raise ValueError('대상 호실 없음')
        keys = floors if args['group_by'] == 'floor' else sorted({s['use'] for s in states})
        groups = [(k, [s for s in states if s[args['group_by']] == k]) for k in keys]
        groups = [{'group': k, 'value': fn(rs), 'rooms': len(rs)} for k, rs in groups if rs]
        if args['group_by'] == 'use':
            groups.sort(key=lambda g: -g['value'])  # 용도는 값 큰 순, 층은 층 순서 유지
        chart = _prefer(view, {
            'kind': 'bar', 'title': f"{_where(args)} {'층별' if args['group_by'] == 'floor' else '용도별'} {label}", 'unit': unit,
            'items': [{'label': g['group'], 'sub': f"호실 {g['rooms']}곳", 'value': g['value']} for g in groups],
        })
        return {'metric': f'{label}({unit})', 'at': t.isoformat(), 'groups': groups}, {'highlight': [s['id'] for s in states if s['anomaly']] if args['metric'] == 'anomaly' else [], 'chart': chart}
    if name == 'comfort_index':
        if args['order'] not in ('desc', 'asc'):
            raise ValueError('order 값 오류')
        limit = min(20, max(1, int(args['limit'])))
        rows = [_comfort(sim.state(r, t, schedules)) for r in _pick(rooms, args['floor'], args['use'])]
        rows.sort(key=lambda s: s['di'], reverse=args['order'] == 'desc')
        rows = rows[:limit]
        chart = _prefer(view, {
            'kind': 'bar', 'title': f"{_where(args)} 불쾌지수 {'낮은' if args['order'] == 'asc' else '높은'} 순 {len(rows)}곳", 'unit': 'DI',
            'items': [{'id': s['id'], 'label': s['name'], 'sub': f"{s['diStage']}, PMV {s['pmv']:+.2f}", 'value': s['di']} for s in rows],
        })
        return ({'at': t.isoformat(), 'assumptions': COMFORT_ASSUMPTIONS, 'rooms': [{k: v for k, v in s.items() if k != 'id'} for s in rows]},
                {'highlight': [s['id'] for s in rows], 'chart': chart})
    if name == 'create_schedule':
        if args['action'] not in ('off', 'on', 'setpoint') or args['condition'] not in ('unused', 'always'):
            raise ValueError('action 또는 condition 값 오류')
        if not re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', args['time']):
            raise ValueError('time은 HH:MM 형식')
        if args['action'] == 'setpoint' and not 16 <= args['setpoint'] <= 30:
            raise ValueError('setpoint는 16~30')
        if not isinstance(args.get('rooms', []), list):
            raise ValueError('rooms는 호실 이름 배열')
        names = [str(n) for n in args.get('rooms') or [] if str(n).strip()]
        targets = _pick_names(rooms, args['floor'], names) if names else _pick(rooms, args['floor'], args['use'])
        if not targets:
            raise ValueError('대상 호실 없음')
        floors_hit = {r['floor'] for r in targets}
        draft = {
            'roomIds': [r['id'] for r in targets], 'roomNames': [r['name'] for r in targets][:10],
            'floor': (floors_hit.pop() if len(floors_hit) == 1 else 'all') if names else args['floor'],
            'use': 'all' if names else args['use'], 'pick': 'rooms' if names else 'group',
            'action': args['action'], 'time': args['time'],
            'condition': args['condition'], 'setpoint': args['setpoint'] if args['action'] == 'setpoint' else None,
        }
        before, after = _effect(targets, t, schedules, draft)
        h = int(args['time'][:2])
        draft['estimatedSavingKwh'] = round(sum(max(0.0, b - a) for b, a in zip(before[h:], after[h:])), 1)
        chart = {
            'kind': 'line', 'title': f"스케줄 적용 전후 시간별 전력({len(targets)}곳)", 'unit': 'kW', 'labels': [f'{i}시' for i in range(24)],
            'series': [{'name': '적용 전', 'role': 'previous', 'values': before}, {'name': '적용 후', 'role': 'current', 'values': after}],
            'note': f"{args['time']} 이후 예상 절감 {draft['estimatedSavingKwh']}kWh(오늘, 가상)",
        }
        return ({'targets': len(targets), 'rooms': draft['roomNames'], 'estimatedSavingKwh': draft['estimatedSavingKwh']},
                {'highlight': draft['roomIds'], 'draft': draft, 'chart': chart})
    raise ValueError(f'알 수 없는 도구: {name}')



COMFORT_ASSUMPTIONS = '활동량 1.1met(사무), 착의량 냉방철 0.5clo·난방철 1.0clo, 기류 0.1m/s, 평균복사온도는 실내온도와 같음(가상 데이터)'


def _comfort(s):
    pmv, ppd = comfort.pmv_ppd(s['temp'], s['temp'], 0.1, s['humidity'], 1.1, 0.5 if s['mode'] == 'cooling' else 1.0)
    di = comfort.discomfort_index(s['temp'], s['humidity'])
    return {'id': s['id'], 'name': s['name'], 'floor': s['floor'], 'use': s['use'], 'occupants': s['occupants'], 'temp': s['temp'],
            'humidity': s['humidity'], 'di': di, 'diStage': comfort.di_stage(di), 'pmv': pmv, 'ppd': ppd}


_kb = None


def _retrieve(query):
    # boto3는 Lambda 런타임 기본 포함. KB_ID는 template.yaml이 주입, 없으면 모델에 오류로 알려 다른 방법 안내
    global _kb
    kb_id = os.environ.get('KB_ID')
    if not kb_id:
        raise ValueError('문서 검색이 설정되지 않음(KB_ID 없음)')
    if _kb is None:
        import boto3
        _kb = boto3.client('bedrock-agent-runtime', region_name=os.environ.get('BEDROCK_REGION', 'ap-northeast-2'))
    res = _kb.retrieve(knowledgeBaseId=kb_id, retrievalQuery={'text': query},
                       retrievalConfiguration={'vectorSearchConfiguration': {'numberOfResults': 4}})
    return res['retrievalResults']


def _search(args):
    q = (args.get('query') or '').strip()
    if not 0 < len(q) <= 200:
        raise ValueError('query는 1~200자')
    docs, sources = [], {}
    for r in _retrieve(q):
        md = r.get('metadata') or {}
        title = md.get('title') or str(md.get('x-amz-bedrock-kb-source-uri', '')).rsplit('/', 1)[-1]
        docs.append({'title': title, 'effectiveDate': md.get('effective_date'), 'url': md.get('url'), 'text': r['content']['text'][:700]})
        sources.setdefault(title, {'title': title, 'url': md.get('url', ''), 'date': md.get('effective_date', ''), 'checked': md.get('checked_date', '')})
    if not docs:
        return {'query': q, 'documents': [], 'note': '관련 문서 없음'}, {}
    return {'query': q, 'documents': docs}, {'sources': list(sources.values())}

def _where(args):
    floor = '전체 층' if args.get('floor', 'all') == 'all' else args['floor']
    return floor if args.get('use', 'all') == 'all' else f"{floor} {args['use']}"


def _prefer(view, chart):
    return {**chart, 'prefer': 'table'} if view == 'table' else chart


def _effect(rooms, t, schedules, draft):
    # 오늘 시간별(HH:30 표본) 대상 호실 전력 합: 기존 스케줄만, 초안 추가(sim.py가 스케줄 시각 이후만 적용)
    day = t.replace(minute=30, second=0, microsecond=0)
    after_list = list(schedules) + [draft]
    before, after = [], []
    for h in range(24):
        ts = day.replace(hour=h)
        before.append(round(sum(sim.state(r, ts, schedules)['powerKw'] for r in rooms), 1))
        after.append(round(sum(sim.state(r, ts, after_list)['powerKw'] for r in rooms), 1))
    return before, after


FREQUENCY_BASIS = '최근 4주 같은 요일(오늘 제외), 시간마다 HH:30 표본, 재실 1명 이상이면 사용(가상 데이터)'


def _frequency(args, t, schedules, rooms, bid, view):
    """usage_frequency: 같은 요일 기준 사용 빈도. weekday는 오늘부터 거슬러 가장 가까운 그 요일"""
    wd, hour, focus = args.get('weekday'), args.get('hour'), args.get('focus')
    if wd not in ['today'] + list(WEEKDAYS) or focus not in ('rooms', 'hours') or args.get('order') not in ('asc', 'desc'):
        raise ValueError('weekday(today, 월~일), focus(rooms, hours), order(asc, desc) 값 오류')
    if type(hour) is not int or not -1 <= hour <= 23:
        raise ValueError('hour는 0~23 정수, 현재 시각은 -1')
    base = t if wd == 'today' else t - dt.timedelta(days=(t.weekday() - WEEKDAYS.index(wd)) % 7)
    h = t.hour if hour == -1 else hour
    targets = _pick(rooms, args['floor'], args['use'])
    if not targets:
        raise ValueError('대상 호실 없음')
    profiles = [(r, usage.profile(r, base, schedules)) for r in targets]
    day, weeks = WEEKDAYS[base.weekday()], usage.WEEKS
    common_out = {'weekday': day, 'weeks': weeks, 'basis': FREQUENCY_BASIS, 'rooms': len(targets)}
    if focus == 'hours':
        rate = [round(sum(p['usageRate'][i] for _, p in profiles) / len(profiles), 2) for i in range(24)]
        idle = [round(sum(p['idleOnRate'][i] for _, p in profiles) / len(profiles), 2) for i in range(24)]
        kw = energy.heatmap({'building': bid}, t)['cells'][base.weekday()]
        chart = _prefer(view, {
            'kind': 'line', 'title': f"{_where(args)} {day}요일 시간대별 평균 사용률(최근 {weeks}주)", 'unit': '%', 'labels': [f'{i}시' for i in range(24)],
            'series': [{'name': '사용률', 'role': 'current', 'values': [round(v * 100) for v in rate]},
                       {'name': '빈 채 운전률', 'role': 'previous', 'values': [round(v * 100) for v in idle]}],
            'note': f"대상 {len(targets)}곳, 가장 자주 쓰는 시간 " + (', '.join(f'{x}시' for x in usage.peak_hours(rate)) or '없음'),
        })
        return ({**common_out, 'usageRate': rate, 'idleOnRate': idle, 'peakHours': usage.peak_hours(rate), 'busyHours': usage.busy_hours(rate),
                 'buildingAvgKw': kw, 'buildingAvgKwBasis': f'건물 전체 {day}요일 시간별 평균 전력(kW, 최근 4주, 히트맵과 같은 값)'},
                {'chart': chart})
    limit = min(20, max(1, int(args['limit'])))
    rows = [{'id': r['id'], 'name': r['name'], 'floor': r['floor'], 'use': r['use'],
             'usedWeeks': p['usedWeeks'][h], 'usageRate': p['usageRate'][h], 'idleOnWeeks': p['idleOnWeeks'][h],
             'busyHours': usage.busy_hours(p['usageRate'])} for r, p in profiles]
    rows.sort(key=lambda x: (x['usageRate'] if args['order'] == 'asc' else -x['usageRate'], -x['idleOnWeeks'], x['floor'], x['name']))
    rows = rows[:limit]
    chart = _prefer(view, {
        'kind': 'bar', 'title': f"{_where(args)} {day}요일 {h}시대 사용률 {'낮은' if args['order'] == 'asc' else '높은'} 순 {len(rows)}곳(최근 {weeks}주)", 'unit': '%',
        'items': [{'id': x['id'], 'label': x['name'], 'sub': f"{x['floor']}, {x['use']}, {x['usedWeeks']}/{weeks}회", 'value': round(x['usageRate'] * 100)} for x in rows],
    })
    return ({**common_out, 'hour': h, 'items': [{k: v for k, v in x.items() if k != 'id'} for x in rows]},
            {'highlight': [x['id'] for x in rows], 'chart': chart})


def _trend(args, t, bid, view):
    if args.get('period') not in PERIODS:
        raise ValueError('period는 day, week, month 중 하나')
    cur_name, prev_name, unit_label = PERIODS[args['period']]
    d = energy.trend({'building': bid, 'period': args['period']}, t)
    n = max(len(d['current']), len(d['previous']))
    labels = [(d['previous'] if len(d['previous']) >= len(d['current']) else d['current'])[i]['label'] for i in range(n)]
    pad = lambda pts: [p['kwh'] for p in pts] + [None] * (n - len(pts))  # noqa: E731  아직 오지 않은 시간·날짜는 빈 값
    pct = round((d['totalKwh'] - d['prevSameKwh']) / d['prevSameKwh'] * 100, 1) if d['prevSameKwh'] else None  # LLM 계산 오류 방지
    chart = _prefer(view, {
        'kind': 'line', 'title': f"{buildings.get(bid)['name']} {cur_name} 전력 사용량({unit_label}, {prev_name} 비교)", 'unit': 'kWh', 'labels': labels,
        'series': [{'name': prev_name, 'role': 'previous', 'values': pad(d['previous'])}, {'name': cur_name, 'role': 'current', 'values': pad(d['current'])}],
        'note': f"{cur_name} {d['totalKwh']}kWh, {prev_name} 같은 시점 {d['prevSameKwh']}kWh" + (f"({pct:+}%)" if pct is not None else ''),
    })
    out = {'period': args['period'], 'unit': 'kWh', 'currentTotal': d['totalKwh'], 'previousSamePoint': d['prevSameKwh'], 'changePct': pct, 'previousTotal': d['prevTotalKwh'],
           'current': d['current'], 'previous': d['previous']}
    return out, {'chart': chart}
