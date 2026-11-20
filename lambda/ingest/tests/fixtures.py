"""테스트용 도면 파일 생성(IFC, DXF, PDF)과 S3 대역"""
import io

import ezdxf
import ifcopenshell.api.aggregate
import ifcopenshell.api.context
import ifcopenshell.api.geometry
import ifcopenshell.api.project
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.api.unit
import numpy as np
from ifcopenshell.util.shape_builder import ShapeBuilder
from PIL import Image


def make_ifc(path, units=True):
    """층 1개, 호실 2개(10×5m, 5×5m), 문 1개, 4방향 카세트 1대, 별칭 없는 스탠드형·벽걸이형 각 1대, 급기 디퓨저 1개"""
    f = ifcopenshell.api.project.create_file(version='IFC4')
    proj = ifcopenshell.api.root.create_entity(f, ifc_class='IfcProject', name='P')
    ifcopenshell.api.unit.assign_unit(f, length={'is_metric': True, 'raw': 'METRE'})
    model = ifcopenshell.api.context.add_context(f, context_type='Model')
    body = ifcopenshell.api.context.add_context(f, context_type='Model', context_identifier='Body', target_view='MODEL_VIEW', parent=model)
    site = ifcopenshell.api.root.create_entity(f, ifc_class='IfcSite', name='S')
    bld = ifcopenshell.api.root.create_entity(f, ifc_class='IfcBuilding', name='테스트관')
    st = ifcopenshell.api.root.create_entity(f, ifc_class='IfcBuildingStorey', name='1층')
    ifcopenshell.api.aggregate.assign_object(f, relating_object=proj, products=[site])
    ifcopenshell.api.aggregate.assign_object(f, relating_object=site, products=[bld])
    ifcopenshell.api.aggregate.assign_object(f, relating_object=bld, products=[st])
    for e in (site, bld, st):
        ifcopenshell.api.geometry.edit_object_placement(f, product=e, matrix=np.eye(4))
    sb = ShapeBuilder(f)

    def solid(el, x0, y0, x1, y1, z0, h):
        m = np.eye(4)
        m[:3, 3] = (x0, y0, z0)
        ifcopenshell.api.geometry.edit_object_placement(f, product=el, matrix=m)
        prof = sb.polyline([(0.0, 0.0), (float(x1 - x0), 0.0),
                            (float(x1 - x0), float(y1 - y0)), (0.0, float(y1 - y0))], closed=True)
        rep = sb.get_representation(body, [sb.extrude(prof, h)])
        ifcopenshell.api.geometry.assign_representation(f, product=el, representation=rep)

    for name, long, box in (('101', '사무실', (0, 0, 10, 5)), ('102', '화장실', (10, 0, 15, 5))):
        sp = ifcopenshell.api.root.create_entity(f, ifc_class='IfcSpace', name=name)
        sp.LongName = long
        ifcopenshell.api.aggregate.assign_object(f, relating_object=st, products=[sp])
        solid(sp, *box, 0, 3)
    # 두 호실 사이 벽(x=10)의 폭 0.9m 문. 배치 원점은 문틀 모서리(10, 2), 배치 x축은 +y 방향입니다.
    door = ifcopenshell.api.root.create_entity(f, ifc_class='IfcDoor', name='D1')
    door.OverallWidth, door.OverallHeight = 0.9, 2.1
    ifcopenshell.api.spatial.assign_container(f, relating_structure=st, products=[door])
    ifcopenshell.api.geometry.edit_object_placement(
        f, product=door, matrix=np.array([[0.0, -1, 0, 10], [1, 0, 0, 2], [0, 0, 1, 0], [0, 0, 0, 1]]))
    prof = sb.polyline([(0.0, -0.05), (0.9, -0.05), (0.9, 0.05), (0.0, 0.05)], closed=True)
    ifcopenshell.api.geometry.assign_representation(f, product=door, representation=sb.get_representation(body, [sb.extrude(prof, 2.1)]))
    for cls, name, box in (('IfcUnitaryEquipment', '4WAY CASSETTE', (4.5, 2, 5.5, 3, 2.6, 0.3)),
                           ('IfcUnitaryEquipment', 'IDU-02', (13, 4.5, 13.6, 4.9, 0, 1.8)),
                           ('IfcUnitaryEquipment', 'IDU-03', (1, 4.75, 2, 5, 2, 0.3)),
                           ('IfcAirTerminal', 'Supply Diffuser', (2, 2, 2.6, 2.6, 2.9, 0.1)))[0 if units else 3:]:
        el = ifcopenshell.api.root.create_entity(f, ifc_class=cls, name=name)
        ifcopenshell.api.spatial.assign_container(f, relating_structure=st, products=[el])
        solid(el, *box)
    f.write(str(path))


def make_dxf(path, with_unit=True):
    """mm 단위 12×6m 건물을 내벽으로 나눈 호실 2개, 실 이름 문자, 벽걸이 블록 AC_WALL_MOUNT, 속성 TYPE·MODEL 블록 IDU

    문 2개: 외벽 0.9m 틈의 문 블록 DOOR_900(경첩 (2000, 0)), 내벽 1m 틈의 문 호(경첩 (6000, 2000)).
    문이 아닌 호 2개: 반지름 0.3m 호, 벽에서 떨어진 반지름 0.8m 호.
    """
    doc = ezdxf.new(units=4)
    msp = doc.modelspace()
    doc.layers.add('A-WALL')
    doc.layers.add('A-DOOR')
    for a, b in (((0, 0), (2000, 0)), ((2900, 0), (12000, 0)), ((12000, 0), (12000, 6000)), ((12000, 6000), (0, 6000)),
                 ((0, 6000), (0, 0)), ((6000, 0), (6000, 2000)), ((6000, 3000), (6000, 6000))):  # 외벽 0.9m, 내벽 1m 문 개구부
        msp.add_line(a, b, dxfattribs={'layer': 'A-WALL'})
    door = doc.blocks.new('DOOR_900')
    door.add_arc((0, 0), 900, 0, 90)
    door.add_line((0, 0), (0, 900))
    msp.add_blockref('DOOR_900', (2000, 0))
    msp.add_arc((6000, 2000), 1000, 90, 180, dxfattribs={'layer': 'A-DOOR'})
    msp.add_line((6000, 2000), (5000, 2000), dxfattribs={'layer': 'A-DOOR'})
    msp.add_arc((3000, 4000), 300, 0, 90, dxfattribs={'layer': 'A-FURN'})
    msp.add_arc((3000, 4000), 800, 0, 90, dxfattribs={'layer': 'A-FURN'})
    msp.add_text('회의실', dxfattribs={'insert': (2000, 3000), 'height': 300})
    msp.add_text('201', dxfattribs={'insert': (2000, 2500), 'height': 300})
    msp.add_text('복도', dxfattribs={'insert': (9000, 3000), 'height': 300})
    msp.add_text('24.5㎡', dxfattribs={'insert': (9000, 2500), 'height': 300})
    blk = doc.blocks.new('AC_WALL_MOUNT' if with_unit else 'CHAIR')
    blk.add_lwpolyline([(-450, -100), (450, -100), (450, 100), (-450, 100)], close=True)
    msp.add_blockref(blk.name, (3000, 5800))
    if with_unit:
        idu = doc.blocks.new('IDU')
        idu.add_lwpolyline([(-400, -400), (400, -400), (400, 400), (-400, 400)], close=True)
        idu.add_attdef('TYPE', (0, 0))
        idu.add_attdef('MODEL', (0, -200))
        msp.add_blockref('IDU', (9000, 4000)).add_auto_attribs({'TYPE': '4WAY', 'MODEL': 'ARNU15GTRB4'})
    doc.saveas(str(path))


def make_pdf(path, text=None):
    """A4 가로 1쪽 PDF. text를 주면 해당 문자를 텍스트 객체로 넣습니다(Helvetica, ASCII만)."""
    if text is None:
        Image.new('RGB', (842, 595), 'white').save(path, 'PDF')
        return
    content = f'BT /F1 12 Tf 50 50 Td ({text}) Tj ET'.encode()
    objs = [b'<< /Type /Catalog /Pages 2 0 R >>',
            b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
            b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream',
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    out, offs = io.BytesIO(), []
    out.write(b'%PDF-1.4\n')
    for i, o in enumerate(objs, 1):
        offs.append(out.tell())
        out.write(b'%d 0 obj\n' % i + o + b'\nendobj\n')
    x = out.tell()
    out.write(b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offs))
    out.write(b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, x))
    path.write_bytes(out.getvalue())


class FakeS3:
    """app.py가 쓰는 S3 메서드 3개만 구현한 메모리 저장소"""

    def __init__(self, objects=None):
        self.objects = dict(objects or {})

    def download_file(self, bucket, key, filename):
        from pathlib import Path
        Path(filename).write_bytes(self.objects[key])

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.objects[Key] = Body

    def get_object(self, Bucket, Key):
        return {'Body': io.BytesIO(self.objects[Key])}
