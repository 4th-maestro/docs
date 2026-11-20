"""도면 이미지 실내기 기호 인식(docs/human/reference/plan-ingest.md 5절): 상태 머신 Detect 단계, 층(이미지)마다 1회 실행

- 입력: {floor, imageKey, pxPerM, toPlan}(파싱 결과 detect 항목), 이미지는 도면 버킷(PLANS_BUCKET)
- 처리: 축척을 알면 1m당 80px로 크기 조정 → 1,400px 타일(1,000px 간격) → 타일마다 Serverless Endpoint(DETECT_ENDPOINT) 호출
  → 타일 좌표를 페이지 좌표로 이동 → NMS(IoU 0.5, 문과 실내기 따로) → 원본 이미지 픽셀로 환산
- 출력: {floor, detections: [{cls, conf, box: [u0, v0, u1, v1]}], model}
- Pillow: 계층(layers/pillow)으로 제공. 좌표 계산 함수는 Pillow 없이 테스트하도록 handler 안에서 import
"""
import io
import json
import os

PX_PER_M = 80
TILE, STEP = 1400, 1000
IOU = 0.5
# Serverless Inference 요청 한도 4MB
MAX_BYTES = 4 * 1024 * 1024
_c = {}


def _client(name):
    if name not in _c:
        import boto3
        from botocore.config import Config
        # Endpoint 최대 동시 실행 2: 초과 호출의 제한 오류는 재시도. 콜드 스타트 응답 대기(Endpoint 제한 60초)보다 길게 70초
        _c[name] = boto3.client(name, config=Config(read_timeout=70, retries={'max_attempts': 8, 'mode': 'adaptive'}))
    return _c[name]


def starts(n):
    """한 변 n px의 타일 시작 위치: 1,000px 간격, 마지막 타일은 오른쪽(아래) 끝에 맞춤"""
    out = list(range(0, max(n - TILE, 0) + 1, STEP))
    if out[-1] + TILE < n:
        out.append(n - TILE)
    return out


def iou(a, b):
    w, h = min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def nms(dets, thr=IOU):
    """신뢰도 높은 순으로 남기고, 남긴 상자와 IoU가 thr를 넘는 상자 제거
    - 실내기 유형 구분 없음: 같은 위치의 기호는 실내기 1대이므로 타일마다 유형이 다르게 나와도 1개만 남김
    - 문(door)은 문끼리만 비교: 문 옆 벽걸이형·스탠드형 상자가 문 상자와 겹쳐도 남김
    - shortcut: 타일 경계에서 잘린 기호의 부분 상자는 IoU 0.5 이하이면 중복으로 남음, 중복이 잦으면 타일 안쪽 경계에 닿은 상자 제외 추가
    """
    keep = []
    for d in sorted(dets, key=lambda d: -d['conf']):
        if all(iou(d['box'], k['box']) <= thr for k in keep if (k['cls'] == 'door') == (d['cls'] == 'door')):
            keep.append(d)
    return keep


def page_detections(w, h, infer):
    """w×h 페이지를 타일로 나눠 infer((x0, y0, x1, y1)) 호출, 결과를 페이지 좌표로 옮겨 NMS. (검출 목록, 모델 버전)"""
    dets, model = [], None
    for y in starts(h):
        for x in starts(w):
            out = infer((x, y, min(x + TILE, w), min(y + TILE, h)))
            model = out.get('model') or model
            dets += [{**d, 'box': [d['box'][0] + x, d['box'][1] + y, d['box'][2] + x, d['box'][3] + y]} for d in out['detections']]
    return nms(dets), model


def _infer(tile):
    buf, ctype = io.BytesIO(), 'image/png'
    tile.save(buf, 'PNG')
    # 사진에 가까운 이미지는 PNG가 요청 한도를 넘어 JPEG로 전송
    if buf.tell() > MAX_BYTES:
        buf, ctype = io.BytesIO(), 'image/jpeg'
        tile.save(buf, 'JPEG', quality=90)
    r = _client('sagemaker-runtime').invoke_endpoint(
        EndpointName=os.environ.get('DETECT_ENDPOINT', 'hvac-symbol-detector-sls'), ContentType=ctype, Body=buf.getvalue())
    return json.loads(r['Body'].read())


def handler(event, context):
    from PIL import Image
    body = _client('s3').get_object(Bucket=os.environ['PLANS_BUCKET'], Key=event['imageKey'])['Body'].read()
    img = Image.open(io.BytesIO(body))
    # 투명 배경 도면(CAD 내보내기 PNG)을 RGB로 바꾸면 배경이 검은색이 되어 흰 배경에 합성
    if img.mode in ('RGBA', 'LA', 'PA') or 'transparency' in img.info:
        img = Image.alpha_composite(Image.new('RGBA', img.size, 'white'), img.convert('RGBA'))
    img = img.convert('RGB')
    w, h = img.size
    if event.get('pxPerM'):
        s = PX_PER_M / event['pxPerM']
        img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.Resampling.LANCZOS)
    sx, sy = w / img.width, h / img.height
    dets, model = page_detections(img.width, img.height, lambda box: _infer(img.crop(box)))
    return {'floor': event.get('floor'), 'model': model, 'detections': [
        {'cls': d['cls'], 'conf': d['conf'], 'box': [round(d['box'][0] * sx, 1), round(d['box'][1] * sy, 1),
                                                     round(d['box'][2] * sx, 1), round(d['box'][3] * sy, 1)]} for d in dets]}
