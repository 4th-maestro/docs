"""CubiCasa5K 평면도에 냉난방 실내기 기호를 합성해 YOLO 검출 데이터셋 생성.

사용: python3 synth.py SRC OUT [--limit N] [--seed 0]
  SRC: cubicasa5k 폴더(train.txt 포함), cubicasa5k.zip 경로, zip 내려받기 URL 중 하나
  OUT: images/{train,val,test}, labels/{train,val,test}, data.yaml, stats.json
의존성: Pillow
"""
import argparse
import json
import math
import os
import random
import re
import statistics
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import Pool

from PIL import Image, ImageDraw, ImageFont

# 클래스 순서가 YOLO 클래스 번호. LG 모델 연결은 hvac_types.json
CLASSES = ['cassette_4way', 'cassette_1way', 'wall_mounted', 'ceiling_duct', 'floor_standing', 'cassette_2way']
ON_WALL = {2, 4}
CLASS_WEIGHT = [1, 1, 1, 1, 2, 2]
# 국내 CAD 도면 배관 색(냉매 주황, 드레인 초록, 제어선 빨강)
PIPE = [(240, 110, 40), (40, 160, 70), (220, 50, 50)]
SVG = '{http://www.w3.org/2000/svg}'
NUM = re.compile(r'-?\d+(?:\.\d+)?(?:e-?\d+)?')
# 기호 크기(벽 두께 t의 배수): 내벽 두께 약 0.12m 기준으로 실제 제품 치수(0.6~1.5m)에 맞춤
SIZE = {
    0: lambda r: (r.uniform(5, 8),) * 2,
    1: lambda r: (L := r.uniform(7, 10), L * r.uniform(0.35, 0.45)),
    2: lambda r: (r.uniform(6.5, 9), r.uniform(1.6, 2.4)),
    3: lambda r: (L := r.uniform(8, 12), L * r.uniform(0.4, 0.6)),
    # 스탠드형·2방향 범위는 실제 도면(29kW 스탠드형 약 0.74×1.24m, 2방향 비율 0.73)에 맞춰 v3에서 넓힘(2026-11-20)
    4: lambda r: (L := r.uniform(4, 11), L * r.uniform(0.5, 0.8)),
    5: lambda r: (L := r.uniform(7, 10), L * r.uniform(0.45, 0.8)),
}


def parse(svg_path):
    rooms, walls = [], []
    for g in ET.parse(svg_path).iter(SVG + 'g'):
        c = g.get('class', '')
        p = g.find(SVG + 'polygon')
        if p is None or not (c.startswith('Space ') or c.startswith('Wall')):
            continue
        n = [float(v) for v in NUM.findall(p.get('points', ''))]
        pts = list(zip(n[0::2], n[1::2]))
        if len(pts) >= 3:
            (rooms if c.startswith('Space ') else walls).append((c, pts))
    return rooms, walls


def ring(pts):
    return zip(pts, pts[1:] + pts[:1])


def area(pts):
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in ring(pts))) / 2


def inside(pts, x, y):
    c = False
    for (x0, y0), (x1, y1) in ring(pts):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            c = not c
    return c


def fits(pts, box, m):
    # shortcut: 모서리, 변 중점, 중심 9점만 검사해 오목한 방의 좁은 돌출부는 놓칠 수 있음. 오검출이 보이면 다각형 포함 판정으로 교체
    x0, y0, x1, y1 = box[0] - m, box[1] - m, box[2] + m, box[3] + m
    xs, ys = (x0, (x0 + x1) / 2, x1), (y0, (y0 + y1) / 2, y1)
    return all(inside(pts, x, y) for x in xs for y in ys)


def apart(box, boxes, gap):
    return all(box[2] + gap < b[0] or b[2] + gap < box[0] or box[3] + gap < b[1] or b[3] + gap < box[1] for b in boxes)


def wall_box(rng, pts, L, D, t):
    """방 다각형의 축 정렬 변 하나에 붙인 상자와 벽 방향(0 위, 1 오른쪽, 2 아래, 3 왼쪽)."""
    edges = [(a, b) for a, b in ring(pts) if (abs(a[0] - b[0]) < 1 or abs(a[1] - b[1]) < 1) and math.dist(a, b) > L + 2 * t]
    if not edges:
        return None
    (ax, ay), (bx, by) = rng.choice(edges)
    if abs(ay - by) < 1:
        x0 = min(ax, bx) + rng.uniform(t, abs(ax - bx) - L - t)
        down = inside(pts, x0 + L / 2, ay + 2)
        y0 = ay + 1 if down else ay - 1 - D
        return (x0, y0, x0 + L, y0 + D), 0 if down else 2
    y0 = min(ay, by) + rng.uniform(t, abs(ay - by) - L - t)
    right = inside(pts, ax + 2, y0 + L / 2)
    x0 = ax + 1 if right else ax - 1 - D
    return (x0, y0, x0 + D, y0 + L), 3 if right else 1


def place(rng, rooms, t):
    """방마다 기호 0~2개 배치. 반환: [(클래스, 상자, 벽 방향 또는 None)]."""
    out = []
    if rng.random() < 0.1:  # 기호 없는 음성 도면
        return out
    for c, pts in rooms:
        a = area(pts)
        if 'Outdoor' in c or a < (8 * t) ** 2 or rng.random() > 0.75:
            continue
        for _ in range(1 + (a > (45 * t) ** 2)):
            # 스탠드형(v3 재현율 0.206)과 2방향(v4 재현율 0.60)은 2배 비중으로 합성(v4, v5, 2026-11-20)
            k = rng.choices(range(len(CLASSES)), weights=CLASS_WEIGHT)[0]
            L, D = (s * t for s in SIZE[k](rng))
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            for _ in range(20):
                if k in ON_WALL:
                    got = wall_box(rng, pts, L, D, t)
                    if not got:
                        break
                    box, side = got
                    ok = fits(pts, (box[0] + 2, box[1] + 2, box[2] - 2, box[3] - 2), 0)
                else:
                    w, h = (L, D) if rng.random() < 0.5 else (D, L)
                    if max(xs) - min(xs) < w + 2 * t or max(ys) - min(ys) < h + 2 * t:
                        break
                    x, y = rng.uniform(min(xs), max(xs) - w), rng.uniform(min(ys), max(ys) - h)
                    box, side = (x, y, x + w, y + h), rng.randrange(4)
                    ok = fits(pts, box, t)
                if ok and apart(box, [b for _, b, _ in out], t):
                    out.append((k, box, side if k in ON_WALL or k == 1 else None))
                    break
    return out


def line(d, pts, ink, w):
    d.line(pts, fill=ink, width=w)


def arrow(d, x, y, dx, dy, n, ink, w):
    """(x, y)에서 (dx, dy) 방향 길이 n 화살표."""
    ex, ey = x + dx * n, y + dy * n
    line(d, [(x, y), (ex, ey)], ink, w)
    for s in (0.5, -0.5):
        c, si = math.cos(math.pi - s), math.sin(math.pi - s)
        line(d, [(ex, ey), (ex + (dx * c - dy * si) * n * 0.4, ey + (dx * si + dy * c) * n * 0.4)], ink, w)


def dashed_rect(d, box, ink, w, dash):
    x0, y0, x1, y1 = box
    for a, b in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        n = max(1, int(math.dist(a, b) // dash))
        for i in range(0, n, 2):
            f0, f1 = i / n, min(1, (i + 1) / n)
            line(d, [(a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0), (a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1)], ink, w)


# 벽 방향별 방 안쪽 단위 벡터와 그 방향 변까지의 거리 계산용
INTO = {0: (0, 1), 1: (-1, 0), 2: (0, -1), 3: (1, 0)}


def draw(d, k, box, side, ink, w, t, style='std'):
    """style: 'std' 단순 선 기호, 'kr' 국내 CAD 실시설계 도면 기호(굵은 이중 테두리, 채움, 토출 화살표)."""
    if style == 'kr':
        return draw_kr(d, k, box, side, ink, w)
    x0, y0, x1, y1 = box
    W, H = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    if k == 3:
        dashed_rect(d, box, ink, w, max(3, t * 0.8))
        s = min(W, H) * 0.45
        gx, gy = (x0 + W * 0.25, cy) if W >= H else (cx, y0 + H * 0.25)
        g = (gx - s / 2, gy - s / 2, gx + s / 2, gy + s / 2)
        d.rectangle(g, outline=ink, width=w)
        line(d, [g[:2], g[2:]], ink, w)
        line(d, [(g[0], g[3]), (g[2], g[1])], ink, w)
        return
    d.rectangle(box, outline=ink, width=w)
    if k == 0:
        i = min(W, H) * 0.22
        d.rectangle((x0 + i, y0 + i, x1 - i, y1 - i), outline=ink, width=w)
        for (ax, ay), (bx, by) in (((x0, y0), (x0 + i, y0 + i)), ((x1, y0), (x1 - i, y0 + i)), ((x1, y1), (x1 - i, y1 - i)), ((x0, y1), (x0 + i, y1 - i))):
            line(d, [(ax, ay), (bx, by)], ink, w)
    elif k == 1:
        # 토출구 2줄: 긴 변 중 side 방향에 가까운 쪽
        for f in (0.18, 0.3):
            if W >= H:
                y = y0 + H * f if side < 2 else y1 - H * f
                line(d, [(x0 + W * 0.08, y), (x1 - W * 0.08, y)], ink, w)
            else:
                x = x0 + W * f if side in (1, 3) else x1 - W * f
                line(d, [(x, y0 + H * 0.08), (x, y1 - H * 0.08)], ink, w)
    elif k == 5:
        # 토출구: 양쪽 긴 변에 1줄씩
        for f in (0.2, 0.8):
            if W >= H:
                line(d, [(x0 + W * 0.08, y0 + H * f), (x1 - W * 0.08, y0 + H * f)], ink, w)
            else:
                line(d, [(x0 + W * f, y0 + H * 0.08), (x0 + W * f, y1 - H * 0.08)], ink, w)
    else:
        dx, dy = INTO[side]
        # 방 쪽 변의 중점
        fx, fy = cx + dx * W / 2, cy + dy * H / 2
        if k == 2:
            # 루버 선과 방 안쪽 토출 화살표
            if dy:
                line(d, [(x0 + W * 0.06, fy - dy * H * 0.3), (x1 - W * 0.06, fy - dy * H * 0.3)], ink, w)
            else:
                line(d, [(fx - dx * W * 0.3, y0 + H * 0.06), (fx - dx * W * 0.3, y1 - H * 0.06)], ink, w)
            arrow(d, fx, fy, dx, dy, max(W, H) * 0.25, ink, w)
        else:
            r = min(W, H) * 0.28
            d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=ink, width=w)
            if dy:
                line(d, [(x0 + W * 0.15, fy - dy * H * 0.12), (x1 - W * 0.15, fy - dy * H * 0.12)], ink, w)
            else:
                line(d, [(fx - dx * W * 0.12, y0 + H * 0.15), (fx - dx * W * 0.12, y1 - H * 0.15)], ink, w)


def fans(d, box, side, ink, w, n):
    """방 쪽 변 중점에서 부채꼴로 퍼지는 토출 화살표 3개."""
    x0, y0, x1, y1 = box
    dx, dy = INTO[side]
    fx, fy = (x0 + x1) / 2 + dx * (x1 - x0) / 2, (y0 + y1) / 2 + dy * (y1 - y0) / 2
    for a in (-0.6, 0, 0.6):
        c, s = math.cos(a), math.sin(a)
        arrow(d, fx + dx * w * 2, fy + dy * w * 2, dx * c - dy * s, dx * s + dy * c, n, ink, w)


def draw_kr(d, k, box, side, ink, w):
    x0, y0, x1, y1 = box
    W, H = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m = min(W, H)
    # 실제 도면의 2방향·스탠드형은 테두리가 기호 폭의 약 13%, 4방향은 약 10%로 굵음
    d.rectangle(box, outline=ink, width=max(2, round(m * (0.13 if k in (4, 5) else 0.1 if k == 0 else 0.07))))
    if k == 0:
        # 실제 도면 4방향(v7): 굵은 바깥 테두리, 흰 틈, 둥근 안쪽 사각 테두리, 기호 폭의 약 50%를 채운 가운데 사각형
        # v3~v6은 테두리가 가늘고 가운데 사각형이 약 40%여서 v6에서 실제 4방향 27대 중 12대를 검은 본체 2방향으로 판정
        i, f = m * 0.17, m * 0.28
        d.rounded_rectangle((x0 + i, y0 + i, x1 - i, y1 - i), radius=m * 0.06, outline=ink, width=max(2, round(m * 0.06)))
        d.rectangle((x0 + f, y0 + f, x1 - f, y1 - f), fill=ink)
    elif k == 5:
        # 실제 도면 2방향(v6): 검게 채운 본체에 흰 대괄호 2개([ ]). 긴 변과 평행한 흰 선과 양 끝 안쪽 가로선
        # v3~v5는 흰 바탕에 검은 막대로 그려 실제와 색이 반대였고, 실제 2방향을 스탠드형으로 판정(v5 20대 전부)
        d.rectangle(box, fill=ink)
        white, lw = (255, 255, 255), max(1, round(m * 0.06))
        for side_ in (-1, 1):
            if H >= W:
                x = cx + side_ * W * 0.3
                line(d, [(x, y0 + H * 0.12), (x, y1 - H * 0.12)], white, lw)
                for y in (y0 + H * 0.12, y1 - H * 0.12):
                    line(d, [(x, y), (x - side_ * W * 0.14, y)], white, lw)
            else:
                y = cy + side_ * H * 0.3
                line(d, [(x0 + W * 0.12, y), (x1 - W * 0.12, y)], white, lw)
                for x in (x0 + W * 0.12, x1 - W * 0.12):
                    line(d, [(x, y), (x, y - side_ * H * 0.14)], white, lw)
    elif k == 1:
        # 토출 쪽 긴 변을 따라 채운 띠
        if W >= H:
            ya, yb = (y0, y0 + H * 0.3) if side < 2 else (y1 - H * 0.3, y1)
            d.rectangle((x0, ya, x1, yb), fill=ink)
        else:
            xa, xb = (x0, x0 + W * 0.3) if side in (1, 3) else (x1 - W * 0.3, x1)
            d.rectangle((xa, y0, xb, y1), fill=ink)
    elif k == 3:
        # 이중 테두리와 양 끝 그릴
        i, s = m * 0.15, m * 0.35
        d.rectangle((x0 + i, y0 + i, x1 - i, y1 - i), outline=ink, width=w)
        ends = ((x0 + i + s / 2 + w, cy), (x1 - i - s / 2 - w, cy)) if W >= H else ((cx, y0 + i + s / 2 + w), (cx, y1 - i - s / 2 - w))
        for gx, gy in ends:
            d.rectangle((gx - s / 2, gy - s / 2, gx + s / 2, gy + s / 2), outline=ink, width=w)
    else:
        # 벽 부착형: 벽과 평행한 안쪽 표시와 방 안쪽 토출 화살표
        dx, dy = INTO[side]
        if k == 4:
            return standing_kr(d, box, side, ink, w)
        d.rectangle((x0 + W * 0.1, cy - H * 0.15, x1 - W * 0.1, cy + H * 0.15) if dy else (cx - W * 0.15, y0 + H * 0.1, cx + W * 0.15, y1 - H * 0.1), fill=ink)
        fans(d, box, side, ink, w, max(W, H) * 0.3)


def standing_kr(d, box, side, ink, w):
    """실제 도면 스탠드형: 검게 채운 본체, 벽 쪽 가는 흰 선 2줄, 앞면에서 떨어진 가는 곡선 토출 화살표 3개.
    v4는 흰 띠를 넓게 그려 실제 2방향 기호(굵은 테두리 안 흰 바탕과 막대)와 혼동(2방향 20대 중 14대를 스탠드형으로 판정). v5는 흰 선을 깊이의 8%로 좁힘"""
    x0, y0, x1, y1 = box
    dx, dy = INTO[side]
    d.rectangle(box, fill=ink)
    # 깊이 방향은 벽에서 방 쪽으로 0.2~0.55, 길이 방향은 0.12~0.88 구간을 흰 띠로 비움
    # 벽에서 방 쪽 깊이의 25~33%, 42~50% 구간에 흰 선 2줄(길이 방향 12~88%)
    for f0, f1 in ((0.25, 0.33), (0.42, 0.5)):
        if dy:
            a, b = (y0, y1) if dy > 0 else (y1, y0)
            s0, s1 = sorted((a + (b - a) * f0, a + (b - a) * f1))
            d.rectangle((x0 + (x1 - x0) * 0.12, s0, x1 - (x1 - x0) * 0.12, s1), fill=(255, 255, 255))
        else:
            a, b = (x0, x1) if dx > 0 else (x1, x0)
            s0, s1 = sorted((a + (b - a) * f0, a + (b - a) * f1))
            d.rectangle((s0, y0 + (y1 - y0) * 0.12, s1, y1 - (y1 - y0) * 0.12), fill=(255, 255, 255))
    if dy:
        L, fx, fy, ux, uy = x1 - x0, (x0 + x1) / 2, (y1 if dy > 0 else y0), 1, 0
    else:
        L, fx, fy, ux, uy = y1 - y0, (x1 if dx > 0 else x0), (y0 + y1) / 2, 0, 1
    n, gap = L * 0.45, L * 0.08
    for o, bend in ((-0.3, -1), (0, 0), (0.3, 1)):
        # 가운데는 직선, 양쪽은 바깥으로 휘는 3점 꺾은선
        p0 = (fx + ux * o * L + dx * gap, fy + uy * o * L + dy * gap)
        p1 = (p0[0] + dx * n * 0.5 + ux * bend * n * 0.1, p0[1] + dy * n * 0.5 + uy * bend * n * 0.1)
        p2 = (p0[0] + dx * n + ux * bend * n * 0.35, p0[1] + dy * n + uy * bend * n * 0.35)
        line(d, [p0, p1, p2], ink, max(1, w))
        vx, vy = p2[0] - p1[0], p2[1] - p1[1]
        k = math.hypot(vx, vy) or 1
        vx, vy, h = vx / k, vy / k, max(3, n * 0.18)
        d.polygon([(p2[0] + vx * h * 0.6, p2[1] + vy * h * 0.6), (p2[0] - vy * h * 0.4, p2[1] + vx * h * 0.4), (p2[0] + vy * h * 0.4, p2[1] - vx * h * 0.4)], fill=ink)


def context(d, rng, box, ink, avoid=()):
    """국내 도면에서 실내기 주변에 함께 그려지는 표시(라벨 없음): 연결 박스, 배관 2줄, 관경 박스, 용량 팔각 태그.
    avoid: 다른 기호 상자. 연결 박스와 태그가 겹치면 해당 표시를 생략해 라벨 기호를 가리지 않음."""
    x0, y0, x1, y1 = box
    W, H = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    m = max(W, H)
    w = max(1, round(m * 0.03))
    font = lambda s: ImageFont.load_default(size=max(8, int(s)))
    dx, dy = rng.choice([(0, -1), (0, 1), (-1, 0), (1, 0)])
    s = m * rng.uniform(0.3, 0.4)
    bx, by = cx + dx * (W / 2 + s * 0.7), cy + dy * (H / 2 + s * 0.7)
    c = (bx - s / 2, by - s / 2, bx + s / 2, by + s / 2)
    if not apart(c, avoid, w):
        return
    d.rectangle(c, outline=ink, width=w)
    line(d, [c[:2], c[2:]], ink, w)
    line(d, [(c[0], c[3]), (c[2], c[1])], ink, w)
    n = m * rng.uniform(1.5, 4)
    for o, col in ((-s * 0.25, ink), (s * 0.25, rng.choice(PIPE))):
        sx, sy = bx + dx * s / 2 + (0 if dx else o), by + dy * s / 2 + (o if dx else 0)
        line(d, [(sx, sy), (sx + dx * n, sy + dy * n)], col, w)
    for txt in rng.sample(['32', '40', '25', 'H', 'B'], 2):
        f, q = rng.uniform(0.3, 0.9), s * 0.8
        side = rng.choice([-1, 1]) * q * 1.3
        px, py = bx + dx * (s / 2 + n * f) + (0 if dx else side), by + dy * (s / 2 + n * f) + (side if dx else 0)
        col = rng.choice([ink] + PIPE)
        d.rectangle((px - q / 2, py - q / 2, px + q / 2, py + q / 2), outline=col, width=w)
        d.text((px, py), txt, fill=col, font=font(q * 0.7), anchor='mm')
    R = math.sqrt(W * H) * rng.uniform(0.45, 0.6)
    ox, oy = cx - dx * (W / 2 + R * 1.3), cy - dy * (H / 2 + R * 1.3)
    if not apart((ox - R, oy - R, ox + R, oy + R), avoid, w):
        return
    col = rng.choice([ink] + PIPE)
    d.polygon([(ox + R * math.cos(math.pi / 8 + i * math.pi / 4), oy + R * math.sin(math.pi / 8 + i * math.pi / 4)) for i in range(8)], outline=col, width=w)
    kw = rng.choice([5.2, 6.0, 11.0, 13.0, 14.5, 29.0])
    for j, txt in enumerate([f'{kw:.1f}KW', f'E-{kw / 2.9:.1f}HP', f'{rng.randint(1, 9):02d}']):
        d.text((ox, oy + (j - 1) * R * 0.55), txt, fill=col, font=font(R * 0.32), anchor='mm')


def thickness(walls):
    # 얇은 사각형은 넓이 / (둘레 / 2)가 두께에 가까움
    v = [area(p) / (s / 2) for _, p in walls if (s := sum(math.dist(a, b) for a, b in ring(p))) > 0]
    return min(60.0, max(4.0, statistics.median(v))) if v else 10.0


def make(job):
    src, folder, split, out, seed = job
    name = folder.strip('/').replace('/', '_')
    try:
        rng = random.Random(f'{seed}:{folder}')
        d = os.path.join(src, folder.strip('/'))
        rooms, walls = parse(os.path.join(d, 'model.svg'))
        im = Image.open(os.path.join(d, 'F1_scaled.png')).convert('RGB')
        t = thickness(walls)
        allp = [q for _, p in rooms + walls for q in p] or [(0, 0), im.size]
        crop = tuple(int(v) for v in (
            max(0, min(p[0] for p in allp) - 4 * t), max(0, min(p[1] for p in allp) - 4 * t),
            min(im.width, max(p[0] for p in allp) + 4 * t), min(im.height, max(p[1] for p in allp) + 4 * t)))
        dr = ImageDraw.Draw(im)
        syms = place(rng, rooms, t)
        # 도면 절반은 국내 CAD 실시설계 기호와 주변 표시로 그림(실제 도면 기호 모양 과적합 방지)
        style = 'kr' if rng.random() < 0.5 else 'std'
        rows, kept = [], []
        for k, box, side in syms:
            g = rng.randint(0, 70)
            w = max(1, round(t * rng.uniform(0.1, 0.2)))
            draw(dr, k, box, side, (g, g, g), w, t, style)
            if style == 'kr':
                if rng.random() < 0.8:
                    context(dr, rng, box, (g, g, g), [b for _, b, _ in syms if b is not box])
            elif rng.random() < 0.5:
                tag = f"{rng.choice(['AC', 'IDU', 'FCU', 'EHP'])}-{rng.randint(1, 30)}"
                dr.text((box[2] + t * 0.5, box[1]), tag, fill=(g, g, g), font=ImageFont.load_default(size=max(10, int(t * rng.uniform(1.2, 2)))))
            cw, ch = crop[2] - crop[0], crop[3] - crop[1]
            bx0, by0 = max(box[0] - w / 2, crop[0]), max(box[1] - w / 2, crop[1])
            bx1, by1 = min(box[2] + w / 2, crop[2]), min(box[3] + w / 2, crop[3])
            if bx1 <= bx0 or by1 <= by0:  # SVG 방 다각형이 이미지 밖까지 있는 도면: 보이지 않는 기호는 라벨 제외
                continue
            kept.append(k)
            v =((bx0 + bx1) / 2 - crop[0]) / cw, ((by0 + by1) / 2 - crop[1]) / ch, (bx1 - bx0) / cw, (by1 - by0) / ch
            assert all(0 <= x <= 1 for x in v), (name, v)
            rows.append(f'{k} ' + ' '.join(f'{x:.6f}' for x in v))
        im.crop(crop).save(os.path.join(out, 'images', split, name + '.png'))
        with open(os.path.join(out, 'labels', split, name + '.txt'), 'w') as f:
            f.write('\n'.join(rows) + ('\n' if rows else ''))
        return split, kept, None
    except Exception as e:  # 손상된 원본 1장 때문에 전체 작업이 멈추지 않도록 건너뛰고 집계
        return split, [], f'{folder}: {e!r}'


def fetch(url, path, parts=16):
    """구간 요청 병렬 다운로드. Zenodo는 연결 1개당 속도가 제한되어 단일 연결로 5.5GB가 60분을 넘김(2026-11-20)."""
    r = urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-0'}), timeout=60)
    size = int(r.headers['Content-Range'].split('/')[1])
    with open(path, 'wb') as f:
        f.truncate(size)
    step = -(-size // parts)

    def part(i):
        a, b = i * step, min(size, (i + 1) * step) - 1
        for attempt in range(5):
            try:
                res = urllib.request.urlopen(urllib.request.Request(url, headers={'Range': f'bytes={a}-{b}'}), timeout=120)
                pos = a
                with open(path, 'r+b') as f:
                    f.seek(a)
                    while chunk := res.read(1 << 20):
                        f.write(chunk)
                        pos += len(chunk)
                if pos == b + 1:
                    return
                raise IOError(f'part {i}: {pos - a}/{b - a + 1} bytes')
            except Exception:
                if attempt == 4:
                    raise

    with ThreadPoolExecutor(parts) as ex:
        list(ex.map(part, range(parts)))
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--limit', type=int, default=0, help='분할마다 앞에서 N장만 처리(점검용)')
    ap.add_argument('--seed', type=int, default=0)
    a = ap.parse_args()
    base = os.path.dirname(os.path.abspath(a.out))
    src, work = a.src, os.path.join(base, 'cubicasa_src')
    if src.startswith('http'):
        # src_cache에는 압축 파일만 저장. 처리 작업이 이 폴더를 S3에 보관(sagemaker.sh data)
        cache = os.path.join(base, 'src_cache')
        os.makedirs(cache, exist_ok=True)
        print('download', src, flush=True)
        src = fetch(src, os.path.join(cache, 'cubicasa5k.zip'))
    if src.endswith('.zip'):
        print('extract', src, flush=True)
        zipfile.ZipFile(src).extractall(work)
        src = os.path.join(work, 'cubicasa5k')
    jobs = []
    for split in ('train', 'val', 'test'):
        for sub in ('images', 'labels'):
            os.makedirs(os.path.join(a.out, sub, split), exist_ok=True)
        with open(os.path.join(src, split + '.txt')) as f:
            folders = f.read().split()
        jobs += [(src, x, split, a.out, a.seed) for x in folders[:a.limit or None]]
    with Pool() as p:
        res = p.map(make, jobs, chunksize=8)
    stats = {s: {'images': 0, **{c: 0 for c in CLASSES}} for s in ('train', 'val', 'test')}
    errors = [e for _, _, e in res if e]
    for s, ks, e in res:
        if not e:
            stats[s]['images'] += 1
            for k in ks:
                stats[s][CLASSES[k]] += 1
    with open(os.path.join(a.out, 'data.yaml'), 'w') as f:
        # path 생략: ultralytics가 이 파일의 폴더를 데이터셋 루트로 사용
        f.write('train: images/train\nval: images/val\ntest: images/test\nnames:\n' + ''.join(f'  {i}: {c}\n' for i, c in enumerate(CLASSES)))
    with open(os.path.join(a.out, 'stats.json'), 'w') as f:
        json.dump({'stats': stats, 'errors': errors}, f, ensure_ascii=False, indent=1)
    print(json.dumps(stats), f'errors={len(errors)}', *errors[:20], sep='\n')


if __name__ == '__main__':
    main()
