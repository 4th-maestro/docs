"""건물별 3D 도면 생성: frontend/public/floorplan.json(의원 원본) → frontend/public/floorplans/<건물>.json

- 실행: python3 tools/build_floorplans.py (lambda 폴더에서)
- 호실 id: buildings.py와 같은 규칙(main은 원본 GUID, 가상 건물은 "건물.층.GUID")
- mirror: x 좌표 반전 후 다각형 점 순서를 뒤집어 면 방향 유지
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
import buildings  # noqa: E402

PUB = ROOT.parent / 'frontend' / 'public'
SRC = json.loads((PUB / 'floorplan.json').read_text())
STOREY = 4.57  # 의원 IFC 2F 바닥 높이(m)


def flip(pts, mirror):
    return [[-x, y] for x, y in reversed(pts)] if mirror else pts


out_dir = PUB / 'floorplans'
out_dir.mkdir(exist_ok=True)
for b in buildings.LIST:
    plan = {'source': SRC['source'], 'unit': 'm', 'building': b['id'], 'virtual': b['virtual'], 'floors': {}}
    for i, (floor, src) in enumerate(b['floors'].items()):
        rooms = []
        for r in SRC['floors'][src]['rooms']:
            rid = r['id'] if b['id'] == buildings.DEFAULT else f"{b['id']}.{floor}.{r['id']}"
            rooms.append({'id': rid, 'polys': [flip(p, b['mirror']) for p in r['polys']],
                          'hvac': [[-x, y] if b['mirror'] else [x, y] for x, y in r['hvac']]})
        pts = [p for r in rooms for poly in r['polys'] for p in poly]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        plan['floors'][floor] = {'elevation': round(i * STOREY, 2), 'bounds': [min(xs), min(ys), max(xs), max(ys)], 'rooms': rooms}
    ids = {r['id'] for f in plan['floors'].values() for r in f['rooms']}
    assert ids == {r['id'] for r in buildings.rooms(b['id'])}, f"{b['id']} 호실 id 불일치"
    (out_dir / f"{b['id']}.json").write_text(json.dumps(plan, ensure_ascii=False, separators=(',', ':')))
    print(b['id'], len(ids), 'rooms')
