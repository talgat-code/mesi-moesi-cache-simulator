export type MESIState = 'M' | 'E' | 'S' | 'I'

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
  kind: 'miss' | 'hit' | 'bus' | 'state' | 'silent' | 'info'
}

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
}
