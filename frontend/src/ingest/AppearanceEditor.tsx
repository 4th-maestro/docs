import { useEffect, useRef, useState } from 'react'
import type { Plan } from '../floor-edit'
import { onNeedBuilding, onTwinReady, sendTwin, TWIN_URL, twinSrc } from '../twin'
import { resolveAppearance, type Appearance } from '../../twin/pipeline/appearance.js'
import './appearance.css'

type Props = { plan: Plan; onSave(plan: Plan): void; onBack(plan: Plan): void }
const sliders = [
  { key: 'facadeOpacity', label: '외피 불투명도', min: .1, max: .9, step: .01 },
  { key: 'roofOpacity', label: '지붕 불투명도', min: .15, max: 1, step: .01 },
  { key: 'interiorBrightness', label: '내부 밝기', min: 0, max: 1, step: .01 },
  { key: 'lighting', label: '조명 밝기', min: .55, max: 1.25, step: .01 },
  { key: 'cameraAngle', label: '첫 시점 각도', min: -180, max: 180, step: 1 },
] as const

export default function AppearanceEditor({ plan, onSave, onBack }: Props) {
  const [draft, setDraft] = useState<Partial<Appearance>>(() => plan.appearance ?? {})
  const [ready, setReady] = useState(false)
  const [slow, setSlow] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const appearance = resolveAppearance(plan.building, draft)
  const [src] = useState(() => {
    if (!TWIN_URL) return null
    const url = new URL(twinSrc('appearance-preview'))
    url.searchParams.set('appearancePreview', '1')
    url.searchParams.set('origin', window.location.origin)
    return url.href
  })

  useEffect(() => onNeedBuilding(() => frame.current, async () => plan), [plan])
  useEffect(() => onTwinReady(() => frame.current, () => setReady(true)), [])
  useEffect(() => {
    if (!src || ready) return
    const timer = setTimeout(() => setSlow(true), 10000)
    return () => clearTimeout(timer)
  }, [ready, src])
  useEffect(() => {
    if (ready) sendTwin(frame.current, { type: 'appearance', appearance: draft })
  }, [draft, ready])

  function change<Key extends keyof Appearance>(key: Key, value: Appearance[Key]) {
    setDraft(previous => ({ ...previous, [key]: value }))
  }

  return (
    <section className="card appearance-editor" aria-labelledby="appearance-heading">
      <h2 id="appearance-heading">외관 다듬기</h2>
      <div className="appearance-layout">
        <div className="appearance-preview">
          {src ? <iframe ref={frame} title="3D 외관 미리보기" src={src} /> : <p className="muted">3D 미리보기에 연결하면 조정한 외관을 확인할 수 있습니다.</p>}
          {src && !ready && <p className="muted" role="status">{slow ? '3D 미리보기가 아직 열리지 않았습니다.' : '3D 미리보기 여는 중…'}</p>}
        </div>
        <div className="appearance-controls">
          <label>외피 색상 <input type="color" value={appearance.facadeColor} onChange={e => change('facadeColor', e.target.value)} /></label>
          <label>지붕 색상 <input type="color" value={appearance.roofColor} onChange={e => change('roofColor', e.target.value)} /></label>
          {sliders.map(({ key, label, min, max, step }) => (
            <label key={key}>
              <span>{label}</span><output>{key === 'cameraAngle' ? `${appearance[key]}°` : `${Math.round(appearance[key] * 100)}%`}</output>
              <input type="range" min={min} max={max} step={step} value={appearance[key]} onChange={e => change(key, e.target.valueAsNumber)} />
            </label>
          ))}
          <button type="button" className="pill" onClick={() => setDraft({})}>자동값으로 되돌리기</button>
        </div>
      </div>
      <footer className="edit-actions">
        <button type="button" className="pill" onClick={() => onBack({ ...plan, appearance: draft })}>이전 단계</button>
        <button type="button" className="primary" onClick={() => onSave({ ...plan, appearance: draft })}>외관 확정</button>
      </footer>
    </section>
  )
}
