"""CAD 파서: DXF(DWG는 dwg2dxf 변환 후)에서 벽 선으로 호실, 문자로 실 이름, 블록으로 실내기를 읽습니다."""
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

from common import PX_PER_M, cap_scale, classify

WALL = re.compile(r'wall|벽|구조', re.I)
NOT_WALL = re.compile(r'dim|text|txt|hatch|furn|equip|hvac|mech|치수|문자|해치|가구|설비|기계', re.I)
DOOR = 0.5  # 벽 선 팽창 반지름(m). 폭 1.0m 이하 문 개구부를 막아 호실을 닫힌 영역으로 만듭니다.
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


def parse(path):
    """DXF 1개(1개 층)를 읽어 (호실, 실내기, 렌더링용 선분 또는 None, 경고)를 돌려줍니다. 좌표는 m, y 위쪽입니다."""
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
        cls = classify(e.dxf.name, *attrs.values())
        if not cls:
            continue
        b = bbox.extents([e])
        if not b.has_data:
            continue
        units.append({'pt': (b.center.x * k, b.center.y * k), 'size': (b.size.x * k, b.size.y * k), 'cls': cls, 'conf': 1,
                      'model': next((v for t, v in attrs.items() if 'MODEL' in t and v), None),
                      'ref': e.dxf.handle, 'source': 'cad', 'basis': 'CAD 블록 이름·속성 일치'})
    return rooms, units, (None if units else _lines(list(msp), k)), warnings


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
