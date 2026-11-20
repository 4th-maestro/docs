"""논문·보고서 PDF 핵심 문장 강조 캡처

- 입력: argv[1] JSON 파일(목록), argv[2] 출력 폴더, argv[3] PDF 내려받기 폴더
- 항목: {"id", "url", "marks": [문장...], "ctx": 위아래 여백 pt(기본 40), "page": 쪽 번호(선택)}
- 처리: pdftotext -bbox로 단어 좌표 확인, 첫 문장이 있는 쪽을 200dpi로 렌더링, 노란 강조 후 주변 영역 저장
- 의존성: poppler(pdftotext, pdftoppm), Pillow
"""
import html
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

from PIL import Image, ImageDraw

DPI = 200
WORD = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>')


def norm(s):
    return re.sub(r'[^0-9a-z가-힣%$]', '', s.lower())


def find(words, phrase):
    # 단어를 이어 붙인 정규화 문자열에서 문장 위치를 찾고 단어 범위로 변환
    joined, owner = '', []
    for i, w in enumerate(words):
        n = norm(w[4])
        joined += n
        owner += [i] * len(n)
    k = joined.find(norm(phrase))
    if k < 0:
        return None
    return owner[k], owner[k + len(norm(phrase)) - 1]


def main():
    targets = json.loads(pathlib.Path(sys.argv[1]).read_text())
    out, tmp = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
    tmp.mkdir(parents=True, exist_ok=True)
    for t in targets:
        pdf = tmp / f"{t['id']}.pdf"
        if not pdf.exists():
            req = urllib.request.Request(t['url'], headers={'User-Agent': 'Mozilla/5.0'})
            pdf.write_bytes(urllib.request.urlopen(req, timeout=60).read())
        info = subprocess.run(['pdfinfo', str(pdf)], capture_output=True, text=True).stdout
        count = int(re.search(r'Pages:\s+(\d+)', info).group(1))
        hit = None
        for pi in range(count):
            if t.get('page') and pi + 1 != t['page']:
                continue
            # 쪽 단위 추출: 일부 PDF는 전체 추출 시 pdftotext가 비정상 종료
            pg = subprocess.run(['pdftotext', '-bbox', '-f', str(pi + 1), '-l', str(pi + 1), str(pdf), '-'], capture_output=True, text=True).stdout
            words = [(float(a), float(b), float(c), float(d), html.unescape(e)) for a, b, c, d, e in WORD.findall(pg)]
            spans = [find(words, m) for m in t['marks']]
            if spans[0]:
                hit = (pi, words, [s for s in spans if s])
                break
        if not hit:
            print(f"miss {t['id']}: {t['marks'][0][:40]}")
            continue
        pi, words, spans = hit
        missing = len(t['marks']) - len(spans)
        png = tmp / f"{t['id']}-p{pi + 1}"
        subprocess.run(['pdftoppm', '-f', str(pi + 1), '-l', str(pi + 1), '-r', str(DPI), '-png', '-singlefile', str(pdf), str(png)], check=True)
        img = Image.open(f'{png}.png').convert('RGBA')
        s = DPI / 72
        layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        marked = [words[i] for a, b in spans for i in range(a, b + 1)]
        for x0, y0, x1, y1, _ in marked:
            draw.rectangle([x0 * s - 1, y0 * s - 1, x1 * s + 1, y1 * s + 1], fill=(255, 221, 0, 110))
        img = Image.alpha_composite(img, layer).convert('RGB')
        ctx = t.get('ctx', 40)
        top = min(w[1] for w in marked) - ctx
        bottom = max(w[3] for w in marked) + ctx
        near = [w for w in words if w[1] >= top and w[3] <= bottom] or marked
        # 영역 안에 온전히 들어온 줄만 남겨 위아래 줄 잘림 방지
        top = min(w[1] for w in near) - 1
        bottom = max(w[3] for w in near) + 1.5
        left = min(w[0] for w in near) - 12
        right = max(w[2] for w in near) + 12
        box = [max(0, int(v * s)) for v in (left, top, right, bottom)]
        img.crop(box).save(out / f"{t['id']}.png")
        print(f"ok {t['id']} p{pi + 1}" + (f' (문장 {missing}개 미발견)' if missing else ''))


if __name__ == '__main__':
    main()
