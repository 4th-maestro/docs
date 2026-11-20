import { AlertTriangle, CheckCircle2, TrendingDown } from 'lucide-react'
import type { BuildingCard, Level } from '../types'

// 건물 상태 표시: 색·아이콘·글자 병행(디자인 시스템 1절), 전체 현황 카드와 상단 건물 토글 공용
export const LEVEL: Record<Level, { Icon: typeof AlertTriangle; text: (b: BuildingCard) => string }> = {
  alert: { Icon: AlertTriangle, text: (b) => `이상 ${b.now.anomaly}건` },
  warn: { Icon: TrendingDown, text: () => '절감 검토' },
  ok: { Icon: CheckCircle2, text: () => '정상' },
}
