"""PDF 렌더링: 페이지별 이미지, 축척 문자, 층 표기"""
import re

import pypdfium2 as pdfium

from common import PX_PER_M, cap_scale, floor_hint

SCALES = {50, 60, 100, 150, 200, 250, 300, 400, 500, 600, 1000, 1200}
SCALE = re.compile(r'(S\s*=\s*|축척\s*:?\s*|SCALE\s*:?\s*)?(?<![\d.])1\s*[/:]\s*(\d{2,4})(?![\d/])', re.I)
DPI = 200  # 축척을 모를 때의 렌더링 해상도


def find_scale(text):
    """`1/200`, `1:100`, `S=1/200`, `축척 1/200` 형식의 축척 분모를 찾습니다. 접두어가 있는 값을 우선합니다."""
    # 배수 구배(1/100)는 축척이 아니므로 제외합니다.
    hits = [(bool(m[1]), int(m[2])) for m in SCALE.finditer(text or '')
            if int(m[2]) in SCALES and '구배' not in text[max(0, m.start() - 5):m.start()]]
    return max(hits, key=lambda h: h[0])[1] if hits else None


def pages(path, scale=None):
    """페이지마다 (PIL 이미지, 1m당 화소 또는 None, 층 표기, 축척 분모)를 돌려줍니다.

    축척(scale 인자 우선, 없으면 페이지 문자)을 알면 1m가 80px가 되도록 렌더링하고, 모르면 200dpi로 렌더링합니다.
    PDF 용지 크기를 원본 도면 용지로 가정합니다.
    """
    doc = pdfium.PdfDocument(str(path))
    try:
        for page in doc:
            text = page.get_textpage().get_text_range()
            s = scale or find_scale(text)
            w, h = page.get_size()  # pt
            # 용지 1pt는 실제 s·25.4/72000 m이므로 1m를 80px로 렌더링하는 배율은 80·s·25.4/72000(px/pt)입니다.
            k = cap_scale(w, h, PX_PER_M * s * 25.4 / 72000 if s else DPI / 72)
            img = page.render(scale=k).to_pil()
            yield img, (round(k * 72000 / (s * 25.4), 3) if s else None), floor_hint(text), s
    finally:
        doc.close()
