"""Frontend 데모용 상태 JSON 출력(API 없이 화면 확인): python3 lambda/tools/demo_status.py > frontend/public/demo-status.json"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import status  # noqa: E402

print(status.handler({}, None)['body'])
