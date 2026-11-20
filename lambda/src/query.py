"""자연어 질의 처리: Bedrock Claude 도구 호출과 단계 이벤트(POST /query, WebSocket ask 공용)

- 단계: understand(요청 해석) → query(데이터 조회) → review(결과 검토) → answer(답변 작성), 도구 없이 되묻으면 understand → answer
- emit(event): 단계가 실제로 바뀌는 시점에 호출, WebSocket은 즉시 전송하고 HTTP는 버림(결과의 steps에 기록이 남음)
"""
import json
import logging
import os
import re
import time

from anthropic import AnthropicBedrock

import buildings
import chat
import common
import sim
import tenant
import tools

# bedrock-runtime + global 추론 프로필: bedrock-mantle은 Sonnet 5.5 ID를 404로 거부(2026-11-20)
client = AnthropicBedrock(aws_region=os.environ.get('BEDROCK_REGION', 'ap-northeast-2'))
MODEL = os.environ.get('MODEL_ID', 'global.anthropic.claude-sonnet-5-5')
LABELS = {'understand': '요청 해석', 'query': '데이터 조회', 'review': '결과 검토', 'answer': '답변 작성'}
REFUSAL = '이 요청은 처리할 수 없습니다. 질문을 바꿔 다시 입력하십시오.'
# 구조화 응답: 결론·근거·조치 3칸, 칸마다 첫 문장만 표시해 3문장 이하 보장(2026-11-20, 프롬프트 지침만으로는 35문항 중 3~12건 초과)
# - 스키마의 글자 수 제한(maxLength)은 API 미지원이라 문장 수만 서버에서 강제
FIELDS = ('conclusion', 'detail', 'action')
ANSWER_FORMAT = {'type': 'json_schema', 'schema': {
    'type': 'object', 'additionalProperties': False, 'required': list(FIELDS),
    'properties': {
        'conclusion': {'type': 'string', 'description': '결론과 핵심 수치 1~2개, 1문장. 되묻기면 질문 1문장'},
        'detail': {'type': 'string', 'description': '근거나 해석 1문장. 되묻기면 선택 후보. 없으면 빈 문자열'},
        'action': {'type': 'string', 'description': '낭비를 줄일 다음 조치 1문장. 되묻기, 인사, 안내면 빈 문자열'},
    }}}
_FIELD = re.compile(r'"(conclusion|detail|action)"\s*:\s*"((?:[^"\\]|\\.)*)')
_SENTENCE_END = re.compile(r'(?<=[가-힣)\]%][.?!])\s')


# 층 미지정 제어 요청 검증: 범위(전체, 모든 층, 재실 0곳 등)를 말하지 않았는데 전체 층 초안을 요청하면 실행하지 않고 되묻게 함
# - 프롬프트 지침만으로는 구조화 응답에서 층 추정 초안 발생(7차 평가 q22), 사용자 결정(2026-11-20 층 미지정은 되묻기)을 서버에서 강제
SCOPE = re.compile(r'전체|모든|모두|전\s?층|재실\s?0|재실이?\s?없는')
FLOOR_ASK = '층을 말하지 않은 제어 요청입니다. 초안을 만들지 말고 층 후보를 들어 되물으십시오.'


def floor_given(text, memory):
    """사용자가 전체 범위를 밝혔는지: 이번 질문, 직전 2턴 질문, 직전 초안(전체 층)"""
    m = memory or {}
    recent = [x.get('q', '') for x in (m.get('turns') or [])[-2:]]
    return any(SCOPE.search(q) for q in [text, *recent]) or (m.get('draft') or {}).get('floor') == 'all'


def _unescape(raw):
    # 스트리밍 중 잘린 이스케이프(\, \u00) 제거 후 JSON 문자열로 해석
    raw = re.sub(r'\\(u[0-9a-fA-F]{0,3})?$', '', raw)
    try:
        return json.loads(f'"{raw}"')
    except ValueError:
        return raw


def render(text):
    """구조화 응답(완성 또는 스트리밍 중 부분 JSON) → 칸마다 첫 문장, 줄바꿈으로 연결"""
    vals = {k: _unescape(v).strip() for k, v in _FIELD.findall(text)}
    lines = [vals[k][:m.start()] if (m := _SENTENCE_END.search(vals[k])) else vals[k] for k in FIELDS if vals.get(k)]
    return '\n'.join(x.strip() for x in lines if x.strip())


def system(b, memory=None, t=None):
    """건물별 시스템 프롬프트: 도구 enum은 전체 건물 합집합이라 이 건물의 층·용도를 프롬프트로 한정

    - memory: 대화 메모리(chat.py, 최근 10턴 요약). 원문 대화 대신 이 요약만 전달해 후속 질문 해석
    - t: 현재 시각(sim.now). 없으면 모델이 시각을 추측하거나 운영자에게 HH:MM 형식을 요구(2026-11-20 제보)
    """
    t = t or sim.now()
    uses = sorted({r['use'] for r in buildings.rooms(b['id'])})
    kind = '가상 건물' if b['virtual'] else '공개 IFC 도면 건물'
    return f"""너는 건물 운영 디지털트윈의 운영 도우미다. 사용자는 건물 운영자다.
- 대상 건물: {b['name']}({b['use']}, {kind}). 다른 건물은 조회할 수 없다.
- 현재 시각: {t:%Y-%m-%d}({'월화수목금토일'[t.weekday()]}) {t:%H:%M}. '지금', '현재', '바로'나 시각을 말하지 않은 제어 요청은 이 시각을 time으로 쓰고 답변에 적용 시각을 밝힌다. '3시 반', '오후 6시'처럼 말한 시각은 HH:MM으로 바꿔 쓰고, 사용자에게 시각 형식을 요구하지 않는다.
- 층 목록: {', '.join(buildings.floors(b['id']))}. 용도 목록: {', '.join(uses)}.
- 호실 지표 순위는 query_spaces, 층·용도별 합계·비교는 aggregate_spaces, 기간 전력 추이·이전 기간 비교는 energy_trend, 켜기·끄기·설정온도 요청은 create_schedule, 불쾌지수·PMV·쾌적도는 comfort_index, 냉난방 기준 온도·규정·쾌적 지표 정의 질문은 search_documents 도구로 처리한다. 도구 결과에 없는 수치는 만들지 않는다. 문서의 규정을 인용할 때는 문서명과 시행일을 함께 쓰고, 문서에 없는 기준은 만들지 않는다.
- 화면이 도구 결과로 그래프와 표를 자동으로 그린다. 답변에 수치 목록을 길게 나열하지 말고 핵심 수치 1~2개와 해석만 쓴다. 사용자가 표를 원하면 view=table, 그 외에는 view=auto로 호출한다.
- 대상 층이나 용도가 불분명하거나 이 건물에 없으면 도구를 쓰지 말고 후보를 들어 되묻는다. 시각과 달리 제어 요청의 층은 추정하지 않는다. 층을 말하지 않은 제어 요청('전체', '모든 층', '재실 0곳인 곳'처럼 범위를 밝힌 경우 제외)은 초안을 만들지 말고 층을 되묻는다. 되물을 때는 판단 이유나 지침을 쓰지 말고 질문 1문장과 후보만 쓴다.
- 스케줄 저장 방법과 실제 설비 미제어 안내는 화면의 초안 카드가 표시하므로 답변에 쓰지 않는다. 실제 설비 제어는 하지 않는다.
- 답변은 JSON 3칸(conclusion, detail, action)으로 쓰고 칸마다 한국어 1문장이다. conclusion은 결론과 핵심 수치 1~2개, detail은 근거나 해석, action은 낭비를 줄일 다음 조치 1개다. 되묻기는 conclusion에 질문, detail에 후보를 쓰고 action은 비운다. 인사와 사용 안내는 action을 비운다. 호실 이름은 2개까지만 쓰고 나머지는 '외 N곳'으로 줄인다(전체 목록은 화면 그래프와 표가 표시). 다음 조치에 이유 문장을 덧붙이지 않는다.""" + (
        f"\n- 이전 대화 메모리(JSON): {json.dumps(memory, ensure_ascii=False)}\n  turns는 최근 대화(오래된 순, 질문 q와 답변 a 앞부분)다. 사용자가 '그중', '방금 것', '아까 그 층'처럼 앞 대화를 가리키면 이 메모리로 해석한다. 직전 답변이 되물은 경우 사용자의 짧은 답(시각, 층, 용도)은 그 되묻기의 답이므로 처음 요청과 합쳐 처리한다. draft가 있으면 '15:30', '2층으로'처럼 짧은 답은 그 초안의 해당 값만 바꿔 create_schedule을 다시 호출한다. 메모리로 정할 수 없으면 되묻는다."
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
    try:
        tenant.require_building(event, b['id'])
    except tenant.Forbidden as e:
        return common.resp(403, e.body())
    return common.resp(200, converse(text, lambda e: None, b['id'], chat.user(event)))


def converse(text, emit, bid, sub):
    """로그인 사용자 질의: 대화 메모리 주입, 완료 후 대화 기록과 메모리 저장(저장 실패는 응답에 영향 없음)"""
    mem = chat.get_memory(sub, bid)
    result = run(text, emit, bid, mem)
    if not sub:
        return result  # 로그인 정보 없음(로컬 테스트): 기록·메모리 저장 생략
    try:
        chat.append(sub, bid, [{'role': 'user', 'text': text},
                               {'role': 'assistant', 'text': result['answer'], 'steps': result['steps'], 'highlight': result['highlight'], 'draft': result['draft'], 'charts': result.get('charts', []), 'sources': result.get('sources', [])}])
        chat.put_memory(sub, bid, chat.make_memory(mem, text, result))
    except Exception:
        logging.exception('대화 기록 저장 실패')
    return result


def run(text, emit, bid=None, memory=None):
    """질의 처리 후 {answer, highlight, draft, steps} 반환. emit 예외(연결 종료)는 그대로 전파해 모델 호출 중단"""
    b = buildings.get(bid)
    t, schedules = sim.now(), common.list_schedules()
    prompt = system(b, memory, t)
    messages, ui = [{'role': 'user', 'content': text}], {'highlight': [], 'draft': None, 'charts': [], 'sources': []}
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
    for _ in range(4):  # 문서 검색 후 계산 도구까지 4회
        chips = []  # 이번 라운드 도구 인자 조건(병렬 호출은 합침)
        with client.messages.stream(
            model=MODEL, max_tokens=4096, system=prompt, tools=tools.definitions(),
            output_config={'effort': 'low', 'format': ANSWER_FORMAT}, messages=messages,
        ) as stream:
            buf, shown = '', ''  # 라운드별 부분 JSON, 화면에 보낸 칸 텍스트
            for ev in stream:
                if ev.type == 'text':
                    if 'answer' not in started:
                        advance('answer')
                    buf += ev.text
                    now_text = render(buf)
                    if len(now_text) > len(shown) and now_text.startswith(shown):  # 칸 순서가 바뀌면 done에서 교체
                        emit({'type': 'delta', 'text': now_text[len(shown):]})
                        shown = now_text
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
        asked_floor = False
        for block in res.content:
            if block.type != 'tool_use':
                continue
            if block.name == 'create_schedule' and block.input.get('floor') == 'all' and not floor_given(text, memory):
                results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': FLOOR_ASK, 'is_error': True})
                asked_floor = True
                continue
            try:
                out, view = tools.run(block.name, block.input, t, schedules, b['id'])
                ui['highlight'] = view.get('highlight', ui['highlight'])
                ui['draft'] = view.get('draft', ui['draft'])
                if view.get('chart'):
                    ui['charts'].append(view['chart'])
                ui['sources'] += [x for x in view.get('sources', []) if x not in ui['sources']]
                found.update(view.get('highlight', []))
                results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': json.dumps(out, ensure_ascii=False)})
            except (ValueError, KeyError, TypeError) as e:
                results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': str(e), 'is_error': True})
        messages.append({'role': 'user', 'content': results})
        if asked_floor and all(r.get('is_error') for r in results):
            step('query', 'done', chips=list(chips), detail='층 확인 필요')
        elif all(r.get('is_error') for r in results):
            step('query', 'error', chips=list(chips), detail='조회 실패')
        else:
            step('query', 'done', chips=list(chips), detail=f'{len(found)}곳')
        step('review', 'active')
    answer = render(''.join(b.text for b in res.content if b.type == 'text'))
    return finish(answer or '응답을 만들지 못했습니다.')
