// pipeline-core.js 중 앱(src)에서 쓰는 함수의 형식
type EstimatedUnit = { id: string; ctrlAddr: string; room: string; model: string; type: string; coolKw: number; ratedKw: number; pos: [number, number]; odu: string; source: string; basis: string }
export function placeIdus(floors: unknown[], src: Record<string, unknown>, W: number): { idus: EstimatedUnit[]; odus: unknown[]; warn: string[] }
