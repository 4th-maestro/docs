"""AI 운영 도우미 평가: 도구 선택 정답 비교 + JEV 답변 판단(선택)

- 실행: AWS_PROFILE=maestro python tools/eval_ai.py [--building main] [--out eval/results.json] (lambda 폴더, anthropic 설치 필요)
- 도구 선택: eval/questions.json의 정답 도구·인자(일부 키)와 실제 첫 도구 호출을 비교. tool=null(되묻기·안내)은 스케줄 초안을 만들지 않으면 정답(조회 호출 허용, 2026-11-20 결정)
- 다중 턴: turns 목록을 대화 메모리(chat.make_memory)로 이어 실행하고 마지막 턴의 도구 호출을 비교
- JEV 판단: 환경 변수 TYPESAFE_API_KEY가 있으면 답변마다 3개 항목 판단, 확신도 0.8 미만은 사람 검토 목록
  - TypeSafe 직접 호출 POST https://api.typesafe.ai/v1/systemone, 모델 기본 jev-latest(JEV_MODEL로 변경), docs.typesafe.ai/api 기준
- 실제 Bedrock(Sonnet 5.5) 호출 비용 발생: 질문당 모델 호출 1~3회, 사용 토큰을 결과에 기록
"""
import argparse
import datetime as dt
import json
import os
import re
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
import chat  # noqa: E402
import query  # noqa: E402
import tools  # noqa: E402

REVIEW_BELOW = 0.8
JEV_URL = 'https://api.typesafe.ai/v1/systemone'
JEV_QUESTIONS = {
    'numbers': {
        'type': 'choice',
        'instructions': '답변 글의 측정값(전력, 온도, 습도, 인원, 대수, 건수, 절감량)이 도구 결과(tool_calls[].result)와 일치하는지 판단하라. 반올림과 단위 표기 차이는 일치로 본다. 층 이름, 시각, 질문에 나온 값은 측정값이 아니다.',
        'criteria': {'consistent': '답변의 측정값이 모두 도구 결과에 있음', 'inconsistent': '도구 결과와 다르거나 도구 결과에 없는 측정값이 하나 이상 있음', 'no_numbers': '답변에 측정값이 없음(되묻기, 안내 포함)'},
    },
    'clarify': {
        'type': 'choice',
        'instructions': '질문이 모호하거나 이 건물에 없는 대상을 가리킬 때 되물었는지 판단하라.',
        'criteria': {'appropriate': '필요할 때 되물었거나, 되물을 필요가 없어 바로 답함', 'missing': '모호하거나 없는 대상인데 추측해서 처리함', 'unnecessary': '명확한 질문인데 되물음'},
    },
    'clear': {
        'type': 'choice',
        'instructions': '40~50대 건물 운영자가 한 번 읽고 다음에 할 일을 알 수 있는 답변인지 판단하라. 되묻는 답변은 질문과 선택 후보가 분명하면 clear다.',
        'criteria': {'clear': '결론 또는 되묻는 질문이 분명하고 다음에 할 일(조치, 확인, 답하기)을 바로 알 수 있음', 'unclear': '결론이 흐리거나 전문 용어, 장황한 설명, 내부 판단 서술로 이해가 어려움'},
    },
}


def sentences(text):
    # 시스템 프롬프트 규칙(3문장 이내) 검사: 한글·닫는 괄호 뒤 마침표만 문장 끝("Conf. Room" 같은 영문 약어 제외)
    return len([s for s in re.split(r'(?<=[가-힣)][.?!])\s+', text.strip()) if s])


def match(expected, calls):
    # 정답 비교: 도구 이름과 정답에 적힌 인자 키만 비교(나머지 인자는 자유)
    if expected.get('noTools'):
        return not calls, '도구 없이 안내' if not calls else '불필요한 도구 호출'
    if expected['tool'] is None:
        made = [c for c in calls if c['name'] in ('create_schedule', 'operations_action')]
        return not made, '초안 없음' + (f"(조회 {len(calls)}회)" if calls else '') if not made else '불필요한 초안 생성'
    if not calls:
        return False, '도구 호출 없음'
    first = calls[0]
    if first['name'] != expected['tool']:
        return False, f"도구 불일치 {first['name']}"
    diff = [k for k, v in expected['args'].items() if first['args'].get(k) != v]
    return not diff, '일치' if not diff else f"인자 불일치 {', '.join(f'{k}={first['args'].get(k)}' for k in diff)}"


def jev(state):
    key = os.environ.get('TYPESAFE_API_KEY')
    if not key:
        return None
    body = {'model': os.environ.get('JEV_MODEL', 'jev-latest'), 'state': state, 'questions': JEV_QUESTIONS}
    req = urllib.request.Request(JEV_URL, json.dumps(body, ensure_ascii=False).encode(), {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    return {'model': data.get('model'), 'usage': data.get('usage'), **{k: {'choice': a.get('choice'), 'confidence': a.get('confidence'), 'probabilities': a.get('probabilities')} for k, a in data.get('answers', {}).items()}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--building', default='main')
    ap.add_argument('--out', default=str(ROOT / 'eval' / f"results-{dt.date.today().isoformat()}.json"))
    ap.add_argument('--only', help='질문 id 쉼표 목록')
    a = ap.parse_args()
    qs = json.loads((ROOT / 'eval' / 'questions.json').read_text())
    if a.only:
        qs = [q for q in qs if q['id'] in a.only.split(',')]
    calls, usage = [], {'input': 0, 'output': 0}
    real_run, real_create = tools.run, query.client.messages.stream

    def spy_run(name, args, *rest, **kw):
        out = real_run(name, args, *rest, **kw)
        calls.append({'name': name, 'args': dict(args), 'result': out[0] if isinstance(out, tuple) else out})
        return out

    class Spy:
        # 스트림 관리자 감싸기: with 문은 클래스의 __enter__·__exit__를 사용하므로 위임 클래스로 토큰 집계
        def __init__(self, cm):
            self.cm = cm

        def __enter__(self):
            self.s = self.cm.__enter__()
            return self.s

        def __exit__(self, *exc):
            try:
                m = self.s.get_final_message()
                usage['input'] += m.usage.input_tokens
                usage['output'] += m.usage.output_tokens
            except Exception:
                pass
            return self.cm.__exit__(*exc)

    def spy_stream(*args, **kw):
        return Spy(real_create(*args, **kw))

    query.tools.run = spy_run
    query.client.messages.stream = spy_stream
    rows = []
    for q in qs:
        texts, mem = q.get('turns') or [q['text']], None
        t0 = time.monotonic()
        for text in texts:
            calls.clear()
            try:
                res = query.run(text, lambda e: None, a.building, mem)
            except Exception as e:  # 실패도 결과로 기록
                res = {'answer': f'오류: {e}', 'charts': [], 'error': str(e)}
            history, mem = (mem or {}).get('turns', []), chat.make_memory(mem, text, res)
        ok, why = (False, '실행 오류') if res.get('error') else match(q, calls)
        row = {'id': q['id'], 'text': ' → '.join(texts), 'expected': q.get('tool'), 'calls': list(calls), 'ok': ok, 'why': why,
               'answer': res.get('answer', ''), 'charts': len(res.get('charts') or []), 'sec': round(time.monotonic() - t0, 1)}
        row['sentences'] = sentences(row['answer'])
        try:
            row['jev'] = jev({'previous_turns': history, 'question': texts[-1], 'tool_calls': row['calls'], 'answer': row['answer']})
        except Exception as e:
            row['jev'] = {'error': str(e)[:200]}
        rows.append(row)
        print(f"{q['id']} {'O' if ok else 'X'} {why:28} {row['sec']:5}s  {row['text']}", flush=True)
    passed = sum(r['ok'] for r in rows)
    review = [r['id'] for r in rows if isinstance(r.get('jev'), dict) and any(r['jev'].get(k, {}).get('confidence', 1) < REVIEW_BELOW for k in JEV_QUESTIONS)]
    summary = {'at': dt.datetime.now().isoformat(timespec='seconds'), 'model': query.MODEL, 'building': a.building, 'total': len(rows), 'passed': passed,
               'tokens': usage, 'over3Sentences': [r['id'] for r in rows if r['sentences'] > 3], 'jevReview': review}
    pathlib.Path(a.out).write_text(json.dumps({'summary': summary, 'rows': rows}, ensure_ascii=False, indent=1))
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
