'use client'

import { useReducer, useRef, useCallback, useEffect } from 'react'
import type { SimState, CoreState, MemEntry, Packet, LogEntry, BusStats, CacheStats, Protocol } from '@/types'
import { SIM_STEPS, DEMO_OPS, INITIAL_MEM, BX, ML, MY, CY, CR, ADDR_A, ADDR_B, ADDR_C } from '@/steps'
import { computeRead, computeWrite } from '@/engine'
import type { SimStep, CacheChange } from '@/steps'
import styles from './Simulator.module.css'

// ─── Per-core accent colors ───────────────────────────────────────────────────
const CORE_ACCENT = ['#3b82f6', '#a855f7', '#06b6d4', '#f59e0b'] as const
const CORE_GLOW   = [
  '59,130,246',   // blue
  '168,85,247',   // purple
  '6,182,212',    // cyan
  '245,158,11',   // amber
] as const

// ─── Initial state ────────────────────────────────────────────────────────────
const makeCore = (id: number): CoreState => ({
  id,
  isActive: false,
  isSnooping: false,
  currentOp: null,
  cache: [
    { index: 0, address: null, data: 0, state: 'I', flash: false, flashKind: null },
    { index: 1, address: null, data: 0, state: 'I', flash: false, flashKind: null },
    { index: 2, address: null, data: 0, state: 'I', flash: false, flashKind: null },
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
const ZERO_CACHE_STATS: CacheStats = { hits: 0, misses: 0, invalidations: 0, writebacks: 0 }

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
  scenarioStep: 0,
  fsStats: { on: null, off: null },
  cacheStats: { ...ZERO_CACHE_STATS },
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
  | { type: 'SET_MODE'; mode: 'demo' | 'scenario' | 'interactive' | 'falsesharing' }
  | { type: 'SET_PROTOCOL'; protocol: Protocol }
  | { type: 'RESET' }
  | { type: 'STEP_TO'; idx: number }
  | { type: 'SET_SCENARIO_STEP'; v: number }
  | { type: 'SET_FS_STATS'; scenario: 'on' | 'off'; stats: BusStats }
  | { type: 'INC_CACHE_STATS'; delta: CacheStats }

function applyChanges(state: SimState, cacheChanges: CacheChange[], memChange?: { address: number; data: number }): SimState {
  let cores = state.cores.map(c => ({
    ...c,
    cache: c.cache.map(line => ({ ...line, flash: false, flashKind: null as SimState['cores'][0]['cache'][0]['flashKind'] })),
  }))
  for (const ch of cacheChanges) {
    cores = cores.map(c =>
      c.id === ch.coreId
        ? {
            ...c,
            cache: c.cache.map(line => {
              if (line.index !== ch.lineIndex) return line
              const oldState = line.state
              const newState = ch.state
              const flashKind =
                newState === 'I'      ? 'invalidate' as const :
                oldState === 'I'      ? 'miss'       as const :
                oldState === newState ? 'hit'        as const :
                                       'update'      as const
              return { ...line, state: ch.state, address: ch.address, data: ch.data, flash: true, flashKind }
            }),
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
        cores: state.cores.map(c => ({ ...c, isActive: c.id === action.id, isSnooping: false })),
      }
    case 'SET_SNOOP_CORES':
      return { ...state, cores: state.cores.map(c => ({ ...c, isSnooping: action.ids.includes(c.id) })) }
    case 'ADD_PKT':
      return { ...state, packets: [...state.packets, action.pkt] }
    case 'MOVE_PKT':
      return { ...state, packets: state.packets.map(p => p.id === action.id ? { ...p, x: action.x, y: action.y } : p) }
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
          cache: c.cache.map(line => ({ ...line, flash: false, flashKind: null as SimState['cores'][0]['cache'][0]['flashKind'] })),
        })),
        memory: state.memory.map(m => ({ ...m, flash: false })),
        memActive: false,
      }
    case 'SET_ANIMATING':     return { ...state, isAnimating: action.v }
    case 'SET_PLAYING':       return { ...state, isPlaying: action.v }
    case 'SET_MEM_ACTIVE':    return { ...state, memActive: action.v }
    case 'SET_SPEED':         return { ...state, speed: action.v }
    case 'SET_MODE':          return { ...state, mode: action.mode }
    case 'SET_SCENARIO_STEP': return { ...state, scenarioStep: action.v }
    case 'SET_FS_STATS':
      return { ...state, fsStats: { ...state.fsStats, [action.scenario]: action.stats } }
    case 'INC_CACHE_STATS':
      return {
        ...state,
        cacheStats: {
          hits:         state.cacheStats.hits         + action.delta.hits,
          misses:       state.cacheStats.misses        + action.delta.misses,
          invalidations:state.cacheStats.invalidations + action.delta.invalidations,
          writebacks:   state.cacheStats.writebacks    + action.delta.writebacks,
        },
      }
    case 'SET_PROTOCOL':
      return { ...INIT, speed: state.speed, mode: state.mode, protocol: action.protocol, allProtoStats: state.allProtoStats }
    case 'RESET':
      return { ...INIT, speed: state.speed, mode: state.mode, protocol: state.protocol, allProtoStats: state.allProtoStats }
    case 'STEP_TO':
      return { ...state, stepIndex: action.idx }
    default:
      return state
  }
}

// ─── Cache stats helper ───────────────────────────────────────────────────────
function computeCacheStatsDelta(
  cores: SimState['cores'],
  changes: CacheChange[],
  packetTypes: string[]
): CacheStats {
  const d = { hits: 0, misses: 0, invalidations: 0, writebacks: 0 }
  for (const ch of changes) {
    const oldSt = cores.find(c => c.id === ch.coreId)?.cache.find(l => l.index === ch.lineIndex)?.state ?? 'I'
    const newSt = ch.state
    if (newSt === 'I')       d.invalidations++
    else if (oldSt === 'I')  d.misses++
    else if (oldSt === newSt) d.hits++
  }
  d.writebacks = packetTypes.filter(t => t === 'Flush').length
  return d
}

// ─── Animation engine ─────────────────────────────────────────────────────────
const SEG_BASE = 420

function useSimEngine(state: SimState, dispatch: React.Dispatch<Action>) {
  const tidRef       = useRef<ReturnType<typeof setTimeout>[]>([])
  const isPlayingRef = useRef(false)
  const stepRef      = useRef(state.stepIndex)
  const speedRef     = useRef(state.speed)
  const stateRef     = useRef(state)
  const dynOpRef     = useRef<{ protocol: Protocol; nextIdx: number } | null>(null)

  useEffect(() => { stepRef.current     = state.stepIndex }, [state.stepIndex])
  useEffect(() => { isPlayingRef.current = state.isPlaying }, [state.isPlaying])
  useEffect(() => { speedRef.current    = state.speed },    [state.speed])
  useEffect(() => { stateRef.current    = state },          [state])

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
        schedule(baseDelay + 50 + i * segMs, () => dispatch({ type: 'MOVE_PKT', id: pkt.id, x: xi, y: yi }))
      }
      schedule(baseDelay + 50 + waypoints.length * segMs, () => dispatch({ type: 'DEL_PKT', id: pkt.id }))
    },
    [dispatch, schedule]
  )

  const runStep = useCallback(
    (step: SimStep, onDone?: () => void, onLogs?: (baseEntries: LogEntry[]) => void) => {
      dispatch({ type: 'SET_ANIMATING', v: true })
      schedule(0, () => dispatch({ type: 'SET_ACTIVE_CORE', id: step.initiatorCore }))

      for (const sp of step.packets) {
        animatePkt({ id: sp.id, type: sp.type, label: sp.label, color: sp.color }, sp.waypoints, sp.delay / speedRef.current)
      }

      if (step.snoopCores.length > 0) {
        schedule(step.snoopDelay / speedRef.current, () => dispatch({ type: 'SET_SNOOP_CORES', ids: step.snoopCores }))
      }

      const hitsMem = step.packets.some(p => p.waypoints[p.waypoints.length - 1][0] >= ML - 10)
      if (hitsMem && step.packets[0]) {
        const arr = (step.packets[0].delay + (step.packets[0].waypoints.length - 1) * SEG_BASE) / speedRef.current
        schedule(arr, () => dispatch({ type: 'SET_MEM_ACTIVE', v: true }))
        schedule(arr + 400 / speedRef.current, () => dispatch({ type: 'SET_MEM_ACTIVE', v: false }))
      }

      schedule(step.changeMs / speedRef.current, () => {
        const baseEntries: LogEntry[] = step.logs.map((l, i) => ({
          id: `lg_${Date.now()}_${i}`, text: l.text, detail: l.detail, kind: l.kind,
        }))
        if (onLogs) onLogs(baseEntries)
        else dispatch({ type: 'ADD_LOGS', entries: baseEntries })
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

  const playStep = useCallback((stepIdx: number) => {
    if (stepIdx >= SIM_STEPS.length) {
      dispatch({ type: 'SET_PLAYING', v: false })
      dispatch({ type: 'SET_ANIMATING', v: false })
      return
    }
    const step = SIM_STEPS[stepIdx]
    const opNum = ++opCountRef.current
    const csDelta = computeCacheStatsDelta(stateRef.current.cores, step.cacheChanges, step.packets.map(p => p.type))
    dispatch({ type: 'STEP_TO', idx: stepIdx })

    runStep(step, () => {
      dispatch({ type: 'APPLY_CHANGES', stepIdx })
      dispatch({ type: 'INC_CACHE_STATS', delta: csDelta })
      if (isPlayingRef.current) {
        const next = stepRef.current + 1
        if (next < SIM_STEPS.length) { dispatch({ type: 'STEP_TO', idx: next }); playStep(next) }
        else { dispatch({ type: 'STEP_TO', idx: SIM_STEPS.length }); dispatch({ type: 'SET_PLAYING', v: false }) }
      }
    }, (baseEntries) => {
      dispatch({ type: 'ADD_LOGS', entries: [
        { id: `shdr_${Date.now()}`, text: step.title, detail: step.subtitle, kind: 'step', opNum, stepDescription: step.description },
        ...baseEntries,
      ]})
    })
    schedule(step.changeMs / speedRef.current, () => dispatch({ type: 'APPLY_CHANGES', stepIdx }))
  }, [dispatch, schedule, runStep, stateRef])

  const runDynStep = useCallback((protocol: Protocol, i: number) => {
    if (i >= DEMO_OPS.length) {
      dispatch({ type: 'SET_PLAYING', v: false })
      return
    }
    const op = DEMO_OPS[i]
    const cur = stateRef.current
    const step = op.type === 'read'
      ? computeRead(op.coreId, op.address, cur, protocol)
      : computeWrite(op.coreId, op.address, op.data, cur, protocol)

    dynOpRef.current = { protocol, nextIdx: i + 1 }
    dispatch({ type: 'SET_SCENARIO_STEP', v: i + 1 })

    const statsInc: Partial<BusStats> = {}
    for (const p of step.packets) {
      statsInc[p.type as keyof BusStats] = (statsInc[p.type as keyof BusStats] ?? 0) + 1
    }
    const csDelta = computeCacheStatsDelta(cur.cores, step.cacheChanges, step.packets.map(p => p.type))
    const opNum = ++opCountRef.current

    runStep(step, () => {
      dispatch({ type: 'APPLY_DYN', changes: step.cacheChanges, memChange: step.memChange, statsInc })
      dispatch({ type: 'INC_CACHE_STATS', delta: csDelta })
      if (isPlayingRef.current) schedule(400, () => runDynStep(protocol, i + 1))
    }, (baseEntries) => {
      dispatch({ type: 'ADD_LOGS', entries: [
        { id: `shdr_${Date.now()}`, text: step.title, detail: step.subtitle, kind: 'step', opNum, stepDescription: step.description },
        ...baseEntries,
      ]})
    })
    schedule(step.changeMs / speedRef.current, () => {
      dispatch({ type: 'APPLY_DYN', changes: step.cacheChanges, memChange: step.memChange, statsInc: {} })
    })
  }, [runStep, dispatch, schedule, stateRef])

  const playInteractiveOp = useCallback(
    (step: SimStep, compare?: Partial<Record<Protocol, number>>, protocol?: Protocol) => {
      if (state.isAnimating) return
      clearTids()
      const statsInc: Partial<BusStats> = {}
      for (const p of step.packets) {
        statsInc[p.type as keyof BusStats] = (statsInc[p.type as keyof BusStats] ?? 0) + 1
      }
      const csDelta = computeCacheStatsDelta(stateRef.current.cores, step.cacheChanges, step.packets.map(p => p.type))
      const opNum = ++opCountRef.current

      runStep(step, () => {
        dispatch({ type: 'APPLY_DYN', changes: step.cacheChanges, memChange: step.memChange, statsInc })
        dispatch({ type: 'INC_CACHE_STATS', delta: csDelta })
      }, (baseEntries) => {
        const entries: LogEntry[] = [
          { id: `shdr_${Date.now()}`, text: step.title, detail: step.subtitle, kind: 'step', opNum, stepDescription: step.description },
          ...baseEntries,
        ]
        if (compare) {
          entries.push({ id: `cmp_${Date.now()}`, text: '', detail: '', kind: 'compare', compareData: compare, currentProtocol: protocol })
        }
        dispatch({ type: 'ADD_LOGS', entries })
      })
      schedule(step.changeMs / speedRef.current, () => {
        dispatch({ type: 'APPLY_DYN', changes: step.cacheChanges, memChange: step.memChange, statsInc: {} })
      })
    },
    [state.isAnimating, clearTids, runStep, dispatch, schedule]
  )

  const play = useCallback(() => {
    clearTids()
    dispatch({ type: 'SET_PLAYING', v: true })
    if (stateRef.current.mode === 'scenario' && dynOpRef.current) {
      const { protocol, nextIdx } = dynOpRef.current
      runDynStep(protocol, nextIdx)
    } else {
      const idx = stepRef.current >= SIM_STEPS.length ? 0 : stepRef.current
      if (stepRef.current >= SIM_STEPS.length) dispatch({ type: 'RESET' })
      playStep(idx)
    }
  }, [clearTids, dispatch, playStep, runDynStep])

  const pause = useCallback(() => {
    clearTids()
    dispatch({ type: 'SET_PLAYING', v: false })
    dispatch({ type: 'SET_ANIMATING', v: false })
    dispatch({ type: 'CLEAR_ANIM' })
  }, [clearTids, dispatch])

  const stepForward = useCallback(() => {
    if (state.isAnimating) return
    if (state.mode === 'scenario' && dynOpRef.current) {
      runDynStep(dynOpRef.current.protocol, dynOpRef.current.nextIdx)
    } else {
      const idx = state.stepIndex >= SIM_STEPS.length ? 0 : state.stepIndex
      playStep(idx)
    }
  }, [state.isAnimating, state.stepIndex, state.mode, playStep, runDynStep])

  const reset = useCallback(() => {
    clearTids()
    dispatch({ type: 'SET_PLAYING', v: false })
    dispatch({ type: 'SET_ANIMATING', v: false })
    dispatch({ type: 'RESET' })
    if (dynOpRef.current) dynOpRef.current = { ...dynOpRef.current, nextIdx: 0 }
  }, [clearTids, dispatch])

  const runProtocolDemo = useCallback((protocol: Protocol) => {
    clearTids()
    dispatch({ type: 'RESET' })
    dispatch({ type: 'SET_PROTOCOL', protocol })
    dispatch({ type: 'SET_MODE', mode: 'scenario' })
    dispatch({ type: 'SET_PLAYING', v: true })
    dynOpRef.current = { protocol, nextIdx: 0 }
    schedule(50, () => runDynStep(protocol, 0))
  }, [clearTids, dispatch, schedule, runDynStep])

  const runFalseSharingDemo = useCallback((scenario: 'on' | 'off') => {
    clearTids()
    dispatch({ type: 'RESET' })
    dispatch({ type: 'SET_MODE', mode: 'falsesharing' })

    const addr0 = ADDR_A
    const addr1 = scenario === 'on' ? ADDR_A : ADDR_B
    const ops = [
      { coreId: 0, address: addr0 }, { coreId: 1, address: addr1 },
      { coreId: 0, address: addr0 }, { coreId: 1, address: addr1 },
      { coreId: 0, address: addr0 }, { coreId: 1, address: addr1 },
    ]
    const accumulated: BusStats = { ...ZERO_STATS }

    function runNext(i: number) {
      if (i >= ops.length) {
        dispatch({ type: 'SET_ANIMATING', v: false })
        dispatch({ type: 'SET_FS_STATS', scenario, stats: { ...accumulated } })
        return
      }
      const op = ops[i]
      const cur = stateRef.current
      const nd = ((cur.memory.find(m => m.address === op.address)?.data ?? 0) + i + 1) & 0xff
      const step = computeWrite(op.coreId, op.address, nd, cur, cur.protocol)
      for (const pkt of step.packets) {
        accumulated[pkt.type as keyof BusStats] = (accumulated[pkt.type as keyof BusStats] ?? 0) + 1
      }
      const statsInc: Partial<BusStats> = {}
      for (const pkt of step.packets) {
        statsInc[pkt.type as keyof BusStats] = (statsInc[pkt.type as keyof BusStats] ?? 0) + 1
      }
      const csDelta = computeCacheStatsDelta(cur.cores, step.cacheChanges, step.packets.map(p => p.type))
      const opNum = ++opCountRef.current
      runStep(step, () => {
        dispatch({ type: 'APPLY_DYN', changes: step.cacheChanges, memChange: step.memChange, statsInc })
        dispatch({ type: 'INC_CACHE_STATS', delta: csDelta })
        schedule(400, () => runNext(i + 1))
      }, (baseEntries) => {
        dispatch({ type: 'ADD_LOGS', entries: [
          { id: `shdr_${Date.now()}`, text: step.title, detail: step.subtitle, kind: 'step', opNum, stepDescription: step.description },
          ...baseEntries,
        ]})
      })
      schedule(step.changeMs / speedRef.current, () => {
        dispatch({ type: 'APPLY_DYN', changes: step.cacheChanges, memChange: step.memChange, statsInc: {} })
      })
    }
    schedule(50, () => runNext(0))
  }, [clearTids, dispatch, runStep, schedule, stateRef])

  return { play, pause, stepForward, reset, playInteractiveOp, runProtocolDemo, runFalseSharingDemo }
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

const hex  = (n: number) => `0x${n.toString(16).toUpperCase()}`
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

function CoreBox({ core, top, accentColor, glowRgb }: {
  core: CoreState
  top: number
  accentColor: string
  glowRgb: string
}) {
  const isActive   = core.isActive
  const isSnooping = core.isSnooping

  const boxStyle: React.CSSProperties = {
    top,
    borderColor: isActive
      ? accentColor
      : isSnooping
        ? '#d97706'
        : undefined,
    boxShadow: isActive
      ? `0 0 0 1px rgba(${glowRgb},0.5), 0 0 28px rgba(${glowRgb},0.25), inset 0 0 50px rgba(${glowRgb},0.06)`
      : isSnooping
        ? '0 0 0 1px rgba(217,119,6,0.4), 0 0 22px rgba(217,119,6,0.18)'
        : undefined,
    background: isActive
      ? `linear-gradient(150deg, rgba(${glowRgb},0.06) 0%, rgba(${glowRgb},0.02) 100%), #081328`
      : undefined,
  }

  const cls = [styles.coreBox, isSnooping ? styles.coreSnooping : ''].filter(Boolean).join(' ')

  return (
    <div className={cls} style={boxStyle}>
      <div className={styles.coreAccentBar} style={{ background: accentColor }} />
      <div className={styles.coreHeader}>
        <span className={styles.coreLabel} style={{ color: accentColor }}>{`Core ${core.id}`}</span>
        {isActive   && <span className={styles.coreBadgeActive} style={{ color: accentColor, borderColor: accentColor, background: `rgba(${glowRgb},0.12)` }}>▶ active</span>}
        {isSnooping && <span className={styles.coreBadgeSnoop}>👁 snoop</span>}
      </div>
      <table className={styles.cacheTable}>
        <thead>
          <tr><th>Ln</th><th>State</th><th>Addr</th><th>Data</th></tr>
        </thead>
        <tbody>
          {core.cache.map(line => {
            const flashCls = line.flash
              ? line.flashKind === 'invalidate' ? styles.flashInvalidate
              : line.flashKind === 'hit'        ? styles.flashHit
              : line.flashKind === 'update'     ? styles.flashUpdate
              : styles.flash
              : ''
            return (
              <tr key={line.index} className={flashCls}>
                <td>{line.index}</td>
                <td><StateBadge s={line.state} /></td>
                <td className={styles.mono}>{line.address !== null ? hex(line.address) : '—'}</td>
                <td className={styles.mono}>{line.address !== null ? hex2(line.data) : '—'}</td>
              </tr>
            )
          })}
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
      <svg className={styles.busSvg} width="1050" height="540" viewBox="0 0 1050 540">
        <defs>
          <filter id="gs" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="gm" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          {/* Arrow markers — one per core color */}
          {(CORE_ACCENT as readonly string[]).map((color, i) => (
            <marker key={i} id={`arr${i}`} markerWidth="8" markerHeight="8"
              refX="7" refY="4" orient="auto">
              <path d="M0,1 L7,4 L0,7 Z" fill={color} fillOpacity="0.9" />
            </marker>
          ))}
          <marker id="arrMem" markerWidth="8" markerHeight="8"
            refX="7" refY="4" orient="auto">
            <path d="M0,1 L7,4 L0,7 Z" fill="#d97706" fillOpacity="0.9" />
          </marker>
        </defs>

        {/* Per-core horizontal spokes */}
        {CY.map((y, i) => (
          <g key={i}>
            {/* Wide glow halo */}
            <line x1={CR + 2} y1={y} x2={BX} y2={y}
              stroke={CORE_ACCENT[i]} strokeWidth="7" opacity="0.10" />
            {/* Dashed spoke with arrow */}
            <line x1={CR + 2} y1={y} x2={BX - 9} y2={y}
              stroke={CORE_ACCENT[i]} strokeWidth="1.8" opacity="0.70"
              strokeDasharray="8 5"
              markerEnd={`url(#arr${i})`} />
          </g>
        ))}

        {/* Bus backbone */}
        <line x1={BX} y1={16} x2={BX} y2={524}
          stroke="#071840" strokeWidth="7" />
        <line x1={BX} y1={16} x2={BX} y2={524}
          stroke="#2563eb" strokeWidth="2.5" opacity="0.80" filter="url(#gm)" />

        {/* Junction dots (ring + fill) */}
        {CY.map((y, i) => (
          <g key={i}>
            <circle cx={BX} cy={y} r="9" fill="#04080f"
              stroke={CORE_ACCENT[i]} strokeWidth="1.5" opacity="0.80" />
            <circle cx={BX} cy={y} r="4.5" fill={CORE_ACCENT[i]} opacity="0.90" filter="url(#gs)" />
          </g>
        ))}

        {/* Memory connection (gold, arrow) */}
        <line x1={BX + 4} y1={MY} x2={ML} y2={MY}
          stroke="#d97706" strokeWidth="7" opacity="0.08" />
        <line x1={BX + 4} y1={MY} x2={ML - 9} y2={MY}
          stroke="#d97706" strokeWidth="1.8" opacity="0.70"
          strokeDasharray="8 5"
          markerEnd="url(#arrMem)" />

        {/* Bus label */}
        <text x={BX + 14} y={MY - 12} fill="#1e4898" fontSize="8.5"
          fontFamily="monospace" fontWeight="800" letterSpacing="2">SHARED BUS</text>

        {/* Memory endpoint dots */}
        <circle cx={BX} cy={MY} r="6" fill="#78350f" opacity="0.55" filter="url(#gs)" />
        <circle cx={ML} cy={MY} r="6" fill="#d97706" opacity="0.85" filter="url(#gs)" />

        {/* Core spoke labels */}
        {CY.map((y, i) => (
          <text key={i} x={CR + 6} y={y - 7}
            fill={CORE_ACCENT[i]} fontSize="8.5" fontFamily="monospace"
            fontWeight="800" opacity="0.75">C{i}</text>
        ))}
      </svg>

      {packets.map(p => (
        <div
          key={p.id}
          className={styles.busPkt}
          style={{
            left: p.x, top: p.y, background: p.color,
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
  MSI: '#94a3b8', MESI: '#60a5fa', MOESI: '#a78bfa',
}

function CompareRow({ data, current }: { data: Partial<Record<Protocol, number>>; current?: Protocol }) {
  const protocols: Protocol[] = ['MSI', 'MESI', 'MOESI']
  return (
    <div className={styles.logCompare}>
      <span className={styles.logCompareLabel}>Bus txn:</span>
      {protocols.map(p => {
        const n = data[p] ?? 0
        const isActive = p === current
        return (
          <span
            key={p}
            className={`${styles.logCompareItem}${isActive ? ' ' + styles.logCompareActive : ''}`}
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
                return <CompareRow key={e.id} data={e.compareData ?? {}} current={e.currentProtocol} />
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

// ─── "What Happened?" card ────────────────────────────────────────────────────
function WhatHappenedCard({ log }: { log: LogEntry[] }) {
  const lastStep = [...log].reverse().find(e => e.kind === 'step')
  if (!lastStep) return null
  return (
    <div className={styles.whatHappened}>
      <div className={styles.whatHappenedHeader}>
        <span>💡 What Happened?</span>
      </div>
      <div className={styles.whatHappenedOp}>{lastStep.text}</div>
      <div className={styles.whatHappenedSub}>{lastStep.detail}</div>
      {lastStep.stepDescription && (
        <div className={styles.whatHappenedDesc}>{lastStep.stepDescription}</div>
      )}
    </div>
  )
}

// ─── Protocol key features card ───────────────────────────────────────────────
const PROTO_KEY: Record<Protocol, { title: string; color: string; points: string[] }> = {
  MSI: {
    title: 'MSI — Simplest Protocol',
    color: '#94a3b8',
    points: [
      'Only 3 states: Modified · Shared · Invalid',
      'Cold miss always loads as SHARED (no Exclusive)',
      'Write from S → BusRdX (invalidates all copies, even when sole owner)',
      'Wastes bus bandwidth: a lone writer still broadcasts BusRdX',
    ],
  },
  MESI: {
    title: 'MESI — Exclusive Optimization',
    color: '#60a5fa',
    points: [
      'Adds Exclusive state: sole clean copy, no other caches have it',
      'Cold miss with no copies → E (not S)',
      'Write from E → M is SILENT — zero bus transactions!',
      'Write from S → BusUpgr (cheaper: no data, just invalidate)',
    ],
  },
  MOESI: {
    title: 'MOESI — Owned State',
    color: '#a78bfa',
    points: [
      'All MESI optimizations, plus Owned state',
      'Modified core sharing data → goes to O instead of S',
      'Owned core supplies data directly — memory NOT updated',
      'Avoids expensive writeback to memory on sharing',
    ],
  },
}

function ProtocolKeyCard({ protocol }: { protocol: Protocol }) {
  const info = PROTO_KEY[protocol]
  return (
    <div className={styles.protoKeyCard} style={{ borderColor: `${info.color}33` }}>
      <div className={styles.protoKeyHeader} style={{ color: info.color }}>{info.title}</div>
      <ul className={styles.protoKeyList}>
        {info.points.map((p, i) => (
          <li key={i} className={styles.protoKeyItem}>{p}</li>
        ))}
      </ul>
    </div>
  )
}

// ─── Step / Scenario info ─────────────────────────────────────────────────────
function StepInfo({ stepIndex }: { stepIndex: number }) {
  const step = SIM_STEPS[stepIndex - 1]
  if (!step) {
    return (
      <div className={styles.stepInfo}>
        <div className={styles.stepTitle}>MESI Classic Demo</div>
        <div className={styles.stepDesc}>
          9 steps showing MESI state transitions. Press <strong>Play</strong> for auto or <strong>Step</strong> one at a time.
        </div>
      </div>
    )
  }
  return (
    <div className={styles.stepInfo}>
      <div className={styles.stepTitle}>Step {step.id}/{SIM_STEPS.length} — {step.title}</div>
      <div className={styles.stepSubtitle}>{step.subtitle}</div>
    </div>
  )
}

function ScenarioInfo({ protocol, scenarioStep }: { protocol: Protocol; scenarioStep: number }) {
  return (
    <div className={styles.stepInfo}>
      <div className={styles.stepTitle}>{protocol} Protocol Demo</div>
      <div className={styles.stepSubtitle}>
        Step {Math.min(scenarioStep, DEMO_OPS.length)} / {DEMO_OPS.length}
      </div>
    </div>
  )
}

function FalseSharingInfo({ fsStats, isAnimating, onRunOn, onRunOff }: {
  fsStats: { on: BusStats | null; off: BusStats | null }
  isAnimating: boolean
  onRunOn: () => void
  onRunOff: () => void
}) {
  const total = (s: BusStats) => Object.values(s).reduce((a, b) => a + b, 0)
  const invld = (s: BusStats) => s.BusReadX + s.BusUpgr

  return (
    <div className={styles.stepInfo}>
      <div className={styles.stepTitle}>False Sharing Demo</div>
      <div className={styles.stepDesc}>
        <strong style={{ color: '#ef4444' }}>ON</strong>: Core 0 writes <code>0xA0</code>,
        Core 1 writes <code>0xA0</code> — same cache line.
        Every write forces the other core&apos;s line to be <strong style={{ color: '#ef4444' }}>invalidated</strong>.<br /><br />
        <strong style={{ color: '#22c55e' }}>OFF</strong>: Core 0 writes <code>0xA0</code>,
        Core 1 writes <code>0xB0</code> — different lines. No false interference.
      </div>
      <div className={styles.fsBtns}>
        <button className={`${styles.btn} ${styles.btnFsOn}`} onClick={onRunOn} disabled={isAnimating}>
          ▶ Run False Sharing ON
        </button>
        <button className={`${styles.btn} ${styles.btnFsOff}`} onClick={onRunOff} disabled={isAnimating}>
          ▶ Run False Sharing OFF
        </button>
      </div>
      {(fsStats.on || fsStats.off) && (
        <div className={styles.fsComparison}>
          <div className={styles.fsCompHeader}>Results</div>
          {fsStats.on && (
            <div className={styles.fsCompRow}>
              <span className={styles.fsLabel} style={{ color: '#ef4444' }}>ON</span>
              <span>Invalidations: <strong style={{ color: '#ef4444' }}>{invld(fsStats.on)}</strong></span>
              <span>Bus total: <strong style={{ color: '#f59e0b' }}>{total(fsStats.on)}</strong></span>
            </div>
          )}
          {fsStats.off && (
            <div className={styles.fsCompRow}>
              <span className={styles.fsLabel} style={{ color: '#22c55e' }}>OFF</span>
              <span>Invalidations: <strong style={{ color: '#22c55e' }}>{invld(fsStats.off)}</strong></span>
              <span>Bus total: <strong style={{ color: '#22c55e' }}>{total(fsStats.off)}</strong></span>
            </div>
          )}
          {fsStats.on && fsStats.off && (
            <div className={styles.fsSummary}>
              Bus traffic {total(fsStats.off) < total(fsStats.on)
                ? `reduced by ${Math.round((1 - total(fsStats.off) / Math.max(1, total(fsStats.on))) * 100)}% with false sharing OFF`
                : 'unchanged — try MESI/MOESI for bigger difference'}
            </div>
          )}
        </div>
      )}
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
      <div className={styles.legendDivider} />
      <div className={styles.legendItem}><span className={styles.flashDot} style={{ background: '#ef4444' }} /><span className={styles.legendName}>Invalidate</span></div>
      <div className={styles.legendItem}><span className={styles.flashDot} style={{ background: '#22c55e' }} /><span className={styles.legendName}>Hit</span></div>
      <div className={styles.legendItem}><span className={styles.flashDot} style={{ background: '#f59e0b' }} /><span className={styles.legendName}>Miss</span></div>
      <div className={styles.legendItem}><span className={styles.flashDot} style={{ background: '#3b82f6' }} /><span className={styles.legendName}>Update</span></div>
    </div>
  )
}

// ─── Cache stats bar ──────────────────────────────────────────────────────────
function CacheStatsBar({ stats }: { stats: CacheStats }) {
  const total = stats.hits + stats.misses
  const hitRate = total > 0 ? Math.round((stats.hits / total) * 100) : null
  return (
    <div className={styles.cacheStatsBar}>
      <span className={styles.ctrlLabel}>Cache Stats:</span>
      <div className={styles.cacheStatItem}>
        <span className={styles.cacheStatDot} style={{ background: '#22c55e' }} />
        <span className={styles.cacheStatLabel}>Hits</span>
        <span className={styles.cacheStatCount} style={{ color: '#22c55e' }}>{stats.hits}</span>
      </div>
      <div className={styles.busStatDivider} />
      <div className={styles.cacheStatItem}>
        <span className={styles.cacheStatDot} style={{ background: '#f59e0b' }} />
        <span className={styles.cacheStatLabel}>Misses</span>
        <span className={styles.cacheStatCount} style={{ color: '#f59e0b' }}>{stats.misses}</span>
      </div>
      <div className={styles.busStatDivider} />
      <div className={styles.cacheStatItem}>
        <span className={styles.cacheStatDot} style={{ background: '#ef4444' }} />
        <span className={styles.cacheStatLabel}>Invalidations</span>
        <span className={styles.cacheStatCount} style={{ color: '#ef4444' }}>{stats.invalidations}</span>
      </div>
      <div className={styles.busStatDivider} />
      <div className={styles.cacheStatItem}>
        <span className={styles.cacheStatDot} style={{ background: '#a855f7' }} />
        <span className={styles.cacheStatLabel}>Writebacks</span>
        <span className={styles.cacheStatCount} style={{ color: '#a855f7' }}>{stats.writebacks}</span>
      </div>
      {hitRate !== null && (
        <>
          <div className={styles.busStatDivider} />
          <div className={styles.cacheStatItem}>
            <span className={styles.cacheStatDot} style={{ background: '#60a5fa' }} />
            <span className={styles.cacheStatLabel}>Hit Rate</span>
            <span className={styles.cacheStatCount} style={{ color: '#60a5fa' }}>{hitRate}%</span>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Interactive op panel ─────────────────────────────────────────────────────
const ADDRS = [
  { label: '0xA0', value: ADDR_A },
  { label: '0xB0', value: ADDR_B },
  { label: '0xC0', value: ADDR_C },
]

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
          <button key={p} className={`${styles.protoTab}${protocol === p ? ' ' + styles.protoTabActive : ''}`} onClick={() => onChange(p)}>
            {p}
          </button>
        ))}
      </div>
      <span className={styles.protoDesc}>{PROTO_DESC[protocol]}</span>
    </div>
  )
}

type OpHandler = (step: ReturnType<typeof computeRead>, compare: Partial<Record<Protocol, number>>, protocol: Protocol) => void

function buildCompare(opType: 'read' | 'write', coreId: number, address: number, newData: number, state: SimState) {
  const counts: Partial<Record<Protocol, number>> = {}
  for (const p of ['MSI', 'MESI', 'MOESI'] as Protocol[]) {
    const step = opType === 'read'
      ? computeRead(coreId, address, state, p)
      : computeWrite(coreId, address, newData, state, p)
    counts[p] = step.packets.length
  }
  return counts
}

function OpPanel({ state, onOp }: { state: SimState; onOp: OpHandler }) {
  const disabled = state.isAnimating || state.isPlaying
  return (
    <div className={styles.opPanel}>
      <div className={styles.opPanelTitle}>Operations — click to execute</div>
      <div className={styles.opGrid}>
        <div />
        {[0, 1, 2, 3].map(id => (
          <div key={id} className={styles.opGridHeader} style={{ color: CORE_ACCENT[id] }}>Core {id}</div>
        ))}
        {ADDRS.map(addr => (
          <>
            <div key={`lbl-${addr.value}`} className={styles.opAddrLabel}>{addr.label}</div>
            {[0, 1, 2, 3].map(coreId => (
              <div key={`cell-${addr.value}-${coreId}`} className={styles.opCell}>
                <button className={styles.btnRead} disabled={disabled}
                  onClick={() => {
                    const step = computeRead(coreId, addr.value, state, state.protocol)
                    const counts = buildCompare('read', coreId, addr.value, 0, state)
                    onOp(step, counts, state.protocol)
                  }}>Rd</button>
                <button className={styles.btnWrite} disabled={disabled}
                  onClick={() => {
                    const nd = nextWriteData(state, coreId, addr.value)
                    const step = computeWrite(coreId, addr.value, nd, state, state.protocol)
                    const counts = buildCompare('write', coreId, addr.value, nd, state)
                    onOp(step, counts, state.protocol)
                  }}>Wr</button>
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
            <span className={styles.busStatCount} style={{ color: STAT_COLOR[k] }}>{state.busStats[k]}</span>
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
  const { play, pause, stepForward, reset, playInteractiveOp, runProtocolDemo, runFalseSharingDemo } =
    useSimEngine(state, dispatch)

  const isDemo     = state.mode === 'demo'
  const isScenario = state.mode === 'scenario'
  const isInteract = state.mode === 'interactive'
  const isFS       = state.mode === 'falsesharing'

  const demoDone     = isDemo     && state.stepIndex >= SIM_STEPS.length
  const scenarioDone = isScenario && state.scenarioStep >= DEMO_OPS.length
  const anyDone      = demoDone || scenarioDone

  const displayProtocol = isDemo ? 'MESI' : state.protocol

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          {displayProtocol} Cache Coherence Simulator
        </h1>
        <Legend protocol={displayProtocol} />
      </header>

      <main className={styles.main}>
        {/* Left panel */}
        <aside className={styles.aside}>
          {isDemo     && <StepInfo stepIndex={state.stepIndex} />}
          {isScenario && <ScenarioInfo protocol={state.protocol} scenarioStep={state.scenarioStep} />}
          {isInteract && (
            <div className={styles.stepInfo}>
              <div className={styles.stepTitle}>Interactive Mode</div>
              <div className={styles.stepDesc}>
                Click <strong>Rd</strong> or <strong>Wr</strong> for any Core × Address.
                <br /><br />
                <span style={{ color: '#f59e0b' }}>Wr</span> writes current value + 1.
              </div>
            </div>
          )}
          {isFS && (
            <FalseSharingInfo
              fsStats={state.fsStats}
              isAnimating={state.isAnimating}
              onRunOn={() => runFalseSharingDemo('on')}
              onRunOff={() => runFalseSharingDemo('off')}
            />
          )}

          {/* Protocol key features card */}
          {(isScenario || isInteract) && <ProtocolKeyCard protocol={state.protocol} />}

          {/* What happened? — shown for all modes after first step */}
          {state.log.length > 0 && <WhatHappenedCard log={state.log} />}

          <EventLog entries={state.log} />
        </aside>

        {/* Simulator + controls */}
        <div className={styles.simWrap}>
          <div className={styles.simCanvas}>
            {state.cores.map((core, i) => (
              <CoreBox
                key={core.id}
                core={core}
                top={CORE_TOPS[i]}
                accentColor={CORE_ACCENT[i]}
                glowRgb={CORE_GLOW[i]}
              />
            ))}
            <div style={{ position: 'absolute', left: ML, top: MY - 52 }}>
              <MemoryBox entries={state.memory} active={state.memActive} />
            </div>
            <BusOverlay packets={state.packets} />
          </div>

          <CacheStatsBar stats={state.cacheStats} />

          {/* Controls */}
          <div className={styles.controls}>
            <div className={styles.modeTabs}>
              <button
                className={`${styles.modeTab}${(isDemo || isScenario) ? ' ' + styles.modeTabActive : ''}`}
                onClick={() => { dispatch({ type: 'SET_MODE', mode: 'demo' }); reset() }}
              >Demo</button>
              <button
                className={`${styles.modeTab}${isInteract ? ' ' + styles.modeTabActive : ''}`}
                onClick={() => { dispatch({ type: 'SET_MODE', mode: 'interactive' }); reset() }}
              >Interactive</button>
              <button
                className={`${styles.modeTab}${isFS ? ' ' + styles.modeTabActive : ''}`}
                onClick={() => { dispatch({ type: 'SET_MODE', mode: 'falsesharing' }); reset() }}
              >False Sharing</button>
            </div>

            {(isDemo || isScenario) && (
              <>
                <div className={styles.scenarioBtns}>
                  <span className={styles.ctrlLabel}>Run&nbsp;Demo</span>
                  {(['MSI', 'MESI', 'MOESI'] as Protocol[]).map(p => (
                    <button
                      key={p}
                      className={`${styles.btn} ${styles.btnScenario}${isScenario && state.protocol === p ? ' ' + styles.btnScenarioActive : ''}`}
                      onClick={() => runProtocolDemo(p)}
                      disabled={state.isAnimating}
                      title={PROTO_DESC[p]}
                    >{p}</button>
                  ))}
                  <button
                    className={`${styles.btn} ${styles.btnScenario}${isDemo ? ' ' + styles.btnScenarioActive : ''}`}
                    onClick={() => { dispatch({ type: 'SET_MODE', mode: 'demo' }); reset() }}
                    disabled={state.isAnimating}
                    title="Classic MESI walkthrough with descriptions"
                  >MESI Classic</button>
                </div>

                <div className={styles.ctrlBtns}>
                  {state.isPlaying
                    ? <button className={`${styles.btn} ${styles.btnPause}`} onClick={pause}>⏸ Pause</button>
                    : <button className={`${styles.btn} ${styles.btnPlay}`} onClick={play} disabled={anyDone && !isScenario}>
                        ▶ {anyDone ? 'Done' : (state.stepIndex === 0 && state.scenarioStep === 0) ? 'Play' : 'Resume'}
                      </button>
                  }
                  <button className={`${styles.btn} ${styles.btnStep}`} onClick={stepForward}
                    disabled={state.isPlaying || state.isAnimating || anyDone}>⏭ Step</button>
                  <button className={`${styles.btn} ${styles.btnReset}`} onClick={reset}>↺ Reset</button>
                </div>

                <div className={styles.ctrlSpeed}>
                  <span className={styles.ctrlLabel}>Speed</span>
                  {([0.5, 1, 2, 3] as const).map(v => (
                    <button key={v}
                      className={`${styles.btn} ${styles.btnSpeed}${state.speed === v ? ' ' + styles.btnSpeedActive : ''}`}
                      onClick={() => dispatch({ type: 'SET_SPEED', v })}>{v}×</button>
                  ))}
                </div>

                <div className={styles.ctrlProgress}>
                  <span className={styles.ctrlLabel}>Step</span>
                  <span className={styles.stepCounter}>
                    {isScenario
                      ? `${Math.min(state.scenarioStep, DEMO_OPS.length)}/${DEMO_OPS.length}`
                      : `${Math.min(state.stepIndex, SIM_STEPS.length)}/${SIM_STEPS.length}`}
                  </span>
                  <div className={styles.progressBar}>
                    <div className={styles.progressFill} style={{
                      width: isScenario
                        ? `${(Math.min(state.scenarioStep, DEMO_OPS.length) / DEMO_OPS.length) * 100}%`
                        : `${(Math.min(state.stepIndex, SIM_STEPS.length) / SIM_STEPS.length) * 100}%`,
                    }} />
                  </div>
                </div>
              </>
            )}

            {isInteract && (
              <>
                <div className={styles.ctrlSpeed}>
                  <span className={styles.ctrlLabel}>Speed</span>
                  {([0.5, 1, 2, 3] as const).map(v => (
                    <button key={v}
                      className={`${styles.btn} ${styles.btnSpeed}${state.speed === v ? ' ' + styles.btnSpeedActive : ''}`}
                      onClick={() => dispatch({ type: 'SET_SPEED', v })}>{v}×</button>
                  ))}
                </div>
                <button className={`${styles.btn} ${styles.btnReset}`} onClick={reset}>↺ Reset</button>
              </>
            )}

            {isFS && (
              <>
                <div className={styles.ctrlSpeed}>
                  <span className={styles.ctrlLabel}>Speed</span>
                  {([0.5, 1, 2, 3] as const).map(v => (
                    <button key={v}
                      className={`${styles.btn} ${styles.btnSpeed}${state.speed === v ? ' ' + styles.btnSpeedActive : ''}`}
                      onClick={() => dispatch({ type: 'SET_SPEED', v })}>{v}×</button>
                  ))}
                </div>
                <button className={`${styles.btn} ${styles.btnReset}`} onClick={reset}>↺ Reset</button>
              </>
            )}
          </div>

          {isFS && (
            <ProtocolSelector
              protocol={state.protocol}
              onChange={p => dispatch({ type: 'SET_PROTOCOL', protocol: p })}
            />
          )}

          {isInteract && (
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
