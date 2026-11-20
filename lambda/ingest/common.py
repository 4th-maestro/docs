"""형식 공통 처리: 실내기 유형 판정, 층 이름 판정, 평면 좌표 변환, 호실 배정, 인식 결과 병합"""
import json
import math
import pathlib
import re
from collections import Counter
from datetime import datetime, timezone

from shapely import affinity
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

# 원본은 _maestro/ml/hvac_types.json입니다. 이 파일은 컨테이너 빌드용 복사본입니다.
TYPES = {t['class']: t for t in json.loads((pathlib.Path(__file__).parent / 'hvac_types.json').read_text())['types']}
ALIASES = [(c, re.compile(t['aliases'], re.I)) for c, t in TYPES.items()]
CASSETTE = re.compile(r'cassette|카세트', re.I)

FLOOR_HEIGHT, CEILING = 3.6, 2.8  # 원본에 값이 없을 때 쓰는 기본값(frontend/twin/data/building.json과 같음)
MAX_PX = 64_000_000  # 도면 이미지 1장의 최대 화소 수, 인식 Lambda 메모리 기준
PX_PER_M = 80  # 인식 모델 학습 축척(1m당 80px)
DOOR_W = (0.6, 2.0)  # 문 폭 정상 범위(m). CAD 문 호 판정과 인식 문 확인 기준(plan-ingest.md 3-4)

ROOM_TYPES = [
    ('wc', re.compile(r'화장실|toilet|\bwc\b|restroom|lavatory|bath', re.I)),
    ('core', re.compile(r'계단|stair|엘리베이터|승강기|elev|\bev\b|shaft|샤프트|\be?ps\b|\bad\b', re.I)),
    ('corridor', re.compile(r'복도|corridor|hall|홀|로비|lobby|현관|\bentr|foyer', re.I)),
    ('store', re.compile(r'창고|storage|store', re.I)),
]
KO_NUM = '일이삼사오육칠팔구십'
FLOOR_KO = re.compile(rf'(지하\s*)?(\d{{1,2}}|(?<![가-힣])[{KO_NUM}])\s*층')
FLOOR_EN = re.compile(r'(?<![A-Za-z0-9])(B?)(\d{1,2})\s*F\b', re.I)


def classify(*texts):
    """이름·ObjectType·블록 이름에서 실내기 유형을 판정합니다. 맞는 별칭이 없으면 None입니다."""
    s = ' '.join(t for t in texts if t).replace('_', ' ')  # CAD 블록 이름의 _ 구분자에서도 \b 경계가 맞도록 바꿉니다.
    for cls, rx in ALIASES:
        if rx.search(s):
            return cls
    return 'cassette_4way' if CASSETTE.search(s) else None  # 방향 표기 없는 카세트는 4방향(hvac_types.json aliasNote)


def describe(cls, model=None):
    """유형별 표시 이름, LG 예시 모델, 매뉴얼을 채웁니다. 원본 모델명이 있으면 원본 값을 씁니다."""
    t = TYPES.get(cls, {})
    return {'cls': cls, 'type': t.get('name', '미확인'), 'model': model or t.get('exampleModel'), 'manual': t.get('manual')}


def floor_hint(text):
    """문자열에서 층 표기(1층, 일층, 지하1층, 1F, B1F)를 찾아 가장 많이 나온 층 ID를 돌려줍니다."""
    hits = []
    for m in FLOOR_KO.finditer(text or ''):
        n = int(m[2]) if m[2].isdigit() else KO_NUM.index(m[2]) + 1
        hits.append(f'B{n}F' if m[1] else f'{n}F')
    hits += [f'{m[1].upper()}{int(m[2])}F' for m in FLOOR_EN.finditer(text or '')]
    return Counter(hits).most_common(1)[0][0] if hits else None


def level(fid, default):
    """층 ID의 층 번호입니다(3F → 3, B1F → -1). 층 표기가 아니면 default입니다."""
    m = re.fullmatch(r'(B?)(\d+)F', fid)
    return (-1 if m[1] else 1) * int(m[2]) if m else default


def room_type(name):
    return next((t for t, rx in ROOM_TYPES if rx.search(name or '')), 'room')


def cap_scale(w, h, scale):
    """w×h(원본 단위)를 scale배로 렌더링할 때 화소 수가 MAX_PX를 넘으면 배율을 줄입니다."""
    return min(scale, (MAX_PX / max(w * h, 1e-9)) ** 0.5)


def assign_room(rooms, pos):
    """pos를 포함하는 호실 ID와 확인 필요 여부를 돌려줍니다. 포함 호실이 없으면 가장 가까운 호실입니다."""
    if not rooms:
        return None, True
    p = Point(pos)
    polys = [(r['id'], Polygon(r['polygon'], r.get('holes'))) for r in rooms]
    hit = next((rid for rid, g in polys if g.contains(p)), None)
    return (hit, False) if hit else (min(polys, key=lambda x: x[1].distance(p))[0], True)


def build(job, building, kind, files, floors, warnings, name=None, floor_height=None):
    """원본 좌표(m, y 위쪽) 층 목록을 twin.building/v1 초안으로 바꿉니다.

    floors: [{id, level, elevation?, rooms: [{name, number?, poly}], units: [{pt, size?, cls, conf, model?, ref, source, basis}],
              doors?: [{a, b, hinge, side, source, conf, review, ref}]}]
    문 side는 화면 표시 기준 a→b 왼쪽 1입니다. y 반전 후에도 화면상 왼쪽·오른쪽이 같으므로 값을 그대로 씁니다.
    돌려주는 M은 원본 좌표에서 평면 좌표로 가는 shapely affine 계수입니다(건물 외곽 최소점 원점, y 아래쪽).
    """
    geoms = [r['poly'] for f in floors for r in f['rooms']] + [Point(u['pt']) for f in floors for u in f['units']]
    minx, miny, maxx, maxy = unary_union(geoms).bounds if geoms else (0, 0, 0, 0)
    M = [1, 0, 0, -1, -minx, maxy]

    def xy(p):
        return [round(p[0] - minx, 2), round(maxy - p[1], 2)]

    out_floors, idus = [], []
    for f in floors:
        rooms, seen = [], set()
        for i, r in enumerate(f['rooms'], 1):
            g = affinity.affine_transform(r['poly'], M)
            num = r.get('number')
            rid = f"{f['id']}-{num}" if num and num not in seen else f"{f['id']}-r{i:02d}"
            seen.add(num)
            room = {'id': rid, 'name': r['name'] or rid, 'type': room_type(r['name']),
                    'polygon': [[round(x, 2), round(y, 2)] for x, y in g.exterior.coords[:-1]]}
            if g.interiors:
                room['holes'] = [[[round(x, 2), round(y, 2)] for x, y in h.coords[:-1]] for h in g.interiors]
            if num:
                room['number'] = num
            rooms.append(room)
        fl = {'id': f['id'], 'level': f['level'], 'rooms': rooms}
        if f.get('elevation') is not None:
            fl['elevation'] = round(f['elevation'], 2)
        if f.get('doors'):  # 문이 없으면 키를 두지 않아 트윈이 임의 문을 생성합니다(plan-ingest.md 3절).
            fl['doors'] = [{'id': f"D-{f['id']}-{n:02d}", **d, 'a': xy(d['a']), 'b': xy(d['b'])} for n, d in enumerate(f['doors'], 1)]
        out_floors.append(fl)
        for n, u in enumerate(f['units'], 1):
            pos = xy(u['pt'])
            rid, far = assign_room(rooms, pos)
            idu = {'id': f"IDU-{f['id']}-{n:02d}", 'floor': f['id'], 'room': rid, 'pos': pos,
                   **describe(u['cls'], u.get('model')), 'source': u['source'], 'basis': u['basis'],
                   'conf': u['conf'], 'review': far or u['cls'] == 'unknown', 'ref': u['ref']}
            if u.get('size'):
                idu['size'] = [round(v, 2) for v in u['size']]
            idus.append(idu)
    draft = {
        'schema': 'twin.building/v1',
        'source': f"도면 변환({kind}): {', '.join(files)}",
        'building': {'id': building, 'name': name or building, 'size': {'w': round(maxx - minx, 2), 'd': round(maxy - miny, 2)},
                     'floorHeight': round(floor_height or FLOOR_HEIGHT, 2), 'ceiling': CEILING},
        'floors': out_floors,
        'idus': idus,
        'meta': {'ingest': {'jobId': job, 'kind': kind, 'files': files,
                            'createdAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'warnings': warnings}},
    }
    return draft, M


def door_from_box(rooms, T, box):
    """문 인식 상자를 가장 가까운 호실 변 위 구간으로 바꿉니다(plan-ingest.md 3-4). (a, b, side, 변 일치 여부, 폭 m)

    폭은 상자 긴 변(m)입니다. 상자 중심과 거리가 폭 이하인 변 중 가장 가까운 변(1e-6m 이내 동률은 앞 변)에
    상자 중심을 투영하고, 그 점을 중심으로 폭만큼의 구간을 만듭니다. 변이 폭보다 길면 구간을 변 안으로 옮깁니다.
    맞는 변이 없으면 상자 긴 변 방향 중심선을 씁니다. side는 상자 중심(호 기호)이 있는 쪽입니다.
    """
    a, b, c, d, e, f = T
    u0, v0, u1, v1 = box

    def plan(u, v):
        return a * u + b * v + c, d * u + e * v + f

    wu, wv = (u1 - u0) * math.hypot(a, d), (v1 - v0) * math.hypot(b, e)
    w, (um, vm) = max(wu, wv), ((u0 + u1) / 2, (v0 + v1) / 2)
    cx, cy = plan(um, vm)
    edges = [LineString((p, q)) for r in rooms for p, q in zip(r['polygon'], r['polygon'][1:] + r['polygon'][:1]) if p != q]
    ds = [g.distance(Point(cx, cy)) for g in edges]
    near = min(ds, default=math.inf)
    hit = near <= w
    if hit:
        (px, py), (qx, qy) = edges[next(i for i, x in enumerate(ds) if x <= near + 1e-6)].coords
    else:
        (px, py), (qx, qy) = (plan(u0, vm), plan(u1, vm)) if wu >= wv else (plan(um, v0), plan(um, v1))
    n = math.hypot(qx - px, qy - py) or 1
    dx, dy = (qx - px) / n, (qy - py) / n
    t = (cx - px) * dx + (cy - py) * dy
    if n >= w:
        t = min(max(t, w / 2), n - w / 2)
    p0, p1 = [px + dx * (t - w / 2), py + dy * (t - w / 2)], [px + dx * (t + w / 2), py + dy * (t + w / 2)]
    # 평면 좌표(y 아래쪽)에서 화면상 a→b 왼쪽 법선은 (dy, -dx)입니다.
    side = 1 if (cx - p0[0]) * dy - (cy - p0[1]) * dx >= 0 else -1
    return p0, p1, side, hit, w


def merge(draft, detections):
    """YOLO 결과를 초안에 반영합니다. toPlan이 있는 층은 idus로 바꾸고, 없는 층은 floors[].detections에 둡니다.

    cls가 door인 결과는 실내기로 바꾸지 않습니다. toPlan이 있는 층은 floors[].doors로 바꾸고, 없는 층은 detections에 둡니다.
    """
    floors = {f['id']: f for f in draft['floors']}
    warnings = draft['meta']['ingest'].setdefault('warnings', [])
    # 같은 작업을 다시 병합할 때 중복을 막기 위해 해당 층의 이전 인식 결과를 지웁니다.
    draft['idus'] = [u for u in draft['idus'] if not (u.get('source') == 'yolo' and u.get('floor') in detections)]
    for fid, dets in detections.items():
        f = floors.get(fid)
        if f is None:
            warnings.append(f'인식 결과의 층 {fid}이 초안에 없음')
            continue
        f.pop('detections', None)
        T = (f.get('background') or {}).get('toPlan')
        if not T:
            f['detections'] = [{'cls': d['cls'], 'conf': d['conf'], 'box': d['box']} for d in dets]
            continue
        a, b, c, d_, e, g = T
        doors = [x for x in f.pop('doors', []) if x.get('source') != 'yolo']
        for i, d in enumerate(dets, 1):
            if d['cls'] == 'door':
                p0, p1, side, hit, w = door_from_box(f['rooms'], T, d['box'])
                mid = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
                # CAD에서 읽은 문과 같은 위치(중점 거리 0.5m 미만)면 원본 형상을 유지합니다.
                if any(math.dist(mid, ((x['a'][0] + x['b'][0]) / 2, (x['a'][1] + x['b'][1]) / 2)) < 0.5 for x in doors):
                    continue
                doors.append({'id': f'D-{fid}-Y{i:02d}', 'a': [round(v, 2) for v in p0], 'b': [round(v, 2) for v in p1],
                              'hinge': 'a', 'side': side, 'source': 'yolo', 'conf': round(d['conf'], 3),
                              'review': not hit or not DOOR_W[0] <= w <= DOOR_W[1] or d['conf'] < 0.5, 'ref': f'det-{i}'})
                continue
            u0, v0, u1, v1 = d['box']
            u, v = (u0 + u1) / 2, (v0 + v1) / 2
            pos = [round(a * u + b * v + c, 2), round(d_ * u + e * v + g, 2)]
            rid, far = assign_room(f['rooms'], pos)
            draft['idus'].append({
                'id': f'IDU-{fid}-Y{i:02d}', 'floor': fid, 'room': rid, 'pos': pos, **describe(d['cls']),
                'source': 'yolo', 'basis': 'YOLO 도면 기호 인식', 'conf': round(d['conf'], 3),
                'review': d['conf'] < 0.5 or far or d['cls'] == 'unknown', 'ref': f'yolo-{fid}-{i}',
                'size': [round((u1 - u0) * (a * a + d_ * d_) ** 0.5, 2), round((v1 - v0) * (b * b + e * e) ** 0.5, 2)],
            })
        if doors:
            f['doors'] = doors
    # 응답 units, review는 실내기 수입니다. 문 인식 결과(detections의 door)는 세지 않습니다.
    left = sum(1 for f in draft['floors'] for d in f.get('detections', []) if d['cls'] != 'door')
    units = len(draft['idus']) + left
    review = sum(1 for u in draft['idus'] if u.get('review')) + left
    return units, review
