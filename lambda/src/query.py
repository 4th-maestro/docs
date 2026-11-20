"""자연어 질의 처리: Bedrock Claude 도구 호출과 단계 이벤트(POST /query, WebSocket ask 공용)

- 단계: understand(요청 해석) → query(데이터 조회) → review(결과 검토) → answer(답변 작성), 도구 없이 되묻으면 understand → answer
- emit(event): 단계가 실제로 바뀌는 시점에 호출, WebSocket은 즉시 전송하고 HTTP는 버림(결과의 steps에 기록이 남음)
"""
import json
import logging
import os
import time

from anthropic import AnthropicBedrock

import buildings
import chat
import common
import sim
import tools

# bedrock-runtime + global 추론 프로필: bedrock-mantle은 Sonnet 5.5 ID를 404로 거부(2026-11-20)
client = AnthropicBedrock(aws_region=os.environ.get('BEDROCK_REGION', 'ap-northeast-2'))
MODEL = os.environ.get('MODEL_ID', 'global.anthropic.claude-sonnet-5-5')
LABELS = {'understand': '요청 해석', 'query': '데이터 조회', 'review': '결과 검토', 'answer': '답변 작성'}
REFUSAL = '이 요청은 처리할 수 없습니다. 질문을 바꿔 다시 입력하십시오.'


def system(b, memory=None):
    """건물별 시스템 프롬프트: 도구 enum은 전체 건물 합집합이라 이 건물의 층·용도를 프롬프트로 한정

    - memory: 대화 메모리(chat.py, 1KB 이하 요약). 원문 대화 대신 이 요약만 전달해 후속 질문 해석
    """
    uses = sorted({r['use'] for r in buildings.rooms(b['id'])})
    kind = '가상 건물' if b['virtual'] else '공개 IFC 도면 건물'
    return f"""너는 건물 운영 디지털트윈의 운영 도우미다. 사용자는 건물 운영자다.
- 대상 건물: {b['name']}({b['use']}, {kind}). 다른 건물은 조회할 수 없다.
- 층 목록: {', '.join(buildings.floors(b['id']))}. 용도 목록: {', '.join(uses)}.
- 지표·상태 질문은 query_spaces, 켜기·끄기·설정온도 요청은 create_schedule 도구로 처리한다. 도구 결과에 없는 수치는 만들지 않는다.
- 대상 층이나 용도가 불분명하거나 이 건물에 없으면 도구를 쓰지 말고 후보를 들어 되묻는다.
- 스케줄은 초안이며 운영자가 화면에서 확인해야 저장된다고 안내한다. 실제 설비 제어는 하지 않는다.
- 답변은 한국어 3문장 이내로 쓰고, 마지막 문장에서 낭비를 줄일 다음 조치 1개를 제안한다.""" + (
        f"\n- 이전 대화 메모리(JSON): {json.dumps(memory, ensure_ascii=False)}\n  사용자가 '그중', '방금 것', '아까 그 층'처럼 앞 대화를 가리키면 이 메모리로 해석한다. 메모리로 정할 수 없으면 되묻는다."
        if memory else '')


def clean(text):
    """1~500자 질의문, 범위 밖이면 None"""
    text = text.strip() if isinstance(text, str) else ''
    return text if 0 < len(text) <= 500 else None


def building(value):
    """buildingId 검증: 없으면 main, 알 수 없으면 None"""
    try:
        return buildings.get(value)
    except ValueError:
        return None


def handler(event, context):
    req = common.body(event) or {}
    text, b = clean(req.get('text')), building(req.get('buildingId'))
    if not text:
        return common.resp(400, {'error': 'text는 1~500자'})
    if not b:
        return common.resp(400, {'error': f"알 수 없는 건물: {req.get('buildingId')}"})
    return common.resp(200, converse(text, lambda e: None, b['id'], chat.user(event)))


def converse(text, emit, bid, sub):
    """로그인 사용자 질의: 대화 메모리 주입, 완료 후 대화 기록과 메모리 저장(저장 실패는 응답에 영향 없음)"""
    mem = chat.get_memory(sub, bid)
    result = run(text, emit, bid, mem)
    try:
        chat.append(sub, bid, [{'role': 'user', 'text': text},
                               {'role': 'assistant', 'text': result['answer'], 'steps': result['steps'], 'highlight': result['highlight'], 'draft': result['draft']}])
        chat.put_memory(sub, bid, chat.make_memory(mem, text, result))
    except Exception:
        logging.exception('대화 기록 저장 실패')
    return result


def run(text, emit, bid=None, memory=None):
    """질의 처리 후 {answer, highlight, draft, steps} 반환. emit 예외(연결 종료)는 그대로 전파해 모델 호출 중단"""
    b = buildings.get(bid)
    prompt, t, schedules = system(b, memory), sim.now(), common.list_schedules()
    messages, ui = [{'role': 'user', 'content': text}], {'highlight': [], 'draft': None}
    trace, started, t0 = {}, {}, time.monotonic()

    def step(sid, status, **extra):
        ev = {'id': sid, 'status': status, 'label': LABELS[sid], **extra}
        if status == 'active':
            started.setdefault(sid, time.monotonic())
        elif sid in started:
            ev['ms'] = round((time.monotonic() - started.pop(sid)) * 1000)
        trace[sid] = ev
        emit({'type': 'step', **ev})

    def advance(to, **extra):
        # 도구 호출 앞에 나온 텍스트는 답변이 아니므로 기록에서 제외(화면은 query 시작 시 답변 초기화)
        if to == 'query' and started.pop('answer', None) is not None:
            trace.pop('answer', None)
        for sid in [s for s in started if s != to]:
            step(sid, 'done')
        step(to, 'active', **extra)

    def finish(answer, status='done'):
        for sid in list(started):
            step(sid, status)
        if status == 'done' and trace.get('answer', {}).get('status') != 'done':
            step('answer', 'done')
        result = {'answer': answer, **ui, 'steps': [trace[s] for s in LABELS if s in trace]}
        emit({'type': 'done', 'result': result, 'ms': round((time.monotonic() - t0) * 1000)})
        return result

    step('understand', 'active')
    for _ in range(3):
        chips = []  # 이번 라운드 도구 인자 조건(병렬 호출은 합침)
        with client.messages.stream(
            model=MODEL, max_tokens=4096, system=prompt, tools=tools.TOOLS,
            output_config={'effort': 'low'}, messages=messages,
        ) as stream:
            for ev in stream:
                if ev.type == 'text':
                    if 'answer' not in started:
                        advance('answer')
                    emit({'type': 'delta', 'text': ev.text})
                elif ev.type == 'content_block_stop' and ev.content_block.type == 'tool_use':
                    chips += [c for c in tools.chips(ev.content_block.name, ev.content_block.input) if c not in chips]
                    advance('query', chips=list(chips), detail=f'조건 {len(chips)}개를 반영하는 중입니다')
            res = stream.get_final_message()
        if res.stop_reason == 'refusal':
            return finish(REFUSAL, 'error')
        if res.stop_reason != 'tool_use':
            break
        messages.append({'role': 'assistant', 'content': res.content})
        results, found = [], set()
        for block in res.content:
            if block.type != 'tool_use':
                continue
            try:
                out, view = tools.run(block.name, block.input, t, schedules, b['id'])
                ui['highlight'] = view.get('highlight', ui['highlight'])
                ui['draft'] = view.get('draft', ui['draft'])
                found.update(view.get('highlight', []))
                results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': json.dumps(out, ensure_ascii=False)})
            except (ValueError, KeyError, TypeError) as e:
                results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': str(e), 'is_error': True})
        messages.append({'role': 'user', 'content': results})
        if all(r.get('is_error') for r in results):
            step('query', 'error', chips=list(chips), detail='조회 실패')
        else:
            step('query', 'done', chips=list(chips), detail=f'{len(found)}곳')
        step('review', 'active')
    answer = ''.join(b.text for b in res.content if b.type == 'text').strip()
    return finish(answer or '응답을 만들지 못했습니다.')
