'use client'

import { useReducer, useRef, useCallback, useEffect } from 'react'
import type { SimState, CoreState, MemEntry, Packet, LogEntry, BusStats, Protocol } from '@/types'
import { SIM_STEPS, INITIAL_MEM, BX, ML, MY, CY, CR, ADDR_A, ADDR_B, ADDR_C } from '@/steps'
import { computeRead, computeWrite } from '@/engine'
import type { SimStep, CacheChange } from '@/steps'
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
    { index: 2, address: null, data: 0, state: 'I', flash: false },
  ],
})

const makeMemory = (): MemEntry[] =>
  INITIAL_MEM.map(([address, data]) => ({
    address,
    data,
    label: `0x${address.toString(16).toUpperCase()}`,
    flash: false,
  }))

const ZERO_STATS: BusStats = { BusRead: 0, BusReadX: 0, BusUpgr: 0, Flush: 0, Supply: 0 }

const ZERO_ALL_PROTO_STATS = (): Record<Protocol, BusStats> => ({
  MSI:   { ...ZERO_STATS },
  MESI:  { ...ZERO_STATS },
  MOESI: { ...ZERO_STATS },
})

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
  mode: 'demo',
  protocol: 'MESI',
  busStats: { ...ZERO_STATS },
  allProtoStats: ZERO_ALL_PROTO_STATS(),
}

// ─── Reducer ──────────────────────────────────────────────────────────────────
type Action =
  | { type: 'SET_ACTIVE_CORE'; id: number | null }
  | { type: 'SET_SNOOP_CORES'; ids: number[] }
  | { type: 'ADD_PKT'; pkt: Packet }
  | { type: 'MOVE_PKT'; id: string; x: number; y: number }
  | { type: 'DEL_PKT'; id: string }
  | { type: 'APPLY_CHANGES'; stepIdx: number }
  | { type: 'APPLY_DYN'; changes: CacheChange[]; memChange?: { address: number; data: number }; statsInc: Partial<BusStats> }
  | { type: 'INC_PROTO_STATS'; breakdown: Record<Protocol, Partial<BusStats>> }
  | { type: 'ADD_LOGS'; entries: LogEntry[] }
  | { type: 'CLEAR_ANIM' }
  | { type: 'SET_ANIMATING'; v: boolean }
  | { type: 'SET_PLAYING'; v: boolean }
  | { type: 'SET_MEM_ACTIVE'; v: boolean }
  | { type: 'SET_SPEED'; v: number }
  | { type: 'SET_MODE'; mode: 'demo' | 'interactive' }
  | { type: 'SET_PROTOCOL'; protocol: Protocol }
  | { type: 'RESET' }
  | { type: 'STEP_TO'; idx: number }

function applyChanges(state: SimState, cacheChanges: CacheChange[], memChange?: { address: number; data: number }): SimState {
  let cores = state.cores.map(c => ({
    ...c,
    cache: c.cache.map(line => ({ ...line, flash: false })),
  }))
  for (const ch of cacheChanges) {
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
  if (memChange) {
    memory = state.memory.map(m =>
      m.address === memChange.address ? { ...m, data: memChange.data, flash: true } : m
    )
  }
  return { ...state, cores, memory }
}

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
      return applyChanges(state, step.cacheChanges, step.memChange)
    }
    case 'APPLY_DYN': {
      const next = applyChanges(state, action.changes, action.memChange)
      const bs = { ...state.busStats }
      for (const [k, v] of Object.entries(action.statsInc)) {
        bs[k as keyof BusStats] = (bs[k as keyof BusStats] ?? 0) + (v ?? 0)
      }
      return { ...next, busStats: bs }
    }
    case 'INC_PROTO_STATS': {
      const aps: Record<Protocol, BusStats> = {
        MSI:   { ...state.allProtoStats.MSI },
        MESI:  { ...state.allProtoStats.MESI },
        MOESI: { ...state.allProtoStats.MOESI },
      }
      for (const p of ['MSI', 'MESI', 'MOESI'] as Protocol[]) {
        const inc = action.breakdown[p] ?? {}
        for (const k of Object.keys(inc) as (keyof BusStats)[]) {
          aps[p][k] = (aps[p][k] ?? 0) + (inc[k] ?? 0)
        }
      }
      return { ...state, allProtoStats: aps }
    }
    case 'ADD_LOGS': {
      const next = [...state.log, ...action.entries].slice(-60)
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
    case 'SET_MODE':       return { ...state, mode: action.mode }
    case 'SET_PROTOCOL':   return { ...INIT, speed: state.speed, mode: state.mode, protocol: action.protocol, allProtoStats: state.allProtoStats }
    case 'RESET':          return { ...INIT, speed: state.speed, mode: state.mode, protocol: state.protocol, allProtoStats: state.allProtoStats }
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
  const stateRef = useRef(state)

  useEffect(() => { stepRef.current = state.stepIndex }, [state.stepIndex])
  useEffect(() => { isPlayingRef.current = state.isPlaying }, [state.isPlaying])
  useEffect(() => { speedRef.current = state.speed }, [state.speed])
  useEffect(() => { stateRef.current = state }, [state])

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

  const runStep = useCallback(
    (
      step: SimStep,
      onDone?: () => void,
      onLogs?: (baseEntries: LogEntry[]) => void,
    ) => {
      dispatch({ type: 'SET_ANIMATING', v: true })
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
        const baseEntries: LogEntry[] = step.logs.map((l, i) => ({
          id: `lg_${Date.now()}_${i}`,
          text: l.text,
          detail: l.detail,
          kind: l.kind,
        }))
        if (onLogs) {
          onLogs(baseEntries)
        } else {
          dispatch({ type: 'ADD_LOGS', entries: baseEntries })
        }
      })

      schedule(step.totalMs / speedRef.current, () => {
        dispatch({ type: 'CLEAR_ANIM' })
        dispatch({ type: 'SET_ANIMATING', v: false })
        onDone?.()
      })
    },
    [dispatch, schedule, animatePkt]
  )

  const opCountRef = useRef(0)

  const playStep = useCallback(
    (stepIdx: number) => {
      if (stepIdx >= SIM_STEPS.length) {
        dispatch({ type: 'SET_PLAYING', v: false })
        dispatch({ type: 'SET_ANIMATING', v: false })
        return
      }
      const step = SIM_STEPS[stepIdx]
      const opNum = ++opCountRef.current
      dispatch({ type: 'STEP_TO', idx: stepIdx })

      runStep(step, () => {
        dispatch({ type: 'APPLY_CHANGES', stepIdx })
        if (isPlayingRef.current) {
          const next = stepRef.current + 1
          if (next < SIM_STEPS.length) {
            dispatch({ type: 'STEP_TO', idx: next })
            playStep(next)
          } else {
            dispatch({ type: 'SET_PLAYING', v: false })
          }
        }
      }, (baseEntries) => {
        dispatch({
          type: 'ADD_LOGS',
          entries: [
            { id: `shdr_${Date.now()}`, text: step.title, detail: step.subtitle, kind: 'step', opNum },
            ...baseEntries,
          ],
        })
      })

      schedule(step.changeMs / speedRef.current, () =>
        dispatch({ type: 'APPLY_CHANGES', stepIdx })
      )
    },
    [dispatch, schedule, runStep]
  )

  const playInteractiveOp = useCallback(
    (step: SimStep, compare?: Partial<Record<Protocol, number>>, protocol?: Protocol) => {
      if (state.isAnimating) return
      clearTids()
      const statsInc: Partial<BusStats> = {}
      for (const p of step.packets) {
        statsInc[p.type as keyof BusStats] = (statsInc[p.type as keyof BusStats] ?? 0) + 1
      }
      const opNum = ++opCountRef.current

      runStep(step, () => {
        dispatch({
          type: 'APPLY_DYN',
          changes: step.cacheChanges,
          memChange: step.memChange,
          statsInc,
        })
      }, (baseEntries) => {
        const entries: LogEntry[] = [
          { id: `shdr_${Date.now()}`, text: step.title, detail: step.subtitle, kind: 'step', opNum },
          ...baseEntries,
        ]
        if (compare) {
          entries.push({
            id: `cmp_${Date.now()}`,
            text: '',
            detail: '',
            kind: 'compare',
            compareData: compare,
            currentProtocol: protocol,
          })
        }
        dispatch({ type: 'ADD_LOGS', entries })
      })

      schedule(step.changeMs / speedRef.current, () => {
        dispatch({
          type: 'APPLY_DYN',
          changes: step.cacheChanges,
          memChange: step.memChange,
          statsInc: {},
        })
      })
    },
    [state.isAnimating, clearTids, runStep, dispatch, schedule]
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

  const runFalseSharingOps = useCallback((
    scenario: 'on' | 'off',
    onDone: (stats: BusStats) => void,
  ) => {
    clearTids()
    dispatch({ type: 'RESET' })
    const addr1 = ADDR_A
    const addr2 = scenario === 'on' ? ADDR_A : ADDR_B
    const ops = [
      { coreId: 0, address: addr1 },
      { coreId: 1, address: addr2 },
      { coreId: 0, address: addr1 },
      { coreId: 1, address: addr2 },
    ]
    const accumulated: BusStats = { ...ZERO_STATS }

    function runNext(i: number) {
      if (i >= ops.length) {
        dispatch({ type: 'SET_ANIMATING', v: false })
        onDone(accumulated)
        return
      }
      const op = ops[i]
      const cur = stateRef.current
      const nd = (cur.memory.find(m => m.address === op.address)?.data ?? 0) + i + 1 & 0xff
      const step = computeWrite(op.coreId, op.address, nd, cur, cur.protocol)

      for (const pkt of step.packets) {
        accumulated[pkt.type as keyof BusStats] = (accumulated[pkt.type as keyof BusStats] ?? 0) + 1
      }
      const statsInc: Partial<BusStats> = {}
      for (const pkt of step.packets) {
        statsInc[pkt.type as keyof BusStats] = (statsInc[pkt.type as keyof BusStats] ?? 0) + 1
      }

      runStep(step, () => {
        dispatch({ type: 'APPLY_DYN', changes: step.cacheChanges, memChange: step.memChange, statsInc })
        schedule(400, () => runNext(i + 1))
      }, (baseEntries) => {
        dispatch({ type: 'ADD_LOGS', entries: baseEntries })
      })
      schedule(step.changeMs / speedRef.current, () => {
        dispatch({ type: 'APPLY_DYN', changes: step.cacheChanges, memChange: step.memChange, statsInc: {} })
      })
    }

    schedule(50, () => runNext(0))
  }, [clearTids, dispatch, runStep, schedule, stateRef])

  return { play, pause, stepForward, reset, playInteractiveOp, runFalseSharingOps }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const STATE_LABEL: Record<string, string> = {
  M: 'Modified', O: 'Owned', E: 'Exclusive', S: 'Shared', I: 'Invalid',
}
const STATE_COLOR: Record<string, string> = {
  M: '#dc2626', O: '#ea580c', E: '#2563eb', S: '#16a34a', I: '#475569',
}
const LOG_ICON: Record<string, string> = {
  miss: '⚠', hit: '✓', bus: '↔', state: '◆', silent: '⚡', info: 'ℹ',
}
const LOG_COLOR: Record<string, string> = {
  miss: '#f59e0b', hit: '#22c55e', bus: '#60a5fa',
  state: '#a78bfa', silent: '#fb923c', info: '#94a3b8',
}
const STAT_COLOR: Record<string, string> = {
  BusRead: '#f59e0b', BusReadX: '#ef4444', BusUpgr: '#f97316', Flush: '#a855f7', Supply: '#06b6d4',
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

const CORE_TOPS = [16, 150, 284, 418]

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
      <svg className={styles.busSvg} width="900" height="540" viewBox="0 0 900 540">
        <defs>
          <filter id="busGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {CY.map((y, i) => (
          <line key={i} x1={CR} y1={y} x2={BX} y2={y}
            stroke="#1a3060" strokeWidth="1.5" strokeDasharray="6 4" opacity="0.85" />
        ))}
        <line x1={BX} y1={20} x2={BX} y2={520}
          stroke="#1e3562" strokeWidth="2.5" filter="url(#busGlow)" />
        {CY.map((y, i) => (
          <circle key={i} cx={BX} cy={y} r="4" fill="#2a5298" filter="url(#busGlow)" />
        ))}
        <text x={BX + 10} y={260} fill="#2a4a80" fontSize="10" fontFamily="monospace" fontWeight="600" letterSpacing="1">SHARED</text>
        <text x={BX + 10} y={275} fill="#2a4a80" fontSize="10" fontFamily="monospace" fontWeight="600" letterSpacing="1">BUS</text>
        <line x1={BX} y1={MY} x2={ML} y2={MY}
          stroke="#1a3060" strokeWidth="1.5" strokeDasharray="6 4" opacity="0.85" />
        <circle cx={BX} cy={MY} r="4" fill="#2a5298" />
        <circle cx={ML} cy={MY} r="4" fill="#2a5298" />
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

const STAT_PKT_COLOR: Record<string, string> = {
  MSI:   '#94a3b8',
  MESI:  '#60a5fa',
  MOESI: '#a78bfa',
}

function CompareRow({ data, current }: { data: Partial<Record<Protocol, number>>; current?: Protocol }) {
  const protocols: Protocol[] = ['MSI', 'MESI', 'MOESI']
  return (
    <div className={styles.logCompare}>
      <span className={styles.logCompareLabel}>Bus txn:</span>
      {protocols.map(p => {
        const n = data[p] ?? 0
        const isActive = p === current
        const isBest = n === Math.min(...protocols.map(pp => data[pp] ?? 0))
        return (
          <span
            key={p}
            className={`${styles.logCompareItem}${isActive ? ' ' + styles.logCompareActive : ''}${isBest && n === 0 ? ' ' + styles.logCompareBest : ''}`}
            title={`${p}: ${n} bus transaction${n !== 1 ? 's' : ''}`}
          >
            <span style={{ color: STAT_PKT_COLOR[p], fontSize: 10, fontWeight: 700 }}>{p}</span>
            <span className={styles.logCompareCount} style={{ color: n === 0 ? '#22c55e' : n <= 1 ? '#94a3b8' : '#f59e0b' }}>
              {n}
            </span>
            {isActive && <span className={styles.logCompareTag}>◀</span>}
          </span>
        )
      })}
    </div>
  )
}

function EventLog({ entries }: { entries: LogEntry[] }) {
  const grouped = [...entries].reverse()
  return (
    <div className={styles.eventLog}>
      <div className={styles.logHeader}>Event Log</div>
      <div className={styles.logBody}>
        {grouped.length === 0
          ? <div className={styles.logEmpty}>Press Play or Step to begin</div>
          : grouped.map(e => {
              if (e.kind === 'step') {
                return (
                  <div key={e.id} className={styles.logStep}>
                    <div className={styles.logStepBadge}>Op {e.opNum ?? '?'}</div>
                    <div className={styles.logStepContent}>
                      <div className={styles.logStepTitle}>{e.text}</div>
                      {e.detail && <div className={styles.logStepSub}>{e.detail}</div>}
                    </div>
                  </div>
                )
              }
              if (e.kind === 'compare') {
                return (
                  <CompareRow key={e.id} data={e.compareData ?? {}} current={e.currentProtocol} />
                )
              }
              return (
                <div key={e.id} className={styles.logEntry}>
                  <span className={styles.logIcon} style={{ color: LOG_COLOR[e.kind] ?? '#94a3b8' }}>
                    {LOG_ICON[e.kind] ?? 'ℹ'}
                  </span>
                  <span className={styles.logText}>{e.text}</span>
                  {e.detail && <span className={styles.logDetail}>{e.detail}</span>}
                </div>
              )
            })
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
        <div className={styles.stepTitle}>MOESI Cache Coherence Protocol</div>
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

function Legend({ protocol }: { protocol: Protocol }) {
  const states = PROTO_STATES[protocol] ?? ['M', 'O', 'E', 'S', 'I']
  return (
    <div className={styles.legend}>
      {states.map(s => (
        <div key={s} className={styles.legendItem}>
          <StateBadge s={s} />
          <span className={styles.legendName}>{STATE_LABEL[s]}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Interactive op panel ─────────────────────────────────────────────────────
const ADDRS = [
  { label: '0xA0', value: ADDR_A },
  { label: '0xB0', value: ADDR_B },
  { label: '0xC0', value: ADDR_C },
]

// Protocol state labels per protocol — must be declared before Legend uses it
const PROTO_STATES: Record<Protocol, string[]> = {
  MSI:   ['M', 'S', 'I'],
  MESI:  ['M', 'E', 'S', 'I'],
  MOESI: ['M', 'O', 'E', 'S', 'I'],
}

const PROTO_DESC: Record<Protocol, string> = {
  MSI:   'M·S·I — simplest protocol. Cold miss always loads as S. Write from S uses BusRdX (no upgrade shortcut).',
  MESI:  'M·E·S·I — adds Exclusive state. Cold miss → E. Write from E is silent (no bus). Key MESI optimization.',
  MOESI: 'M·O·E·S·I — adds Owned state. Dirty M can transition to O when shared, avoiding memory writeback.',
}

function nextWriteData(state: SimState, coreId: number, address: number): number {
  const memVal = state.memory.find(m => m.address === address)?.data ?? 0
  for (const c of state.cores) {
    const l = c.cache.find(cl => cl.address === address && (cl.state === 'M' || cl.state === 'O'))
    if (l) return (l.data + 1) & 0xff
  }
  return (memVal + 1) & 0xff
}

function ProtocolSelector({ protocol, onChange }: { protocol: Protocol; onChange: (p: Protocol) => void }) {
  return (
    <div className={styles.protoSelector}>
      <span className={styles.ctrlLabel}>Protocol</span>
      <div className={styles.protoTabs}>
        {(['MSI', 'MESI', 'MOESI'] as Protocol[]).map(p => (
          <button
            key={p}
            className={`${styles.protoTab}${protocol === p ? ' ' + styles.protoTabActive : ''}`}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ))}
      </div>
      <span className={styles.protoDesc}>{PROTO_DESC[protocol]}</span>
    </div>
  )
}

type OpHandler = (step: ReturnType<typeof computeRead>, compare: Partial<Record<Protocol, number>>, protocol: Protocol) => void

function buildCompare(opType: 'read' | 'write', coreId: number, address: number, newData: number, state: SimState): {
  counts: Partial<Record<Protocol, number>>
  breakdown: Record<Protocol, Partial<BusStats>>
} {
  const counts: Partial<Record<Protocol, number>> = {}
  const breakdown = {} as Record<Protocol, Partial<BusStats>>
  for (const p of ['MSI', 'MESI', 'MOESI'] as Protocol[]) {
    const step = opType === 'read'
      ? computeRead(coreId, address, state, p)
      : computeWrite(coreId, address, newData, state, p)
    counts[p] = step.packets.length
    const inc: Partial<BusStats> = {}
    for (const pkt of step.packets) {
      inc[pkt.type as keyof BusStats] = (inc[pkt.type as keyof BusStats] ?? 0) + 1
    }
    breakdown[p] = inc
  }
  return { counts, breakdown }
}

function OpPanel({ state, onOp }: { state: SimState; onOp: OpHandler }) {
  const disabled = state.isAnimating || state.isPlaying

  return (
    <div className={styles.opPanel}>
      <div className={styles.opPanelTitle}>Operations — click to execute</div>

      <div className={styles.opGrid}>
        {/* Header row */}
        <div />
        {[0, 1, 2, 3].map(id => (
          <div key={id} className={styles.opGridHeader}>Core {id}</div>
        ))}

        {ADDRS.map(addr => (
          <>
            <div key={`lbl-${addr.value}`} className={styles.opAddrLabel}>{addr.label}</div>
            {[0, 1, 2, 3].map(coreId => (
              <div key={`cell-${addr.value}-${coreId}`} className={styles.opCell}>
                <button
                  className={styles.btnRead}
                  disabled={disabled}
                  onClick={() => {
                    const step = computeRead(coreId, addr.value, state, state.protocol)
                    const compare = buildCompare('read', coreId, addr.value, 0, state)
                    onOp(step, compare, state.protocol)
                  }}
                >
                  Rd
                </button>
                <button
                  className={styles.btnWrite}
                  disabled={disabled}
                  onClick={() => {
                    const nd = nextWriteData(state, coreId, addr.value)
                    const step = computeWrite(coreId, addr.value, nd, state, state.protocol)
                    const compare = buildCompare('write', coreId, addr.value, nd, state)
                    onOp(step, compare, state.protocol)
                  }}
                >
                  Wr
                </button>
              </div>
            ))}
          </>
        ))}
      </div>

      <div className={styles.busStats}>
        <span className={styles.ctrlLabel}>Bus traffic:</span>
        {(Object.keys(ZERO_STATS) as (keyof BusStats)[]).map((k, i) => (
          <div key={k} className={styles.busStatItem}>
            {i > 0 && <div className={styles.busStatDivider} />}
            <span className={styles.busStatLabel}>{k}</span>
            <span className={styles.busStatCount} style={{ color: STAT_COLOR[k] }}>
              {state.busStats[k]}
            </span>
          </div>
        ))}
        <div className={styles.busStatDivider} />
        <div className={styles.busStatItem}>
          <span className={styles.busStatLabel}>Total</span>
          <span className={styles.busStatCount} style={{ color: '#e2e8f0' }}>
            {Object.values(state.busStats).reduce((a, b) => a + b, 0)}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────
export function Simulator() {
  const [state, dispatch] = useReducer(reducer, INIT)
  const { play, pause, stepForward, reset, playInteractiveOp } = useSimEngine(state, dispatch)
  const done = state.stepIndex >= SIM_STEPS.length

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          {state.mode === 'demo' ? 'MESI' : state.protocol} Cache Coherence Simulator
        </h1>
        <Legend protocol={state.mode === 'demo' ? 'MESI' : state.protocol} />
      </header>

      <main className={styles.main}>
        {/* Left panel */}
        <aside className={styles.aside}>
          {state.mode === 'demo'
            ? <StepInfo stepIndex={state.stepIndex} />
            : (
              <div className={styles.stepInfo}>
                <div className={styles.stepTitle}>Interactive Mode</div>
                <div className={styles.stepDesc}>
                  Click <strong>Rd</strong> or <strong>Wr</strong> for any Core × Address combination.
                  The MOESI protocol logic runs automatically and animates the bus transactions.
                  <br /><br />
                  <span style={{ color: '#f59e0b' }}>Wr</span> writes current value + 1.
                </div>
              </div>
            )
          }
          <EventLog entries={state.log} />
        </aside>

        {/* Simulator + controls */}
        <div className={styles.simWrap}>
          <div className={styles.simCanvas}>
            {state.cores.map((core, i) => (
              <CoreBox key={core.id} core={core} top={CORE_TOPS[i]} />
            ))}
            <div style={{ position: 'absolute', left: ML, top: MY - 52 }}>
              <MemoryBox entries={state.memory} active={state.memActive} />
            </div>
            <BusOverlay packets={state.packets} />
          </div>

          {/* Mode toggle + controls */}
          <div className={styles.controls}>
            <div className={styles.modeTabs}>
              <button
                className={`${styles.modeTab}${state.mode === 'demo' ? ' ' + styles.modeTabActive : ''}`}
                onClick={() => { dispatch({ type: 'SET_MODE', mode: 'demo' }); reset() }}
              >
                Demo
              </button>
              <button
                className={`${styles.modeTab}${state.mode === 'interactive' ? ' ' + styles.modeTabActive : ''}`}
                onClick={() => { dispatch({ type: 'SET_MODE', mode: 'interactive' }); reset() }}
              >
                Interactive
              </button>
            </div>

            {state.mode === 'demo' ? (
              <>
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
              </>
            ) : (
              <>
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
                <button className={`${styles.btn} ${styles.btnReset}`} onClick={reset}>↺ Reset</button>
              </>
            )}
          </div>

          {state.mode === 'interactive' && (
            <>
              <ProtocolSelector
                protocol={state.protocol}
                onChange={p => dispatch({ type: 'SET_PROTOCOL', protocol: p })}
              />
              <OpPanel
                state={state}
                onOp={(step, compare, protocol) => playInteractiveOp(step, compare, protocol)}
              />
            </>
          )}
        </div>
      </main>
    </div>
  )
}
