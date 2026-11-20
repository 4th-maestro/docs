import { placeIdus } from '../../twin/pipeline/pipeline-core.js'
import type { IndoorUnit, Plan } from '../floor-edit.ts'
import { connectOdus, typeFields } from './units.ts'

// 실내기가 없는 실(type room)에 면적 추정 실내기(40㎡당 1대, 트윈 파이프라인 placeIdus 규칙)를 넣고 실외기에 연결. 추정 실내기는 확인 필요(review)
// - floors: 대상 층 id(기본 전체). 위치를 맞추지 않은 인식 결과가 남은 층은 제외(위치 맞춤 후 인식 결과가 실내기가 됨)
// - pipeline-core.js(약 80KB)는 앱 첫 화면에 필요 없어 이 파일을 동적 import로 불러옴
export function autoUnits(plan: Plan, floors?: string[]): { plan: Plan; added: number } {
  const has = new Set(plan.idus.map(u => u.room))
  const target = plan.floors.filter(f => (!floors || floors.includes(f.id)) && !f.detections?.length)
    .map(f => ({ ...f, rooms: f.rooms.filter(r => r.type === 'room' && !has.has(r.id)) }))
  // 제어 주소(ctrlAddr)는 층마다 00부터 다시 매겨 기존 실내기와 겹칠 수 있어 넣지 않음
  // 추정 용량으로 모델을 대응(exact, nearest). kwSource는 비움(용량 출처는 source estimate)
  const est: IndoorUnit[] = placeIdus(target, {}, plan.building.size.w).idus.map(u => ({
    id: u.id, room: u.room, pos: u.pos, coolKw: u.coolKw, ratedKw: u.ratedKw, odu: u.odu, source: u.source, basis: u.basis,
    ...typeFields(/1WAY/.test(u.type) ? 'cassette_1way' : 'cassette_4way', u.coolKw), review: true,
  }))
  return { plan: connectOdus({ ...plan, idus: [...plan.idus, ...est] }), added: est.length }
}
