"""AI 운영 도우미 평가: 도구 선택 정답 비교 + JEV 답변 판단(선택)

- 실행: AWS_PROFILE=maestro python tools/eval_ai.py [--building main] [--out eval/results.json] (lambda 폴더, anthropic 설치 필요)
- 도구 선택: eval/questions.json의 정답 도구·인자(일부 키)와 실제 첫 도구 호출을 비교. tool=null은 도구 호출 없음이 정답
- JEV 판단: 환경 변수 JEV_URL, JEV_KEY, JEV_MODEL이 모두 있으면 답변마다 3개 항목 판단, 확신도 0.8 미만은 사람 검토 목록
  - 요청 형식 {model, state, questions}(DigitalOcean·AIML API 문서 기준), JEV_STYLE=cloudflare면 state·questions를 input 아래에 둠
- 실제 Bedrock(Sonnet 5.5) 호출 비용 발생: 질문당 모델 호출 1~3회, 사용 토큰을 결과에 기록
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
import query  # noqa: E402
import tools  # noqa: E402

REVIEW_BELOW = 0.8
JEV_QUESTIONS = {
    'numbers': {
        'type': 'choice',
        'instructions': '답변 글의 수치가 도구 결과(tool_results)와 일치하는지 판단하라. 도구 결과에 없는 수치를 만들었으면 inconsistent.',
        'criteria': {'consistent': '답변의 모든 수치가 도구 결과에 있음', 'inconsistent': '도구 결과와 다르거나 없는 수치가 하나 이상 있음', 'no_numbers': '답변에 수치가 없음'},
    },
    'clarify': {
        'type': 'choice',
        'instructions': '질문이 모호하거나 이 건물에 없는 대상을 가리킬 때 되물었는지 판단하라.',
        'criteria': {'appropriate': '필요할 때 되물었거나, 되물을 필요가 없어 바로 답함', 'missing': '모호하거나 없는 대상인데 추측해서 처리함', 'unnecessary': '명확한 질문인데 되물음'},
    },
    'clear': {
        'type': 'choice',
        'instructions': '40~50대 건물 운영자가 한 번 읽고 다음 행동을 알 수 있는 답변인지 판단하라.',
        'criteria': {'clear': '핵심 결론과 다음 조치가 분명함', 'unclear': '결론이 흐리거나 전문 용어·장황한 설명으로 이해가 어려움'},
    },
}


def match(expected, calls):
    # 정답 비교: 도구 이름과 정답에 적힌 인자 키만 비교(나머지 인자는 자유)
    if expected['tool'] is None:
        return not calls, '도구 호출 없음' if not calls else f"불필요한 호출 {calls[0]['name']}"
    if not calls:
        return False, '도구 호출 없음'
    first = calls[0]
    if first['name'] != expected['tool']:
        return False, f"도구 불일치 {first['name']}"
    diff = [k for k, v in expected['args'].items() if first['args'].get(k) != v]
    return not diff, '일치' if not diff else f"인자 불일치 {', '.join(f'{k}={first['args'].get(k)}' for k in diff)}"


def jev(state):
    url, key, model = (os.environ.get(k) for k in ('JEV_URL', 'JEV_KEY', 'JEV_MODEL'))
    if not (url and key and model):
        return None
    body = {'state': state, 'questions': JEV_QUESTIONS}
    body = {'model': model, 'input': body} if os.environ.get('JEV_STYLE') == 'cloudflare' else {'model': model, **body}
    req = urllib.request.Request(url, json.dumps(body, ensure_ascii=False).encode(), {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    answers = (data.get('result') or data).get('answers', {})
    return {k: {'choice': a.get('choice'), 'confidence': a.get('confidence')} for k, a in answers.items()}


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
        calls.append({'name': name, 'args': dict(args)})
        return real_run(name, args, *rest, **kw)

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
        calls.clear()
        t0 = time.monotonic()
        try:
            res = query.run(q['text'], lambda e: None, a.building)
        except Exception as e:  # 실패도 결과로 기록
            res = {'answer': f'오류: {e}', 'charts': []}
        ok, why = match(q, calls)
        row = {'id': q['id'], 'text': q['text'], 'expected': q.get('tool'), 'calls': list(calls), 'ok': ok, 'why': why,
               'answer': res.get('answer', ''), 'charts': len(res.get('charts') or []), 'sec': round(time.monotonic() - t0, 1)}
        try:
            row['jev'] = jev({'question': q['text'], 'tool_calls': row['calls'], 'tool_results': res.get('charts'), 'answer': row['answer']})
        except Exception as e:
            row['jev'] = {'error': str(e)[:200]}
        rows.append(row)
        print(f"{q['id']} {'O' if ok else 'X'} {why:28} {row['sec']:5}s  {q['text']}", flush=True)
    passed = sum(r['ok'] for r in rows)
    review = [r['id'] for r in rows if isinstance(r.get('jev'), dict) and any(isinstance(v, dict) and (v.get('confidence') or 0) < REVIEW_BELOW for v in r['jev'].values())]
    summary = {'at': dt.datetime.now().isoformat(timespec='seconds'), 'model': query.MODEL, 'building': a.building, 'total': len(rows), 'passed': passed,
               'tokens': usage, 'jevReview': review}
    pathlib.Path(a.out).write_text(json.dumps({'summary': summary, 'rows': rows}, ensure_ascii=False, indent=1))
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
