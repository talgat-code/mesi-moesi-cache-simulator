import type { SimState, MESIState, Protocol } from './types'
import type { SimStep, CacheChange, StepLog } from './steps'
import { PKT_COLOR, wpCoreToMem, wpMemToCore, wpCoreToBus, wpCoreToCore } from './steps'

const SEG = 420
const dur = (wps: [number, number][]) => (wps.length - 1) * SEG
const hex2 = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`
const hexA = (n: number) => `0x${n.toString(16).toUpperCase()}`

let _id = 0
const uid = (p: string) => `${p}_${++_id}`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function targetLine(state: SimState, coreId: number, address: number): number {
  const cache = state.cores[coreId].cache
  const existing = cache.find(l => l.address === address)
  if (existing) return existing.index
  const free = cache.find(l => l.state === 'I')
  if (free) return free.index
  for (const pref of ['S', 'E', 'O', 'M'] as MESIState[]) {
    const found = cache.find(l => l.state === pref)
    if (found) return found.index
  }
  return 0
}

function peers(state: SimState, coreId: number, address: number, ...states: MESIState[]) {
  return state.cores.filter(
    c => c.id !== coreId && c.cache.some(l => l.address === address && states.includes(l.state))
  )
}

function line(state: SimState, coreId: number, address: number) {
  return state.cores[coreId].cache.find(l => l.address === address)
}

function invalidLine(coreId: number, lineIndex: number): CacheChange {
  return { coreId, lineIndex, state: 'I', address: null, data: 0 }
}

// ─── READ ─────────────────────────────────────────────────────────────────────

export function computeRead(coreId: number, address: number, state: SimState, protocol: Protocol): SimStep {
  const addrHex = hexA(address)
  const myLine  = state.cores[coreId].cache.find(l => l.address === address)

  // ── HIT ──────────────────────────────────────────────────────────────────
  const validStates: MESIState[] =
    protocol === 'MSI'   ? ['M', 'S'] :
    protocol === 'MESI'  ? ['M', 'E', 'S'] :
    /* MOESI */            ['M', 'O', 'E', 'S']

  if (myLine && (validStates as string[]).includes(myLine.state)) {
    const s = myLine.state
    return {
      id: 0,
      title: `Core ${coreId} READ ${addrHex}`,
      subtitle: `Cache HIT — ${s}`,
      description: `Core ${coreId} reads ${addrHex}. Cache hit in state ${s}. No bus transaction.`,
      initiatorCore: coreId, isSilent: true,
      packets: [], snoopCores: [], snoopDelay: 0,
      cacheChanges: [{ coreId, lineIndex: myLine.index, state: s, address, data: myLine.data }],
      logs: [{ text: `Core ${coreId} READ ${addrHex}`, detail: `${s} → HIT`, kind: 'hit' }],
      totalMs: 800, changeMs: 200,
    }
  }

  // ── MISS ──────────────────────────────────────────────────────────────────
  const lineIdx  = targetLine(state, coreId, address)
  const memData  = state.memory.find(m => m.address === address)?.data ?? 0

  const [mPeer]  = peers(state, coreId, address, 'M')
  const [oPeer]  = protocol === 'MOESI' ? peers(state, coreId, address, 'O') : []
  const [ePeer]  = protocol !== 'MSI'   ? peers(state, coreId, address, 'E') : []
  const sPeers   = peers(state, coreId, address, 'S')

  // ── Case: M peer ──────────────────────────────────────────────────────────
  // MSI/MESI: M→S (Flush + writeback)
  // MOESI:    M→O (supply without memory writeback)
  if (mPeer) {
    const sl       = line(state, mPeer.id, address)!
    const data     = sl.data
    const reqWp    = wpCoreToBus(coreId)
    const supWp    = wpCoreToCore(mPeer.id, coreId)
    const snoopDly = 200 + dur(reqWp) + 100
    const supDly   = 200 + dur(reqWp) + 500
    const changeMs = supDly + dur(supWp) + 200
    const totalMs  = supDly + dur(supWp) + 700
    const newMState: MESIState = protocol === 'MOESI' ? 'O' : 'S'

    const changes: CacheChange[] = [
      { coreId, lineIndex: lineIdx, state: 'S', address, data },
      { coreId: mPeer.id, lineIndex: sl.index, state: newMState, address, data },
      ...sPeers.map(c => ({ coreId: c.id, lineIndex: line(state, c.id, address)!.index, state: 'S' as MESIState, address, data })),
    ]

    return {
      id: 0,
      title: `Core ${coreId} READ ${addrHex}`,
      subtitle: protocol === 'MOESI' ? 'Miss — M snoops: M→O (MOESI)' : 'Miss — M snoops: Flush, M→S',
      description:
        protocol === 'MOESI'
          ? `Core ${coreId} reads ${addrHex}. Miss — Core ${mPeer.id} has M, transitions to O (Owned dirty), supplies data without memory writeback.`
          : `Core ${coreId} reads ${addrHex}. Miss — Core ${mPeer.id} has M, flushes dirty data back to memory and transitions to S.`,
      initiatorCore: coreId, isSilent: false,
      packets: [
        { id: uid('req'), type: 'BusRead', label: `BusRd\n${addrHex}`,  color: PKT_COLOR.BusRead,  delay: 200,    waypoints: reqWp },
        { id: uid('sup'), type: protocol === 'MOESI' ? 'Supply' : 'Flush',
          label: `${protocol === 'MOESI' ? 'Supply' : 'Flush'}\n${hex2(data)}`,
          color: protocol === 'MOESI' ? PKT_COLOR.Supply : PKT_COLOR.Flush,
          delay: supDly, waypoints: supWp },
      ],
      snoopCores: [mPeer.id, ...sPeers.map(c => c.id)],
      snoopDelay: snoopDly,
      cacheChanges: changes,
      memChange: protocol !== 'MOESI' ? { address, data } : undefined,
      logs: [
        { text: `Core ${coreId} READ ${addrHex}`, detail: 'I → miss', kind: 'miss' },
        { text: `→ BusRd(${addrHex})`, detail: `Core ${mPeer.id} snoops — has M!`, kind: 'bus' },
        protocol === 'MOESI'
          ? { text: `Core ${mPeer.id}: M → O`, detail: 'MOESI Owned, supplies', kind: 'state' as const }
          : { text: `Core ${mPeer.id}: M → S`, detail: 'Flush → memory', kind: 'state' as const },
        { text: `Core ${coreId}: I → S`, detail: 'shared copy', kind: 'state' },
      ],
      totalMs, changeMs,
    }
  }

  // ── Case: O peer (MOESI only) ─────────────────────────────────────────────
  if (oPeer) {
    const sl       = line(state, oPeer.id, address)!
    const data     = sl.data
    const reqWp    = wpCoreToBus(coreId)
    const supWp    = wpCoreToCore(oPeer.id, coreId)
    const snoopDly = 200 + dur(reqWp) + 100
    const supDly   = 200 + dur(reqWp) + 500
    const changeMs = supDly + dur(supWp) + 200
    const totalMs  = supDly + dur(supWp) + 700

    return {
      id: 0,
      title: `Core ${coreId} READ ${addrHex}`,
      subtitle: 'Miss — O snoops: supplies data',
      description: `Core ${coreId} reads ${addrHex}. Miss — Core ${oPeer.id} has O (Owned dirty), supplies data. Requestor gets S.`,
      initiatorCore: coreId, isSilent: false,
      packets: [
        { id: uid('req'), type: 'BusRead', label: `BusRd\n${addrHex}`, color: PKT_COLOR.BusRead, delay: 200, waypoints: reqWp },
        { id: uid('sup'), type: 'Supply',  label: `Supply\n${hex2(data)}`, color: PKT_COLOR.Supply, delay: supDly, waypoints: supWp },
      ],
      snoopCores: [oPeer.id, ...sPeers.map(c => c.id)],
      snoopDelay: snoopDly,
      cacheChanges: [
        { coreId, lineIndex: lineIdx, state: 'S', address, data },
        { coreId: oPeer.id, lineIndex: sl.index, state: 'O', address, data },
        ...sPeers.map(c => ({ coreId: c.id, lineIndex: line(state, c.id, address)!.index, state: 'S' as MESIState, address, data })),
      ],
      logs: [
        { text: `Core ${coreId} READ ${addrHex}`, detail: 'I → miss', kind: 'miss' },
        { text: `→ BusRd(${addrHex})`, detail: `Core ${oPeer.id} snoops (O stays O)`, kind: 'bus' },
        { text: `Core ${oPeer.id}: O stays O`, detail: 'still owner, supplies', kind: 'state' },
        { text: `Core ${coreId}: I → S`, detail: '', kind: 'state' },
      ],
      totalMs, changeMs,
    }
  }

  // ── Case: E peer (MESI/MOESI) ─────────────────────────────────────────────
  if (ePeer) {
    const sl       = line(state, ePeer.id, address)!
    const reqWp    = wpCoreToMem(coreId)
    const supWp    = wpMemToCore(coreId)
    const snoopDly = 200 + dur(wpCoreToBus(coreId)) + 100
    const supDly   = 200 + dur(reqWp) + 300
    const changeMs = supDly + dur(supWp) + 200
    const totalMs  = supDly + dur(supWp) + 700

    return {
      id: 0,
      title: `Core ${coreId} READ ${addrHex}`,
      subtitle: 'Miss — E snoops: E→S',
      description: `Core ${coreId} reads ${addrHex}. Miss — Core ${ePeer.id} has E (sole clean copy), transitions to S. Memory supplies.`,
      initiatorCore: coreId, isSilent: false,
      packets: [
        { id: uid('req'), type: 'BusRead', label: `BusRd\n${addrHex}`,    color: PKT_COLOR.BusRead, delay: 200,   waypoints: reqWp },
        { id: uid('sup'), type: 'Supply',  label: `Supply\n${hex2(memData)}`, color: PKT_COLOR.Supply, delay: supDly, waypoints: supWp },
      ],
      snoopCores: [ePeer.id],
      snoopDelay: snoopDly,
      cacheChanges: [
        { coreId, lineIndex: lineIdx, state: 'S', address, data: memData },
        { coreId: ePeer.id, lineIndex: sl.index, state: 'S', address, data: memData },
      ],
      logs: [
        { text: `Core ${coreId} READ ${addrHex}`, detail: 'I → miss', kind: 'miss' },
        { text: `→ BusRd(${addrHex})`, detail: `Core ${ePeer.id} snoops (E)`, kind: 'bus' },
        { text: `Core ${ePeer.id}: E → S`, detail: 'MESI: was sole owner', kind: 'state' },
        { text: `Core ${coreId}: I → S`, detail: 'memory supplies', kind: 'state' },
      ],
      totalMs, changeMs,
    }
  }

  // ── Case: S peers only ─────────────────────────────────────────────────────
  if (sPeers.length > 0) {
    const reqWp    = wpCoreToMem(coreId)
    const supWp    = wpMemToCore(coreId)
    const snoopDly = 200 + dur(wpCoreToBus(coreId)) + 100
    const supDly   = 200 + dur(reqWp) + 300
    const changeMs = supDly + dur(supWp) + 200
    const totalMs  = supDly + dur(supWp) + 700

    return {
      id: 0,
      title: `Core ${coreId} READ ${addrHex}`,
      subtitle: 'Miss — join Shared',
      description: `Core ${coreId} reads ${addrHex}. Miss — ${sPeers.map(c => `Core ${c.id}`).join(', ')} already S. Memory supplies. All remain/become S.`,
      initiatorCore: coreId, isSilent: false,
      packets: [
        { id: uid('req'), type: 'BusRead', label: `BusRd\n${addrHex}`,    color: PKT_COLOR.BusRead, delay: 200,   waypoints: reqWp },
        { id: uid('sup'), type: 'Supply',  label: `Supply\n${hex2(memData)}`, color: PKT_COLOR.Supply, delay: supDly, waypoints: supWp },
      ],
      snoopCores: sPeers.map(c => c.id),
      snoopDelay: snoopDly,
      cacheChanges: [
        { coreId, lineIndex: lineIdx, state: 'S', address, data: memData },
        ...sPeers.map(c => ({ coreId: c.id, lineIndex: line(state, c.id, address)!.index, state: 'S' as MESIState, address, data: memData })),
      ],
      logs: [
        { text: `Core ${coreId} READ ${addrHex}`, detail: 'I → miss', kind: 'miss' },
        { text: `→ BusRd(${addrHex})`, detail: `${sPeers.map(c => `Core ${c.id}`).join(', ')} snoop (stay S)`, kind: 'bus' },
        { text: `Core ${coreId}: I → S`, detail: hex2(memData), kind: 'state' },
      ],
      totalMs, changeMs,
    }
  }

  // ── Case: cold miss — nobody has it ───────────────────────────────────────
  // MSI: requestor gets S (no E state in MSI)
  // MESI/MOESI: requestor gets E
  const reqWp    = wpCoreToMem(coreId)
  const supWp    = wpMemToCore(coreId)
  const supDly   = 200 + dur(reqWp) + 300
  const changeMs = supDly + dur(supWp) + 200
  const totalMs  = supDly + dur(supWp) + 700
  const coldState: MESIState = protocol === 'MSI' ? 'S' : 'E'
  const coldDetail = protocol === 'MSI'
    ? 'MSI: always S on miss'
    : 'MESI: sole copy → Exclusive'

  return {
    id: 0,
    title: `Core ${coreId} READ ${addrHex}`,
    subtitle: protocol === 'MSI' ? 'Miss → SHARED (MSI)' : 'Miss → EXCLUSIVE',
    description:
      protocol === 'MSI'
        ? `Core ${coreId} reads ${addrHex}. Miss — no other cache has this line. MSI always loads as S (no E state). Memory supplies.`
        : `Core ${coreId} reads ${addrHex}. Miss — no other cache has this line. Memory supplies. Core ${coreId} gets EXCLUSIVE.`,
    initiatorCore: coreId, isSilent: false,
    packets: [
      { id: uid('req'), type: 'BusRead', label: `BusRd\n${addrHex}`,    color: PKT_COLOR.BusRead, delay: 200,   waypoints: reqWp },
      { id: uid('sup'), type: 'Supply',  label: `Supply\n${hex2(memData)}`, color: PKT_COLOR.Supply, delay: supDly, waypoints: supWp },
    ],
    snoopCores: [], snoopDelay: 0,
    cacheChanges: [{ coreId, lineIndex: lineIdx, state: coldState, address, data: memData }],
    logs: [
      { text: `Core ${coreId} READ ${addrHex}`, detail: 'I → miss', kind: 'miss' },
      { text: `→ BusRd(${addrHex})`, detail: 'no other copies', kind: 'bus' },
      { text: `Core ${coreId}: I → ${coldState}`, detail: coldDetail, kind: 'state' },
    ],
    totalMs, changeMs,
  }
}

// ─── WRITE ────────────────────────────────────────────────────────────────────

export function computeWrite(coreId: number, address: number, newData: number, state: SimState, protocol: Protocol): SimStep {
  const addrHex   = hexA(address)
  const myLine    = state.cores[coreId].cache.find(l => l.address === address)
  const curState: MESIState = myLine?.state ?? 'I'

  // ── HIT M: silent write ───────────────────────────────────────────────────
  if (curState === 'M') {
    return {
      id: 0,
      title: `Core ${coreId} WRITE ${addrHex}`,
      subtitle: 'HIT M → silent write',
      description: `Core ${coreId} writes ${addrHex}. M state — sole dirty owner. No bus transaction.`,
      initiatorCore: coreId, isSilent: true,
      packets: [], snoopCores: [], snoopDelay: 0,
      cacheChanges: [{ coreId, lineIndex: myLine!.index, state: 'M', address, data: newData }],
      logs: [
        { text: `Core ${coreId} WRITE ${addrHex} ← ${hex2(newData)}`, detail: 'M → HIT', kind: 'hit' },
        { text: 'SILENT WRITE (already M)', detail: 'no bus transaction', kind: 'silent' },
      ],
      totalMs: 800, changeMs: 200,
    }
  }

  // ── HIT E: silent E→M (MESI/MOESI only) ──────────────────────────────────
  if (curState === 'E' && protocol !== 'MSI') {
    return {
      id: 0,
      title: `Core ${coreId} WRITE ${addrHex}`,
      subtitle: 'HIT E → silent E→M',
      description: `Core ${coreId} writes ${addrHex}. E state — sole owner. Silent upgrade E→M. No bus transaction — key ${protocol} optimization.`,
      initiatorCore: coreId, isSilent: true,
      packets: [], snoopCores: [], snoopDelay: 0,
      cacheChanges: [{ coreId, lineIndex: myLine!.index, state: 'M', address, data: newData }],
      logs: [
        { text: `Core ${coreId} WRITE ${addrHex} ← ${hex2(newData)}`, detail: 'E → HIT', kind: 'hit' },
        { text: `SILENT E→M (${protocol})`, detail: 'no bus transaction!', kind: 'silent' },
        { text: `Core ${coreId}: E → M`, detail: '', kind: 'state' },
      ],
      totalMs: 1200, changeMs: 400,
    }
  }

  // ── HIT S: needs upgrade ───────────────────────────────────────────────────
  // MSI: use BusRdX (no BusUpgr in MSI — bus events are BusRd, BusRdX, Flush)
  // MESI/MOESI: use BusUpgr (no data needed, just invalidation)
  if (curState === 'S') {
    const useBusRdX  = protocol === 'MSI'
    const busWp      = wpCoreToBus(coreId)
    const snoopDly   = 200 + dur(busWp) + 100
    const changeMs   = snoopDly + 600
    const totalMs    = snoopDly + 1200
    const invalids   = peers(state, coreId, address, 'S', 'O')
    const pktType    = useBusRdX ? 'BusReadX' : 'BusUpgr'
    const pktLabel   = useBusRdX ? 'BusRdX' : 'BusUpgr'

    const changes: CacheChange[] = [
      { coreId, lineIndex: myLine!.index, state: 'M', address, data: newData },
      ...invalids.map(c => invalidLine(c.id, line(state, c.id, address)!.index)),
    ]
    const logs: StepLog[] = [
      { text: `Core ${coreId} WRITE ${addrHex} ← ${hex2(newData)}`, detail: 'S → needs upgrade', kind: 'hit' },
      { text: `→ ${pktLabel}(${addrHex})`, detail: useBusRdX ? 'MSI: no BusUpgr' : 'no data on bus', kind: 'bus' },
      ...invalids.map(c => ({ text: `Core ${c.id}: ${line(state, c.id, address)!.state} → I`, detail: 'invalidated', kind: 'state' as const })),
      { text: `Core ${coreId}: S → M`, detail: 'sole dirty owner', kind: 'state' as const },
    ]

    return {
      id: 0,
      title: `Core ${coreId} WRITE ${addrHex}`,
      subtitle: `Write Upgrade: S→M via ${pktLabel}`,
      description: `Core ${coreId} writes ${addrHex}. Has S — sends ${pktLabel}. ${invalids.length} other copy(ies) invalidated. Core ${coreId} becomes M.`,
      initiatorCore: coreId, isSilent: false,
      packets: [{ id: uid('upg'), type: pktType, label: `${pktLabel}\n${addrHex}`, color: PKT_COLOR[pktType], delay: 200, waypoints: busWp }],
      snoopCores: invalids.map(c => c.id), snoopDelay: snoopDly,
      cacheChanges: changes, logs,
      totalMs, changeMs,
    }
  }

  // ── HIT O: BusUpgr O→M (MOESI only) ──────────────────────────────────────
  if (curState === 'O') {
    const busWp    = wpCoreToBus(coreId)
    const snoopDly = 200 + dur(busWp) + 100
    const changeMs = snoopDly + 600
    const totalMs  = snoopDly + 1200
    const invalids = peers(state, coreId, address, 'S', 'O')

    return {
      id: 0,
      title: `Core ${coreId} WRITE ${addrHex}`,
      subtitle: 'Write Upgrade: O→M via BusUpgr',
      description: `Core ${coreId} writes ${addrHex}. Has O (Owned dirty) — sends BusUpgr. Other copies invalidated. Core ${coreId} becomes M.`,
      initiatorCore: coreId, isSilent: false,
      packets: [{ id: uid('upg'), type: 'BusUpgr', label: `BusUpgr\n${addrHex}`, color: PKT_COLOR.BusUpgr, delay: 200, waypoints: busWp }],
      snoopCores: invalids.map(c => c.id), snoopDelay: snoopDly,
      cacheChanges: [
        { coreId, lineIndex: myLine!.index, state: 'M', address, data: newData },
        ...invalids.map(c => invalidLine(c.id, line(state, c.id, address)!.index)),
      ],
      logs: [
        { text: `Core ${coreId} WRITE ${addrHex} ← ${hex2(newData)}`, detail: 'O → needs upgrade', kind: 'hit' },
        { text: `→ BusUpgr(${addrHex})`, detail: '', kind: 'bus' },
        ...invalids.map(c => ({ text: `Core ${c.id}: S → I`, detail: 'invalidated', kind: 'state' as const })),
        { text: `Core ${coreId}: O → M`, detail: 'sole dirty owner', kind: 'state' as const },
      ],
      totalMs, changeMs,
    }
  }

  // ── MISS I: BusRdX ────────────────────────────────────────────────────────
  const lineIdx  = targetLine(state, coreId, address)
  const memData  = state.memory.find(m => m.address === address)?.data ?? 0

  const [mPeer] = peers(state, coreId, address, 'M')
  const [oPeer] = protocol === 'MOESI' ? peers(state, coreId, address, 'O') : []
  const [ePeer] = protocol !== 'MSI'   ? peers(state, coreId, address, 'E') : []
  const sPeers  = peers(state, coreId, address, 'S')

  // M or O flushes, supplies
  const flusher = mPeer ?? oPeer
  if (flusher) {
    const sl         = line(state, flusher.id, address)!
    const flushedSt  = sl.state
    const data       = sl.data
    const busRxWp    = wpCoreToBus(coreId)
    const flushWp    = wpCoreToCore(flusher.id, coreId)
    const snoopDly   = 200 + dur(busRxWp) + 100
    const flushDly   = 200 + dur(busRxWp) + 500
    const changeMs   = flushDly + dur(flushWp) + 200
    const totalMs    = flushDly + dur(flushWp) + 700
    const invalids   = peers(state, coreId, address, 'S', 'O', 'E').filter(c => c.id !== flusher.id)

    return {
      id: 0,
      title: `Core ${coreId} WRITE ${addrHex}`,
      subtitle: 'Write Miss → BusRdX, Flush',
      description: `Core ${coreId} writes ${addrHex}. Miss — Core ${flusher.id} has ${flushedSt}, flushes. Core ${coreId} gets M.`,
      initiatorCore: coreId, isSilent: false,
      packets: [
        { id: uid('rx'),  type: 'BusReadX', label: `BusRdX\n${addrHex}`, color: PKT_COLOR.BusReadX, delay: 200,      waypoints: busRxWp },
        { id: uid('flu'), type: 'Flush',    label: `Flush\n${hex2(data)}`, color: PKT_COLOR.Flush,    delay: flushDly, waypoints: flushWp },
      ],
      snoopCores: [flusher.id, ...invalids.map(c => c.id)],
      snoopDelay: snoopDly,
      cacheChanges: [
        { coreId, lineIndex: lineIdx, state: 'M', address, data: newData },
        invalidLine(flusher.id, sl.index),
        ...invalids.map(c => invalidLine(c.id, line(state, c.id, address)!.index)),
      ],
      memChange: flushedSt === 'M' ? { address, data } : undefined,
      logs: [
        { text: `Core ${coreId} WRITE ${addrHex} ← ${hex2(newData)}`, detail: 'I → write miss', kind: 'miss' },
        { text: `→ BusRdX(${addrHex})`, detail: `Core ${flusher.id} snoops (${flushedSt})`, kind: 'bus' },
        { text: `Core ${flusher.id} FLUSH`, detail: `${flushedSt}→I, supplies`, kind: 'bus' },
        { text: `Core ${coreId}: I → M`, detail: `writes ${hex2(newData)}`, kind: 'state' },
        ...invalids.map(c => ({ text: `Core ${c.id}: ${line(state, c.id, address)!.state} → I`, detail: 'invalidated', kind: 'state' as const })),
      ],
      totalMs, changeMs,
    }
  }

  // E only → E→I, memory supplies
  if (ePeer) {
    const sl       = line(state, ePeer.id, address)!
    const busRxWp  = wpCoreToMem(coreId)
    const supWp    = wpMemToCore(coreId)
    const snoopDly = 200 + dur(wpCoreToBus(coreId)) + 100
    const supDly   = 200 + dur(busRxWp) + 300
    const changeMs = supDly + dur(supWp) + 200
    const totalMs  = supDly + dur(supWp) + 700

    return {
      id: 0,
      title: `Core ${coreId} WRITE ${addrHex}`,
      subtitle: 'Write Miss → BusRdX',
      description: `Core ${coreId} writes ${addrHex}. Miss — Core ${ePeer.id} has E (→I). Memory supplies. Core ${coreId} gets M.`,
      initiatorCore: coreId, isSilent: false,
      packets: [
        { id: uid('rx'),  type: 'BusReadX', label: `BusRdX\n${addrHex}`,    color: PKT_COLOR.BusReadX, delay: 200,   waypoints: busRxWp },
        { id: uid('sup'), type: 'Supply',   label: `Supply\n${hex2(memData)}`, color: PKT_COLOR.Supply, delay: supDly, waypoints: supWp },
      ],
      snoopCores: [ePeer.id], snoopDelay: snoopDly,
      cacheChanges: [
        { coreId, lineIndex: lineIdx, state: 'M', address, data: newData },
        invalidLine(ePeer.id, sl.index),
      ],
      logs: [
        { text: `Core ${coreId} WRITE ${addrHex} ← ${hex2(newData)}`, detail: 'I → write miss', kind: 'miss' },
        { text: `→ BusRdX(${addrHex})`, detail: `Core ${ePeer.id} snoops (E)`, kind: 'bus' },
        { text: `Core ${ePeer.id}: E → I`, detail: 'invalidated', kind: 'state' },
        { text: `Core ${coreId}: I → M`, detail: `writes ${hex2(newData)}`, kind: 'state' },
      ],
      totalMs, changeMs,
    }
  }

  // S only, or nobody — memory supplies
  const busRxWp  = wpCoreToMem(coreId)
  const supWp    = wpMemToCore(coreId)
  const snoopDly = 200 + dur(wpCoreToBus(coreId)) + 100
  const supDly   = 200 + dur(busRxWp) + 300
  const changeMs = supDly + dur(supWp) + 200
  const totalMs  = supDly + dur(supWp) + 700

  return {
    id: 0,
    title: `Core ${coreId} WRITE ${addrHex}`,
    subtitle: sPeers.length > 0 ? 'Write Miss → BusRdX, invalidate S' : 'Write Miss → BusRdX',
    description: `Core ${coreId} writes ${addrHex}. Miss${sPeers.length > 0 ? ` — ${sPeers.map(c => `Core ${c.id}`).join(', ')} invalidated` : ''}. Memory supplies. Core ${coreId} gets M.`,
    initiatorCore: coreId, isSilent: false,
    packets: [
      { id: uid('rx'),  type: 'BusReadX', label: `BusRdX\n${addrHex}`,    color: PKT_COLOR.BusReadX, delay: 200,   waypoints: busRxWp },
      { id: uid('sup'), type: 'Supply',   label: `Supply\n${hex2(memData)}`, color: PKT_COLOR.Supply, delay: supDly, waypoints: supWp },
    ],
    snoopCores: sPeers.map(c => c.id), snoopDelay: snoopDly,
    cacheChanges: [
      { coreId, lineIndex: lineIdx, state: 'M', address, data: newData },
      ...sPeers.map(c => invalidLine(c.id, line(state, c.id, address)!.index)),
    ],
    logs: [
      { text: `Core ${coreId} WRITE ${addrHex} ← ${hex2(newData)}`, detail: 'I → write miss', kind: 'miss' },
      { text: `→ BusRdX(${addrHex})`, detail: sPeers.length > 0 ? `${sPeers.map(c => `Core ${c.id}`).join(', ')} invalidated` : 'no other copies', kind: 'bus' },
      { text: `Core ${coreId}: I → M`, detail: `writes ${hex2(newData)}`, kind: 'state' },
    ],
    totalMs, changeMs,
  }
}
