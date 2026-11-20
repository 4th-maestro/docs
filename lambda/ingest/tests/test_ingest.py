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

    def test_pset_model_and_capacity(self):
        make_ifc(TMP / 'pset.ifc', pset=True)
        _, d = run(upload(TMP / 'pset.ifc'), 'ifc', ['pset.ifc'])
        units = {u['cls']: u for u in d['idus']}
        c = units['cassette_4way']
        # 유형 속성의 ModelReference, 객체 속성의 NominalCoolingCapacity(W). 현열 능력(SensibleCoolingCapacity)은 제외
        self.assertEqual((c['model'], c['modelMatch'], c['coolKw'], c['kwSource']), ('AM130FN4DEH', 'source', 13.0, 'ifc'))
        self.assertEqual((units['wall_mounted']['modelMatch'], 'coolKw' in units['wall_mounted']), ('type', False))

    def test_door(self):
        make_ifc(TMP / 'door.ifc')
        _, d = run(upload(TMP / 'door.ifc'), 'ifc', ['door.ifc'])
        door, = d['floors'][0]['doors']
        # 배치 원점(10, 2)이 문틀 모서리여도 형상 범위 중심으로 맞춤. y 반전: 원본 y 2.0~2.9 → 평면 y 3.0~2.1
        self.assertEqual(door, {'id': 'D-1F-01', 'a': [10.0, 3.0], 'b': [10.0, 2.1], 'hinge': 'a', 'side': 1,
                                'source': 'ifc', 'conf': 1, 'review': False, 'ref': door['ref']})
        self.assertEqual(len(door['ref']), 22)  # IFC GlobalId

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

    def test_doors_from_block_and_arc(self):
        make_dxf(TMP / '4층.dxf')
        _, d = run(upload(TMP / '4층.dxf'), 'cad', ['4층.dxf'])
        block, arc = d['floors'][0]['doors']  # 반지름 0.3m 호와 벽에서 떨어진 호 제외
        # 문짝 끝(원본 (2, 0.9) → 평면 (2, 5.1))이 a→b(+x) 기준 화면 위쪽(왼쪽, 법선 (0, -1))이므로 side 1
        self.assertEqual({k: block[k] for k in ('a', 'b', 'hinge', 'side', 'source', 'conf', 'review')},
                         {'a': [2.0, 6.0], 'b': [2.9, 6.0], 'hinge': 'a', 'side': 1, 'source': 'cad', 'conf': 1, 'review': False})
        # 문짝 끝 평면 (5, 4)는 a→b(-y) 기준 법선 (-1, 0) 쪽이므로 side 1
        self.assertEqual({k: arc[k] for k in ('a', 'b', 'side', 'conf', 'review')},
                         {'a': [6.0, 4.0], 'b': [6.0, 3.0], 'side': 1, 'conf': 0.6, 'review': False})
        self.assertEqual(len(d['idus']), 2)  # 문 블록은 실내기 판정 제외
        self.assertEqual(len(d['floors'][0]['rooms']), 2)

    def test_attrib_text_and_schedule(self):
        make_dxf(TMP / '5층.dxf', labels=True)
        _, d = run(upload(TMP / '5층.dxf'), 'cad', ['5층.dxf'])
        self.assertEqual(d['meta']['ingest']['schedule'],
                         [{'tag': 'FCU-1', 'name': None, 'model': 'AR07TXFCAWKN', 'kw': 7.2, 'maker': None, 'page': 1}])
        units = {u['cls']: u for u in d['idus']}
        # 블록 옆 문자 7.2kW·FCU-1, 장비 번호가 일람표 행과 맞아 일람표 모델·용량
        w = units['wall_mounted']
        self.assertEqual((w['tag'], w['coolKw'], w['kwSource'], w['model'], w['modelMatch']),
                         ('FCU-1', 7.2, 'schedule', 'AR07TXFCAWKN', 'schedule'))
        # 블록 속성 MODEL·TAG·CAP. 3.9m 떨어진 5.6kW 문자는 연결하지 않음
        c = units['cassette_4way']
        self.assertEqual((c['tag'], c['coolKw'], c['kwSource'], c['model'], c['modelMatch']),
                         ('CAC-01', 14.5, 'cad-text', 'ARNU15GTRB4', 'source'))
        self.assertEqual(d['floors'][0]['rooms'][0]['name'], '회의실 201')

    # 실제 대응 표와 무관하게 '용량은 있으나 표가 빔 → 유형 예시'를 점검
    @patch.dict(common.TYPES, {'cassette_4way': {**common.TYPES['cassette_4way'], 'models': []}})
    def test_rendered_floor_texts_attach_to_detections(self):
        make_dxf(TMP / 'lab.dxf', with_unit=False, labels=True)
        s3 = upload(TMP / 'lab.dxf')
        out, d = run(s3, 'cad', ['lab.dxf'])
        T = d['floors'][0]['background']['toPlan']
        self.assertEqual(d['meta']['ingest']['texts']['1F']['pxPerM'], 80)

        def box(x, y):  # 평면 (x, y) 중심 40px 상자
            u, v = (x - T[2]) / T[0], (y - T[5]) / T[4]
            return [u - 20, v - 20, u + 20, v + 20]

        dets = {'1F': [{'cls': 'wall_mounted', 'conf': 0.9, 'box': box(3.0, 0.2)},
                       {'cls': 'cassette_4way', 'conf': 0.9, 'box': box(11.0, 5.5)}]}
        app.handler({'op': 'merge', 'jobId': 'j', 'bucket': 'bk', 'draftKey': out['draftKey'], 'detections': dets}, None)
        a, b = json.loads(s3.objects[out['draftKey']])['idus']
        self.assertEqual((a['tag'], a['coolKw'], a['kwSource'], a['modelMatch']), ('FCU-1', 7.2, 'schedule', 'schedule'))
        self.assertEqual((b.get('tag'), b['coolKw'], b['kwSource'], b['modelMatch']), (None, 5.6, 'cad-text', 'type'))

    def test_door_name(self):
        hits = {n: bool(cad.DOOR_NAME.search(n)) for n in ('DOOR_900', 'A-DOOR', 'DR1', 'SD_DR', '방화문', 'OUTDOOR_UNIT', 'DRAIN', '창문', '문자')}
        self.assertEqual(hits, {'DOOR_900': True, 'A-DOOR': True, 'DR1': True, 'SD_DR': True, '방화문': True,
                                'OUTDOOR_UNIT': False, 'DRAIN': False, '창문': False, '문자': False})

    def test_door_detections_become_doors_not_units(self):
        make_dxf(TMP / 'door.dxf', with_unit=False)
        s3 = upload(TMP / 'door.dxf')
        out, _ = run(s3, 'cad', ['door.dxf'])
        # 평면 (x, y)는 화소 ((x + 1)·80, (y + 1)·80)
        dets = {'1F': [{'cls': 'cassette_4way', 'conf': 0.9, 'box': [300, 220, 340, 260]},
                       {'cls': 'door', 'conf': 0.8, 'box': [800, 80, 872, 152]},     # 위 외벽 x 9.0~9.9, 호는 아래쪽
                       {'cls': 'door', 'conf': 0.9, 'box': [480, 320, 560, 400]},    # 내벽 CAD 문 호와 같은 위치
                       {'cls': 'door', 'conf': 0.9, 'box': [224, 224, 256, 256]}]}   # 벽에서 먼 0.4m 상자
        ev = {'op': 'merge', 'jobId': 'j', 'bucket': 'bk', 'draftKey': out['draftKey'], 'detections': dets}
        res = app.handler(ev, None)
        self.assertEqual(app.handler(ev, None), res)  # 다시 병합해도 중복 없음
        self.assertEqual(res, {'draftKey': 'jobs/j/draft.json', 'units': 1, 'review': 0})
        d = json.loads(s3.objects[out['draftKey']])
        self.assertEqual([u['cls'] for u in d['idus']], ['cassette_4way'])
        doors = d['floors'][0]['doors']
        self.assertEqual([x['source'] for x in doors], ['cad', 'cad', 'yolo', 'yolo'])
        top, far = doors[2:]
        self.assertEqual(sorted([top['a'], top['b']]), [[9.0, 0.0], [9.9, 0.0]])
        # 상자 중심(y 0.45)이 변 아래쪽: a→b가 +x면 화면 오른쪽(-1), -x면 왼쪽(1)
        self.assertEqual(top['side'], 1 if top['a'][0] > top['b'][0] else -1)
        self.assertEqual({k: top[k] for k in ('id', 'hinge', 'conf', 'review', 'ref')},
                         {'id': 'D-1F-Y02', 'hinge': 'a', 'conf': 0.8, 'review': False, 'ref': 'det-2'})
        self.assertEqual((far['ref'], far['review'], far['a'], far['b']), ('det-4', True, [1.8, 2.0], [2.2, 2.0]))

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
        rooms, _, _, _, warnings, _ = cad.parse(TMP / 'frame.dxf')
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
                           'detections': {'2F': [{'cls': 'cassette_4way', 'conf': 0.8, 'box': [1, 2, 3, 4]},
                                                 {'cls': 'door', 'conf': 0.7, 'box': [10, 10, 90, 90]}]}}, None)
        self.assertEqual(res['units'], 1)  # 문 인식 결과는 실내기 수에서 제외
        self.assertEqual(res['review'], 1)  # 위치를 맞추지 않은 인식 결과는 확인 필요
        d = json.loads(s3.objects[out['draftKey']])
        self.assertEqual(d['floors'][0]['detections'], [{'cls': 'cassette_4way', 'conf': 0.8, 'box': [1, 2, 3, 4]},
                                                        {'cls': 'door', 'conf': 0.7, 'box': [10, 10, 90, 90]}])
        self.assertEqual(d['idus'], [])
        self.assertNotIn('doors', d['floors'][0])


    def test_text_layer_kw_tag_and_schedule(self):
        # 12pt 문자(pt, 왼쪽 아래 원점). `E-`와 `4.5HP`는 나뉜 문자 객체. 오른쪽 아래는 영문 장비일람표
        make_pdf(TMP / 'cap.pdf', [(50, 560, '2F PLAN S=1/200'), (100, 500, '13.0KW'), (100, 488, 'E-'), (113, 488, '4.5HP'),
                                   (600, 300, 'TAG'), (660, 300, 'MODEL'), (760, 300, 'COOLING'),
                                   (600, 285, 'E-4.5HP'), (660, 285, 'AM130FN4DEH'), (760, 285, '13.0')])
        s3 = upload(TMP / 'cap.pdf')
        out, d = run(s3, 'pdf', ['cap.pdf'])
        ing = d['meta']['ingest']
        self.assertEqual(ing['schedule'], [{'tag': 'E-4.5HP', 'name': None, 'model': 'AM130FN4DEH', 'kw': 13.0, 'maker': None, 'page': 1}])
        self.assertEqual((ing['texts']['2F']['pxPerM'], [x[2] for x in ing['texts']['2F']['kw']]), (80.0, [13.0]))
        # 1m당 80px: 용량 표기 중심 약 (684, 513)px. 첫 상자는 1.9m, 문 상자는 실내기가 아니라 제외, 둘째 상자는 먼 위치
        dets = {'2F': [{'cls': 'cassette_4way', 'conf': 0.8, 'box': [640, 600, 760, 720]},
                       {'cls': 'door', 'conf': 0.8, 'box': [600, 450, 700, 550]},
                       {'cls': 'cassette_4way', 'conf': 0.8, 'box': [3000, 3000, 3100, 3100]}]}
        ev = {'op': 'merge', 'jobId': 'j', 'bucket': 'bk', 'draftKey': out['draftKey'], 'detections': dets}
        app.handler(ev, None)
        d = json.loads(s3.objects[out['draftKey']])
        self.assertEqual(d['floors'][0]['detections'], [{**dets['2F'][0], 'kw': 13.0, 'tag': 'E-4.5HP'}, dets['2F'][1], dets['2F'][2]])
        # 2D 화면에서 위치를 맞춘(toPlan) 층을 다시 병합하면 실내기에 용량, 장비 번호, 일람표 모델이 들어감
        d['floors'][0]['background']['toPlan'] = [1 / 80, 0, 0, 0, 1 / 80, 0]
        s3.objects[out['draftKey']] = json.dumps(d).encode()
        app.handler(ev, None)
        a, b = json.loads(s3.objects[out['draftKey']])['idus']
        self.assertEqual((a['tag'], a['coolKw'], a['kwSource'], a['model'], a['modelMatch']),
                         ('E-4.5HP', 13.0, 'schedule', 'AM130FN4DEH', 'schedule'))
        self.assertEqual((b['model'], b['modelMatch'], 'coolKw' in b), ('ARNU12GTRB4', 'type', False))


class CapacityTest(unittest.TestCase):
    MODELS = [{'kw': 5.6, 'model': 'K56', 'market': 'KR'}, {'kw': 13.0, 'model': 'G130', 'market': 'GLOBAL'},
              {'kw': 13.0, 'model': 'K130', 'market': 'KR'}, {'kw': 14.5, 'model': 'K145', 'market': 'KR'}]

    def test_capacity_text(self):
        cases = {'13.0KW': 13.0, '5.2 kW': 5.2, '29KW': 29.0, '7.5kW,': 7.5, '139.2KW이상': None, '145 KW 이상': None,
                 '15.0KW초과40.6KW이하': None, '~15.0KW이하': None, '~ 8kW': None, '10HP': None, '1234kW': None, 'kW': None,
                 '00KW': None}
        self.assertEqual({t: common.capacity(t) for t in cases}, cases)

    def test_tag_and_labels(self):
        cases = {'E-4.5HP': True, 'E-10HP': True, 'IU-1': True, 'CAC-01': True, 'FCU1': True,
                 '01': False, 'X1': False, 'Y10': False, '13.0KW': False, 'E-10-003504호': False, 'fcu1': False}
        self.assertEqual({t: bool(common.TAG.fullmatch(t)) for t in cases}, cases)
        words = [('FCU-1 13.0 kW', 0, 0, 10, 2), ('회의실 B101', 20, 0, 30, 2), ('13.0KW', 0, 0, 10, 2)]
        self.assertEqual(common.labels(words), {'kw': [[5.0, 1.0, 13.0]], 'tag': [[5.0, 1.0, 'FCU-1']]})  # 같은 위치 중복 1개

    def test_pair_nearest_first_one_to_one(self):
        # 표기 0은 두 실내기 모두에 가장 가깝지만 더 가까운 실내기 1에 연결. 실내기 0은 다음 표기 1, 2.5 초과 표기 2는 미연결
        self.assertEqual(common.pair([(0, 0), (3, 0)], [(2, 0), (0, 2), (9, 9)], 2.5), {1: 0, 0: 1})
        self.assertEqual(common.attach([(0, 0), (3, 0)], {'kw': [[2, 0, 7.1]], 'tag': [[3, 1, 'A-1']]}, 2.5, [{}, {'kw': 9.0}]),
                         [{'kw': 7.1}, {'kw': 9.0, 'tag': 'A-1'}])

    def test_schedule_from_words(self):
        # 머리글 2줄(냉방용량은 윗줄, `형 식`은 글자를 띄움), 모델 칸 값은 품명, 아래 제어기 표(기호, 품명)에서 끝남
        h = 6
        w = lambda t, u, v: (t, u, v, u + len(t) * h, v + h)  # noqa: E731
        words = [w('냉방용량', 300, 100), w('장비번호', 160, 110), w('형', 214, 110), w('식', 226, 110),
                 w('5.2kW', 167, 125), w('E-1.5HP', 164, 132), w('천장카세트', 208, 128), w('2-WAY', 213, 136), w('5.2', 307, 132),
                 w('E-4.5HP', 164, 152), w('ARNU15GTRB4', 208, 152), w('13.0', 305, 152),
                 w('기호', 160, 200), w('품명', 200, 200), w('DMS2', 160, 215), w('3', 300, 215)]
        self.assertEqual(common.schedule(words, 2), [
            {'tag': 'E-1.5HP', 'name': '천장카세트 2-WAY', 'model': None, 'kw': 5.2, 'maker': None, 'page': 2},
            {'tag': 'E-4.5HP', 'name': None, 'model': 'ARNU15GTRB4', 'kw': 13.0, 'maker': None, 'page': 2}])

    def test_model_lookup_order(self):
        rows = [{'tag': 'E-4.5HP', 'model': None, 'kw': 13.0}, {'tag': 'IU-1', 'model': 'AM130FN4DEH', 'kw': None}]
        with patch.dict(common.TYPES, {'cassette_4way': {**common.TYPES['cassette_4way'], 'models': self.MODELS}}):
            def m(**kw):
                r = common.describe('cassette_4way', **kw)
                return r['model'], r['modelMatch'], r.get('coolKw'), r.get('kwSource')
            self.assertEqual(m(kw=13.05, kw_src='pdf-text'), ('K130', 'exact', 13.05, 'pdf-text'))  # 차이 0.05, 같은 용량은 국내 우선
            self.assertEqual(m(kw=13.2, kw_src='pdf-text'), ('K145', 'nearest', 13.2, 'pdf-text'))  # 용량 이상 최소 모델
            self.assertEqual(m(kw=20.0, kw_src='pdf-text'), ('K145', 'nearest', 20.0, 'pdf-text'))  # 없으면 최대 모델
            self.assertEqual(m(), ('ARNU12GTRB4', 'type', None, None))
            self.assertEqual(m(model='X1', kw=13.0, kw_src='ifc'), ('X1', 'source', 13.0, 'ifc'))
            self.assertEqual(m(tag='E 4.5HP', schedule=rows), ('K130', 'exact', 13.0, 'schedule'))  # 일람표 용량으로 대응
            self.assertEqual(m(tag='IU1', kw=5.6, kw_src='cad-text', schedule=rows), ('AM130FN4DEH', 'schedule', 5.6, 'cad-text'))
        with patch.dict(common.TYPES, {'cassette_4way': {**common.TYPES['cassette_4way'], 'models': []}}):
            self.assertEqual(m(kw=13.0, kw_src='pdf-text')[1], 'type')  # 대응 표가 비면 유형 예시


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

    def test_door_box_clamped_to_edge(self):
        # 모서리 근처 상자: 중심 투영(x 0.3)에서 폭 0.9m 구간이 변 시작점 밖으로 나가지 않도록 변 안으로 옮김
        rooms = [{'polygon': [[0, 0], [10, 0], [10, 10], [0, 10]]}]
        a, b, side, hit, w = common.door_from_box(rooms, [1, 0, 0, 0, 1, 0], [-0.15, 0, 0.75, 0.4])
        self.assertEqual(([round(v, 6) for v in a], [round(v, 6) for v in b], hit, round(w, 6)), ([0, 0], [0.9, 0], True, 0.9))
        self.assertEqual(side, -1)  # 상자 중심이 a→b(+x) 기준 화면 아래쪽(오른쪽)

    def test_unknown_op(self):
        with self.assertRaises(ValueError):
            app.handler({'op': 'x'}, None)

    def test_render_cap(self):
        img, ppm, to_plan = cad.render([[(0, 0), (1000, 0), (1000, 1000)]], [1, 0, 0, -1, 0, 1000])
        self.assertLessEqual(img.size[0] * img.size[1], common.MAX_PX)
        self.assertAlmostEqual(to_plan[0], 1 / ppm, places=2)


if __name__ == '__main__':
    unittest.main()
