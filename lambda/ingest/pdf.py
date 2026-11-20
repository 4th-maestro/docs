"""PDF 렌더링: 페이지별 이미지, 축척 문자, 층 표기, 텍스트 레이어 단어 위치"""
import ctypes
import re

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from common import PX_PER_M, cap_scale, floor_hint, lines

SCALES = {50, 60, 100, 150, 200, 250, 300, 400, 500, 600, 1000, 1200}
SCALE = re.compile(r'(S\s*=\s*|축척\s*:?\s*|SCALE\s*:?\s*)?(?<![\d.])1\s*[/:]\s*(\d{2,4})(?![\d/])', re.I)
DPI = 200  # 축척을 모를 때의 렌더링 해상도
JOIN = 0.3  # `-`로 끝나거나 시작하는 단어와 같은 줄 다음 단어의 간격이 글자 높이의 이 배수 미만이면 한 단어(`E-` + `4.5HP`)


def find_scale(text):
    """`1/200`, `1:100`, `S=1/200`, `축척 1/200` 형식의 축척 분모를 찾습니다. 접두어가 있는 값을 우선합니다."""
    # 배수 구배(1/100)는 축척이 아니므로 제외합니다.
    hits = [(bool(m[1]), int(m[2])) for m in SCALE.finditer(text or '')
            if int(m[2]) in SCALES and '구배' not in text[max(0, m.start() - 5):m.start()]]
    return max(hits, key=lambda h: h[0])[1] if hits else None


def words(page, tp, size):
    """텍스트 레이어 단어를 렌더링 이미지 화소 상자 [(문자, u0, v0, u1, v1)](v 아래쪽)로 돌려줍니다.

    공백으로 나눈 단어의 글자 상자를 합친 뒤 FPDF_PageToDevice로 페이지 회전까지 반영해 화소 좌표로 바꿉니다.
    문자 객체가 `E-`, `4.5HP`처럼 `-`에서 나뉘고 같은 줄 간격이 글자 높이(loose 상자)의 0.3배 미만이면 잇습니다.
    춘천초 설비도면에서 이 간격은 0.07~0.14배, 단어 사이 공백은 0.14~0.17배였습니다(2026-11-21 측정).
    shortcut: `-` 없이 나뉜 장비 번호(`CAC` + `01`)는 잇지 않음, 실제 도면에서 확인되면 영문+숫자 조합으로 확대
    """
    # PDFium은 줄 끝 `-`를 U+FFFE(소프트 하이픈)로 돌려주므로 `-`로 되돌립니다(춘천초 5쪽 `E-` + `5.0HP`).
    text, raw, cur = tp.get_text_range().translate({0xFFFE: '-', 0xAD: '-'}), [], None
    if len(text) != tp.count_chars():  # shortcut: BMP 밖 문자(UTF-16 2단위)가 있으면 글자 위치가 어긋나 단어를 읽지 않음
        return []
    for i, ch in enumerate(text):
        if ch.isspace():
            cur = None
            continue
        l, b, r, t = tp.get_charbox(i, loose=True)
        # 텍스트 순서로 이어져도 글자 상자가 단어 상자와 글자 크기 절반 넘게 떨어지면(위아래로 쌓은 `32`, `H`) 다른 단어입니다.
        if cur is not None and max(l - cur[3], cur[1] - r, b - cur[4], cur[2] - t) > max(r - l, t - b) / 2:
            cur = None
        if cur is None:
            cur = [ch, l, b, r, t]
            raw.append(cur)
        else:
            cur[:] = [cur[0] + ch, min(cur[1], l), min(cur[2], b), max(cur[3], r), max(cur[4], t)]
    out = []
    for s, l, b, r, t in raw:
        (u0, v0), (u1, v1) = _device(page, size, l, b), _device(page, size, r, t)
        out.append((s, min(u0, u1), min(v0, v1), max(u0, u1), max(v0, v1)))
    joined = []
    for ln in lines(out):
        w = list(ln[0])
        for x in ln[1:]:
            h = min(w[4] - w[2], x[4] - x[2])
            if -JOIN * h <= x[1] - w[3] < JOIN * h and (w[0].endswith('-') or x[0].startswith('-')):
                w = [w[0] + x[0], w[1], min(w[2], x[2]), max(w[3], x[3]), max(w[4], x[4])]
            else:
                joined.append(tuple(w))
                w = list(x)
        joined.append(tuple(w))
    return joined


def _device(page, size, x, y):
    u, v = ctypes.c_int(), ctypes.c_int()
    pdfium_c.FPDF_PageToDevice(page.raw, 0, 0, size[0], size[1], 0, x, y, u, v)
    return u.value, v.value


def pages(path, scale=None):
    """페이지마다 (PIL 이미지, 1m당 화소 또는 None, 층 표기, 축척 분모, 단어 목록)을 돌려줍니다.

    축척(scale 인자 우선, 없으면 페이지 문자)을 알면 1m가 80px가 되도록 렌더링하고, 모르면 200dpi로 렌더링합니다.
    PDF 용지 크기를 원본 도면 용지로 가정합니다. 단어 위치는 렌더링 이미지 화소 좌표입니다.
    """
    doc = pdfium.PdfDocument(str(path))
    try:
        for page in doc:
            tp = page.get_textpage()
            text = tp.get_text_range()
            s = scale or find_scale(text)
            w, h = page.get_size()  # pt
            # 용지 1pt는 실제 s·25.4/72000 m이므로 1m를 80px로 렌더링하는 배율은 80·s·25.4/72000(px/pt)입니다.
            k = cap_scale(w, h, PX_PER_M * s * 25.4 / 72000 if s else DPI / 72)
            img = page.render(scale=k).to_pil()
            yield img, (round(k * 72000 / (s * 25.4), 3) if s else None), floor_hint(text), s, words(page, tp, img.size)
    finally:
        doc.close()
