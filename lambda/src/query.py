"""POST /query: 자연어 질의를 Bedrock Claude 도구 호출로 해석해 조회 결과·스케줄 초안 반환"""
import json
import os

from anthropic import AnthropicBedrock

import common
import sim
import tools

# bedrock-runtime + global 추론 프로필: bedrock-mantle은 Sonnet 5.5 ID를 404로 거부(2026-11-20)
client = AnthropicBedrock(aws_region=os.environ.get('BEDROCK_REGION', 'ap-northeast-2'))
MODEL = os.environ.get('MODEL_ID', 'global.anthropic.claude-sonnet-5-5')
SYSTEM = f"""너는 건물 운영 디지털트윈의 운영 도우미다. 사용자는 건물 운영자다.
- 층 목록: {', '.join(tools.FLOORS)}. 용도 목록: {', '.join(tools.USES)}.
- 지표·상태 질문은 query_spaces, 켜기·끄기·설정온도 요청은 create_schedule 도구로 처리한다. 도구 결과에 없는 수치는 만들지 않는다.
- 대상 층이나 용도가 불분명하면 도구를 쓰지 말고 후보를 들어 되묻는다.
- 스케줄은 초안이며 운영자가 화면에서 확인해야 저장된다고 안내한다. 실제 설비 제어는 하지 않는다.
- 답변은 한국어 3문장 이내로 쓰고, 마지막 문장에서 낭비를 줄일 다음 조치 1개를 제안한다."""


def handler(event, context):
    req = common.body(event)
    text = (req or {}).get('text', '').strip()
    if not text or len(text) > 500:
        return common.resp(400, {'error': 'text는 1~500자'})
    t, schedules = sim.now(), common.list_schedules()
    messages, ui = [{'role': 'user', 'content': text}], {'highlight': [], 'draft': None}
    for _ in range(3):
        res = client.messages.create(
            model=MODEL, max_tokens=4096, system=SYSTEM, tools=tools.TOOLS,
            output_config={'effort': 'low'}, messages=messages,
        )
        if res.stop_reason == 'refusal':
            return common.resp(200, {'answer': '이 요청은 처리할 수 없습니다. 질문을 바꿔 다시 입력하십시오.', **ui})
        if res.stop_reason != 'tool_use':
            break
        messages.append({'role': 'assistant', 'content': res.content})
        results = []
        for block in res.content:
            if block.type != 'tool_use':
                continue
            try:
                out, view = tools.run(block.name, block.input, t, schedules)
                ui['highlight'] = view.get('highlight', ui['highlight'])
                ui['draft'] = view.get('draft', ui['draft'])
                results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': json.dumps(out, ensure_ascii=False)})
            except (ValueError, KeyError, TypeError) as e:
                results.append({'type': 'tool_result', 'tool_use_id': block.id, 'content': str(e), 'is_error': True})
        messages.append({'role': 'user', 'content': results})
    answer = ''.join(b.text for b in res.content if b.type == 'text').strip()
    return common.resp(200, {'answer': answer or '응답을 만들지 못했습니다.', **ui})
