# 샘플 IFC 실현 가능성 확인: 층·호실 바닥 다각형 추출, 공조 단말의 호실 매핑
# - 실행: python ifc_extract.py <건축 IFC> <공조 IFC> <출력 JSON>
# - 의존성: ifcopenshell, shapely
import ifcopenshell, ifcopenshell.geom, ifcopenshell.util.element as ue, json, collections, sys
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
s = ifcopenshell.geom.settings(); s.set('use-world-coords', True)
arch = ifcopenshell.open(sys.argv[1]); hvac = ifcopenshell.open(sys.argv[2])
def footprint(el):
    sh = ifcopenshell.geom.create_shape(s, el)
    v = sh.geometry.verts; f = sh.geometry.faces
    pts = [(v[i], v[i+1], v[i+2]) for i in range(0, len(v), 3)]
    zmin = min(p[2] for p in pts)
    tris = []
    for i in range(0, len(f), 3):
        a, b, c = pts[f[i]], pts[f[i+1]], pts[f[i+2]]
        if max(abs(a[2]-zmin), abs(b[2]-zmin), abs(c[2]-zmin)) < 0.05:
            t = Polygon([a[:2], b[:2], c[:2]])
            if t.area > 1e-6: tris.append(t)
    return (unary_union(tris).buffer(0) if tris else None), zmin
spaces = []
for sp in arch.by_type('IfcSpace'):
    st = ue.get_container(sp) or (sp.Decomposes[0].RelatingObject if sp.Decomposes else None)
    try: poly, z = footprint(sp)
    except Exception as e: continue
    if poly is None or poly.area < 0.5: continue
    spaces.append({'gid': sp.GlobalId, 'name': (sp.LongName or sp.Name or '').strip(), 'storey': st.Name if st else '', 'z': z, 'poly': poly})
terms = []
for el in hvac.by_type('IfcFlowTerminal') + hvac.by_type('IfcEnergyConversionDevice') + hvac.by_type('IfcFlowMovingDevice'):
    try:
        sh = ifcopenshell.geom.create_shape(s, el); v = sh.geometry.verts
        xs, ys, zs = v[0::3], v[1::3], v[2::3]
        terms.append({'cls': el.is_a(), 'name': el.Name or '', 'x': sum(xs)/len(xs), 'y': sum(ys)/len(ys), 'z': sum(zs)/len(zs)})
    except Exception: pass
# 높이로 층 판별 후 같은 층 호실과 점-다각형 포함 판정
storeys = sorted({(round(sp['z'], 1)) for sp in spaces})
mapped = 0; per_space = collections.Counter()
for t in terms:
    cand = [sp for sp in spaces if sp['z'] - 0.5 <= t['z'] <= sp['z'] + 4.5]
    hit = next((sp for sp in cand if sp['poly'].contains(Point(t['x'], t['y']))), None)
    if hit: mapped += 1; per_space[hit['gid']] += 1; t['space'] = hit['gid']
out = {
 'spaces': len(spaces), 'by_storey': collections.Counter(sp['storey'] for sp in spaces),
 'terminals': len(terms), 'terminal_cls': collections.Counter(t['cls'] for t in terms),
 'mapped': mapped, 'spaces_with_terminal': len(per_space),
 'area_total_m2': round(sum(sp['poly'].area for sp in spaces), 1),
 'conf_like': [sp['name'] for sp in spaces if any(k in sp['name'].upper() for k in ['CONF', 'MEETING', 'TRAIN', 'BREAK', 'LOUNGE'])],
}
print(json.dumps(out, ensure_ascii=False, indent=1, default=dict))
json.dump({'spaces': [{**{k: v for k, v in sp.items() if k != 'poly'}, 'coords': [list(map(list, g.exterior.coords)) for g in (sp['poly'].geoms if sp['poly'].geom_type == 'MultiPolygon' else [sp['poly']])]} for sp in spaces], 'terms': terms}, open(sys.argv[3], 'w'))
