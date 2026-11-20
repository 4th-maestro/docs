"""IFC 파서: 층(IfcBuildingStorey), 호실(IfcSpace 바닥 다각형), 실내기(IfcUnitaryEquipment, 별칭 일치 객체), 문(IfcDoor)"""
import math
import statistics

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import ifcopenshell.util.placement as up
import ifcopenshell.util.unit as uu
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

from common import classify, floor_hint, level

SETTINGS = ifcopenshell.geom.settings()
SETTINGS.set('use-world-coords', True)
# 별칭 검사 대상. 덕트(IfcFlowSegment)와 벽까지 검사하면 'duct', 'stand' 별칭이 덕트·Standard 객체를 실내기로 판정합니다.
CANDIDATES = ('IfcEnergyConversionDevice', 'IfcFlowTerminal', 'IfcFlowMovingDevice', 'IfcBuildingElementProxy')


def _verts(el):
    # Keep the owning SWIG shape alive while copying geometry; a temporary owner
    # can free the native buffers before verts/faces are read.
    shape = ifcopenshell.geom.create_shape(SETTINGS, el)
    g = shape.geometry
    v = tuple(g.verts)
    return [(v[i], v[i + 1], v[i + 2]) for i in range(0, len(v), 3)], tuple(g.faces)


def _footprint(el):
    """형상 최저면 삼각형을 합쳐 바닥 다각형을 만듭니다(docs/reports/tools/ifc_extract.py와 같은 방식)."""
    pts, f = _verts(el)
    zmin = min(p[2] for p in pts)
    tris = [Polygon([pts[f[i + k]][:2] for k in range(3)]) for i in range(0, len(f), 3)
            if max(pts[f[i + k]][2] for k in range(3)) - zmin < 0.05]
    poly = unary_union([t for t in tris if t.area > 1e-6]).buffer(0)
    if poly.geom_type == 'MultiPolygon':
        poly = max(poly.geoms, key=lambda g: g.area)
    return poly.simplify(0.01), zmin


def _storey(el, z, storeys):
    """객체가 속한 층입니다. 공간 구조 관계가 없으면 z 아래 가장 높은 층입니다."""
    st = ue.get_container(el, ifc_class='IfcBuildingStorey') or ue.get_aggregate(el)
    if st is not None and st.is_a('IfcBuildingStorey'):
        return st
    return max(((s, e) for s, e in storeys if e <= z + 0.5), key=lambda x: x[1], default=min(storeys, key=lambda x: x[1]))[0]


def _by_size(x0, y0, x1, y1, z0, z1, floor_z, rooms):
    """별칭이 없는 실내기의 치수 판정(plan-ingest.md 2절 주)."""
    if z0 - floor_z < 0.3 and z1 - z0 >= 1.2:
        return 'floor_standing'
    # 벽 형상 대신 호실 경계를 벽면으로 봅니다.
    wall = min((r['poly'].exterior.distance(box(x0, y0, x1, y1)) for r in rooms), default=1e9)
    return 'wall_mounted' if wall <= 0.2 and min(x1 - x0, y1 - y0) <= 0.35 else 'unknown'


def _door(el, k):
    """IfcDoor를 배치 x축 방향 문 구간으로 바꿉니다. (문, 바닥 z) 또는 None을 돌려줍니다.

    폭은 OverallWidth, 없으면 형상의 x축 범위입니다. 중심은 형상의 x축 범위 중심입니다.
    배치 원점이 문 중심(Revit)인 파일과 문틀 모서리(IfcDoorStandardCase)인 파일을 함께 맞추기 위함입니다.
    형상이 없으면 배치 원점을 중심으로 씁니다. 경첩·열림 방향은 읽지 않고 hinge a, side 1로 둡니다(plan-ingest.md 3-4).
    """
    if el.ObjectPlacement is None:
        return None
    m = up.get_local_placement(el.ObjectPlacement)
    ox, oy, oz = (float(v) * k for v in m[:3, 3])
    n = math.hypot(m[0][0], m[1][0])
    if n < 1e-6:  # x축이 수직인 배치는 평면 방향을 정할 수 없습니다.
        return None
    dx, dy = m[0][0] / n, m[1][0] / n
    try:
        pts, _ = _verts(el)
        ts = [(x - ox) * dx + (y - oy) * dy for x, y, _ in pts]
        t0, t1, oz = min(ts), max(ts), min(p[2] for p in pts)
    except Exception:
        t0 = t1 = 0
    w = (el.OverallWidth or 0) * k or t1 - t0
    if w <= 0:
        return None
    t = (t0 + t1) / 2
    a = (ox + dx * (t - w / 2), oy + dy * (t - w / 2))
    b = (ox + dx * (t + w / 2), oy + dy * (t + w / 2))
    return {'a': a, 'b': b, 'hinge': 'a', 'side': 1, 'source': 'ifc', 'conf': 1, 'review': False, 'ref': el.GlobalId}, oz


def parse(paths):
    """IFC 파일 목록을 읽어 (층 목록, 경고, 건물 이름, 층고)를 돌려줍니다. 좌표는 m, y 위쪽 원본 좌표입니다."""
    groups, warnings, name, models = {}, [], None, []
    for path in paths:
        f = ifcopenshell.open(str(path))
        k = uu.calculate_unit_scale(f)
        name = name or next((b.Name for b in f.by_type('IfcBuilding') if b.Name), None)
        storeys = [(s, float(up.get_storey_elevation(s) * k)) for s in f.by_type('IfcBuildingStorey')]
        if not storeys:
            warnings.append(f'{path.name}: IfcBuildingStorey 없음')
            continue
        # 건축·설비 IFC를 함께 올리면 같은 높이 층이 파일마다 있으므로 높이(0.1m 단위)로 묶습니다.
        for s, e in storeys:
            groups.setdefault(round(e, 1), {'names': [], 'elev': e, 'rooms': [], 'units': [], 'doors': []})['names'].append(s.Name or '')
        models.append((path, f, storeys))
    # 실내기 치수 판정에 호실 경계가 필요하므로 모든 파일의 호실을 먼저 읽습니다.
    for path, f, storeys in models:
        elev, skipped = dict(storeys), 0
        for sp in f.by_type('IfcSpace'):
            try:
                poly, z = _footprint(sp)
            except Exception:
                skipped += 1
                continue
            if poly.is_empty or poly.area < 0.5:
                continue
            g = groups[round(elev[_storey(sp, z, storeys)], 1)]
            # 설비 IFC의 MEP Space처럼 다른 공간과 80% 이상 겹치면 같은 호실로 보고 제외합니다.
            if any(r['poly'].intersection(poly).area > 0.8 * min(poly.area, r['poly'].area) for r in g['rooms']):
                continue
            nm, ln = (sp.Name or '').strip(), (sp.LongName or '').strip()
            g['rooms'].append({'name': ' '.join(dict.fromkeys(x for x in (nm, ln) if x)),
                               'number': nm if ln and nm and nm != ln else None, 'poly': poly})
        if skipped:
            warnings.append(f'{path.name}: 형상이 없는 IfcSpace {skipped}개 제외')
    for path, f, storeys in models:
        elev, skipped = dict(storeys), 0
        for el in (e for c in CANDIDATES for e in f.by_type(c)):
            t = ue.get_type(el)
            cls = classify(el.Name, el.ObjectType, t.Name if t else None)
            if cls is None and not (el.is_a('IfcUnitaryEquipment') or (t is not None and t.is_a('IfcUnitaryEquipmentType'))):
                continue
            try:
                pts, _ = _verts(el)
            except Exception:
                skipped += 1
                continue
            xs, ys, zs = zip(*pts)
            x0, x1, y0, y1, z0, z1 = min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)
            st = _storey(el, z0, storeys)
            g = groups[round(elev[st], 1)]
            conf, basis = (1, 'IFC 이름 일치') if cls else (0.6, 'IFC 치수 판정')
            ps = ue.get_psets(el).get('Pset_ManufacturerTypeInformation', {})
            g['units'].append({'pt': ((x0 + x1) / 2, (y0 + y1) / 2), 'size': (x1 - x0, y1 - y0),
                               'cls': cls or _by_size(x0, y0, x1, y1, z0, z1, elev[st], g['rooms']), 'conf': conf,
                               'model': ps.get('ModelLabel') or ps.get('ModelReference'), 'ref': el.GlobalId,
                               'source': 'ifc', 'basis': basis})
        if skipped:
            warnings.append(f'{path.name}: 형상이 없는 실내기 후보 {skipped}개 제외')
        k = uu.calculate_unit_scale(f)
        for el in f.by_type('IfcDoor'):
            door = _door(el, k)
            if door:
                groups[round(elev[_storey(el, door[1], storeys)], 1)]['doors'].append(door[0])
    kept = [g for _, g in sorted(groups.items()) if g['rooms'] or g['units']]
    empty = [n for g in groups.values() if not (g['rooms'] or g['units']) for n in g['names']]
    if empty:
        warnings.append(f"호실·실내기가 없는 층 제외: {', '.join(empty)}")
    hints = [next(filter(None, map(floor_hint, g['names'])), None) for g in kept]
    if not (all(hints) and len(set(hints)) == len(hints)):
        # 층 이름으로 ID를 정하지 못하면 높이 순서로 정합니다. -0.5m 이상 첫 층이 1층입니다.
        ground = next((i for i, g in enumerate(kept) if g['elev'] >= -0.5), len(kept))
        hints = [f'{i - ground + 1}F' if i >= ground else f'B{ground - i}F' for i in range(len(kept))]
    diffs = [b['elev'] - a['elev'] for a, b in zip(kept, kept[1:])]
    floors = [{'id': h, 'level': level(h, i + 1), 'elevation': g['elev'], 'rooms': g['rooms'], 'units': g['units'],
               'doors': g['doors']}
              for i, (h, g) in enumerate(zip(hints, kept))]
    return floors, warnings, name, statistics.median(diffs) if diffs else None
