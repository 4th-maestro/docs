// 웹(TypeScript)에서 comfort.js를 쓸 때의 형식
export type Comfort = { pmv: number; ppd: number; met: number; clo: number; vel: number; grade: string | null }
export const MET: Record<string, number>
export function cloOf(month: number): number
export function pmvPpd(ta: number, tr: number, vel: number, rh: number, met: number, clo: number, wme?: number): { pmv: number; ppd: number } | null
export function pmvLabel(v: number | null | undefined): string
export function gradeOf(v: number | null | undefined): string | null
export function roomComfort(room: { temp: number; hum?: number; kind?: string; on?: boolean }, month: number): Comfort | null
