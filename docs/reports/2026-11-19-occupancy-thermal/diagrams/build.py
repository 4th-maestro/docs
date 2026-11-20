# 분석 결과 수치로 도식 HTML 생성(값은 2026-11-19 분석 결과, 재현 스크립트는 docs/reports/tools/occupancy_analysis.py)
import pathlib
UCI = [(0, -0.056, 8115), (1, 0.173, 449), (2, 0.236, 727), (3, 0.230, 672)]
# 방, 용도, 최대 인원, 10명당 온도(℃) 추정·하한·상한, 1명당 냉수(kWh/5분) 추정·하한·상한
ROB = [
 ('강의실 1', 38, -0.04, -0.26, 0.09, 0.0302, 0.0164, 0.0634),
 ('강의실 2', 22, 0.74, 0.02, 1.21, 0.0134, -0.0097, 0.0395),
 ('사무실 3', 13, 0.93, 0.42, 1.44, -0.0030, -0.0108, 0.0076),
 ('사무실 4', 18, 0.07, -0.12, 0.28, -0.0029, -0.0216, 0.0153),
 ('도서관 5', 16, 0.26, -0.05, 0.55, -0.0695, -0.1298, -0.0142),
]
BLUE, INK, MUTED, GRID = '#2563EB', '#111827', '#5A6478', '#E5E7EB'
def uci_svg():
    W, H, L, B, T = 860, 300, 70, 250, 30
    y0, y1 = -0.1, 0.3
    Y = lambda v: T + (y1 - v) / (y1 - y0) * (B - T)
    s = [f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}">']
    for v in (-0.1, 0, 0.1, 0.2, 0.3):
        s.append(f'<line x1="{L}" x2="{W-20}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="{GRID if v else "#9CA3AF"}" stroke-width="1"/>')
        s.append(f'<text x="{L-8}" y="{Y(v)+4:.1f}" font-size="12" text-anchor="end" fill="{MUTED}">{v:+.1f}</text>')
    bw = 90
    for i, (c, v, n) in enumerate(UCI):
        x = L + 60 + i * 190
        y, h = (Y(v), Y(0) - Y(v)) if v >= 0 else (Y(0), Y(v) - Y(0))
        s.append(f'<rect x="{x}" y="{y:.1f}" width="{bw}" height="{h:.1f}" rx="4" fill="{BLUE if c else "#9CA3AF"}"/>')
        ly = Y(v) - 8 if v >= 0 else Y(v) + 18
        s.append(f'<text x="{x+bw/2}" y="{ly:.1f}" font-size="13" font-weight="700" text-anchor="middle" fill="{INK}">{v:+.2f}℃/h</text>')
        s.append(f'<text x="{x+bw/2}" y="{B+22}" font-size="13" text-anchor="middle" fill="{INK}">{c}명</text>')
        s.append(f'<text x="{x+bw/2}" y="{B+40}" font-size="11" text-anchor="middle" fill="{MUTED}">{c/27.6:.3f}명/㎡, n={n}</text>')
    s.append(f'<text x="{L-50}" y="{T-12}" font-size="12" fill="{MUTED}">온도 변화율(℃/시간)</text></svg>')
    return ''.join(s)
def forest(idx, lo_, hi_, ticks, unit, fmt):
    W, H, L, R, T = 420, 290, 90, 20, 20
    X = lambda v: L + (v - lo_) / (hi_ - lo_) * (W - L - R)
    s = [f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}">']
    for v in ticks:
        s.append(f'<line x1="{X(v):.1f}" x2="{X(v):.1f}" y1="{T}" y2="{T+5*44}" stroke="{"#9CA3AF" if v == 0 else GRID}" stroke-width="1"/>')
        s.append(f'<text x="{X(v):.1f}" y="{T+5*44+18}" font-size="11" text-anchor="middle" fill="{MUTED}">{fmt(v)}</text>')
    for i, r in enumerate(ROB):
        y = T + 22 + i * 44; e, lo, hi = r[idx], r[idx + 1], r[idx + 2]
        sig = lo > 0 or hi < 0
        s.append(f'<text x="{L-10}" y="{y+4}" font-size="12" text-anchor="end" fill="{INK}">{r[0]}</text>')
        s.append(f'<line x1="{X(lo):.1f}" x2="{X(hi):.1f}" y1="{y}" y2="{y}" stroke="{BLUE if sig else "#9CA3AF"}" stroke-width="2"/>')
        s.append(f'<circle cx="{X(e):.1f}" cy="{y}" r="5" fill="{BLUE if sig else "#FFFFFF"}" stroke="{BLUE if sig else "#6B7280"}" stroke-width="2"/>')
        s.append(f'<text x="{X(e):.1f}" y="{y-10}" font-size="11" text-anchor="middle" fill="{INK}">{fmt(e)}</text>')
    s.append(f'<text x="{L}" y="{H-2}" font-size="11" fill="{MUTED}">{unit}</text></svg>')
    return ''.join(s)
html = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>재실 밀도 도식</title><style>
@font-face {{ font-family: 'Pre'; src: url("../../fonts/Pretendard-Regular.ttf"); font-weight: 400; }}
@font-face {{ font-family: 'Pre'; src: url("../../fonts/Pretendard-Bold.ttf"); font-weight: 700; }}
* {{ box-sizing: border-box; }} body {{ margin: 0; padding: 24px; font-family: 'Pre', sans-serif; color: {INK}; word-break: keep-all; background: #fff; }}
section {{ width: 900px; padding: 20px; margin-bottom: 40px; background: #fff; }} svg text {{ font-family: 'Pre', sans-serif; }}
.cap {{ font-size: 12px; color: {MUTED}; margin-top: 6px; line-height: 1.5; }}
.two {{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }} .two h4 {{ margin: 0 0 4px; font-size: 13.5px; }}
.lg {{ font-size: 11.5px; color: {MUTED}; margin-top: 4px; }} .lg i {{ display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin: 0 4px -1px 10px; }}
table.m {{ width: 100%; border-collapse: separate; border-spacing: 3px; font-size: 11px; }}
table.m th {{ background: #1F3864; color: #fff; padding: 6px 5px; border-radius: 5px; font-size: 11.5px; }}
table.m td {{ padding: 5px 6px; border-radius: 5px; line-height: 1.35; text-align: center; }}
table.m td.n {{ text-align: left; font-weight: 700; background: #EEF1F7; }} table.m td.n span {{ display: block; font-weight: 400; font-size: 10px; color: {MUTED}; }}
td.y {{ background: #E3F4E8; color: #14532D; font-weight: 700; }} td.p {{ background: #FDF0DC; color: #7C3A06; }} td.u {{ background: #F1F2F4; color: #6B7280; }}
</style></head><body>
<section id="d-t-uci">{uci_svg()}<div class="cap">UCI Room Occupancy Estimation, 6×4.6m 실(27.6㎡), 공조 미사용, 2017-12~2018-01. 같은 재실 인원이 이어진 30초 간격 구간의 평균 온도 변화율. 시각·일사 미통제</div></section>
<section id="d-t-robod"><div class="two">
<div><h4>재실 10명당 실내온도 변화(℃)</h4>{forest(2, -0.4, 1.5, [-0.25, 0, 0.5, 1.0, 1.5], '95% 구간, 외기온도·시각 통제', lambda v: f"{v:+.2f}")}</div>
<div><h4>재실 1명당 냉수 에너지 변화(kWh/5분)</h4>{forest(5, -0.13, 0.07, [-0.1, -0.05, 0, 0.05], '95% 구간, 외기온도·시각 통제', lambda v: f"{v:+.3f}")}</div></div>
<div class="lg"><i style="background:{BLUE}"></i>0을 포함하지 않음(유의)<i style="background:#fff;border:2px solid #6B7280"></i>0 포함(유의하지 않음)</div>
<div class="cap">ROBOD(싱가포르 NUS, 2021-09~12, 5분 간격), 08~20시, 회귀식: 실내온도 또는 냉수 에너지 ~ 재실 인원 + 외기온도 + 시각. 95% 구간은 일 단위 블록 부트스트랩 200회(시드 0). 강의실 2 온도와 도서관 5 냉수는 구간 경계가 0에 가까워 재실행 시 판정이 바뀔 수 있음. 방 면적 미확인으로 ㎡당 환산 불가</div></section>
<section id="d-t-datasets"><table class="m">
<tr><th>데이터셋</th><th>재실 인원</th><th>실 면적</th><th>실내온도</th><th>공조·설정</th><th>체감 투표</th><th>공개</th></tr>
<tr><td class="n">ROBOD(2022)<span>싱가포르, 5실, 29~47일</span></td><td class="y">인원 수</td><td class="u">미확인</td><td class="y">5분</td><td class="y">설정온도, 냉수</td><td class="u">없음</td><td class="y">CC BY 4.0</td></tr>
<tr><td class="n">Schwee 외(2019)<span>북유럽, 3실, 44일</span></td><td class="y">카메라 계수</td><td class="u">미확인</td><td class="y">있음</td><td class="p">VAV 댐퍼</td><td class="u">없음</td><td class="p">공개, 조건 미확인</td></tr>
<tr><td class="n">UCI 재실 추정(2018)<span>1실, 0~3명</span></td><td class="y">인원 수</td><td class="y">27.6㎡</td><td class="y">센서 4개</td><td class="u">공조 없음</td><td class="u">없음</td><td class="y">CC BY 4.0</td></tr>
<tr><td class="n">LBNL Building 59(2022)<span>미국 사무 2개 층</span></td><td class="y">카메라·Wi-Fi</td><td class="p">층 단위</td><td class="y">구역별</td><td class="y">HVAC 운전</td><td class="u">없음</td><td class="p">공개, 조건 미확인</td></tr>
<tr><td class="n">ASHRAE 재실 행동 DB(2022)<span>34개 연구, 15개국</span></td><td class="p">재실·인원(연구별)</td><td class="u">연구별</td><td class="y">있음</td><td class="p">연구별</td><td class="u">없음</td><td class="y">공개</td></tr>
<tr><td class="n">ASHRAE 열쾌적 DB II<span>109,033행</span></td><td class="u">밀도 항목 미확인</td><td class="u">미확인</td><td class="y">있음</td><td class="p">냉방 방식</td><td class="y">-3~+3 투표</td><td class="y">공개</td></tr>
<tr><td class="n">볼로냐 캠퍼스(2026)<span>강의실·실험실</span></td><td class="u">미확인</td><td class="u">미확인</td><td class="y">있음</td><td class="u">미확인</td><td class="y">학생 응답</td><td class="y">Zenodo</td></tr>
<tr><td class="n">En-Gage(2022)<span>고등학교 4주</span></td><td class="u">미확인</td><td class="u">미확인</td><td class="y">있음</td><td class="u">미확인</td><td class="y">설문</td><td class="y">공개</td></tr>
<tr><td class="n">Reading 대학 사무실<span>1인실·개방형</span></td><td class="p">실 유형</td><td class="u">미확인</td><td class="y">공기·흑구</td><td class="y">공조</td><td class="y">투표</td><td class="p">공개, 조건 미확인</td></tr>
</table><div class="cap">초록: 확인, 주황: 부분·간접, 회색: 공개 자료에서 확인 못 함. 기준일 2026-11-19</div></section>
</body></html>'''
pathlib.Path(__file__).with_name('diagrams.html').write_text(html)
