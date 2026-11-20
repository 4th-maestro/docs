# 추출 결과 시각화: 1층 평면(호실·공조 단말), 2개 층 등각 투영(가상 전력 사용량 색)
# - 실행: python ifc_render.py <추출 JSON> <출력 폴더>
# - 의존성: Pillow, shapely
import json, math, random, sys, pathlib
from PIL import Image, ImageDraw, ImageFont
D = json.load(open(sys.argv[1]))
F = str(pathlib.Path(__file__).resolve().parent.parent / 'fonts') + '/'
fb = lambda n: ImageFont.truetype(F + 'Pretendard-Bold.ttf', n); fr = lambda n: ImageFont.truetype(F + 'Pretendard-Regular.ttf', n)
OUT = sys.argv[2].rstrip('/') + '/'
conf = lambda n: any(k in n.upper() for k in ['CONF', 'MEETING', 'LOUNGE', 'BREAK'])
# 1층 평면
sp1 = [s for s in D['spaces'] if s['storey'] == 'First Floor']
xs = [p[0] for s in sp1 for r in s['coords'] for p in r]; ys = [p[1] for s in sp1 for r in s['coords'] for p in r]
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
W, pad, top = 1800, 40, 110
k = (W - 2 * pad) / (x1 - x0); H = int((y1 - y0) * k) + top + 90
im = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(im)
T = lambda x, y: (pad + (x - x0) * k, top + (y1 - y) * k)
for s in sp1:
    for r in s['coords']:
        d.polygon([T(*p) for p in r], fill='#DBEAFE' if conf(s['name']) else '#EEF1F7', outline='#4B5563')
z1 = min(s['z'] for s in sp1)
n = 0
for t in D['terms']:
    if z1 - 0.5 <= t['z'] <= z1 + 4.5 and x0 <= t['x'] <= x1 and y0 <= t['y'] <= y1:
        x, y = T(t['x'], t['y']); c = '#B45309' if t.get('space') else '#B91C1C'
        d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=c); n += 1
d.text((pad, 24), '의원 건물 1층: IFC에서 자동 추출한 호실 154개와 공조 단말', font=fb(34), fill='#111827')
d.text((pad, 68), f'파란 칸 회의실·휴게실, 주황 점 호실에 매핑된 공조 단말({n}개), 빨간 점 미매핑', font=fr(24), fill='#4B5563')
d.text((pad, H - 50), '자료: BSI(2020) Medical-Dental Test Files, buildingSMART International(CC BY 4.0), Maestro 팀 추출', font=fr(22), fill='#6B7280')
im.save(OUT + 'r-ifc-plan1.png'); print('plan', im.size, n)
# 2개 층 등각 투영, 호실 색 = 가상 전력 사용량
random.seed(7)
from shapely.geometry import Polygon as P2
sps = [s for s in D['spaces'] if s['storey'] in ('First Floor', 'Second Floor') and s['name'].upper() != 'ROOF']
print('iso rooms', len(sps), sum(s['storey'] == 'First Floor' for s in sps), sum(s['storey'] == 'Second Floor' for s in sps))
pw = {s['gid']: (random.random() ** 1.6) * (1.8 if conf(s['name']) else 1) for s in sps}
mx = max(pw.values())
pal = ['#440154', '#3B528B', '#21918C', '#5EC962', '#FDE725']
def col(v):
    v = min(0.999, v / mx) * (len(pal) - 1); i = int(v); f = v - i
    a = tuple(int(pal[i][j:j + 2], 16) for j in (1, 3, 5)); b = tuple(int(pal[i + 1][j:j + 2], 16) for j in (1, 3, 5))
    return tuple(int(a[q] + (b[q] - a[q]) * f) for q in range(3))
W2, H2 = 1800, 1020
im = Image.new('RGB', (W2, H2), 'white'); d = ImageDraw.Draw(im)
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
sc = 9.0
def iso(x, y, z):
    X = (x - cx) - (y - cy); Y = ((x - cx) + (y - cy)) * 0.5
    return (W2 / 2 + X * sc * 0.72, 640 + Y * sc * 0.72 - z * sc * 9)
for fl, lift in (('First Floor', 0), ('Second Floor', 1)):
    ss = [s for s in sps if s['storey'] == fl]
    ss.sort(key=lambda s: -(sum(p[0] + p[1] for p in s['coords'][0]) / len(s['coords'][0])))
    for s in ss:
        for r in s['coords']:
            d.polygon([iso(p[0], p[1], lift * 4.2) for p in r], fill=col(pw[s['gid']]), outline='#FFFFFF')
    lx, ly = iso(x0, y1, lift * 4.2)
    d.text((360, 520 - lift * 330), '2층' if lift else '1층', font=fb(36), fill='#111827')
d.text((40, 24), '층별 3D와 호실 상태 표시: 가상 전력 사용량', font=fb(34), fill='#111827')
d.text((40, 68), '호실 261개(1층 154, 2층 107, 옥상층 제외), 색은 가상 데이터 예시이며 실제 측정값 아님', font=fr(24), fill='#4B5563')
for i, c in enumerate(pal):
    d.rectangle([40 + i * 70, H2 - 110, 40 + i * 70 + 66, H2 - 86], fill=c)
d.text((40, H2 - 78), '낮음', font=fr(22), fill='#4B5563'); d.text((40 + 4 * 70 + 20, H2 - 78), '높음(kW, 가상)', font=fr(22), fill='#4B5563')
d.text((40, H2 - 44), '자료: BSI(2020) Medical-Dental Test Files(CC BY 4.0) 형상, 색은 Maestro 팀 가상 데이터', font=fr(22), fill='#6B7280')
im.save(OUT + 'r-ifc-iso.png'); print('iso', im.size)
