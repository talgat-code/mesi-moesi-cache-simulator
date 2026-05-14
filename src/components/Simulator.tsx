'use client'

import { useReducer, useRef, useCallback, useEffect } from 'react'
import type { SimState, CoreState, MemEntry, Packet, LogEntry } from '@/types'
import { SIM_STEPS, INITIAL_MEM, BX, ML, MY, CY, CR } from '@/steps'
import styles from './Simulator.module.css'

// ─── Initial state ────────────────────────────────────────────────────────────
const makeCore = (id: number): CoreState => ({
  id,
  isActive: false,
  isSnooping: false,
  currentOp: null,
  cache: [
    { index: 0, address: null, data: 0, state: 'I', flash: false },
    { index: 1, address: null, data: 0, state: 'I', flash: false },
  ],
})

const makeMemory = (): MemEntry[] =>
  INITIAL_MEM.map(([address, data]) => ({
    address,
    data,
    label: `0x${address.toString(16).toUpperCase()}`,
    flash: false,
  }))

const INIT: SimState = {
  stepIndex: 0,
  cores: [0, 1, 2, 3].map(makeCore),
  memory: makeMemory(),
  packets: [],
  log: [],
  isPlaying: false,
  isAnimating: false,
  speed: 1,
  memActive: false,
}

// ─── Reducer ──────────────────────────────────────────────────────────────────
type Action =
  | { type: 'SET_ACTIVE_CORE'; id: number | null }
  | { type: 'SET_SNOOP_CORES'; ids: number[] }
  | { type: 'ADD_PKT'; pkt: Packet }
  | { type: 'MOVE_PKT'; id: string; x: number; y: number }
  | { type: 'DEL_PKT'; id: string }
  | { type: 'APPLY_CHANGES'; stepIdx: number }
  | { type: 'ADD_LOGS'; entries: LogEntry[] }
  | { type: 'CLEAR_ANIM' }
  | { type: 'SET_ANIMATING'; v: boolean }
  | { type: 'SET_PLAYING'; v: boolean }
  | { type: 'SET_MEM_ACTIVE'; v: boolean }
  | { type: 'SET_SPEED'; v: number }
  | { type: 'RESET' }
  | { type: 'STEP_TO'; idx: number }

function reducer(state: SimState, action: Action): SimState {
  switch (action.type) {
    case 'SET_ACTIVE_CORE':
      return {
        ...state,
        cores: state.cores.map(c => ({
          ...c,
          isActive: c.id === action.id,
          isSnooping: false,
        })),
      }
    case 'SET_SNOOP_CORES':
      return {
        ...state,
        cores: state.cores.map(c => ({
          ...c,
          isSnooping: action.ids.includes(c.id),
        })),
      }
    case 'ADD_PKT':
      return { ...state, packets: [...state.packets, action.pkt] }
    case 'MOVE_PKT':
      return {
        ...state,
        packets: state.packets.map(p =>
          p.id === action.id ? { ...p, x: action.x, y: action.y } : p
        ),
      }
    case 'DEL_PKT':
      return { ...state, packets: state.packets.filter(p => p.id !== action.id) }
    case 'APPLY_CHANGES': {
      const step = SIM_STEPS[action.stepIdx]
      if (!step) return state
      let cores = state.cores.map(c => ({
        ...c,
        cache: c.cache.map(line => ({ ...line, flash: false })),
      }))
      for (const ch of step.cacheChanges) {
        cores = cores.map(c =>
          c.id === ch.coreId
            ? {
                ...c,
                cache: c.cache.map(line =>
                  line.index === ch.lineIndex
                    ? { ...line, state: ch.state, address: ch.address, data: ch.data, flash: true }
                    : line
                ),
              }
            : c
        )
      }
      let memory = state.memory
      if (step.memChange) {
        const mc = step.memChange
        memory = state.memory.map(m =>
          m.address === mc.address ? { ...m, data: mc.data, flash: true } : m
        )
      }
      return { ...state, cores, memory }
    }
    case 'ADD_LOGS': {
      const next = [...state.log, ...action.entries].slice(-40)
      return { ...state, log: next }
    }
    case 'CLEAR_ANIM':
      return {
        ...state,
        packets: [],
        cores: state.cores.map(c => ({
          ...c,
          isActive: false,
          isSnooping: false,
          cache: c.cache.map(line => ({ ...line, flash: false })),
        })),
        memory: state.memory.map(m => ({ ...m, flash: false })),
        memActive: false,
      }
    case 'SET_ANIMATING':  return { ...state, isAnimating: action.v }
    case 'SET_PLAYING':    return { ...state, isPlaying: action.v }
    case 'SET_MEM_ACTIVE': return { ...state, memActive: action.v }
    case 'SET_SPEED':      return { ...state, speed: action.v }
    case 'RESET':          return { ...INIT, speed: state.speed }
    case 'STEP_TO':        return { ...state, stepIndex: action.idx }
    default:               return state
  }
}

// ─── Animation engine ─────────────────────────────────────────────────────────
const SEG_BASE = 420

function useSimEngine(state: SimState, dispatch: React.Dispatch<Action>) {
  const tidRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const isPlayingRef = useRef(false)
  const stepRef = useRef(state.stepIndex)
  const speedRef = useRef(state.speed)

  useEffect(() => { stepRef.current = state.stepIndex }, [state.stepIndex])
  useEffect(() => { isPlayingRef.current = state.isPlaying }, [state.isPlaying])
  useEffect(() => { speedRef.current = state.speed }, [state.speed])

  const clearTids = useCallback(() => {
    tidRef.current.forEach(clearTimeout)
    tidRef.current = []
  }, [])

  const schedule = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(fn, Math.round(ms / speedRef.current))
    tidRef.current.push(id)
  }, [])

  const animatePkt = useCallback(
    (pkt: Omit<Packet, 'x' | 'y'>, waypoints: [number, number][], baseDelay: number) => {
      const segMs = SEG_BASE / speedRef.current
      const [x0, y0] = waypoints[0]
      schedule(baseDelay, () => dispatch({ type: 'ADD_PKT', pkt: { ...pkt, x: x0, y: y0 } }))
      for (let i = 1; i < waypoints.length; i++) {
        const [xi, yi] = waypoints[i]
        schedule(baseDelay + 50 + i * segMs, () =>
          dispatch({ type: 'MOVE_PKT', id: pkt.id, x: xi, y: yi })
        )
      }
      schedule(baseDelay + 50 + waypoints.length * segMs, () =>
        dispatch({ type: 'DEL_PKT', id: pkt.id })
      )
    },
    [dispatch, schedule]
  )

  const playStep = useCallback(
    (stepIdx: number) => {
      if (stepIdx >= SIM_STEPS.length) {
        dispatch({ type: 'SET_PLAYING', v: false })
        dispatch({ type: 'SET_ANIMATING', v: false })
        return
      }
      const step = SIM_STEPS[stepIdx]
      dispatch({ type: 'SET_ANIMATING', v: true })
      dispatch({ type: 'STEP_TO', idx: stepIdx })
      schedule(0, () => dispatch({ type: 'SET_ACTIVE_CORE', id: step.initiatorCore }))

      for (const sp of step.packets) {
        animatePkt(
          { id: sp.id, type: sp.type, label: sp.label, color: sp.color },
          sp.waypoints,
          sp.delay / speedRef.current
        )
      }

      if (step.snoopCores.length > 0) {
        schedule(step.snoopDelay / speedRef.current, () =>
          dispatch({ type: 'SET_SNOOP_CORES', ids: step.snoopCores })
        )
      }

      const hitsMem = step.packets.some(
        p => p.waypoints[p.waypoints.length - 1][0] >= ML - 10
      )
      if (hitsMem && step.packets[0]) {
        const arr = (step.packets[0].delay + (step.packets[0].waypoints.length - 1) * SEG_BASE) / speedRef.current
        schedule(arr, () => dispatch({ type: 'SET_MEM_ACTIVE', v: true }))
        schedule(arr + 400 / speedRef.current, () => dispatch({ type: 'SET_MEM_ACTIVE', v: false }))
      }

      schedule(step.changeMs / speedRef.current, () => {
        dispatch({ type: 'APPLY_CHANGES', stepIdx })
        dispatch({
          type: 'ADD_LOGS',
          entries: step.logs.map((l, i) => ({
            id: `s${stepIdx}_l${i}_${Date.now()}`,
            text: l.text,
            detail: l.detail,
            kind: l.kind,
          })),
        })
      })

      schedule(step.totalMs / speedRef.current, () => {
        dispatch({ type: 'CLEAR_ANIM' })
        dispatch({ type: 'SET_ANIMATING', v: false })
        if (isPlayingRef.current) {
          const next = stepRef.current + 1
          if (next < SIM_STEPS.length) {
            dispatch({ type: 'STEP_TO', idx: next })
            playStep(next)
          } else {
            dispatch({ type: 'SET_PLAYING', v: false })
          }
        }
      })
    },
    [dispatch, schedule, animatePkt]
  )

  const play = useCallback(() => {
    clearTids()
    dispatch({ type: 'SET_PLAYING', v: true })
    const idx = stepRef.current >= SIM_STEPS.length ? 0 : stepRef.current
    if (stepRef.current >= SIM_STEPS.length) dispatch({ type: 'RESET' })
    playStep(idx)
  }, [clearTids, dispatch, playStep])

  const pause = useCallback(() => {
    clearTids()
    dispatch({ type: 'SET_PLAYING', v: false })
    dispatch({ type: 'SET_ANIMATING', v: false })
    dispatch({ type: 'CLEAR_ANIM' })
  }, [clearTids, dispatch])

  const stepForward = useCallback(() => {
    if (state.isAnimating) return
    const idx = state.stepIndex >= SIM_STEPS.length ? 0 : state.stepIndex
    playStep(idx)
  }, [state.isAnimating, state.stepIndex, playStep])

  const reset = useCallback(() => {
    clearTids()
    dispatch({ type: 'SET_PLAYING', v: false })
    dispatch({ type: 'SET_ANIMATING', v: false })
    dispatch({ type: 'RESET' })
  }, [clearTids, dispatch])

  return { play, pause, stepForward, reset }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const STATE_LABEL: Record<string, string> = {
  M: 'Modified', E: 'Exclusive', S: 'Shared', I: 'Invalid',
}
const STATE_COLOR: Record<string, string> = {
  M: '#dc2626', E: '#2563eb', S: '#16a34a', I: '#475569',
}
const LOG_ICON: Record<string, string> = {
  miss: '⚠', hit: '✓', bus: '↔', state: '◆', silent: '⚡', info: 'ℹ',
}
const LOG_COLOR: Record<string, string> = {
  miss: '#f59e0b', hit: '#22c55e', bus: '#60a5fa',
  state: '#a78bfa', silent: '#fb923c', info: '#94a3b8',
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`
const hex2 = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`

// ─── Sub-components ───────────────────────────────────────────────────────────
function StateBadge({ s }: { s: string }) {
  return (
    <span className={styles.stateBadge} style={{ background: STATE_COLOR[s] ?? '#475569' }} title={STATE_LABEL[s]}>
      {s}
    </span>
  )
}

const CORE_TOPS = [20, 140, 260, 380]

function CoreBox({ core, top }: { core: CoreState; top: number }) {
  const cls = [
    styles.coreBox,
    core.isActive   ? styles.coreActive   : '',
    core.isSnooping ? styles.coreSnooping : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} style={{ top }}>
      <div className={styles.coreHeader}>
        <span className={styles.coreLabel}>Core {core.id}</span>
        {core.isActive   && <span className={styles.coreBadgeActive}>▶ active</span>}
        {core.isSnooping && <span className={styles.coreBadgeSnoop}>👁 snoop</span>}
      </div>
      <table className={styles.cacheTable}>
        <thead>
          <tr><th>Ln</th><th>State</th><th>Addr</th><th>Data</th></tr>
        </thead>
        <tbody>
          {core.cache.map(line => (
            <tr key={line.index} className={line.flash ? styles.flash : ''}>
              <td>{line.index}</td>
              <td><StateBadge s={line.state} /></td>
              <td className={styles.mono}>{line.address !== null ? hex(line.address) : '—'}</td>
              <td className={styles.mono}>{line.address !== null ? hex2(line.data) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MemoryBox({ entries, active }: { entries: MemEntry[]; active: boolean }) {
  return (
    <div className={`${styles.memBox}${active ? ' ' + styles.memActive : ''}`}>
      <div className={styles.memHeader}>Main Memory</div>
      <table className={styles.cacheTable}>
        <thead><tr><th>Addr</th><th>Data</th></tr></thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.address} className={e.flash ? styles.flash : ''}>
              <td className={styles.mono}>{e.label}</td>
              <td className={styles.mono}>{hex2(e.data)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BusOverlay({ packets }: { packets: Packet[] }) {
  return (
    <div className={styles.busOverlay}>
      <svg className={styles.busSvg} width="700" height="490" viewBox="0 0 700 490">
        {CORE_TOPS.map((top, i) => {
          const y = top + 50
          return (
            <line key={i} x1={CR} y1={y} x2={BX} y2={y}
              stroke="#334155" strokeWidth="2" strokeDasharray="6 4" />
          )
        })}
        <line x1={BX} y1={20} x2={BX} y2={470} stroke="#475569" strokeWidth="3" />
        {CY.map((y, i) => (
          <circle key={i} cx={BX} cy={y} r="5" fill="#64748b" />
        ))}
        <text x={BX + 10} y={245} fill="#64748b" fontSize="11" fontFamily="monospace">Shared</text>
        <text x={BX + 10} y={260} fill="#64748b" fontSize="11" fontFamily="monospace">Bus</text>
        <line x1={BX} y1={MY} x2={ML} y2={MY} stroke="#475569" strokeWidth="2" strokeDasharray="6 4" />
        <circle cx={BX} cy={MY} r="5" fill="#64748b" />
      </svg>

      {packets.map(p => (
        <div
          key={p.id}
          className={styles.busPkt}
          style={{
            left: p.x,
            top: p.y,
            background: p.color,
            transition: `left ${SEG_BASE}ms ease-in-out, top ${SEG_BASE}ms ease-in-out`,
          }}
        >
          {p.label}
        </div>
      ))}
    </div>
  )
}

function EventLog({ entries }: { entries: LogEntry[] }) {
  return (
    <div className={styles.eventLog}>
      <div className={styles.logHeader}>Event Log</div>
      <div className={styles.logBody}>
        {entries.length === 0
          ? <div className={styles.logEmpty}>Press Play or Step to begin</div>
          : [...entries].reverse().map(e => (
              <div key={e.id} className={styles.logEntry}>
                <span className={styles.logIcon} style={{ color: LOG_COLOR[e.kind] ?? '#94a3b8' }}>
                  {LOG_ICON[e.kind] ?? 'ℹ'}
                </span>
                <span className={styles.logText}>{e.text}</span>
                {e.detail && <span className={styles.logDetail}>{e.detail}</span>}
              </div>
            ))
        }
      </div>
    </div>
  )
}

function StepInfo({ stepIndex }: { stepIndex: number }) {
  const step = SIM_STEPS[stepIndex - 1]
  if (!step) {
    return (
      <div className={styles.stepInfo}>
        <div className={styles.stepTitle}>MESI Cache Coherence Protocol</div>
        <div className={styles.stepDesc}>
          Watch how CPU caches maintain coherence over a shared bus.
          Press <strong>Play</strong> for automatic simulation or <strong>Step</strong> to advance manually.
        </div>
      </div>
    )
  }
  return (
    <div className={styles.stepInfo}>
      <div className={styles.stepTitle}>Step {step.id}/{SIM_STEPS.length} — {step.title}</div>
      <div className={styles.stepSubtitle}>{step.subtitle}</div>
      <div className={styles.stepDesc}>{step.description}</div>
    </div>
  )
}

function Legend() {
  return (
    <div className={styles.legend}>
      {(['M', 'E', 'S', 'I'] as const).map(s => (
        <div key={s} className={styles.legendItem}>
          <StateBadge s={s} />
          <span className={styles.legendName}>{STATE_LABEL[s]}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────
export function Simulator() {
  const [state, dispatch] = useReducer(reducer, INIT)
  const { play, pause, stepForward, reset } = useSimEngine(state, dispatch)
  const done = state.stepIndex >= SIM_STEPS.length

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>MESI Cache Coherence Simulator</h1>
        <Legend />
      </header>

      <main className={styles.main}>
        {/* Left panel */}
        <aside className={styles.aside}>
          <StepInfo stepIndex={state.stepIndex} />
          <EventLog entries={state.log} />
        </aside>

        {/* Simulator + controls */}
        <div className={styles.simWrap}>
          <div className={styles.simCanvas}>
            {state.cores.map((core, i) => (
              <CoreBox key={core.id} core={core} top={CORE_TOPS[i]} />
            ))}
            <div style={{ position: 'absolute', left: 455, top: 200 }}>
              <MemoryBox entries={state.memory} active={state.memActive} />
            </div>
            <BusOverlay packets={state.packets} />
          </div>

          {/* Controls */}
          <div className={styles.controls}>
            <div className={styles.ctrlBtns}>
              {state.isPlaying
                ? <button className={`${styles.btn} ${styles.btnPause}`} onClick={pause}>⏸ Pause</button>
                : <button className={`${styles.btn} ${styles.btnPlay}`} onClick={play} disabled={done}>
                    ▶ {done ? 'Done' : state.stepIndex === 0 ? 'Play' : 'Resume'}
                  </button>
              }
              <button
                className={`${styles.btn} ${styles.btnStep}`}
                onClick={stepForward}
                disabled={state.isPlaying || state.isAnimating || done}
              >
                ⏭ Step
              </button>
              <button className={`${styles.btn} ${styles.btnReset}`} onClick={reset}>↺ Reset</button>
            </div>

            <div className={styles.ctrlSpeed}>
              <span className={styles.ctrlLabel}>Speed</span>
              {([0.5, 1, 2, 3] as const).map(v => (
                <button
                  key={v}
                  className={`${styles.btn} ${styles.btnSpeed}${state.speed === v ? ' ' + styles.btnSpeedActive : ''}`}
                  onClick={() => dispatch({ type: 'SET_SPEED', v })}
                >
                  {v}×
                </button>
              ))}
            </div>

            <div className={styles.ctrlProgress}>
              <span className={styles.ctrlLabel}>Step</span>
              <span className={styles.stepCounter}>
                {Math.min(state.stepIndex, SIM_STEPS.length)}/{SIM_STEPS.length}
              </span>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${(Math.min(state.stepIndex, SIM_STEPS.length) / SIM_STEPS.length) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
