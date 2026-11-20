import { useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, AlertTriangle, BarChart3, Briefcase, Building2, CheckCircle2, ChevronDown, FlaskConical, LayoutDashboard, LogOut, Menu, Settings, X } from 'lucide-react'
import { AUTH_ON, currentEmail, isAdmin, signOut } from '../auth/cognito'
import { MeContext, ROLE } from '../auth/me'
import { LEVEL } from '../portfolio/level'
import type { BuildingCard } from '../types'
import logo from '../../assets/ege.svg'
import './shell.css'

import { href, type FloorSummary, type Tab } from './route'
import { Sk } from '../skeleton/Skeleton'
import CountUp from '../motion/CountUp'

// 화면 틀: 상단바(로고, 건물 토글, 운영·전력 분석·시뮬레이션 탭, 오른쪽 도구) + 왼쪽 사이드바(전체 현황, 층) + 본문
// - 사이드바: 743px 이하에서 숨기고 상단바 메뉴 버튼으로 여닫음
export function Layout({ building, tab, buildings, tools, side, admin, settings, children }: {
  building: string | null; tab: Tab; buildings: BuildingCard[]; tools: ReactNode; side?: ReactNode; admin?: boolean; settings?: boolean; children: ReactNode
}) {
  const [drawer, setDrawer] = useState(false)
  const me = useContext(MeContext)
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
        <a className="brand" href="#/" aria-label="에게(에너지게이트) 전체 현황"><img src={logo} alt="" /></a>
        <span className="slash" aria-hidden>/</span>
        <BuildingToggle buildings={buildings} current={building} tab={tab} />
        {building && (
          <nav className="vtabs" aria-label="건물 화면">
            <a href={href(building)} aria-current={tab === 'ops' ? 'page' : undefined}><LayoutDashboard size={18} aria-hidden />운영</a>
            <a href={href(building, 'energy')} aria-current={tab === 'energy' ? 'page' : undefined}><BarChart3 size={18} aria-hidden />전력 분석</a>
            <a href={href(building, 'sim')} aria-current={tab === 'sim' ? 'page' : undefined}><FlaskConical size={18} aria-hidden />시뮬레이션</a>
          </nav>
        )}
        <div className="tools">
          {tools}
          {AUTH_ON && <UserButton />}
        </div>
      </header>
      <div className="body">
        <aside id="side" className={drawer ? 'side open' : 'side'} aria-label="이동">
          <a className={building || admin || settings ? 'side-link' : 'side-link on'} href="#/" aria-current={building || admin || settings ? undefined : 'page'} onClick={() => setDrawer(false)}>
            <LayoutDashboard size={20} aria-hidden />전체 현황
          </a>
          {side}
          {AUTH_ON && (
            <div className="side-foot">
              {/* 고객사 소속: GET /me의 기업 이름과 역할 */}
              {me?.company && (
                <p className="side-me">
                  <Building2 size={20} aria-hidden />
                  <span>{me.company.name}<small>{me.role ? ROLE[me.role] : ''}</small></span>
                </p>
              )}
              {/* 고객사 기업 정보(조회 전용): 판매사 관리자는 기업 관리 사용 */}
              {me?.company && me.role !== 'admin' && (
                <a className={settings ? 'side-link on' : 'side-link'} href="#/settings" aria-current={settings ? 'page' : undefined} onClick={() => setDrawer(false)}>
                  <Settings size={20} aria-hidden />기업 정보
                </a>
              )}
              {/* 관리자 메뉴: 표시는 GET /me 역할(응답 전에는 ID 토큰 그룹) 기준, 권한은 admin API가 판정 */}
              {(me ? me.role === 'admin' : isAdmin()) && (
                <a className={admin ? 'side-link on' : 'side-link'} href="#/admin" aria-current={admin ? 'page' : undefined} onClick={() => setDrawer(false)}>
                  <Briefcase size={20} aria-hidden />기업 관리
                </a>
              )}
            </div>
          )}
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
        <span className="bt-cur">{cur?.name ?? (current && !buildings.length ? <Sk w={56} h={18} /> : current ?? '건물 선택')}</span>
        {cur && <span className="bt-lv">{LEVEL[cur.level].text(cur)}</span>}
        <ChevronDown size={18} aria-hidden />
      </button>
      {open && (
        <div className="bt-menu fade-in" role="menu" aria-label="건물 선택">
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

// 층 목록: 한 줄 행(층, kW, 상태), 위층이 위(건물 단면 순서), 맨 위 전체(건물 보기)
// - 전체 행: 층 값 '', 전력·이상·주의 건수는 층 합계. all이 false면 숨김
// - 상태: 설비 이상(실내기 에러, 설정온도 미도달)은 "이상 N"(빨강), 쾌적도·습도·빈 방 운전 같은 주의만 있으면 "주의 N"(주황), 없으면 "정상"
//   둘 다 있으면 이상을 표시하고 두 건수는 title과 화면 낭독 문구로 제공
export function FloorList({ floors, floor, all, onFloor }: { floors: FloorSummary[]; floor: string; all?: boolean; onFloor: (f: string) => void }) {
  const total = { floor: '', powerKw: Math.round(floors.reduce((s, f) => s + f.powerKw, 0) * 10) / 10, anomaly: floors.reduce((s, f) => s + f.anomaly, 0), caution: floors.reduce((s, f) => s + (f.caution ?? 0), 0) }
  return (
    <nav className="floors" aria-label="층 선택">
      <h2>층</h2>
      <ol>
        {[...(all ? [total] : []), ...[...floors].reverse()].map((f) => {
          const caution = f.caution ?? 0, st = f.anomaly ? 'bad' : caution ? 'warn' : 'ok'
          const detail = [f.anomaly ? `이상 ${f.anomaly}건` : '', caution ? `주의 ${caution}건` : ''].filter(Boolean).join(', ') || '정상'
          return (
            <li key={f.floor || 'all'}>
              <button className={f.floor === floor ? 'fl on' : 'fl'} aria-pressed={f.floor === floor} onClick={() => onFloor(f.floor)} title={detail} aria-label={`${f.floor || '전체'}, ${f.powerKw}kW, ${detail}`}>
                <span className="fl-name">{f.floor || '전체'}</span>
                <span className="fl-kw"><CountUp value={f.powerKw} />kW</span>
                <span className={st === 'ok' ? 'fl-st' : `fl-st ${st}`}>
                  {/* 상태가 바뀔 때만 아이콘 다시 등장(key) */}
                  <span key={st} className="pop-in">{st === 'bad' ? <AlertTriangle size={16} aria-hidden /> : st === 'warn' ? <AlertCircle size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}</span>
                  {st === 'bad' ? `이상 ${f.anomaly}` : st === 'warn' ? `주의 ${caution}` : '정상'}
                </span>
              </button>
            </li>
          )
        })}
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
