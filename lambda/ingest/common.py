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

# 실내기 용량, 장비 번호, 장비일람표(plan-ingest.md 3-5)
# 실내기 중심과 용량·장비 번호 표기의 최대 거리(m). 춘천초 실내기 37대의 표기 거리 0.96~4.41m 기준(2.5m는 5대 미연결)
NEAR = 4.5
KW = re.compile(r'(?<![\d.])(\d{1,3}(?:\.\d)?)\s*kW(?!\s*(?:이상|이하|초과|미만))', re.I)
# 장비 번호: 영문 대문자 1~4자와 숫자(IU-1, CAC-01, FCU1, E-4.5HP). 도면 축 번호(X1, Y10)는 제외합니다.
# shortcut: 숫자만 있는 번호(01)는 계통 번호, 치수, 호실 번호와 구분하지 못해 제외, 필요해지면 일람표 행과 일치하는 숫자만 허용
TAG = re.compile(r'(?![XY]\d+$)[A-Z]{1,4}-?\d{1,3}(?:\.\d)?(?:HP|[A-Z])?')
HANGUL = re.compile(r'[가-힣]')
HEADS = {'tag': re.compile(r'기호|장비번호|TAG|(?<![A-Z])NO\.?(?![A-Z])', re.I),
         'model': re.compile(r'모델|형식|MODEL|규격', re.I),
         'kw': re.compile(r'냉방(능력|용량)|COOLING', re.I),
         'name': re.compile(r'품명|명칭|NAME', re.I),
         'maker': re.compile(r'제조사|제작사|MAKER|메이커', re.I)}
# 모델번호 형식: 영문 대문자 2자와 숫자 2자 이상, 공백 없이 6자 이상(ARNU12GTRB4). `4-WAY`, `R410A`는 제외합니다.
MODEL_CODE = re.compile(r'(?=(?:.*\d){2})(?=(?:.*[A-Z]){2})[A-Z0-9][A-Z0-9/-]{5,}')


def classify(*texts):
    """이름·ObjectType·블록 이름에서 실내기 유형을 판정합니다. 맞는 별칭이 없으면 None입니다."""
    s = ' '.join(t for t in texts if t).replace('_', ' ')  # CAD 블록 이름의 _ 구분자에서도 \b 경계가 맞도록 바꿉니다.
    for cls, rx in ALIASES:
        if rx.search(s):
            return cls
    return 'cassette_4way' if CASSETTE.search(s) else None  # 방향 표기 없는 카세트는 4방향(hvac_types.json aliasNote)


def _norm(tag):
    return re.sub(r'[\s-]', '', tag or '').upper()


def describe(cls, model=None, kw=None, kw_src=None, tag=None, schedule=()):
    """유형 표시 이름, 매뉴얼, 용량, 장비 번호, 모델을 채웁니다(plan-ingest.md 3-5).

    모델 순서는 원본 모델명(source), 장비 번호가 일치한 일람표 행(schedule), 용량 대응 표(exact, nearest), 유형 예시(type)입니다.
    일람표 행에 용량이 있으면 용량도 일람표 값(kwSource: schedule)을 씁니다. 장비 번호 비교는 공백과 `-`를 무시합니다.
    """
    t = TYPES.get(cls, {})
    out = {'cls': cls, 'type': t.get('name', '미확인'), 'manual': t.get('manual')}
    row = next((r for r in schedule if tag and _norm(r['tag']) == _norm(tag)), None)
    if row and row.get('kw') is not None:
        kw, kw_src = row['kw'], 'schedule'
    if kw is not None:
        out.update(coolKw=kw, kwSource=kw_src)
    if tag:
        out['tag'] = tag
    if model:
        return {**out, 'model': model, 'modelMatch': 'source'}
    if row and row.get('model'):
        return {**out, 'model': row['model'], 'modelMatch': 'schedule'}
    ms = sorted(t.get('models') or [], key=lambda m: (m['kw'], m.get('market') != 'KR'))  # 같은 용량은 국내 모델 우선
    if kw is not None and ms:
        m = min(ms, key=lambda m: abs(m['kw'] - kw))
        if abs(m['kw'] - kw) <= 0.05 + 1e-9:
            return {**out, 'model': m['model'], 'modelMatch': 'exact'}
        m = next((m for m in ms if m['kw'] >= kw), None) or max(ms, key=lambda m: m['kw'])
        return {**out, 'model': m['model'], 'modelMatch': 'nearest'}
    return {**out, 'model': t.get('exampleModel'), 'modelMatch': 'type'}


def capacity(text):
    """문자의 냉방 용량(kW)입니다. 범위 표기(뒤 `이상`, `이하`, `초과`, `미만`, 앞 `~`)와 범례 자리 표시(`00KW`)는 제외합니다."""
    for m in KW.finditer(text or ''):
        if float(m[1]) > 0 and not text[:m.start()].rstrip().endswith('~'):
            return float(m[1])
    return None


def lines(words):
    """단어 [(문자, u0, v0, u1, v1)](v 아래쪽)를 세로 중심 차이가 글자 크기 절반 이하인 줄로 묶어 u 순서로 돌려줍니다."""
    out = []
    for w in sorted(words, key=lambda w: w[2] + w[4]):
        vc, h = (w[2] + w[4]) / 2, min(w[3] - w[1], w[4] - w[2])  # 세로 쓰기 단어도 글자 크기가 되도록 짧은 변을 씁니다.
        if out and abs(vc - out[-1][0]) <= h / 2:
            out[-1][1].append(w)
        else:
            out.append((vc, [w]))
    return [sorted(ws, key=lambda w: w[1]) for _, ws in out]


def labels(words):
    """단어에서 용량 표기와 장비 번호 후보를 골라 {'kw': [[u, v, kW]], 'tag': [[u, v, 번호]]}(단어 중심)로 돌려줍니다.

    한글이 있는 줄의 장비 번호 후보는 실 이름 속 호실 번호(회의실 B101)일 수 있어 제외합니다.
    같은 위치에 겹쳐 그린 같은 문자(PDF 중복 문자 객체)는 1개만 남깁니다.
    """
    out = {'kw': [], 'tag': []}
    for t, u0, v0, u1, v1 in words:
        c = [round((u0 + u1) / 2, 2), round((v0 + v1) / 2, 2)]
        kw = capacity(t)
        tag = next((s for ln in t.splitlines() if not HANGUL.search(ln) for s in ln.split() if TAG.fullmatch(s)), None)
        for key, val in (('kw', kw), ('tag', tag)):
            if val is not None and c + [val] not in out[key]:
                out[key].append(c + [val])
    return out


def pair(units, items, r):
    """거리 r 이내 (실내기 점, 표기 점) 쌍을 가까운 순서로 1:1 연결합니다. {실내기 번호: 표기 번호}"""
    near = ((math.dist(u, p), i, j) for i, u in enumerate(units) for j, p in enumerate(items))
    out, used = {}, set()
    for _, i, j in sorted(x for x in near if x[0] <= r):
        if i not in out and j not in used:
            out[i] = j
            used.add(j)
    return out


def attach(pts, labs, r, have=None):
    """점마다 r 이내 용량(kw)과 장비 번호(tag)를 1:1로 붙입니다. have에 값이 이미 있는 점은 그 항목 연결에서 뺍니다."""
    out = [dict(h) for h in have] if have else [{} for _ in pts]
    for key in ('kw', 'tag'):
        need = [i for i, o in enumerate(out) if key not in o]
        items = labs.get(key, [])
        for i, j in pair([pts[n] for n in need], [x[:2] for x in items], r).items():
            out[need[i]][key] = items[j][2]
    return out


def _head(ln, rx):
    """줄 문자를 공백 없이 이어 머리글을 찾습니다(`형 식`처럼 글자를 띄운 머리글 포함). (u0, u1, 글자 크기) 또는 None"""
    s, own = '', []
    for w in ln:
        s += w[0]
        own += [w] * len(w[0])
    m = rx.search(s)
    if not m:
        return None
    a, b = own[m.start()], own[m.end() - 1]
    return a[1], b[3], max(min(a[3] - a[1], a[4] - a[2]), 1e-6)  # 크기 0 단어(PDF 숨은 문자)로 나누지 않도록 하한


def schedule(words, page=None):
    """장비일람표를 읽어 [{tag, name, model, kw, maker, page}]로 돌려줍니다(plan-ingest.md 3-5).

    머리글은 장비 번호 열(기호, 장비번호, TAG, NO)과 같은 줄 또는 글자 크기 2배 이내 줄에
    모델 열(모델, 형식, MODEL, 규격)이나 용량 열(냉방능력, 냉방용량)이 있는 표입니다.
    표의 끝은 다음 머리글(품명, 제조사 열만 있는 표 포함)입니다.
    장비 번호 열 아래 장비 번호 형식 단어가 행이고, 행 범위는 이웃 행과의 중간까지입니다.
    칸은 단어 중심 또는 왼쪽 끝(왼쪽 정렬 칸)이 머리글 u 범위(글자 크기만큼 확장) 안인 단어입니다.
    모델 칸이 모델번호 형식이 아니면(천장카세트 4-WAY) 품명으로 씁니다. 용량 칸의 첫 숫자가 100 이상이면 W로 보고 kW로 바꿉니다.
    shortcut: 두 줄로 나뉜 열 이름(냉방/능력)과 장비 번호 칸이 빈 행은 읽지 않음, 실제 일람표에서 필요해지면 보완
    """
    ls = lines(words)
    vc = [(ln[0][2] + ln[0][4]) / 2 for ln in ls]
    heads = []
    for i, ln in enumerate(ls):
        cols = {'tag': _head(ln, HEADS['tag'])}
        if not cols['tag']:
            continue
        for j in sorted(range(len(ls)), key=lambda j: abs(vc[j] - vc[i])):  # 같은 줄부터 가까운 줄 순서
            if abs(vc[j] - vc[i]) > 2 * cols['tag'][2]:
                break
            for key in ('model', 'kw', 'name', 'maker'):
                cols[key] = cols.get(key) or _head(ls[j], HEADS[key])
        if any(cols[k] for k in ('model', 'kw', 'name', 'maker')):  # 모델·용량 열이 없는 표(제어기 목록)도 앞 표의 끝
            heads.append((vc[i], cols))
    rows = []
    for n, (top, cols) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else math.inf
        if not (cols['model'] or cols['kw']):
            continue

        def under(w, key):
            u0, u1, h = cols[key]
            return u0 - h <= w[1] <= u1 + h or u0 - h <= (w[1] + w[3]) / 2 <= u1 + h

        def cell(key, a, b):
            if not cols[key]:
                return None
            ws = [w for w in words if under(w, key) and a < (w[2] + w[4]) / 2 <= b]
            return ' '.join(w[0] for w in sorted(ws, key=lambda w: (round(w[2] / cols[key][2]), w[1]))) or None

        h = cols['tag'][2]
        top += h / 2  # 머리글 줄 제외
        tags = sorted(((w[2] + w[4]) / 2, w[0].replace(' ', '')) for w in words if top < (w[2] + w[4]) / 2 < end
                      and under(w, 'tag') and TAG.fullmatch(w[0].replace(' ', '')))
        vs = [v for v, _ in tags]
        for k, (v, tag) in enumerate(tags):
            up = (v - vs[k - 1]) / 2 if k else ((vs[1] - v) / 2 if len(vs) > 1 else 3 * h)
            down = (vs[k + 1] - v) / 2 if k + 1 < len(vs) else up
            a, b = max(v - up, top), v + down
            model, num = cell('model', a, b), re.search(r'\d+(?:\.\d+)?', cell('kw', a, b) or '')
            kw = float(num[0]) if num else None
            code = next((s for s in (model or '').split() if MODEL_CODE.fullmatch(s)), None)
            rows.append({'tag': tag, 'name': cell('name', a, b) or (None if code else model), 'model': code,
                         'kw': round(kw / 1000, 2) if kw and kw >= 100 else kw, 'maker': cell('maker', a, b), 'page': page})
    return rows


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


def build(job, building, kind, files, floors, warnings, name=None, floor_height=None, schedule=None):
    """원본 좌표(m, y 위쪽) 층 목록을 twin.building/v1 초안으로 바꿉니다.

    floors: [{id, level, elevation?, rooms: [{name, number?, poly}],
              units: [{pt, size?, cls, conf, model?, kw?, kwSource?, tag?, ref, source, basis}],
              doors?: [{a, b, hinge, side, source, conf, review, ref}]}]
    문 side는 화면 표시 기준 a→b 왼쪽 1입니다. y 반전 후에도 화면상 왼쪽·오른쪽이 같으므로 값을 그대로 씁니다.
    schedule(장비일람표 행)은 meta.ingest.schedule에 저장하고 실내기 모델 대응에 씁니다.
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
            d = describe(u['cls'], u.get('model'), u.get('kw'), u.get('kwSource'), u.get('tag'), schedule or ())
            idu = {'id': f"IDU-{f['id']}-{n:02d}", 'floor': f['id'], 'room': rid, 'pos': pos, **d,
                   'source': u['source'], 'basis': u['basis'], 'conf': u['conf'],
                   'review': far or u['cls'] == 'unknown' or d['modelMatch'] == 'nearest', 'ref': u['ref']}
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
    if schedule:
        draft['meta']['ingest']['schedule'] = schedule
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
    실내기 인식 상자에는 parse 단계에서 저장한 meta.ingest.texts의 용량(kw)과 장비 번호(tag)를 NEAR(4.5m) 이내에서 가까운 쌍부터 1:1로 붙입니다.
    축척(pxPerM)과 toPlan이 모두 없는 층은 거리를 m로 바꿀 수 없어 붙이지 않습니다.
    """
    floors = {f['id']: f for f in draft['floors']}
    ing = draft['meta']['ingest']
    warnings = ing.setdefault('warnings', [])
    texts, sched = ing.get('texts', {}), ing.get('schedule', [])
    src = {'pdf': 'pdf-text', 'cad': 'cad-text'}.get(ing.get('kind'))
    # 같은 작업을 다시 병합할 때 중복을 막기 위해 해당 층의 이전 인식 결과를 지웁니다.
    draft['idus'] = [u for u in draft['idus'] if not (u.get('source') == 'yolo' and u.get('floor') in detections)]
    for fid, dets in detections.items():
        f = floors.get(fid)
        if f is None:
            warnings.append(f'인식 결과의 층 {fid}이 초안에 없음')
            continue
        f.pop('detections', None)
        T = (f.get('background') or {}).get('toPlan')
        t = texts.get(fid, {})
        ppm = t.get('pxPerM') or (1 / math.hypot(T[0], T[3]) if T else None)
        idx = [i for i, d in enumerate(dets) if d['cls'] != 'door']
        pts = [((dets[i]['box'][0] + dets[i]['box'][2]) / 2, (dets[i]['box'][1] + dets[i]['box'][3]) / 2) for i in idx]
        lab = dict(zip(idx, attach(pts, t, NEAR * ppm))) if ppm else {}
        if not T:
            f['detections'] = [{'cls': d['cls'], 'conf': d['conf'], 'box': d['box'], **lab.get(i, {})}
                               for i, d in enumerate(dets)]
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
            x = lab.get(i - 1, {})
            m = describe(d['cls'], None, x.get('kw'), src, x.get('tag'), sched)
            draft['idus'].append({
                'id': f'IDU-{fid}-Y{i:02d}', 'floor': fid, 'room': rid, 'pos': pos, **m,
                'source': 'yolo', 'basis': 'YOLO 도면 기호 인식', 'conf': round(d['conf'], 3),
                'review': d['conf'] < 0.5 or far or d['cls'] == 'unknown' or m['modelMatch'] == 'nearest',
                'ref': f'yolo-{fid}-{i}',
                'size': [round((u1 - u0) * (a * a + d_ * d_) ** 0.5, 2), round((v1 - v0) * (b * b + e * e) ** 0.5, 2)],
            })
        if doors:
            f['doors'] = doors
    # 응답 units, review는 실내기 수입니다. 문 인식 결과(detections의 door)는 세지 않습니다.
    left = sum(1 for f in draft['floors'] for d in f.get('detections', []) if d['cls'] != 'door')
    units = len(draft['idus']) + left
    review = sum(1 for u in draft['idus'] if u.get('review')) + left
    return units, review
