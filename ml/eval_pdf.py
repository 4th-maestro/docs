"""운영 경로와 같은 방식으로 실제 도면 PDF를 인식해 라벨과 대수 기준으로 비교합니다.

모델 교체 기준입니다(기술 선택 기록 14절). 평가 타일 mAP50은 클래스 평균이라 대수가 많은 유형의 하락을 놓칩니다.
- 렌더링: 라벨의 축척으로 1m = 80px, 도면 파서(lambda/ingest/pdf.py)와 같은 pypdfium2 렌더링
- 타일, 병합: lambda/src/detect.py page_detections(1,400px 타일, 1,000px 간격, 유형 구분 없는 NMS IoU 0.5)
- 비교: 라벨 상자와 IoU 0.5 이상이고 유형이 같으면 정답

사용: python ml/eval_pdf.py --model best.pt --pdf chuncheon.pdf [--pages 4,5,6,7,8] [--conf 0.5]
"""
import argparse
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lambda', 'src'))
from detect import PX_PER_M, iou, page_detections  # noqa: E402


def score(gts, dets):
    """라벨 [x0, y0, x1, y1, 유형]과 검출 {cls, box}를 IoU 0.5로 맞춰 (정답, 오검출, 놓침) 유형별 개수를 돌려줍니다."""
    tp, fp, fn, used = Counter(), Counter(), Counter(), set()
    for g in gts:
        best = max(((iou(g[:4], d['box']), i) for i, d in enumerate(dets) if i not in used), default=(0, -1))
        if best[0] >= .5:
            used.add(best[1])
            c = dets[best[1]]['cls']
            if c == g[4]:
                tp[g[4]] += 1
            else:
                fn[g[4]] += 1
                fp[c] += 1
        else:
            fn[g[4]] += 1
    for i, d in enumerate(dets):
        if i not in used:
            fp[d['cls']] += 1
    return tp, fp, fn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--pdf', required=True)
    ap.add_argument('--labels', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'real_labels', 'chuncheon_elem.json'))
    ap.add_argument('--pages', default='4,5,6,7,8')
    ap.add_argument('--conf', type=float, default=.5)
    a = ap.parse_args()
    import pypdfium2 as pdfium
    from ultralytics import YOLO
    model, L, doc = YOLO(a.model), json.load(open(a.labels)), pdfium.PdfDocument(a.pdf)
    tp, fp, fn = Counter(), Counter(), Counter()
    for page in a.pages.split(','):
        P = L['pages'][page]
        gts = json.loads(P['boxes']) if isinstance(P['boxes'], str) else P['boxes']
        scale = PX_PER_M * P['scale'] * 25.4 / 72000  # px/pt, 파서와 같은 식
        img = doc[int(page) - 1].render(scale=scale).to_pil().convert('RGB')

        def infer(box):
            r = model.predict(img.crop(box), imgsz=1024, conf=.25, verbose=False)[0].boxes
            return {'detections': [{'cls': model.names[int(c)], 'conf': s, 'box': b} for c, b, s in zip(r.cls.tolist(), r.xyxy.tolist(), r.conf.tolist())]}

        dets, _ = page_detections(*img.size, infer)
        k = L['dpi'] / 72 / scale
        dets = [{**d, 'box': [v * k for v in d['box']]} for d in dets if d['conf'] >= a.conf]
        for total, part in zip((tp, fp, fn), score(gts, dets)):
            total.update(part)
    T, F, N = sum(tp.values()), sum(fp.values()), sum(fn.values())
    result = {'precision': round(T / max(T + F, 1), 3), 'recall': round(T / max(T + N, 1), 3), 'tp': T, 'fp': F, 'fn': N,
              'per_class_recall': {c: f'{tp[c]}/{tp[c] + fn[c]}' for c in sorted(set(tp) | set(fn))}, 'fp_by_class': dict(fp)}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
