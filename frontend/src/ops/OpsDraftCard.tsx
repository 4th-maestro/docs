import { useRef, useState } from 'react'
import { actOps, HAS_API } from '../api'
import type { OpsDraft } from './types'
import { executeDraft } from './actions'

const LABEL = { accept: '수락', reject: '거절', undo: '되돌리기' }

export default function OpsDraftCard({ draft, active, result, onDone }: { draft: OpsDraft; active: boolean; result?: string; onDone: (notice: string) => void }) {
  const [state, setState] = useState<'pending' | 'running' | 'done' | 'closed'>(result ? 'done' : 'pending')
  const [notice, setNotice] = useState(result ?? '')
  const locked = useRef(false)
  async function execute() {
    if (locked.current || !active || state !== 'pending') return
    locked.current = true
    setState('running')
    const { success, conflict, failed, errors } = await executeDraft(draft, actOps)
    const summary = `성공 ${success}건, 이미 처리됨(409) ${conflict}건, 실패 ${failed}건${errors.length ? `: ${errors.join(', ')}` : ''}`
    setNotice(summary)
    setState('done')
    onDone(summary)
  }
  return (
    <div className="draft" aria-label="자동 운영 초안">
      <h3>자동 운영 {LABEL[draft.action]} 초안</h3>
      <p>대상 {draft.decisionIds.length}건: {draft.rooms.join(', ')}</p>
      {state === 'pending' && active && <>
        <p className="draft-note">실행을 누르면 위 대상에 {LABEL[draft.action]}을 요청합니다.</p>
        <div className="btns">
          <button className="secondary" onClick={() => { setState('closed'); onDone('취소한 초안입니다.') }}>취소</button>
          <button className="primary" disabled={!HAS_API} onClick={execute}>실행</button>
        </div>
        {!HAS_API && <p>서버 연결 후 실행할 수 있습니다.</p>}
      </>}
      {state === 'running' && <p role="status">처리 중입니다.</p>}
      {(state === 'closed' || (!active && state === 'pending')) && <p>닫힌 초안입니다. 필요하면 다시 요청하세요.</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
