"""도면 변환 컨테이너 Lambda 진입점

- op=parse: 업로드 파일을 형식별로 파싱해 jobs/<jobId>/draft.json과 도면 이미지를 저장합니다.
- op=merge: YOLO 인식 결과를 초안에 병합합니다.
요청·응답 형식은 README.md 1절과 docs/human/reference/plan-ingest.md에 있습니다.
"""
import io
import json
import pathlib
import tempfile

import boto3
from PIL import Image, ImageOps

import cad
import common
import ifc
import pdf

s3 = boto3.client('s3')
IMAGE = {'.png', '.jpg', '.jpeg'}


def handler(event, context):
    op = event.get('op')
    if op not in ('parse', 'merge'):
        raise ValueError(f'알 수 없는 op: {op}')
    return parse(event) if op == 'parse' else merge(event)


def _put_json(bucket, key, data):
    s3.put_object(Bucket=bucket, Key=key, Body=json.dumps(data, ensure_ascii=False).encode(), ContentType='application/json; charset=utf-8')


class _Pages:
    """jobs/<jobId>/pages/<번호>.png 저장. 번호는 작업 안에서 1부터 이어집니다."""

    def __init__(self, bucket, job):
        self.bucket, self.job, self.n = bucket, job, 0

    def put(self, img):
        self.n += 1
        key = f'jobs/{self.job}/pages/{self.n}.png'
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        s3.put_object(Bucket=self.bucket, Key=key, Body=buf.getvalue(), ContentType='image/png')
        return key


def parse(ev):
    job, bucket, kind, building = ev['jobId'], ev['bucket'], ev['kind'], ev['building']
    opts = ev.get('options') or {}
    pages = _Pages(bucket, job)
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for key in ev['keys']:
            p = pathlib.Path(tmp) / pathlib.Path(key).name
            s3.download_file(bucket, key, str(p))
            paths.append((key, p))
        files = [p.name for _, p in paths]
        if kind == 'ifc':
            draft, detect = _ifc(job, building, files, paths, opts, pages)
        elif kind == 'cad':
            draft, detect = _cad(job, building, files, paths, pages, tmp)
        elif kind == 'pdf':
            draft, detect = _pdf(job, building, files, paths, opts, pages)
        elif kind == 'image':
            draft, detect = _image(job, building, files, paths, opts, pages)
        else:
            raise ValueError(f'지원하지 않는 kind: {kind}')
    key = f'jobs/{job}/draft.json'
    _put_json(bucket, key, draft)
    return {'draftKey': key, 'detect': detect, 'warnings': draft['meta']['ingest']['warnings']}


def _ifc(job, building, files, paths, opts, pages):
    ifcs = [p for _, p in paths if p.suffix.lower() == '.ifc']
    if not ifcs:
        raise ValueError('IFC 파일이 없습니다.')
    floors, warnings, name, fh = ifc.parse(ifcs)
    draft, _ = common.build(job, building, 'ifc', files, floors, warnings, name, fh)
    # 같은 작업으로 올린 설비도면: (이미지 키, 크기, 1m당 화소, 층 표기)
    drawings = []
    for key, p in paths:
        if p.suffix.lower() in IMAGE:
            with Image.open(p) as im:
                drawings.append((key, list(im.size), opts.get('pxPerM'), common.floor_hint(p.stem)))
        elif p.suffix.lower() == '.pdf':
            for img, ppm, hint, _ in pdf.pages(p, opts.get('scale')):
                drawings.append((pages.put(img), list(img.size), ppm, hint or common.floor_hint(p.stem)))
    with_units = {u['floor'] for u in draft['idus']}
    detect = []
    for key, px, ppm, hint in drawings:
        # 층 표기가 맞는 층, 없으면 높이 순서로 도면과 실내기가 모두 없는 첫 층에 배정합니다.
        f = next((f for f in draft['floors'] if f['id'] == hint), None) or \
            next((f for f in draft['floors'] if 'background' not in f and f['id'] not in with_units), None)
        if f is None or 'background' in f:
            warnings.append(f'설비도면 {key}: 붙일 층을 정하지 못해 제외')
            continue
        if f['id'] != hint:
            warnings.append(f"설비도면 {key}: 층 표기와 맞는 층이 없어 {f['id']}에 배정")
        f['background'] = {'key': key, 'px': px, 'toPlan': None}
        if f['id'] not in with_units:
            detect.append({'floor': f['id'], 'imageKey': key, 'pxPerM': ppm, 'toPlan': None})
    return draft, detect


def _cad(job, building, files, paths, pages, tmp):
    floors, lines, warnings = [], [], []
    cads = [p for _, p in paths if p.suffix.lower() in ('.dxf', '.dwg')]
    if not cads:
        raise ValueError('DXF·DWG 파일이 없습니다.')
    for i, p in enumerate(cads, 1):
        rooms, units, doors, ln, w = cad.parse(cad.dwg_to_dxf(p, tmp) if p.suffix.lower() == '.dwg' else p)
        warnings += w
        fid = common.floor_hint(p.stem) or f'{i}F'
        if any(f['id'] == fid for f in floors):
            warnings.append(f'{p.name}: 층 {fid}이 겹쳐 P{i}로 지정')
            fid = f'P{i}'
        floors.append({'id': fid, 'level': common.level(fid, i), 'rooms': rooms, 'units': units, 'doors': doors})
        lines.append(ln)
    draft, M = common.build(job, building, 'cad', files, floors, warnings)
    detect = []
    for f, ln in zip(draft['floors'], lines):
        if ln is None:
            continue
        if not ln:
            warnings.append(f"{f['id']}: 렌더링할 선이 없어 인식 제외")
            continue
        img, ppm, to_plan = cad.render(ln, M)
        key = pages.put(img)
        f['background'] = {'key': key, 'px': list(img.size), 'toPlan': to_plan}
        detect.append({'floor': f['id'], 'imageKey': key, 'pxPerM': ppm, 'toPlan': to_plan})
    return draft, detect


def _pdf(job, building, files, paths, opts, pages):
    floors, backgrounds, warnings = [], [], []
    pdfs = [p for _, p in paths if p.suffix.lower() == '.pdf']
    if not pdfs:
        raise ValueError('PDF 파일이 없습니다.')
    for p in pdfs:
        for no, (img, ppm, hint, scale) in enumerate(pdf.pages(p, opts.get('scale')), 1):
            key = pages.put(img)
            fid = hint or f'P{pages.n}'
            if any(f['id'] == fid for f in floors):
                warnings.append(f'{p.name} {no}쪽: 층 {fid}이 겹쳐 P{pages.n}로 지정')
                fid = f'P{pages.n}'
            if not scale:
                warnings.append(f'{p.name} {no}쪽: 축척 문자 없음, 2D 화면에서 기준 치수 입력 필요')
            floors.append({'id': fid, 'level': common.level(fid, pages.n), 'rooms': [], 'units': []})
            backgrounds.append((key, list(img.size), ppm))
    draft, _ = common.build(job, building, 'pdf', files, floors, warnings)
    detect = []
    for f, (key, px, ppm) in zip(draft['floors'], backgrounds):
        f['background'] = {'key': key, 'px': px, 'toPlan': None}
        detect.append({'floor': f['id'], 'imageKey': key, 'pxPerM': ppm, 'toPlan': None})
    return draft, detect


def _image(job, building, files, paths, opts, pages):
    """이미지 도면도 PDF처럼 보정용 배경·인식 대상으로 변환. EXIF 방향을 PNG에 고정."""
    floors, backgrounds, warnings = [], [], []
    for _, path in paths:
        if path.suffix.lower() not in IMAGE:
            raise ValueError('이미지 작업에는 PNG·JPG 파일만 사용할 수 있습니다.')
        with Image.open(path) as source:
            if source.format not in ('PNG', 'JPEG'):
                raise ValueError('PNG·JPEG 이미지가 아닙니다.')
            if source.width * source.height > common.MAX_PX:
                raise ValueError('도면 이미지가 최대 6,400만 화소를 초과합니다.')
            with ImageOps.exif_transpose(source) as upright:
                if upright.mode in ('RGBA', 'LA', 'PA') or 'transparency' in upright.info:
                    with upright.convert('RGBA') as rgba, Image.new('RGBA', upright.size, 'white') as background:
                        with Image.alpha_composite(background, rgba) as composed:
                            image = composed.convert('RGB')
                else:
                    image = upright.convert('RGB')
                try:
                    key, px = pages.put(image), list(image.size)
                finally:
                    image.close()
        fid = common.floor_hint(path.stem) or f'P{pages.n}'
        if any(f['id'] == fid for f in floors):
            warnings.append(f'{path.name}: 층 {fid}이 겹쳐 P{pages.n}로 지정')
            fid = f'P{pages.n}'
        ppm = opts.get('pxPerM')
        if not ppm:
            warnings.append(f'{path.name}: 축척 없음, 2D 화면에서 기준 치수 입력 필요')
        floors.append({'id': fid, 'level': common.level(fid, pages.n), 'rooms': [], 'units': []})
        backgrounds.append((key, px, ppm))
    if not floors:
        raise ValueError('이미지 파일이 없습니다.')
    draft, _ = common.build(job, building, 'image', files, floors, warnings)
    detect = []
    for floor, (key, px, ppm) in zip(draft['floors'], backgrounds):
        floor['background'] = {'key': key, 'px': px, 'toPlan': None}
        detect.append({'floor': floor['id'], 'imageKey': key, 'pxPerM': ppm, 'toPlan': None})
    return draft, detect


def merge(ev):
    bucket, key = ev['bucket'], ev['draftKey']
    with s3.get_object(Bucket=bucket, Key=key)['Body'] as body:
        draft = json.loads(body.read())
    units, review = common.merge(draft, ev.get('detections') or {})
    _put_json(bucket, key, draft)
    return {'draftKey': key, 'units': units, 'review': review}
