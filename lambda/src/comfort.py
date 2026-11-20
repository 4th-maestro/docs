"""쾌적 지표 계산: 기상청 불쾌지수, ISO 7730 PMV·PPD

- 불쾌지수 DI = 0.81T + 0.01RH(0.99T - 14.3) + 46.3, 단계 경계는 기상청 기준(docs/human/explanation/research/kb-sources.md)
- PMV·PPD는 ISO 7730 부속서 D의 반복 계산을 옮긴 식. 외부 패키지 없음
- 가상 데이터라 평균복사온도는 실내온도와 같다고 가정
"""
import math

DI_STAGES = ((80, '매우 높음'), (75, '높음'), (68, '보통'), (float('-inf'), '낮음'))


def discomfort_index(t, rh):
    return round(0.81 * t + 0.01 * rh * (0.99 * t - 14.3) + 46.3, 1)


def di_stage(di):
    return next(name for low, name in DI_STAGES if di >= low)


def pmv_ppd(ta, tr, vr, rh, met, clo, wme=0.0):
    """ta·tr ℃, vr m/s, rh %, met, clo. 반환 (PMV, PPD%)"""
    pa = rh * 10 * math.exp(16.6536 - 4030.183 / (ta + 235))  # 수증기 분압 Pa
    icl, m, w = 0.155 * clo, met * 58.15, wme * 58.15
    mw = m - w
    fcl = 1 + 1.29 * icl if icl <= 0.078 else 1.05 + 0.645 * icl
    hcf = 12.1 * math.sqrt(vr)
    taa, tra = ta + 273, tr + 273
    tcla = taa + (35.5 - ta) / (3.5 * icl + 0.1)
    p1 = icl * fcl
    p2, p3, p4 = p1 * 3.96, p1 * 100, p1 * taa
    p5 = 308.7 - 0.028 * mw + p2 * (tra / 100) ** 4
    xn, xf, hc = tcla / 100, tcla / 50, hcf
    for _ in range(150):  # 의복 표면온도 반복 계산, ISO 7730 수렴 기준 0.00015
        if abs(xn - xf) <= 0.00015:
            break
        xf = (xf + xn) / 2
        hc = max(hcf, 2.38 * abs(100 * xf - taa) ** 0.25)
        xn = (p5 + p4 * hc - p2 * xf ** 4) / (100 + p3 * hc)
    else:
        raise ValueError('PMV 계산 수렴 실패')
    tcl = 100 * xn - 273
    hl = (3.05e-3 * (5733 - 6.99 * mw - pa) + (0.42 * (mw - 58.15) if mw > 58.15 else 0) + 1.7e-5 * m * (5867 - pa)
          + 0.0014 * m * (34 - ta) + 3.96 * fcl * (xn ** 4 - (tra / 100) ** 4) + fcl * hc * (tcl - ta))
    pmv = (0.303 * math.exp(-0.036 * m) + 0.028) * (mw - hl)
    ppd = 100 - 95 * math.exp(-0.03353 * pmv ** 4 - 0.2179 * pmv ** 2)
    return round(pmv, 2), round(ppd, 1)
