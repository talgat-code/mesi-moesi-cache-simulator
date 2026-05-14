export type MESIState = 'M' | 'O' | 'E' | 'S' | 'I'

export interface CacheLine {
  index: number
  address: number | null
  data: number
  state: MESIState
  flash: boolean
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
}

export interface BusStats {
  BusRead: number
  BusReadX: number
  BusUpgr: number
  Flush: number
  Supply: number
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
  mode: 'demo' | 'interactive' | 'falsesharing'
  protocol: Protocol
  busStats: BusStats
  allProtoStats: Record<Protocol, BusStats>
}
