"""API 단일 진입점 경로 분기 검증(boto3 없는 환경은 가짜 모듈로 대체)"""
import pathlib
import sys
import types
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
sys.modules.setdefault('boto3', types.ModuleType('boto3'))
import api  # noqa: E402


class RouteTest(unittest.TestCase):
    def test_every_template_route_has_handler(self):
        tpl = (pathlib.Path(__file__).resolve().parent.parent / 'template.yaml').read_text()
        block = tpl[tpl.index('  ApiFunction:'):tpl.index('  QueryFunction:')]
        paths = [line.split('Path: ')[1].split(',')[0].strip("'") for line in block.splitlines() if 'Path: ' in line]
        self.assertEqual(len(paths), 19)  # 2026-11-20 도면 경로 추가
        for p in paths:
            self.assertIsNotNone(api.route(p), p)

    def test_prefix_does_not_cross_routes(self):
        self.assertIs(api.route('/rooms/status'), api.status.handler)
        self.assertIs(api.route('/rooms/history'), api.history.handler)
        self.assertIs(api.route('/schedules/abc'), api.schedules.handler)
        self.assertIsNone(api.route('/roomsx'))
        self.assertEqual(api.handler({'routeKey': 'GET /nope'}, None)['statusCode'], 404)


if __name__ == '__main__':
    unittest.main()
