"""SageMaker Serverless Inference 진입점: 도면 타일 1장의 실내기 기호 검출(YOLO ONNX, onnxruntime CPU).

요청: image/png 또는 image/jpeg 1장(Serverless 요청 한도 4MB). 큰 도면은 호출 쪽이 1400px 타일로 나눠 보냄.
응답: {"model", "size": [w, h], "detections": [{"cls", "conf", "box": [u0, v0, u1, v1]}]} 입력 이미지 픽셀 좌표.
규약 원본: docs/human/reference/plan-ingest.md 5절. ultralytics 대신 onnxruntime을 쓰는 이유는 콜드 스타트 설치량 축소.
"""
import json
import os

import cv2
import numpy as np

IMGSZ = 1024
CONF = 0.25
IOU = 0.7  # 타일 안 NMS. 타일 간 중복은 호출 쪽 NMS(IoU 0.5)


def model_fn(model_dir):
    import ast
    import onnxruntime as ort
    sess = ort.InferenceSession(os.path.join(model_dir, 'best.onnx'), providers=['CPUExecutionProvider'])
    names = ast.literal_eval(sess.get_modelmeta().custom_metadata_map['names'])  # ultralytics 내보내기가 기록한 {번호: 이름}
    return {'sess': sess, 'names': names, 'version': os.environ.get('MODEL_VERSION', 'unknown')}


def input_fn(body, content_type):
    if content_type not in ('image/png', 'image/jpeg', 'application/x-image'):
        raise ValueError(f'지원하지 않는 형식: {content_type}')
    im = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR)  # BGR
    if im is None:
        raise ValueError('이미지를 읽지 못했습니다.')
    return im


def letterbox(im):
    """학습(ultralytics)과 같은 전처리: OpenCV INTER_LINEAR 비율 유지 축소, 회색(114) 여백 가운데 정렬.
    PIL bilinear로 바꾸면 얇은 선 도면에서 신뢰도가 0.76에서 0.54로 달라짐(2026-11-20 측정)."""
    h, w = im.shape[:2]
    r = min(IMGSZ / w, IMGSZ / h)
    nw, nh = round(w * r), round(h * r)
    left, top = int(round((IMGSZ - nw) / 2 - 0.1)), int(round((IMGSZ - nh) / 2 - 0.1))
    canvas = np.full((IMGSZ, IMGSZ, 3), 114, np.uint8)
    canvas[top:top + nh, left:left + nw] = cv2.resize(im, (nw, nh), interpolation=cv2.INTER_LINEAR)
    x = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0  # BGR → RGB, CHW
    return x, r, left, top


def nms(boxes, scores, iou):
    order, keep = scores.argsort()[::-1], []
    while order.size:
        i = order[0]
        keep.append(i)
        x0 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        y0 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        x1 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        y1 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
        order = order[1:][inter / (area(boxes[i]) + area(boxes[order[1:]]) - inter + 1e-9) < iou]
    return keep


def predict_fn(im, model):
    x, r, left, top = letterbox(im)
    out = model['sess'].run(None, {model['sess'].get_inputs()[0].name: x})[0][0]  # (4 + 클래스 수, 앵커 수)
    cls_scores = out[4:]
    cls, conf = cls_scores.argmax(0), cls_scores.max(0)
    m = conf >= CONF
    cx, cy, bw, bh = out[:4, m]
    boxes = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], 1)
    boxes = (boxes - [left, top, left, top]) / r  # 여백 제거 후 원본 픽셀
    h, w = im.shape[:2]
    boxes = np.clip(boxes, 0, [w, h, w, h])
    cls, conf = cls[m], conf[m]
    dets = []
    for c in np.unique(cls):  # 클래스별 NMS(ultralytics 기본과 같음)
        idx = np.where(cls == c)[0]
        for i in nms(boxes[idx], conf[idx], IOU):
            j = idx[i]
            dets.append({'cls': model['names'][int(c)], 'conf': round(float(conf[j]), 4), 'box': [round(float(v), 1) for v in boxes[j]]})
    return {'model': model['version'], 'size': [w, h], 'detections': sorted(dets, key=lambda d: -d['conf'])}


def output_fn(pred, accept):
    return json.dumps(pred, ensure_ascii=False), 'application/json'
