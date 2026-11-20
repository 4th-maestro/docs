"""도면 기호 찾기(op=match): 운영자가 상자로 지정한 기호 1개와 비슷한 기호를 같은 도면 이미지에서 찾습니다.

규약은 docs/human/reference/plan-ingest.md 3-6절, 요청·응답은 README.md 표 1.3입니다.
"""
import io
import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from botocore.exceptions import ClientError
from PIL import Image

SIDE = 32  # 본 기호 짧은 변을 이 화소로 축소(확대 안 함)
BOX = (8, 400)  # 본 기호 상자 한 변 범위(원본 화소)
LIMIT = 500  # 응답 상자 최대 수
# matchTemplate 1회는 단일 스레드이고 적분 영상(float64 2장)을 만들어 1억 화소 한 번 계산은 2GB 이상 사용(2026-11-21 측정)
STRIP = 1024
MAX_PX = 110_000_000  # 1/500 도면 1m당 80px 렌더링(약 1억 화소) 포함. 1억 화소 축소 없는 계산 최대 2.3GB(함수 3,008MB)
NO_IMAGE = '도면 이미지가 없습니다. 보관 기간(7일)이 지났으면 도면을 다시 변환하십시오.'


class Invalid(ValueError):
    pass


def find(gray, box, min_score=.35, rotate=True):
    """gray(흑백 uint8 2차원 배열)에서 box([u0, v0, u1, v1], 원본 화소)와 비슷한 기호 [{box, score}], 점수 내림차순"""
    u0, v0, u1, v1 = box
    w, h = u1 - u0, v1 - v0
    k = min(1.0, SIDE / min(w, h))
    img = cv2.resize(gray, None, fx=k, fy=k, interpolation=cv2.INTER_AREA) if k < 1 else gray
    x0, y0 = round(u0 * k), round(v0 * k)
    tpl = img[y0:y0 + round(h * k), x0:x0 + round(w * k)]
    if tpl.std() < 1:
        raise Invalid('상자 안에 기호 선이 없습니다. 기호 1개를 감싸도록 다시 지정하십시오.')
    H, W = img.shape
    th, tw = tpl.shape
    # 회전마다 상관 지도를 기호 중심 기준으로 겹쳐 화소별 최댓값과 그 각도를 보관
    best = np.full((H, W), -1, np.float32)
    angle = np.zeros((H, W), np.uint8)
    # 행 STRIP개 단위 띠로 나눠 계산(띠마다 기호 높이 - 1행 겹침이라 점수는 전체 한 번 계산과 같음). 띠 2개씩 동시 계산
    tasks = []
    for r in range(4 if rotate else 1):
        t = np.ascontiguousarray(np.rot90(tpl, r))
        if t.shape[0] <= H and t.shape[1] <= W:
            tasks += [(r, t, y) for y in range(0, H - t.shape[0] + 1, STRIP)]

    def corr(task):
        _, t, y = task
        return cv2.matchTemplate(img[y:y + STRIP + t.shape[0] - 1], t, cv2.TM_CCOEFF_NORMED)

    with ThreadPoolExecutor(2) as pool:
        for i in range(0, len(tasks), 2):
            for (r, t, y), res in zip(tasks[i:i + 2], pool.map(corr, tasks[i:i + 2])):
                oy, ox = y + t.shape[0] // 2, t.shape[1] // 2
                view = best[oy:oy + res.shape[0], ox:ox + res.shape[1]]
                win = res > view
                np.copyto(view, res, where=win)
                np.copyto(angle[oy:oy + res.shape[0], ox:ox + res.shape[1]], r, where=win)
    s = min(tw, th)
    ys, xs = np.nonzero((best >= min_score) & (best == cv2.dilate(best, np.ones((s, s), np.uint8))))
    scores = best[ys, xs]
    out, cx, cy, hw, hh = [], np.empty(LIMIT), np.empty(LIMIT), np.empty(LIMIT), np.empty(LIMIT)
    for i in np.argsort(-scores, kind='stable'):
        y, x, r = int(ys[i]), int(xs[i]), int(angle[ys[i], xs[i]])
        bw, bh = (tw, th) if r % 2 == 0 else (th, tw)
        n = len(out)
        # 상자가 겹치는 앞 순위 결과가 있으면 같은 기호로 보고 제외
        if n and np.any((np.abs(cx[:n] - x) < hw[:n] + bw / 2) & (np.abs(cy[:n] - y) < hh[:n] + bh / 2)):
            continue
        cx[n], cy[n], hw[n], hh[n] = x, y, bw / 2, bh / 2
        ow, oh = (w, h) if r % 2 == 0 else (h, w)
        u, v = round((x - bw // 2) / k), round((y - bh // 2) / k)
        out.append({'box': [u, v, u + ow, v + oh], 'score': round(float(scores[i]), 3)})
        if len(out) == LIMIT:
            break
    return out


def load(body):
    """PNG·JPEG 바이트 → 흑백 배열. 화소 상한 초과·이미지 아님은 Invalid"""
    big = Invalid(f'도면 이미지는 {MAX_PX:,}화소 이하입니다.')
    try:
        with Image.open(io.BytesIO(body)) as im:
            if im.width * im.height > MAX_PX:
                raise big
            return np.asarray(im.convert('L'))
    except Image.DecompressionBombError:  # Pillow 기본 상한 2배(약 1억 7,900만 화소) 초과는 열 때 오류
        raise big from None
    except Image.UnidentifiedImageError:
        raise Invalid('도면 이미지 형식(PNG, JPEG)이 아닙니다.') from None


def run(ev, s3):
    """{bucket, key, box, min, rotate} → {matches, size, ms} 또는 {status, error}. 키 접두어와 값 형식은 API(plan_ingest.match)가 검사"""
    t0 = time.monotonic()
    box = [round(c) for c in ev['box']]
    u0, v0, u1, v1 = box
    if not all(BOX[0] <= s <= BOX[1] for s in (u1 - u0, v1 - v0)):
        return {'status': 400, 'error': f'상자 한 변은 도면 이미지 화소 {BOX[0]}~{BOX[1]}px입니다. 기호 1개만 감싸도록 다시 지정하십시오.'}
    try:
        body = s3.get_object(Bucket=ev['bucket'], Key=ev['key'])['Body'].read()
    except ClientError as e:
        # 함수에 목록 권한이 없어 없는 키도 AccessDenied. 키 접두어(uploads/, jobs/)는 읽기 권한 범위 안
        if e.response.get('Error', {}).get('Code') in ('NoSuchKey', 'AccessDenied', '404', '403'):
            return {'status': 404, 'error': NO_IMAGE}
        raise
    try:
        gray = load(body)
        H, W = gray.shape
        if not (0 <= u0 and u1 <= W and 0 <= v0 and v1 <= H):
            raise Invalid(f'상자가 도면 이미지({W}×{H}px) 밖입니다.')
        matches = find(gray, box, ev.get('min', .35), ev.get('rotate', True))
    except Invalid as e:
        return {'status': 400, 'error': str(e)}
    return {'matches': matches, 'size': [W, H], 'ms': round((time.monotonic() - t0) * 1000)}
