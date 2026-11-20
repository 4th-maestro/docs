import type { OpsAction, OpsDraft } from './types'

// 한 건이 실패해도 나머지는 처리하고, 각 요청의 결과를 구분한다.
export async function executeDraft(draft: OpsDraft, submit: (building: string, id: string, action: OpsAction) => Promise<unknown>) {
  let success = 0, conflict = 0, failed = 0
  const errors = new Set<string>()
  for (const id of new Set(draft.decisionIds)) {
    try {
      await submit(draft.buildingId, id, draft.action)
      success++
    } catch (e) {
      if ((e as { status?: number } | null)?.status === 409) conflict++
      else { failed++; errors.add(e instanceof Error ? e.message : '요청 실패') }
    }
  }
  return { success, conflict, failed, errors: [...errors] }
}
