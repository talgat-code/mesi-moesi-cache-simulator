export type MESIState = 'M' | 'O' | 'E' | 'S' | 'I'

export interface CacheLine {
  index: number
  address: number | null
  data: number
  state: MESIState
  flash: boolean
  flashKind: 'miss' | 'hit' | 'invalidate' | 'update' | null
}

export interface CoreState {
  id: number
  isActive: boolean
  isSnooping: boolean
  cache: CacheLine[]
  currentOp: string | null
}

export interface MemEntry {
  address: number
  data: number
  label: string
  flash: boolean
}

export type PktType = 'BusRead' | 'BusReadX' | 'BusUpgr' | 'Flush' | 'Supply'

export interface Packet {
  id: string
  type: PktType
  label: string
  color: string
  x: number
  y: number
}

export interface LogEntry {
  id: string
  text: string
  detail: string
  kind: 'miss' | 'hit' | 'bus' | 'state' | 'silent' | 'info' | 'step' | 'compare'
  compareData?: Partial<Record<Protocol, number>>
  currentProtocol?: Protocol
  opNum?: number
  stepDescription?: string
}

export interface BusStats {
  BusRead: number
  BusReadX: number
  BusUpgr: number
  Flush: number
  Supply: number
}

export interface CacheStats {
  hits: number
  misses: number
  invalidations: number
  writebacks: number
}

export type Protocol = 'MSI' | 'MESI' | 'MOESI'

export interface SimState {
  stepIndex: number
  cores: CoreState[]
  memory: MemEntry[]
  packets: Packet[]
  log: LogEntry[]
  isPlaying: boolean
  isAnimating: boolean
  speed: number
  memActive: boolean
  mode: 'demo' | 'scenario' | 'interactive' | 'falsesharing'
  protocol: Protocol
  busStats: BusStats
  allProtoStats: Record<Protocol, BusStats>
  scenarioStep: number
  fsStats: { on: BusStats | null; off: BusStats | null }
  cacheStats: CacheStats
}
