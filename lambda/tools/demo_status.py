"""Frontend 데모용 건물별 상태 JSON 생성(API 없이 화면 확인)

- 실행: python3 tools/demo_status.py (lambda 폴더에서)
- 출력: frontend/public/demo/<건물>.json(GET /rooms/status?building=<건물> 전체 층 응답), demo/index.json(건물 id 목록)
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
import buildings  # noqa: E402
import status  # noqa: E402

out = ROOT.parent / 'frontend' / 'public' / 'demo'
out.mkdir(exist_ok=True)
for b in buildings.LIST:
    (out / f"{b['id']}.json").write_text(status.handler({'queryStringParameters': {'building': b['id']}}, None)['body'])
(out / 'index.json').write_text(json.dumps([b['id'] for b in buildings.LIST]))
print(', '.join(b['id'] for b in buildings.LIST), '→', out)
