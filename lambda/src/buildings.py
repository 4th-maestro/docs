"""건물 목록과 건물별 호실(의원 IFC 호실 137개를 규칙으로 변형)

- main: 공개 IFC 의원 원본. 호실 id는 IFC GUID 그대로(기존 스케줄 호환)
- 가상 건물: 원본 층을 복제·선택하고 용도를 바꿔 생성, 호실 id는 "건물.층.GUID"
- 운영 프로필(hours, weekend, waste)은 호실 dict에 넣어 sim.py가 건물 구분 없이 사용
"""
import json
import pathlib

_DIR = pathlib.Path(__file__).parent
BASE = json.loads((_DIR / 'rooms.json').read_text())
LIST = json.loads((_DIR / 'buildings.json').read_text())
DEFAULT = 'main'
_BY_ID = {b['id']: b for b in LIST}


def get(bid):
    # 요청 본문 값 그대로 조회: 문자열이 아닌 값(목록 등)도 str 변환 후 없는 건물로 처리
    b = _BY_ID.get(str(bid or DEFAULT))
    if not b:
        raise ValueError(f'알 수 없는 건물: {bid}')
    return b


def _make(b):
    out = []
    for floor, src in b['floors'].items():
        for i, r in enumerate([r for r in BASE if r['floor'] == src], 1):
            out.append({
                **r,
                'id': r['id'] if b['id'] == DEFAULT else f"{b['id']}.{floor}.{r['id']}",
                'idu': r['idu'] if b['id'] == DEFAULT else f'IDU-{floor}-{i:03d}',
                'floor': floor, 'use': b['remap'].get(r['use'], r['use']),
                'building': b['id'], 'hours': b['hours'], 'weekend': b['weekend'], 'waste': b['waste'],
            })
    return out


_ROOMS = {b['id']: _make(b) for b in LIST}
BY_ROOM = {r['id']: r for rs in _ROOMS.values() for r in rs}


def rooms(bid=None):
    return _ROOMS[get(bid)['id']]


def floors(bid=None):
    return list(get(bid)['floors'])


def summary(b):
    # 목록 응답용 정적 정보(실시간 값 제외)
    rs = rooms(b['id'])
    return {k: b[k] for k in ('id', 'name', 'use', 'virtual', 'basis')} | {
        'floors': floors(b['id']), 'roomCount': len(rs), 'areaM2': round(sum(r['areaM2'] for r in rs), 1)}
