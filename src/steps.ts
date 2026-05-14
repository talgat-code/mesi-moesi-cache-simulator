import type { MESIState, PktType } from './types'

// ── Layout constants (pixels, within the 900×540 simulator container) ──
export const CR = 230   // core box right edge
export const BX = 375   // bus x
export const ML = 445   // memory left edge
export const MY = 280   // memory center y
export const CY = [70, 190, 310, 430] as const  // core center y per id

// ── Packet colors ──
export const PKT_COLOR: Record<PktType, string> = {
  BusRead:  '#f59e0b',
  BusReadX: '#ef4444',
  BusUpgr:  '#f97316',
  Flush:    '#a855f7',
  Supply:   '#06b6d4',
}

// ── Waypoint helpers ──
type WP = [number, number]
export const wpCoreToMem  = (n: number): WP[] => [[CR, CY[n]], [BX, CY[n]], [BX, MY], [ML, MY]]
export const wpMemToCore  = (n: number): WP[] => [[ML, MY], [BX, MY], [BX, CY[n]], [CR, CY[n]]]
export const wpCoreToBus  = (n: number): WP[] => [[CR, CY[n]], [BX, CY[n]]]
export const wpCoreToCore = (a: number, b: number): WP[] => [[CR, CY[a]], [BX, CY[a]], [BX, CY[b]], [CR, CY[b]]]

// ── Step data types ──
export interface StepPkt {
  id: string
  type: PktType
  label: string
  color: string
  delay: number      // ms from step start before packet appears
  waypoints: WP[]
}

export interface CacheChange {
  coreId: number
  lineIndex: number
  state: MESIState
  address: number | null
  data: number
}

export interface StepLog {
  text: string
  detail: string
  kind: 'miss' | 'hit' | 'bus' | 'state' | 'silent' | 'info'
}

export interface SimStep {
  id: number
  title: string
  subtitle: string
  description: string
  initiatorCore: number
  isSilent: boolean
  packets: StepPkt[]
  snoopCores: number[]
  snoopDelay: number
  cacheChanges: CacheChange[]
  memChange?: { address: number; data: number }
  logs: StepLog[]
  totalMs: number
  changeMs: number
}

// ── Timing ──
const SEG = 420   // ms per waypoint segment
const dur = (wps: WP[]) => (wps.length - 1) * SEG

// ── Addresses ──
export const ADDR_A = 0xa0
export const ADDR_B = 0xb0

export const INITIAL_MEM: [number, number][] = [
  [ADDR_A, 0x42],
  [ADDR_B, 0x73],
]

// ── The 9 simulation steps ──
export const SIM_STEPS: SimStep[] = [
  // ─── Step 1: Core 0 READ 0xA0 → miss → BusRead → Memory → E ───
  {
    id: 1,
    title: 'Core 0  READ  0xA0',
    subtitle: 'Cache Miss → EXCLUSIVE',
    description:
      'Core 0 reads 0xA0. Cache miss — sends BusRead on the bus. ' +
      'No other core has this line, so memory supplies data 0x42. ' +
      'Core 0 gets EXCLUSIVE state (only copy, clean).',
    initiatorCore: 0,
    isSilent: false,
    packets: [
      {
        id: 's1_req', type: 'BusRead', label: 'BusRead\n0xA0', color: PKT_COLOR.BusRead,
        delay: 200, waypoints: wpCoreToMem(0),
      },
      {
        id: 's1_rsp', type: 'Supply', label: 'Supply\n0x42', color: PKT_COLOR.Supply,
        delay: 200 + dur(wpCoreToMem(0)) + 300, waypoints: wpMemToCore(0),
      },
    ],
    snoopCores: [], snoopDelay: 0,
    cacheChanges: [{ coreId: 0, lineIndex: 0, state: 'E', address: ADDR_A, data: 0x42 }],
    logs: [
      { text: 'Core 0 READ 0xA0', detail: 'I → miss', kind: 'miss' },
      { text: '→ BusRead(0xA0)', detail: 'broadcast on bus', kind: 'bus' },
      { text: '← Memory supplies 0x42', detail: 'no snoops', kind: 'bus' },
      { text: 'Core 0: I → E', detail: 'Exclusive owner', kind: 'state' },
    ],
    totalMs:  200 + dur(wpCoreToMem(0)) + 300 + dur(wpMemToCore(0)) + 700,
    changeMs: 200 + dur(wpCoreToMem(0)) + 300 + dur(wpMemToCore(0)) + 200,
  },

  // ─── Step 2: Core 1 READ 0xA0 → E→S, Core 1 gets S ───
  {
    id: 2,
    title: 'Core 1  READ  0xA0',
    subtitle: 'E→S: Shared transition',
    description:
      'Core 1 reads 0xA0. Cache miss — sends BusRead. ' +
      'Core 0 snoops and sees BusRead: transitions E→S, supplies data. ' +
      'Both cores now have SHARED state.',
    initiatorCore: 1,
    isSilent: false,
    packets: [
      {
        id: 's2_req', type: 'BusRead', label: 'BusRead\n0xA0', color: PKT_COLOR.BusRead,
        delay: 200, waypoints: wpCoreToBus(1),
      },
      {
        id: 's2_sup', type: 'Supply', label: 'Supply\n0x42', color: PKT_COLOR.Supply,
        delay: 200 + dur(wpCoreToBus(1)) + 400, waypoints: wpCoreToCore(0, 1),
      },
    ],
    snoopCores: [0], snoopDelay: 200 + dur(wpCoreToBus(1)) + 100,
    cacheChanges: [
      { coreId: 0, lineIndex: 0, state: 'S', address: ADDR_A, data: 0x42 },
      { coreId: 1, lineIndex: 0, state: 'S', address: ADDR_A, data: 0x42 },
    ],
    logs: [
      { text: 'Core 1 READ 0xA0', detail: 'I → miss', kind: 'miss' },
      { text: '→ BusRead(0xA0)', detail: 'Core 0 snoops!', kind: 'bus' },
      { text: 'Core 0: E → S', detail: 'supplies data', kind: 'state' },
      { text: 'Core 1: I → S', detail: 'gets shared copy', kind: 'state' },
    ],
    totalMs:  200 + dur(wpCoreToBus(1)) + 400 + dur(wpCoreToCore(0, 1)) + 700,
    changeMs: 200 + dur(wpCoreToBus(1)) + 400 + dur(wpCoreToCore(0, 1)) + 200,
  },

  // ─── Step 3: Core 2 READ 0xA0 → both stay S, Core 2 gets S ───
  {
    id: 3,
    title: 'Core 2  READ  0xA0',
    subtitle: 'Multi-core SHARED',
    description:
      'Core 2 reads 0xA0. Cache miss — sends BusRead. ' +
      'Cores 0 and 1 both snoop but stay in S. ' +
      'Memory supplies data. Core 2 also gets SHARED.',
    initiatorCore: 2,
    isSilent: false,
    packets: [
      {
        id: 's3_req', type: 'BusRead', label: 'BusRead\n0xA0', color: PKT_COLOR.BusRead,
        delay: 200, waypoints: wpCoreToMem(2),
      },
      {
        id: 's3_rsp', type: 'Supply', label: 'Supply\n0x42', color: PKT_COLOR.Supply,
        delay: 200 + dur(wpCoreToMem(2)) + 300, waypoints: wpMemToCore(2),
      },
    ],
    snoopCores: [0, 1], snoopDelay: 200 + dur(wpCoreToBus(2)) + 100,
    cacheChanges: [
      { coreId: 2, lineIndex: 0, state: 'S', address: ADDR_A, data: 0x42 },
    ],
    logs: [
      { text: 'Core 2 READ 0xA0', detail: 'I → miss', kind: 'miss' },
      { text: '→ BusRead(0xA0)', detail: 'Cores 0,1 snoop (stay S)', kind: 'bus' },
      { text: '← Memory supplies 0x42', detail: '', kind: 'bus' },
      { text: 'Core 2: I → S', detail: '3 cores share this line', kind: 'state' },
    ],
    totalMs:  200 + dur(wpCoreToMem(2)) + 300 + dur(wpMemToCore(2)) + 700,
    changeMs: 200 + dur(wpCoreToMem(2)) + 300 + dur(wpMemToCore(2)) + 200,
  },

  // ─── Step 4: Core 0 WRITE 0xA0=0xFF → BusUpgr → Core 1,2 → I, Core 0 → M ───
  {
    id: 4,
    title: 'Core 0  WRITE  0xA0 = 0xFF',
    subtitle: 'Write Upgrade: S→M + Invalidation',
    description:
      'Core 0 writes 0xA0. Has S state — data already in cache! ' +
      'Sends BusUpgr (upgrade, no data fetch needed). ' +
      'Cores 1 and 2 invalidate their copies (S→I). ' +
      'Core 0 becomes sole MODIFIED owner.',
    initiatorCore: 0,
    isSilent: false,
    packets: [
      {
        id: 's4_upg', type: 'BusUpgr', label: 'BusUpgr\n0xA0', color: PKT_COLOR.BusUpgr,
        delay: 200, waypoints: wpCoreToBus(0),
      },
    ],
    snoopCores: [1, 2], snoopDelay: 200 + dur(wpCoreToBus(0)) + 100,
    cacheChanges: [
      { coreId: 0, lineIndex: 0, state: 'M', address: ADDR_A, data: 0xff },
      { coreId: 1, lineIndex: 0, state: 'I', address: null, data: 0 },
      { coreId: 2, lineIndex: 0, state: 'I', address: null, data: 0 },
    ],
    logs: [
      { text: 'Core 0 WRITE 0xA0 ← 0xFF', detail: 'S → hit, needs upgrade', kind: 'hit' },
      { text: '→ BusUpgr(0xA0)', detail: 'no data on bus', kind: 'bus' },
      { text: 'Core 1: S → I', detail: 'invalidated', kind: 'state' },
      { text: 'Core 2: S → I', detail: 'invalidated', kind: 'state' },
      { text: 'Core 0: S → M', detail: 'sole dirty owner', kind: 'state' },
    ],
    totalMs:  200 + dur(wpCoreToBus(0)) + 100 + 1200,
    changeMs: 200 + dur(wpCoreToBus(0)) + 100 + 600,
  },

  // ─── Step 5: Core 3 READ 0xB0 → miss → E ───
  {
    id: 5,
    title: 'Core 3  READ  0xB0',
    subtitle: 'Cache Miss → EXCLUSIVE',
    description:
      'Core 3 reads address 0xB0. Cache miss — sends BusRead. ' +
      'No other core has this line. Memory supplies 0x73. ' +
      'Core 3 gets EXCLUSIVE state.',
    initiatorCore: 3,
    isSilent: false,
    packets: [
      {
        id: 's5_req', type: 'BusRead', label: 'BusRead\n0xB0', color: PKT_COLOR.BusRead,
        delay: 200, waypoints: wpCoreToMem(3),
      },
      {
        id: 's5_rsp', type: 'Supply', label: 'Supply\n0x73', color: PKT_COLOR.Supply,
        delay: 200 + dur(wpCoreToMem(3)) + 300, waypoints: wpMemToCore(3),
      },
    ],
    snoopCores: [], snoopDelay: 0,
    cacheChanges: [{ coreId: 3, lineIndex: 1, state: 'E', address: ADDR_B, data: 0x73 }],
    logs: [
      { text: 'Core 3 READ 0xB0', detail: 'I → miss', kind: 'miss' },
      { text: '→ BusRead(0xB0)', detail: 'no snoops', kind: 'bus' },
      { text: '← Memory supplies 0x73', detail: '', kind: 'bus' },
      { text: 'Core 3: I → E', detail: 'Exclusive owner', kind: 'state' },
    ],
    totalMs:  200 + dur(wpCoreToMem(3)) + 300 + dur(wpMemToCore(3)) + 700,
    changeMs: 200 + dur(wpCoreToMem(3)) + 300 + dur(wpMemToCore(3)) + 200,
  },

  // ─── Step 6: Core 3 WRITE 0xB0=0x99 → E→M SILENT (no bus!) ───
  {
    id: 6,
    title: 'Core 3  WRITE  0xB0 = 0x99',
    subtitle: 'Silent Upgrade: E→M (no bus!)',
    description:
      'Core 3 writes 0xB0. Has EXCLUSIVE state — it is the only owner! ' +
      'No bus transaction needed. Core 3 silently upgrades E→M. ' +
      'This is a key MESI optimization.',
    initiatorCore: 3,
    isSilent: true,
    packets: [],
    snoopCores: [], snoopDelay: 0,
    cacheChanges: [{ coreId: 3, lineIndex: 1, state: 'M', address: ADDR_B, data: 0x99 }],
    logs: [
      { text: 'Core 3 WRITE 0xB0 ← 0x99', detail: 'E → hit!', kind: 'hit' },
      { text: 'SILENT UPGRADE E→M', detail: 'no bus transaction!', kind: 'silent' },
      { text: 'Core 3: E → M', detail: 'dirty, no one else has it', kind: 'state' },
    ],
    totalMs:  1600,
    changeMs: 700,
  },

  // ─── Step 7: Core 1 READ 0xA0 (I) → BusRead → Core 0 Flush M→S → Core 1 S ───
  {
    id: 7,
    title: 'Core 1  READ  0xA0',
    subtitle: 'M→S Flush on Snoop',
    description:
      'Core 1 reads 0xA0 (was invalidated in step 4). Cache miss — sends BusRead. ' +
      'Core 0 snoops: has MODIFIED! Must flush — writes 0xFF back to memory, ' +
      'supplies to Core 1, transitions M→S. Core 1 gets S.',
    initiatorCore: 1,
    isSilent: false,
    packets: [
      {
        id: 's7_req', type: 'BusRead', label: 'BusRead\n0xA0', color: PKT_COLOR.BusRead,
        delay: 200, waypoints: wpCoreToBus(1),
      },
      {
        id: 's7_flu', type: 'Flush', label: 'Flush\n0xFF', color: PKT_COLOR.Flush,
        delay: 200 + dur(wpCoreToBus(1)) + 500, waypoints: wpCoreToCore(0, 1),
      },
    ],
    snoopCores: [0], snoopDelay: 200 + dur(wpCoreToBus(1)) + 100,
    cacheChanges: [
      { coreId: 0, lineIndex: 0, state: 'S', address: ADDR_A, data: 0xff },
      { coreId: 1, lineIndex: 0, state: 'S', address: ADDR_A, data: 0xff },
    ],
    memChange: { address: ADDR_A, data: 0xff },
    logs: [
      { text: 'Core 1 READ 0xA0', detail: 'I → miss', kind: 'miss' },
      { text: '→ BusRead(0xA0)', detail: 'Core 0 snoops — has M!', kind: 'bus' },
      { text: 'Core 0 FLUSH 0xFF', detail: 'M→S, writeback to memory', kind: 'bus' },
      { text: 'Core 0: M → S', detail: 'wrote back dirty data', kind: 'state' },
      { text: 'Core 1: I → S', detail: 'receives flushed data', kind: 'state' },
    ],
    totalMs:  200 + dur(wpCoreToBus(1)) + 500 + dur(wpCoreToCore(0, 1)) + 700,
    changeMs: 200 + dur(wpCoreToBus(1)) + 500 + dur(wpCoreToCore(0, 1)) + 200,
  },

  // ─── Step 8: Core 2 WRITE 0xA0=0xAA → BusReadX → Core 0,1 I → Core 2 M ───
  {
    id: 8,
    title: 'Core 2  WRITE  0xA0 = 0xAA',
    subtitle: 'Write Miss → BusReadX',
    description:
      'Core 2 writes 0xA0 (was invalidated). Cache miss with write intent — sends BusReadX. ' +
      'Cores 0 and 1 snoop and invalidate (S→I). ' +
      'Memory supplies old data, Core 2 overwrites → MODIFIED.',
    initiatorCore: 2,
    isSilent: false,
    packets: [
      {
        id: 's8_req', type: 'BusReadX', label: 'BusReadX\n0xA0', color: PKT_COLOR.BusReadX,
        delay: 200, waypoints: wpCoreToMem(2),
      },
      {
        id: 's8_rsp', type: 'Supply', label: 'Supply\n0xFF', color: PKT_COLOR.Supply,
        delay: 200 + dur(wpCoreToMem(2)) + 300, waypoints: wpMemToCore(2),
      },
    ],
    snoopCores: [0, 1], snoopDelay: 200 + dur(wpCoreToBus(2)) + 100,
    cacheChanges: [
      { coreId: 0, lineIndex: 0, state: 'I', address: null, data: 0 },
      { coreId: 1, lineIndex: 0, state: 'I', address: null, data: 0 },
      { coreId: 2, lineIndex: 0, state: 'M', address: ADDR_A, data: 0xaa },
    ],
    logs: [
      { text: 'Core 2 WRITE 0xA0 ← 0xAA', detail: 'I → write miss', kind: 'miss' },
      { text: '→ BusReadX(0xA0)', detail: 'read exclusive intent', kind: 'bus' },
      { text: 'Core 0: S → I', detail: 'invalidated', kind: 'state' },
      { text: 'Core 1: S → I', detail: 'invalidated', kind: 'state' },
      { text: 'Core 2: I → M', detail: 'writes 0xAA', kind: 'state' },
    ],
    totalMs:  200 + dur(wpCoreToMem(2)) + 300 + dur(wpMemToCore(2)) + 700,
    changeMs: 200 + dur(wpCoreToMem(2)) + 300 + dur(wpMemToCore(2)) + 200,
  },

  // ─── Step 9: Core 0 READ 0xB0 → Core 3 Flush M→S → Core 0 S ───
  {
    id: 9,
    title: 'Core 0  READ  0xB0',
    subtitle: 'M→S Flush on Snoop (again)',
    description:
      'Core 0 reads 0xB0 (never cached). Cache miss — sends BusRead. ' +
      'Core 3 snoops: has MODIFIED 0x99! Flushes to memory, supplies to Core 0, transitions M→S. ' +
      'Both cores now SHARED.',
    initiatorCore: 0,
    isSilent: false,
    packets: [
      {
        id: 's9_req', type: 'BusRead', label: 'BusRead\n0xB0', color: PKT_COLOR.BusRead,
        delay: 200, waypoints: wpCoreToBus(0),
      },
      {
        id: 's9_flu', type: 'Flush', label: 'Flush\n0x99', color: PKT_COLOR.Flush,
        delay: 200 + dur(wpCoreToBus(0)) + 500, waypoints: wpCoreToCore(3, 0),
      },
    ],
    snoopCores: [3], snoopDelay: 200 + dur(wpCoreToBus(0)) + 100,
    cacheChanges: [
      { coreId: 0, lineIndex: 1, state: 'S', address: ADDR_B, data: 0x99 },
      { coreId: 3, lineIndex: 1, state: 'S', address: ADDR_B, data: 0x99 },
    ],
    memChange: { address: ADDR_B, data: 0x99 },
    logs: [
      { text: 'Core 0 READ 0xB0', detail: 'I → miss', kind: 'miss' },
      { text: '→ BusRead(0xB0)', detail: 'Core 3 snoops — has M!', kind: 'bus' },
      { text: 'Core 3 FLUSH 0x99', detail: 'M→S, writeback to memory', kind: 'bus' },
      { text: 'Core 3: M → S', detail: 'wrote back dirty data', kind: 'state' },
      { text: 'Core 0: I → S', detail: 'receives flushed data', kind: 'state' },
    ],
    totalMs:  200 + dur(wpCoreToBus(0)) + 500 + dur(wpCoreToCore(3, 0)) + 700,
    changeMs: 200 + dur(wpCoreToBus(0)) + 500 + dur(wpCoreToCore(3, 0)) + 200,
  },
]
