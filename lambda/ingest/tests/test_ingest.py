"""도면 변환 handler 테스트(cd ingest && python -m unittest discover tests)"""
import json
import io
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import app  # noqa: E402
import ezdxf  # noqa: E402
import cad  # noqa: E402
import common  # noqa: E402
import pdf  # noqa: E402
from fixtures import FakeS3, make_dxf, make_ifc, make_pdf  # noqa: E402
from PIL import Image  # noqa: E402

TMP = pathlib.Path(tempfile.mkdtemp())


def upload(*paths):
    return FakeS3({f'uploads/j/{p.name}': p.read_bytes() for p in paths})


def run(s3, kind, names, **extra):
    app.s3 = s3
    out = app.handler({'op': 'parse', 'jobId': 'j', 'building': 'b-test0001', 'kind': kind, 'bucket': 'bk',
                       'keys': [f'uploads/j/{n}' for n in names], **extra}, None)
    return out, json.loads(s3.objects[out['draftKey']])


class ImageTest(unittest.TestCase):
    def test_transparent_background_is_composited_onto_white(self):
        image = Image.new('RGBA', (10, 10), (0, 0, 0, 0))
        image.putpixel((0, 0), (0, 0, 0, 255))
        image.save(TMP / 'transparent.png')
        source = upload(TMP / 'transparent.png')
        out, _ = run(source, 'image', ['transparent.png'])
        with Image.open(io.BytesIO(source.objects[out['detect'][0]['imageKey']])) as normalized:
            self.assertEqual(normalized.getpixel((0, 0)), (0, 0, 0))
            self.assertEqual(normalized.getpixel((5, 5)), (255, 255, 255))

    def test_images_become_review_backgrounds_and_detection_inputs(self):
        Image.new('RGB', (40, 30), 'white').save(TMP / '1층.png')
        Image.new('RGB', (60, 20), 'white').save(TMP / '2층.jpg')
        out, draft = run(upload(TMP / '1층.png', TMP / '2층.jpg'), 'image',
                         ['1층.png', '2층.jpg'], options={'pxPerM': 40})
        self.assertEqual(draft['meta']['ingest']['kind'], 'image')
        self.assertEqual([x['id'] for x in draft['floors']], ['1F', '2F'])
        self.assertEqual([(x['pxPerM'], x['toPlan']) for x in out['detect']], [(40, None), (40, None)])
        self.assertEqual(draft['floors'][0]['background']['px'], [40, 30])
        self.assertEqual(draft['floors'][1]['background']['px'], [60, 20])

    def test_exif_rotation_is_materialized_before_detection(self):
        exif = Image.Exif()
        exif[274] = 6
        Image.new('RGB', (40, 30), 'white').save(TMP / 'rotate.jpg', exif=exif)
        source = upload(TMP / 'rotate.jpg')
        out, draft = run(source, 'image', ['rotate.jpg'])
        self.assertEqual(draft['floors'][0]['background']['px'], [30, 40])
        self.assertIsNone(out['detect'][0]['pxPerM'])
        self.assertTrue(draft['meta']['ingest']['warnings'])

    def test_size_limit_and_wrong_format_fail_before_draft_is_saved(self):
        Image.new('RGB', (40, 30)).save(TMP / 'small.png')
        with patch.object(common, 'MAX_PX', 100):
            with self.assertRaisesRegex(ValueError, '6,400만'):
                run(upload(TMP / 'small.png'), 'image', ['small.png'])
        (TMP / 'bad.png').write_bytes(b'not an image')
        with self.assertRaises(Exception):
            run(upload(TMP / 'bad.png'), 'image', ['bad.png'])


class IfcTest(unittest.TestCase):
    def test_storey_spaces_units(self):
        make_ifc(TMP / 'a.ifc')
        out, d = run(upload(TMP / 'a.ifc'), 'ifc', ['a.ifc'])
        self.assertEqual(out['draftKey'], 'jobs/j/draft.json')
        self.assertEqual(out['detect'], [])
        self.assertEqual(d['schema'], 'twin.building/v1')
        self.assertEqual(d['building']['name'], '테스트관')
        self.assertEqual(d['building']['size'], {'w': 15.0, 'd': 5.0})
        f = d['floors'][0]
        self.assertEqual((f['id'], f['level'], f['elevation']), ('1F', 1, 0.0))
        self.assertEqual([(r['id'], r['type']) for r in f['rooms']], [('1F-101', 'room'), ('1F-102', 'wc')])
        units = {u['cls']: u for u in d['idus']}
        self.assertEqual(set(units), {'cassette_4way', 'floor_standing', 'wall_mounted'})  # 급기 디퓨저 제외
        c = units['cassette_4way']
        self.assertEqual((c['room'], c['conf'], c['source'], c['model'], c['review']), ('1F-101', 1, 'ifc', 'ARNU12GTRB4', False))
        self.assertEqual(units['floor_standing']['pos'], [13.3, 0.3])  # IFC y(4.7)를 아래쪽 기준으로 뒤집음
        self.assertEqual((units['floor_standing']['room'], units['floor_standing']['conf']), ('1F-102', 0.6))
        self.assertEqual(units['wall_mounted']['room'], '1F-101')
        self.assertEqual(d['meta']['ingest']['kind'], 'ifc')

    def test_drawing_for_floor_without_units(self):
        make_ifc(TMP / 'b.ifc', units=False)
        Image.new('L', (400, 300), 255).save(TMP / '1층_설비.png')
        out, d = run(upload(TMP / 'b.ifc', TMP / '1층_설비.png'), 'ifc', ['b.ifc', '1층_설비.png'], options={'pxPerM': 40})
        self.assertEqual(out['detect'], [{'floor': '1F', 'imageKey': 'uploads/j/1층_설비.png', 'pxPerM': 40, 'toPlan': None}])
        self.assertEqual(d['floors'][0]['background'], {'key': 'uploads/j/1층_설비.png', 'px': [400, 300], 'toPlan': None})


class CadTest(unittest.TestCase):
    def test_rooms_names_blocks(self):
        make_dxf(TMP / '2층.dxf')
        out, d = run(upload(TMP / '2층.dxf'), 'cad', ['2층.dxf'])
        self.assertEqual(out['detect'], [])
        f = d['floors'][0]
        self.assertEqual(f['id'], '2F')
        rooms = {r['id']: r for r in f['rooms']}
        self.assertEqual(set(rooms), {'2F-201', '2F-r02'})
        self.assertEqual((rooms['2F-201']['name'], rooms['2F-r02']['type']), ('회의실 201', 'corridor'))
        units = {u['cls']: u for u in d['idus']}
        self.assertEqual(units['wall_mounted']['room'], '2F-201')
        self.assertEqual(units['wall_mounted']['pos'], [3.0, 0.2])
        self.assertEqual((units['cassette_4way']['room'], units['cassette_4way']['model']), ('2F-r02', 'ARNU15GTRB4'))

    def test_render_when_no_block_matches_then_merge(self):
        make_dxf(TMP / 'plan.dxf', with_unit=False)
        s3 = upload(TMP / 'plan.dxf')
        out, d = run(s3, 'cad', ['plan.dxf'])
        det = out['detect'][0]
        self.assertEqual((det['floor'], det['imageKey'], det['pxPerM']), ('1F', 'jobs/j/pages/1.png', 80))
        self.assertIn('jobs/j/pages/1.png', s3.objects)
        self.assertEqual(d['floors'][0]['background']['toPlan'], det['toPlan'])
        # 평면 (3, 2)와 (9, 4) 위치의 상자: u = (x + 1)·80, v = (y + 1)·80
        dets = {'1F': [{'cls': 'cassette_1way', 'conf': 0.9, 'box': [300, 220, 340, 260]},
                       {'cls': 'wall_mounted', 'conf': 0.3, 'box': [780, 380, 820, 420]}],
                'XF': [{'cls': 'unknown', 'conf': 0.9, 'box': [0, 0, 1, 1]}]}
        ev = {'op': 'merge', 'jobId': 'j', 'bucket': 'bk', 'draftKey': out['draftKey'], 'detections': dets}
        res = app.handler(ev, None)
        self.assertEqual(res, {'draftKey': 'jobs/j/draft.json', 'units': 2, 'review': 1})
        self.assertEqual(app.handler(ev, None), res)  # 다시 병합해도 중복 없음
        d = json.loads(s3.objects[out['draftKey']])
        a, b = d['idus']
        self.assertEqual((a['pos'], a['room'], a['source'], a['review'], a['model']), ([3.0, 2.0], '1F-201', 'yolo', False, 'ARNU07GTUA4'))
        self.assertEqual((b['pos'], b['room'], b['review']), ([9.0, 4.0], '1F-r02', True))
        self.assertTrue(any('XF' in w for w in d['meta']['ingest']['warnings']))

    def test_no_wall_layer_with_frame(self):
        doc = ezdxf.new(units=4)
        msp = doc.modelspace()
        for a, b in (((0, 0), (12000, 0)), ((12000, 0), (12000, 6000)), ((12000, 6000), (0, 6000)), ((0, 6000), (0, 0)),
                     ((6000, 0), (6000, 2000)), ((6000, 3000), (6000, 6000))):
            msp.add_line(a, b)
        msp.add_lwpolyline([(-5000, -5000), (17000, -5000), (17000, 11000), (-5000, 11000)], close=True)  # 도면 틀
        msp.add_line((-2000, 0), (-2000, 6000), dxfattribs={'layer': 'DIM'})
        doc.saveas(TMP / 'frame.dxf')
        rooms, _, _, warnings = cad.parse(TMP / 'frame.dxf')
        self.assertEqual(sorted(r['poly'].bounds for r in rooms), [(0, 0, 6, 6), (6, 0, 12, 6)])
        self.assertIn('벽 레이어 없음', warnings[0])

    @unittest.skipIf(shutil.which('dwg2dxf'), 'dwg2dxf 설치 환경')
    def test_dwg_without_converter(self):
        (TMP / 'a.dwg').write_bytes(b'AC1032')
        with self.assertRaisesRegex(RuntimeError, 'dwg2dxf'):
            run(upload(TMP / 'a.dwg'), 'cad', ['a.dwg'])

    @unittest.skipUnless(shutil.which('dwg2dxf') and shutil.which('dxf2dwg'), 'libredwg 없음')
    def test_dwg(self):
        make_dxf(TMP / '3F.dxf')
        subprocess.run(['dxf2dwg', '-y', '-o', str(TMP / '3F.dwg'), str(TMP / '3F.dxf')], check=False)
        out, d = run(upload(TMP / '3F.dwg'), 'cad', ['3F.dwg'])
        self.assertEqual(d['floors'][0]['id'], '3F')
        self.assertEqual(len(d['floors'][0]['rooms']), 2)


class PdfTest(unittest.TestCase):
    def test_pages_scale_floor_and_merge(self):
        make_pdf(TMP / 'a.pdf', '2F PLAN S=1/200')
        make_pdf(TMP / 'b.pdf')
        s3 = upload(TMP / 'a.pdf', TMP / 'b.pdf')
        out, d = run(s3, 'pdf', ['a.pdf', 'b.pdf'])
        self.assertEqual([(x['floor'], x['imageKey'], x['pxPerM'], x['toPlan']) for x in out['detect']],
                         [('2F', 'jobs/j/pages/1.png', 80.0, None), ('P2', 'jobs/j/pages/2.png', None, None)])
        self.assertEqual([f['rooms'] for f in d['floors']], [[], []])
        self.assertEqual(d['floors'][0]['background']['px'], [4753, 3359])  # A4 가로, 1/200, 1m당 80px
        self.assertTrue(any('축척 문자 없음' in w for w in out['warnings']))
        res = app.handler({'op': 'merge', 'jobId': 'j', 'bucket': 'bk', 'draftKey': out['draftKey'],
                           'detections': {'2F': [{'cls': 'cassette_4way', 'conf': 0.8, 'box': [1, 2, 3, 4]}]}}, None)
        self.assertEqual(res['units'], 1)
        self.assertEqual(res['review'], 1)  # 위치를 맞추지 않은 인식 결과는 확인 필요
        d = json.loads(s3.objects[out['draftKey']])
        self.assertEqual(d['floors'][0]['detections'], [{'cls': 'cassette_4way', 'conf': 0.8, 'box': [1, 2, 3, 4]}])
        self.assertEqual(d['idus'], [])


class RuleTest(unittest.TestCase):
    def test_scale_text(self):
        cases = {'축척 1/200': 200, '1:100': 100, 'SCALE 1 : 50': 50, '배수 구배 1/100': None, '2026/1/20': None,
                 'A 1/300 S=1/100': 100, '11/200': None}
        self.assertEqual({t: pdf.find_scale(t) for t in cases}, cases)

    def test_floor_hint(self):
        cases = {'1층 평면도': '1F', '일층': '1F', '지하1층': 'B1F', 'B1F': 'B1F', 'plan_3F': '3F', '0x1f': None, 'abc': None}
        self.assertEqual({t: common.floor_hint(t) for t in cases}, cases)

    def test_classify(self):
        self.assertEqual(common.classify('Ceiling Cassette'), 'cassette_4way')  # 방향 표기 없는 카세트
        self.assertEqual(common.classify('AC_WM'), 'wall_mounted')
        self.assertEqual(common.classify('1WAY'), 'cassette_1way')
        self.assertIsNone(common.classify('Supply Diffuser'))

    def test_unknown_op(self):
        with self.assertRaises(ValueError):
            app.handler({'op': 'x'}, None)

    def test_render_cap(self):
        img, ppm, to_plan = cad.render([[(0, 0), (1000, 0), (1000, 1000)]], [1, 0, 0, -1, 0, 1000])
        self.assertLessEqual(img.size[0] * img.size[1], common.MAX_PX)
        self.assertAlmostEqual(to_plan[0], 1 / ppm, places=2)


if __name__ == '__main__':
    unittest.main()
