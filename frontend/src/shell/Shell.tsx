import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, BarChart3, Building2, CheckCircle2, ChevronDown, LayoutDashboard, LogOut, Menu, X } from 'lucide-react'
import { AUTH_ON, currentEmail, signOut } from '../auth/cognito'
import { LEVEL } from '../portfolio/level'
import type { BuildingCard } from '../types'
import './shell.css'

import { href, type FloorSummary, type Tab } from './route'

// 화면 틀: 상단바(로고, 건물 토글, 운영·전력 분석 탭, 오른쪽 도구) + 왼쪽 사이드바(전체 현황, 층) + 본문
// - 사이드바: 743px 이하에서 숨기고 상단바 메뉴 버튼으로 여닫음
export function Layout({ building, tab, buildings, tools, side, children }: {
  building: string | null; tab: Tab; buildings: BuildingCard[]; tools: ReactNode; side?: ReactNode; children: ReactNode
}) {
  const [drawer, setDrawer] = useState(false)
  // 주소(건물·층·탭) 변경 시 열린 메뉴 닫기
  useEffect(() => {
    const close = () => setDrawer(false)
    window.addEventListener('hashchange', close)
    return () => window.removeEventListener('hashchange', close)
  }, [])
  return (
    <div className="app">
      <header className="top">
        <button className="icon menu-btn" onClick={() => setDrawer(!drawer)} aria-expanded={drawer} aria-controls="side" aria-label={drawer ? '메뉴 닫기' : '메뉴 열기'}>
          {drawer ? <X size={20} /> : <Menu size={20} />}
        </button>
        <a className="brand" href="#/">Maestro</a>
        <span className="slash" aria-hidden>/</span>
        <BuildingToggle buildings={buildings} current={building} tab={tab} />
        {building && (
          <nav className="vtabs" aria-label="건물 화면">
            <a href={href(building)} aria-current={tab === 'ops' ? 'page' : undefined}><LayoutDashboard size={18} aria-hidden />운영</a>
            <a href={href(building, 'energy')} aria-current={tab === 'energy' ? 'page' : undefined}><BarChart3 size={18} aria-hidden />전력 분석</a>
          </nav>
        )}
        <div className="tools">
          {tools}
          {AUTH_ON && <UserButton />}
        </div>
      </header>
      <div className="body">
        <aside id="side" className={drawer ? 'side open' : 'side'} aria-label="이동">
          <a className={building ? 'side-link' : 'side-link on'} href="#/" aria-current={building ? undefined : 'page'} onClick={() => setDrawer(false)}>
            <LayoutDashboard size={20} aria-hidden />전체 현황
          </a>
          {side}
        </aside>
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden />}
        <div className="content">{children}</div>
      </div>
    </div>
  )
}

// 건물 토글: 로고 오른쪽, 누르면 건물 목록(상태, 현재 전력) 표시
function BuildingToggle({ buildings, current, tab }: { buildings: BuildingCard[]; current: string | null; tab: Tab }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const cur = buildings.find((b) => b.id === current)
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); box.current?.querySelector('button')?.focus() } }
    document.addEventListener('mousedown', out)
    document.addEventListener('keydown', esc)
    box.current?.querySelector<HTMLElement>('.bt-menu a')?.focus()
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc) }
  }, [open])
  const Lv = cur ? LEVEL[cur.level].Icon : Building2
  return (
    <div className="bt" ref={box}>
      <button className={`bt-btn ${cur?.level ?? ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true">
        <Lv size={18} aria-hidden />
        <span className="bt-cur">{cur?.name ?? (current ? current : '건물 선택')}</span>
        {cur && <span className="bt-lv">{LEVEL[cur.level].text(cur)}</span>}
        <ChevronDown size={18} aria-hidden />
      </button>
      {open && (
        <div className="bt-menu" role="menu" aria-label="건물 선택">
          {buildings.map((b) => {
            const { Icon, text } = LEVEL[b.level]
            return (
              <a key={b.id} role="menuitem" href={href(b.id, tab)} aria-current={b.id === current ? 'true' : undefined} onClick={() => setOpen(false)}>
                <span className="bt-name">{b.name}<small>{b.use}{b.virtual ? ', 가상 건물' : ''}</small></span>
                <span className={`bt-st ${b.level}`}><Icon size={16} aria-hidden />{text(b)}</span>
                <span className="bt-kw">{b.now.powerKw}kW</span>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 층 목록: 위층이 위(건물 단면 순서), 층마다 이상 건수와 전력 표시
export function FloorList({ floors, floor, onFloor }: { floors: FloorSummary[]; floor: string; onFloor: (f: string) => void }) {
  return (
    <nav className="floors" aria-label="층 선택">
      <h2>층</h2>
      <ol>
        {[...floors].reverse().map((f) => (
          <li key={f.floor}>
            <button className={f.floor === floor ? 'fl on' : 'fl'} aria-pressed={f.floor === floor} onClick={() => onFloor(f.floor)}>
              <span className="fl-name">{f.floor}</span>
              <span className="fl-kw">{f.powerKw}kW</span>
              <span className={f.anomaly ? 'fl-st bad' : 'fl-st'}>
                {f.anomaly ? <><AlertTriangle size={16} aria-hidden />이상 {f.anomaly}</> : <><CheckCircle2 size={16} aria-hidden />정상</>}
              </span>
              <span className="fl-on">운전 {f.on}/{f.total}대</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

function UserButton() {
  const email = currentEmail()
  return (
    <button className="user" onClick={signOut} title={email ? `${email} 로그아웃` : '로그아웃'}>
      <LogOut size={18} aria-hidden /><span>로그아웃</span>
    </button>
  )
}
