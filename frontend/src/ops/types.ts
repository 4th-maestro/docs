// 자동 운영(maestro-ops 스택, Lambda infra/ops/README.md) 응답 형식
export type OpsSettings = { buildingId: string; autoApply: boolean; updatedAt: string | null; updatedBy: string | null }
export type OpsStatus = 'pending' | 'applied' | 'accepted' | 'rejected' | 'reverted' | 'expired' | 'alert'
export type OpsFacts = { inOperatingHours?: boolean; minutesSinceClose?: number; idleOnMinutes?: number; lastOccupiedAt?: string }
export type Decision = {
  decisionId: string
  kind: 'idle' | 'anomaly'
  status: OpsStatus
  roomId: string; roomName: string; floor: string; use: string
  message: string
  createdAt: string; expiresAt?: string; decidedAt?: string; decidedBy?: string
  scheduleId?: string
  autoApply?: boolean
  jev?: { choice: 'empty' | 'occupied' | 'uncertain'; confidence: number; probabilities?: Record<string, number> } | null
  evidence?: { recent?: unknown[]; facts?: OpsFacts; temp?: number; setpoint?: number }
}
export type OpsOverview = { settings: OpsSettings; decisions: Decision[]; pendingCount: number; mock?: boolean }
export type OpsAction = 'accept' | 'reject' | 'undo'
