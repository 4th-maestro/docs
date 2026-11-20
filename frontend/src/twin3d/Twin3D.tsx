import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Grid2x2, RotateCcw } from 'lucide-react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { ANOMALY, SCALES, color, value } from '../heat'
import type { Mode, Room } from '../types'
import './twin3d.css'

type Pt = [number, number]
// public/floorplan.json 형식(IFC 평면 좌표, m)
type Plan = { floors: Record<string, { bounds: [number, number, number, number]; rooms: { id: string; polys: Pt[][]; hvac: Pt[] }[] }> }
type Props = { floor: string; mode: Mode; rooms: Room[]; highlight: string[]; selectedId: string | null; onSelect: (id: string) => void }
type RoomObj = {
  id: string
  mesh: THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshLambertMaterial>
  edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>
  marker: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshLambertMaterial>
  bad: boolean
}
type Shared = {
  edge: THREE.LineBasicMaterial; edgeDim: THREE.LineBasicMaterial
  on: THREE.MeshLambertMaterial; off: THREE.MeshLambertMaterial; bad: THREE.MeshLambertMaterial
  marker: THREE.CylinderGeometry
}
type Ctx = { canvas: HTMLCanvasElement; scene: THREE.Scene; shared: Shared; rooms: RoomObj[]; selected: RoomObj | null; radius: number; top: boolean; view: (top: boolean) => void; request: () => void }
type Hover = { id: string; x: number; y: number; left: boolean; up: boolean }

// 표시 치수(m)
// - 호실: 높이 0.6, 질의 결과 강조 시 0.6 상승
// - HVAC 표시: 호실 윗면에서 0.5 위
const H = 0.6
const RAISE = 0.6
const MARK_Y = H + 0.5
const MAX_POLAR = 1.35 // 약 77도, 바닥 아래로 회전 차단
// WebGL 재질 색: 재질은 CSS 변수를 읽지 못하므로 index.css 토큰 값을 사용
const INK = '#222222'
// 선택 외곽선: 디자인 시스템 표 6.1 기준 primary
const PRIMARY = '#ff385c'
const OFF = '#c1c1c1'
const NO_DATA = '#dddddd'
const CANVAS = '#ffffff'
const WHITE = new THREE.Color(CANVAS)

const mean = (pts: Pt[]): Pt => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]

// 다각형 면적 중심: HVAC 위치가 없는 호실의 표시 위치
function centroid(polys: Pt[][]): Pt {
  let a = 0
  let cx = 0
  let cy = 0
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i]
      const [x1, y1] = p[(i + 1) % p.length]
      const k = x0 * y1 - x1 * y0
      a += k
      cx += (x0 + x1) * k
      cy += (y0 + y1) * k
    }
  }
  return [cx / (3 * a), cy / (3 * a)]
}

export default function Twin3D({ floor, mode, rooms, highlight, selectedId, onSelect }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<Ctx | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [failed, setFailed] = useState(false)
  const [noGL, setNoGL] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)
  const [top, setTop] = useState(false)
  const select = useEffectEvent((id: string) => onSelect(id))

  useEffect(() => {
    fetch('/floorplan.json')
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<Plan>
      })
      .then(setPlan)
      .catch(() => setFailed(true))
  }, [])

  // 렌더러, 카메라, 조작, 입력 이벤트: 마운트 1회
  useEffect(() => {
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      // WebGL 지원 여부: 컨텍스트 생성 시점에만 확인 가능
      // oxlint-disable-next-line react/set-state-in-effect
      setNoGL(true)
      return
    }
    const stage = stageRef.current!
    const canvas = renderer.domElement
    canvas.setAttribute('role', 'img')
    stage.append(canvas)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // shortcut: 동작 줄이기 설정은 마운트 시점 값만 반영, 실행 중 변경 대응이 필요하면 change 이벤트 구독
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const scene = new THREE.Scene()
    // 반구광 세기 π
    // - 윗면: Lambert 반사가 재질 색과 같아 범례 색 그대로 표시
    // - 옆면: 바닥색 쪽으로 어두워져 높이 구분
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a9a, Math.PI))
    const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 2000)
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = !reduced
    controls.dampingFactor = 0.1
    controls.minDistance = 8

    const shared: Shared = {
      edge: new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.45 }),
      edgeDim: new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.12 }),
      on: new THREE.MeshLambertMaterial({ color: INK }),
      off: new THREE.MeshLambertMaterial({ color: OFF }),
      bad: new THREE.MeshLambertMaterial({ color: ANOMALY }),
      marker: new THREE.CylinderGeometry(0.35, 0.35, 0.18, 24),
    }

    let raf = 0
    let alive = true
    const v = new THREE.Vector3()
    const request = () => {
      if (alive && !raf) raf = requestAnimationFrame(frame)
    }
    const frame = (t: number) => {
      raf = 0
      const moving = controls.update()
      let pulsing = false
      for (const o of ctx.rooms) {
        if (!o.bad || reduced) continue
        o.marker.scale.setScalar(1.15 + 0.15 * Math.sin(t / 300))
        pulsing = true
      }
      renderer.render(scene, camera)
      const label = labelRef.current
      const sel = ctx.selected
      if (label) {
        if (sel) {
          sel.marker.getWorldPosition(v)
          v.y += 0.6
          v.project(camera)
        }
        const show = sel && v.z < 1
        label.style.display = show ? 'block' : 'none'
        if (show) label.style.transform = `translate(${((v.x + 1) / 2) * canvas.clientWidth}px, ${((1 - v.y) / 2) * canvas.clientHeight}px) translate(-50%, -100%)`
      }
      if (moving || pulsing) request()
    }
    controls.addEventListener('change', request)

    // 층 경계 대각선이 화면 짧은 쪽 화각에 들어오는 거리로 배치
    const view = (topView: boolean) => {
      ctx.top = topView
      const fov = THREE.MathUtils.degToRad(camera.fov) / 2
      const half = Math.min(fov, Math.atan(Math.tan(fov) * camera.aspect))
      // 구도: 경계 구는 사선 시점에서 과대 추정이라 tan 기준으로 축소(사선 0.86, 위 0.9)
      const dist = (ctx.radius / Math.tan(half)) * (topView ? 0.9 : 0.86)
      controls.target.set(0, 0, 0)
      camera.position.setFromSphericalCoords(dist, topView ? 0 : 0.95, topView ? 0 : Math.PI / 4)
      controls.maxPolarAngle = topView ? 0 : MAX_POLAR
      controls.enableRotate = !topView
      controls.mouseButtons.LEFT = topView ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
      controls.touches.ONE = topView ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE
      controls.maxDistance = dist * 2.5
      controls.update()
      request()
    }
    const ctx: Ctx = { canvas, scene, shared, rooms: [], selected: null, radius: 30, top: false, view, request }
    ctxRef.current = ctx

    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const pick = (e: MouseEvent): Hover | null => {
      const r = canvas.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      ray.setFromCamera(ndc.set((x / r.width) * 2 - 1, 1 - (y / r.height) * 2), camera)
      const hit = ray.intersectObjects(ctx.rooms.map((o) => o.mesh), false)[0]
      return hit ? { id: hit.object.userData.id as string, x, y, left: x > r.width * 0.6, up: y > r.height * 0.6 } : null
    }
    let down = { x: 0, y: 0 }
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY } })
    canvas.addEventListener('pointermove', (e) => {
      const h = e.buttons ? null : pick(e)
      canvas.style.cursor = h ? 'pointer' : ''
      setHover(h)
    })
    canvas.addEventListener('pointerleave', () => setHover(null))
    canvas.addEventListener('click', (e) => {
      // 회전·이동 드래그 직후의 click은 선택에서 제외
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return
      const h = pick(e)
      if (h) select(h.id)
    })

    const ro = new ResizeObserver(() => {
      const w = stage.clientWidth
      const h = stage.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      request()
    })
    ro.observe(stage)

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      Object.values(shared).forEach((s) => s.dispose())
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
      ctxRef.current = null
    }
  }, [])

  // 층 형상: plan, floor 변경 시에만 재생성
  useEffect(() => {
    const ctx = ctxRef.current
    const data = plan?.floors[floor]
    if (!ctx || !data) return
    const [x0, y0, x1, y1] = data.bounds
    const group = new THREE.Group()
    // 좌표 변환: 평면 (x, y) → 월드 (x, 높이, -y), 층 경계 중심을 원점에 배치
    group.position.set(-(x0 + x1) / 2, 0, (y0 + y1) / 2)
    const plate = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 4, 0.3, y1 - y0 + 4), new THREE.MeshLambertMaterial({ color: CANVAS }))
    plate.position.set((x0 + x1) / 2, -0.15, -(y0 + y1) / 2)
    group.add(plate)

    const objs: RoomObj[] = data.rooms.map((room) => {
      const shapes = room.polys.map((p) => new THREE.Shape(p.map(([x, y]) => new THREE.Vector2(x, y))))
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: H, bevelEnabled: false }).rotateX(-Math.PI / 2)
      // polygonOffset: 면을 깊이 방향으로 밀어 같은 위치의 테두리 선 깜빡임 방지
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }))
      mesh.userData.id = room.id
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), ctx.shared.edge)
      const [ax, ay] = room.hvac.length ? mean(room.hvac) : centroid(room.polys)
      const marker = new THREE.Mesh(ctx.shared.marker, ctx.shared.off)
      marker.position.set(ax, MARK_Y, -ay)
      mesh.add(edges, marker)
      group.add(mesh)
      return { id: room.id, mesh, edges, marker, bad: false }
    })
    ctx.rooms = objs
    ctx.scene.add(group)
    ctx.radius = Math.hypot(x1 - x0, y1 - y0) / 2
    ctx.view(ctx.top)

    return () => {
      ctx.scene.remove(group)
      plate.geometry.dispose()
      plate.material.dispose()
      for (const o of objs) {
        o.mesh.geometry.dispose()
        o.mesh.material.dispose()
        o.edges.geometry.dispose()
      }
      ctx.rooms = []
    }
  }, [plan, floor])

  // 상태 색, 강조, HVAC 표시: 5초 갱신마다 재질만 변경
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const byId = new Map(rooms.map((r) => [r.id, r]))
    const hot = new Set(highlight)
    ctx.rooms.forEach((o) => {
      const r = byId.get(o.id)
      const dim = hot.size > 0 && !hot.has(o.id)
      o.mesh.material.color.set(r ? color(mode, r) : NO_DATA)
      if (dim) o.mesh.material.color.lerp(WHITE, 0.65)
      o.mesh.position.y = hot.has(o.id) ? RAISE : 0
      o.edges.material = dim ? ctx.shared.edgeDim : ctx.shared.edge
      o.bad = !!r?.anomaly
      o.marker.material = o.bad ? ctx.shared.bad : r?.onOff ? ctx.shared.on : ctx.shared.off
      o.marker.scale.setScalar(1)
    })
    ctx.request()
  }, [plan, floor, rooms, mode, highlight])

  // 선택 호실: 굵은 외곽선, 이름 라벨 위치는 렌더 루프에서 갱신
  useEffect(() => {
    const ctx = ctxRef.current
    const o = ctx?.rooms.find((r) => r.id === selectedId)
    if (!ctx || !o) return
    const line = new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(o.edges.geometry), new LineMaterial({ color: PRIMARY, linewidth: 3 }))
    o.mesh.add(line)
    ctx.selected = o
    ctx.request()
    return () => {
      o.mesh.remove(line)
      line.geometry.dispose()
      line.material.dispose()
      ctx.selected = null
      ctx.request()
    }
  }, [plan, floor, selectedId])

  const count = plan?.floors[floor]?.rooms.length ?? 0
  useEffect(() => {
    ctxRef.current?.canvas.setAttribute('aria-label', `${floor} 3D 도면, 호실 ${count}곳입니다.`)
  }, [floor, count])

  const msg = noGL ? '3D 도면을 표시할 수 없습니다. WebGL을 지원하는 브라우저가 필요합니다.'
    : failed ? '도면 데이터를 불러오지 못했습니다.'
    : !plan ? '도면을 불러오는 중입니다.'
    : !plan.floors[floor] ? `${floor} 도면 데이터가 없습니다.`
    : ''
  const hovered = hover && rooms.find((r) => r.id === hover.id)
  const selName = rooms.find((r) => r.id === selectedId)?.name ?? ''

  return (
    <div className="t3">
      <div ref={stageRef} className="t3-stage" />
      {selName && <div ref={labelRef} className="t3-label">{selName}</div>}
      {hover && (
        <div className="t3-tip" style={{ left: hover.x, top: hover.y, transform: `translate(${hover.left ? 'calc(-100% - 12px)' : '12px'}, ${hover.up ? 'calc(-100% - 12px)' : '12px'})` }}>
          {hovered ? (
            <>
              <strong>{hovered.name}</strong>
              <span>HVAC {hovered.idu}, {hovered.onOff ? '운전' : '정지'}</span>
              <span>{mode === 'anomaly' ? value(mode, hovered) : `${SCALES[mode].label} ${value(mode, hovered)}`}</span>
              <span>재실 {hovered.occupants}명</span>
            </>
          ) : <span>상태 데이터 없음</span>}
        </div>
      )}
      {!noGL && (
        <div className="t3-tools">
          <button type="button" aria-label="시점 초기화" title="시점 초기화" onClick={() => { setTop(false); ctxRef.current?.view(false) }}>
            <RotateCcw size={18} aria-hidden />
          </button>
          <button type="button" aria-label="위에서 보기" title="위에서 보기" aria-pressed={top} onClick={() => { setTop(!top); ctxRef.current?.view(!top) }}>
            <Grid2x2 size={18} aria-hidden />
          </button>
        </div>
      )}
      {msg && <p className="t3-msg">{msg}</p>}
    </div>
  )
}
