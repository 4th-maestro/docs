"""건물 목록과 건물별 호실

- 출처: 환경 변수 BUILDINGS_TABLE·ROOMS_TABLE이 있으면 DynamoDB(maestro-twin 스택의 Buildings·Rooms), 없으면 buildings.json·rooms.json(로컬·테스트)
  - 판매사·고객사 구조(2026-11-20 계획)에서 건물이 화면으로 추가·수정되므로 고정 파일 대신 테이블. 초기 적재는 infra/twin/seed.py
  - 판매사 건물 등록·도면 교체·삭제(admin.py)가 Buildings·Rooms 테이블에 직접 기록. 테이블 이름은 tenant.table(테스트는 가짜 테이블)
- 캐시: 실행 환경별 60초. 다시 읽은 내용이 바뀌면 version()이 바뀌고, 다른 모듈의 파생 값은 version 기준으로 다시 계산
- 수정 정보: 환경 변수 OWNERS_TABLE이 있으면 BuildingOwnersTable 항목의 overrides(name, use, hours, weekend)를 원본 값 위에 덮어씀
  - 트윈 Buildings 테이블은 적재 스크립트가 항목 전체를 덮어써서 수정 정보를 별도 테이블에 저장. PATCH /admin/buildings/{id}(admin.py)가 기록
- 파일 출처의 호실: main은 공개 IFC 의원 원본(호실 id는 IFC GUID), 가상 건물은 원본 층을 복제·선택하고 용도를 바꿔 생성(호실 id "건물.층.GUID")
- 운영 프로필(hours, weekend, waste)은 호실 dict에 넣어 sim.py가 건물 구분 없이 사용
- LIST, BY_ROOM은 모듈 속성으로 접근하면 캐시에서 계산(기존 호출 코드 호환)
"""
import hashlib
import json
import os
import pathlib
import re
import time
from decimal import Decimal

import tenant

_DIR = pathlib.Path(__file__).parent
DEFAULT = 'main'
TTL = 60
_cache = {'at': 0.0, 'data': None}


def _make(b, base):
    out = []
    for floor, src in b['floors'].items():
        for i, r in enumerate([r for r in base if r['floor'] == src], 1):
            out.append({
                **r,
                'id': r['id'] if b['id'] == DEFAULT else f"{b['id']}.{floor}.{r['id']}",
                'idu': r['idu'] if b['id'] == DEFAULT else f'IDU-{floor}-{i:03d}',
                'floor': floor, 'use': b['remap'].get(r['use'], r['use']),
            })
    return out


def _plain(v):
    # DynamoDB Decimal → int·float
    if isinstance(v, Decimal):
        return int(v) if v == int(v) else float(v)
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


def _floor_key(f):
    # 1F < 2F < 10F, 지하 B1F는 음수
    m = re.fullmatch(r'(B?)(\d+)F?', f)
    return (-int(m.group(2)) if m.group(1) else int(m.group(2))) if m else 0


def _from_files():
    base = json.loads((_DIR / 'rooms.json').read_text())
    lst = json.loads((_DIR / 'buildings.json').read_text())
    return lst, {b['id']: _make(b, base) for b in lst}


def _from_tables():
    lst = [{'id': x.pop('buildingId'), **x} for x in map(_plain, tenant.scan('BUILDINGS_TABLE'))]
    rooms = {}
    for x in map(_plain, tenant.scan('ROOMS_TABLE')):
        rooms.setdefault(x.pop('buildingId'), []).append({'id': x.pop('roomId'), **x})
    # 테이블 스캔 순서는 임의: 건물은 기본 건물 먼저 + id 순, 호실은 층 순 + 실내기 번호 순(파일 출처와 같은 순서)
    lst.sort(key=lambda b: (b['id'] != DEFAULT, b['id']))
    for b in lst:
        b['floors'] = dict(sorted(b['floors'].items(), key=lambda kv: _floor_key(kv[0])))
        order = list(b['floors'])
        rooms[b['id']] = sorted(rooms.get(b['id'], []), key=lambda r: (order.index(r['floor']) if r['floor'] in order else 99, r['idu']))
    return lst, rooms


def _overrides():
    if not os.environ.get('OWNERS_TABLE'):
        return {}
    return {o['buildingId']: _plain(o['overrides']) for o in tenant.scan('OWNERS_TABLE') if o.get('overrides')}


def _load():
    lst, rooms = _from_tables() if os.environ.get('BUILDINGS_TABLE') else _from_files()
    over = _overrides()
    for b in lst:
        b.update(over.get(b['id'], {}))
    by_id = {b['id']: b for b in lst}
    for bid, rs in rooms.items():
        b = by_id.get(bid)
        for r in rs:
            r.update(building=bid, **({'hours': b['hours'], 'weekend': b['weekend'], 'waste': b['waste']} if b else {}))
    ver = hashlib.sha1(json.dumps([lst, rooms], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    return {'list': lst, 'by_id': by_id, 'rooms': rooms, 'by_room': {r['id']: r for rs in rooms.values() for r in rs}, 'version': ver}


def _data():
    now = time.monotonic()
    if _cache['data'] is None or now - _cache['at'] > TTL:
        _cache['data'], _cache['at'] = _load(), now
    return _cache['data']


def forget():
    """건물 정보 수정 후 같은 실행 환경의 캐시 비움(다른 실행 환경은 60초 안에 반영)"""
    _cache['data'] = None


def version():
    """데이터 내용 해시: 다른 모듈의 파생 값 캐시 키"""
    return _data()['version']


def __getattr__(name):
    if name == 'LIST':
        return _data()['list']
    if name == 'BY_ROOM':
        return _data()['by_room']
    raise AttributeError(name)


def get(bid):
    # 요청 본문 값 그대로 조회: 문자열이 아닌 값(목록 등)도 str 변환 후 없는 건물로 처리
    b = _data()['by_id'].get(str(bid or DEFAULT))
    if not b:
        raise ValueError(f'알 수 없는 건물: {bid}')
    return b


def rooms(bid=None):
    return _data()['rooms'].get(get(bid)['id'], [])


def floors(bid=None):
    return list(get(bid)['floors'])


def summary(b):
    # 목록 응답용 정적 정보(실시간 값 제외)
    rs = rooms(b['id'])
    return {k: b[k] for k in ('id', 'name', 'use', 'virtual', 'basis', 'hours', 'weekend')} | {
        'floors': floors(b['id']), 'roomCount': len(rs), 'areaM2': round(sum(r['areaM2'] for r in rs), 1)}
