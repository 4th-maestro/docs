"""CAD 파서: DXF(DWG는 dwg2dxf 변환 후)에서 벽 선으로 호실, 문자로 실 이름, 블록으로 실내기, 문 블록·호로 문을 읽습니다."""
import math
import pathlib
import re
import shutil
import subprocess

from ezdxf import bbox, disassemble, recover
from ezdxf import units as dxf_units
from PIL import Image, ImageDraw
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from common import DOOR_W, PX_PER_M, cap_scale, classify

WALL = re.compile(r'wall|벽|구조', re.I)
NOT_WALL = re.compile(r'dim|text|txt|hatch|furn|equip|hvac|mech|치수|문자|해치|가구|설비|기계', re.I)
DOOR = 0.5  # 벽 선 팽창 반지름(m). 폭 1.0m 이하 문 개구부를 막아 호실을 닫힌 영역으로 만듭니다.
# 문 블록·레이어 별칭. 앞뒤 영문자 검사로 DOOR900, DR1, A-DOOR는 맞고 OUTDOOR(실외기), DRAIN, 창문, 문자는 제외합니다.
DOOR_NAME = re.compile(r'(?<![a-z])(door|dr(?![a-z]))|(?<!창)문(?!자)', re.I)
GAP = 0.3  # 문 호의 경첩·닫힌 쪽 끝과 벽 선의 최대 거리(m)
AREA_TEXT = re.compile(r'㎡|m2|m²', re.I)
NUMBER = re.compile(r'^[A-Z]?\d{2,4}(-\d+)?[A-Z]?$', re.I)


def dwg_to_dxf(src, out_dir):
    exe = shutil.which('dwg2dxf')
    if not exe:
        raise RuntimeError('DWG 변환 도구 dwg2dxf(libredwg)가 없습니다. 컨테이너 이미지로 실행하십시오.')
    dst = pathlib.Path(out_dir) / (pathlib.Path(src).stem + '.dxf')
    # dwg2dxf는 지원하지 않는 객체가 있으면 결과 파일을 만들고도 0이 아닌 코드로 끝나므로 결과 파일로 판정합니다.
    r = subprocess.run([exe, '-y', '-o', str(dst), str(src)], capture_output=True, text=True, timeout=600)
    if not dst.exists():
        raise RuntimeError(f'DWG 변환 실패: {(r.stderr or r.stdout).strip()[-300:]}')
    return dst


def _lines(entities, k):
    """객체를 선분 목록(m)으로 분해합니다. 원호, 블록 안 객체도 포함합니다."""
    out = []
    for p in disassemble.to_primitives(disassemble.recursive_decompose(entities)):
        v = [(q.x * k, q.y * k) for q in p.vertices()]
        if len(v) >= 2:
            out.append(v)
    return out


def _rooms(lines):
    """벽 선을 DOOR만큼 팽창해 문 개구부를 막고, 벽 사이 빈 영역을 호실로 만듭니다."""
    if not lines:
        return []
    walls = unary_union([LineString(v) for v in lines])
    x0, y0, x1, y1 = walls.bounds
    mass = walls.buffer(DOOR, cap_style='square', join_style='mitre')  # 둥근 끝은 개구부 중앙에 뾰족한 틈을 남깁니다.
    free = box(x0 - 1, y0 - 1, x1 + 1, y1 + 1).difference(mass)
    rooms = []
    for p in getattr(free, 'geoms', [free]):
        if p.bounds[0] < x0 - 0.75:  # 건물 바깥 영역
            continue
        r = p.buffer(DOOR, join_style='mitre', mitre_limit=2).simplify(0.02)
        r = Polygon(r.exterior, [h for h in r.interiors if Polygon(h).area >= 2])
        if r.area < 2:
            continue
        bx0, by0, bx1, by1 = r.bounds
        if r.interiors and max(bx0 - x0, by0 - y0, x1 - bx1, y1 - by1) < 1:  # 건물을 구멍으로 둘러싼 도면 틀 안쪽 영역
            continue
        rooms.append(r)
    return rooms


def _door_arc(arc, k, walls):
    """문 호를 벽 위 문 구간으로 바꿉니다. 호 중심이 경첩(a), 반지름이 폭입니다. (문, 벽 틈 일치 여부)를 돌려줍니다.

    호 양 끝 중 벽 선에서 GAP 이내이고 경첩과의 중간점이 벽 선에서 0.1m 넘게 떨어진(벽 틈) 끝을 닫힌 쪽(b)으로 봅니다.
    다른 끝은 열린 문짝 끝이며 side(화면 표시 기준 a→b 왼쪽 1, 오른쪽 -1)를 정합니다.
    shortcut: 벽 레이어가 없는 도면은 문짝 선도 벽 선으로 읽어 닫힌 쪽 판정이 틀릴 수 있음, 실제 도면 검증 후 보완
    """
    c = arc.ocs().to_wcs(arc.dxf.center)
    h = (c.x * k, c.y * k)
    ends = [(p.x * k, p.y * k) for p in (arc.start_point, arc.end_point)]
    gap = sorted((walls.distance(Point(p)), i) for i, p in enumerate(ends) if walls.distance(Point(p)) <= GAP
                 and walls.distance(Point((h[0] + p[0]) / 2, (h[1] + p[1]) / 2)) > 0.1)
    i = gap[0][1] if gap else 0
    b, tip = ends[i], ends[1 - i]
    cross = (b[0] - h[0]) * (tip[1] - h[1]) - (b[1] - h[1]) * (tip[0] - h[0])  # y 위쪽 원본 좌표에서 양수가 왼쪽
    door = {'a': h, 'b': b, 'hinge': 'a', 'side': 1 if cross >= 0 else -1}
    return door, bool(gap) and walls.distance(Point(h)) <= GAP


def _doors(msp, walls, k):
    """문 블록(DOOR_NAME과 맞는 INSERT)과 벽 틈 옆 문 호(ARC, 반지름 0.6~2.0m)를 문 목록으로 만듭니다."""
    # 문 호·문짝·문 블록이 벽 선에 섞이면 벽 틈 판정이 틀리므로 제외합니다.
    lines = _lines([e for e in walls if e.dxftype() != 'ARC' and not DOOR_NAME.search(e.dxf.layer)
                    and not (e.dxftype() == 'INSERT' and DOOR_NAME.search(e.dxf.name))], k)
    wall = unary_union([LineString(v) for v in lines])  # 선이 없으면 거리가 nan이라 모든 판정이 거짓
    doors = []
    for e in msp.query('INSERT'):
        if not DOOR_NAME.search(e.dxf.name):
            continue
        arc = next((v for v in disassemble.recursive_decompose([e]) if v.dxftype() == 'ARC'), None)
        if arc is not None:
            door, ok = _door_arc(arc, k, wall)
            ok = ok and DOOR_W[0] <= arc.dxf.radius * k <= DOOR_W[1]
        else:  # 호가 없는 문 블록(미서기문 등)은 외곽 상자 긴 변 방향 중심선
            b = bbox.extents([e])
            if not b.has_data:
                continue
            x0, y0, x1, y1 = b.extmin.x * k, b.extmin.y * k, b.extmax.x * k, b.extmax.y * k
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            door = {'a': (x0, cy), 'b': (x1, cy)} if x1 - x0 >= y1 - y0 else {'a': (cx, y0), 'b': (cx, y1)}
            door, ok = {**door, 'hinge': 'a', 'side': 1}, False
        doors.append({**door, 'source': 'cad', 'conf': 1, 'review': not ok, 'ref': e.dxf.handle})
    for e in msp.query('ARC'):
        if not DOOR_W[0] <= e.dxf.radius * k <= DOOR_W[1]:
            continue
        door, ok = _door_arc(e, k, wall)
        if ok:  # 벽 틈 옆이 아닌 호는 문으로 보지 않습니다.
            doors.append({**door, 'source': 'cad', 'conf': 0.6, 'review': False, 'ref': e.dxf.handle})
    return doors


def parse(path):
    """DXF 1개(1개 층)를 읽어 (호실, 실내기, 문, 렌더링용 선분 또는 None, 경고)를 돌려줍니다. 좌표는 m, y 위쪽입니다."""
    doc, _ = recover.readfile(str(path))
    name, warnings = pathlib.Path(path).name, []
    if not doc.units:
        warnings.append(f'{name}: $INSUNITS 없음, mm로 가정')
    k = dxf_units.conversion_factor(doc.units or dxf_units.MM, dxf_units.M)
    msp = doc.modelspace()
    walls = [e for e in msp if WALL.search(e.dxf.layer)]
    if not walls:
        walls = [e for e in msp if e.dxftype() in ('LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC') and not NOT_WALL.search(e.dxf.layer)]
        warnings.append(f'{name}: 벽 레이어 없음, 치수·문자·가구·설비 외 레이어의 선으로 호실 생성')
    polys = _rooms(_lines(walls, k))
    texts = [(Point(e.dxf.insert.x * k, e.dxf.insert.y * k), (e.dxf.text if e.dxftype() == 'TEXT' else e.plain_text()).strip())
             for e in msp.query('TEXT MTEXT')]
    rooms = []
    for p in polys:
        inside = [t for pt, t in texts if t and not AREA_TEXT.search(t) and p.contains(pt)]
        rooms.append({'name': ' '.join(inside[:2]), 'number': next((t for t in inside if NUMBER.match(t)), None), 'poly': p})
    units = []
    for e in msp.query('INSERT'):
        attrs = {a.dxf.tag.upper(): a.dxf.text for a in e.attribs}
        cls = None if DOOR_NAME.search(e.dxf.name) else classify(e.dxf.name, *attrs.values())
        if not cls:
            continue
        b = bbox.extents([e])
        if not b.has_data:
            continue
        units.append({'pt': (b.center.x * k, b.center.y * k), 'size': (b.size.x * k, b.size.y * k), 'cls': cls, 'conf': 1,
                      'model': next((v for t, v in attrs.items() if 'MODEL' in t and v), None),
                      'ref': e.dxf.handle, 'source': 'cad', 'basis': 'CAD 블록 이름·속성 일치'})
    return rooms, units, _doors(msp, walls, k), (None if units else _lines(list(msp), k)), warnings


def render(lines, M):
    """선분(원본 m)을 평면 좌표로 변환해 1m당 80px로 렌더링합니다. (이미지, 1m당 화소, toPlan)을 돌려줍니다."""
    a, b, d, e, xo, yo = M
    plan = [[(a * x + b * y + xo, d * x + e * y + yo) for x, y in v] for v in lines]
    xs = [x for v in plan for x, _ in v]
    ys = [y for v in plan for _, y in v]
    x0, y0 = min(xs) - 1, min(ys) - 1
    w, h = max(xs) + 1 - x0, max(ys) + 1 - y0
    s = cap_scale(w, h, PX_PER_M)
    img = Image.new('L', (math.ceil(w * s), math.ceil(h * s)), 255)
    draw = ImageDraw.Draw(img)
    for v in plan:
        draw.line([((x - x0) * s, (y - y0) * s) for x, y in v], fill=0, width=2)
    return img, round(s, 3), [1 / s, 0, x0, 0, 1 / s, y0]
