import { useEffect, useState } from 'react'
import { Info, Trash2 } from 'lucide-react'
import { buildingsChanged, customOf, removeCustom, setRendered } from './custom'
import { onBuildingRendered, pipelineSrc } from './twin'


// 건물 추가: 도면 이미지를 넣고 트윈 파이프라인에서 '트윈에서 렌더링'을 누르기 전까지는 데이터를 만들지 않음
export default function AddBuilding({ id }: { id: string }) {
  const c = customOf(id)
  const src = pipelineSrc()
  const [error, setError] = useState('')
  useEffect(() => onBuildingRendered((b) => {
    if (setRendered(id, b)) buildingsChanged()
    else setError('도면을 저장하지 못했습니다(브라우저 저장 공간 부족).')
  }), [id])
  return (
    <main className="add-bd">
      <div className="add-head">
        <h1>{c?.name ?? '새 건물'} 추가</h1>
        <button className="ghost" onClick={() => { removeCustom(id); buildingsChanged(); location.hash = '#/' }}><Trash2 size={16} aria-hidden />추가 취소</button>
      </div>
      <div className="banner" role="note">
        <Info size={16} aria-hidden />
        <span>도면 이미지를 넣고 실을 인식한 뒤 오른쪽 아래 <b>트윈에서 렌더링</b>을 누르면 그때부터 이 건물의 운전 데이터가 만들어집니다. 그 전에는 데이터를 만들지 않습니다.</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {src ? <iframe className="add-pipe" src={src} title="트윈 파이프라인(도면 → 3D)" /> : <p className="error">3D 트윈 주소(VITE_TWIN_URL)가 없어 도면을 넣을 수 없습니다.</p>}
    </main>
  )
}
