import { useEffect, useMemo, useState } from 'react'
import { appInfo } from '../../shared/config/app-info'

type NodeKey = 'core1' | 'core2' | 'core3' | 'core4' | 'bus' | 'memory'
type ProtocolName = 'MSI' | 'MESI' | 'MOESI'
type PacketKind = 'request' | 'data' | 'invalidate' | 'flush'

type CacheRow = {
  address: string
  state: string
  value: string
}

type Packet = {
  from: NodeKey
  to: NodeKey
  kind: PacketKind
}

type Transition = {
  actor: string
  change: string
  note: string
}

type Operation = {
  id: string
  coreId: number
  label: string
  event: string
  address: string
  action: string
  protocol: ProtocolName
  focusStates: string[]
  phases: string[]
  packets: Packet[]
  transitions: Transition[]
  cacheOverrides: Partial<Record<number, Record<string, Pick<CacheRow, 'state' | 'value'>>>>
  memoryOverrides: Record<string, string>
}

const topologyLines = [
  { coreId: 1, d: 'M190 412 V430 H610', pathId: 'wire-core1-bus' },
  { coreId: 2, d: 'M490 412 V430 H610', pathId: 'wire-core2-bus' },
  { coreId: 3, d: 'M190 520 V430 H610', pathId: 'wire-core3-bus' },
  { coreId: 4, d: 'M490 520 V430 H610', pathId: 'wire-core4-bus' },
]

const packetPaths: Record<string, string> = {
  'core1-bus': 'M190 412 V430 H610',
  'bus-core1': 'M610 430 H190 V412',
  'core2-bus': 'M490 412 V430 H610',
  'bus-core2': 'M610 430 H490 V412',
  'core3-bus': 'M190 520 V430 H610',
  'bus-core3': 'M610 430 H190 V520',
  'core4-bus': 'M490 520 V430 H610',
  'bus-core4': 'M610 430 H490 V520',
  'bus-memory': 'M770 430 H930',
  'memory-bus': 'M930 430 H770',
}

const protocolFamilies = [
  {
    name: 'MSI' as const,
    description: 'Base invalidate protocol with Modified, Shared and Invalid line ownership.',
    states: ['M', 'S', 'I'],
  },
  {
    name: 'MESI' as const,
    description: 'Adds Exclusive for clean private data and fewer memory writes on first read.',
    states: ['M', 'E', 'S', 'I'],
  },
  {
    name: 'MOESI' as const,
    description: 'Adds Owned so one cache can supply shared data without immediate writeback.',
    states: ['M', 'O', 'E', 'S', 'I'],
  },
]

const coreSeeds: CacheRow[][] = [
  [
    { address: '0x1A40', state: 'I', value: '--' },
    { address: '0x0B10', state: 'S', value: '04' },
    { address: '0x2200', state: 'E', value: '41' },
  ],
  [
    { address: '0x1A40', state: 'S', value: '17' },
    { address: '0x2C18', state: 'I', value: '--' },
    { address: '0x3308', state: 'M', value: '88' },
  ],
  [
    { address: '0x2C18', state: 'S', value: '03' },
    { address: '0x1104', state: 'E', value: '52' },
    { address: '0x3F20', state: 'I', value: '--' },
  ],
  [
    { address: '0x3F20', state: 'M', value: '91' },
    { address: '0x1A40', state: 'I', value: '--' },
    { address: '0x4100', state: 'S', value: '64' },
  ],
]

const memorySeeds = [
  { address: '0x1A40', value: '17' },
  { address: '0x2C18', value: '03' },
  { address: '0x3F20', value: '91' },
]

const operations: Operation[] = [
  {
    id: 'read-miss-shared',
    coreId: 1,
    label: 'Read miss on shared line',
    event: 'BusRd',
    address: '0x1A40',
    action: 'CPU 1 reads through the bus, memory replies, and the line settles in Shared because CPU 2 already holds a clean copy.',
    protocol: 'MESI',
    focusStates: ['I', 'S', 'E'],
    phases: ['CPU 1 issues read request', 'Shared bus forwards the read', 'Line arrives as shared data'],
    packets: [
      { from: 'core1', to: 'bus', kind: 'request' },
      { from: 'bus', to: 'memory', kind: 'request' },
      { from: 'memory', to: 'bus', kind: 'data' },
      { from: 'bus', to: 'core1', kind: 'data' },
    ],
    transitions: [
      { actor: 'CPU 1 cache', change: 'I -> S', note: 'Requester loads the line after the miss.' },
      { actor: 'CPU 2 cache', change: 'S -> S', note: 'Peer keeps a clean shared copy.' },
      { actor: 'Main memory', change: '17 -> 17', note: 'Memory serves clean data without ownership change.' },
    ],
    cacheOverrides: {
      1: { '0x1A40': { state: 'S', value: '17' } },
      2: { '0x1A40': { state: 'S', value: '17' } },
    },
    memoryOverrides: { '0x1A40': '17' },
  },
  {
    id: 'write-upgrade',
    coreId: 2,
    label: 'Write upgrade with invalidation',
    event: 'BusUpgr',
    address: '0x1A40',
    action: 'CPU 2 already has the data, so it upgrades ownership on the bus and invalidates other shared copies before writing.',
    protocol: 'MSI',
    focusStates: ['S', 'M', 'I'],
    phases: ['CPU 2 requests ownership', 'Bus broadcasts invalidation', 'CPU 2 commits the write in Modified'],
    packets: [
      { from: 'core2', to: 'bus', kind: 'request' },
      { from: 'bus', to: 'core1', kind: 'invalidate' },
    ],
    transitions: [
      { actor: 'CPU 2 cache', change: 'S -> M', note: 'Writer becomes the only valid owner.' },
      { actor: 'CPU 1 cache', change: 'S -> I', note: 'Shared peer is invalidated by the bus upgrade.' },
      { actor: 'Main memory', change: '17 -> 17', note: 'Data stays dirty in cache until a later flush.' },
    ],
    cacheOverrides: {
      1: { '0x1A40': { state: 'I', value: '--' } },
      2: { '0x1A40': { state: 'M', value: '19' } },
    },
    memoryOverrides: { '0x1A40': '17' },
  },
  {
    id: 'owned-share',
    coreId: 3,
    label: 'Remote read from modified owner',
    event: 'BusRd',
    address: '0x3F20',
    action: 'CPU 3 reads a line that CPU 4 owns in Modified, so MOESI lets CPU 4 downgrade to Owned and supply the data over the bus.',
    protocol: 'MOESI',
    focusStates: ['M', 'O', 'S', 'I'],
    phases: ['CPU 3 announces a read miss', 'CPU 4 snoops and supplies data', 'Sharer enters S while owner becomes O'],
    packets: [
      { from: 'core3', to: 'bus', kind: 'request' },
      { from: 'core4', to: 'bus', kind: 'data' },
      { from: 'bus', to: 'core3', kind: 'data' },
    ],
    transitions: [
      { actor: 'CPU 3 cache', change: 'I -> S', note: 'Requester receives the shared line.' },
      { actor: 'CPU 4 cache', change: 'M -> O', note: 'Owner keeps responsibility for the freshest data.' },
      { actor: 'Main memory', change: '91 -> 91', note: 'Writeback is deferred because the owner can still answer reads.' },
    ],
    cacheOverrides: {
      3: { '0x3F20': { state: 'S', value: '91' } },
      4: { '0x3F20': { state: 'O', value: '91' } },
    },
    memoryOverrides: { '0x3F20': '91' },
  },
  {
    id: 'writeback-flush',
    coreId: 4,
    label: 'Flush to main memory',
    event: 'Flush',
    address: '0x3F20',
    action: 'CPU 4 evicts the dirty line, pushes the latest data over the bus, and memory becomes authoritative again.',
    protocol: 'MOESI',
    focusStates: ['M', 'O', 'I'],
    phases: ['CPU 4 starts writeback', 'Bus carries flush payload', 'Memory stores the new value and cache line is released'],
    packets: [
      { from: 'core4', to: 'bus', kind: 'flush' },
      { from: 'bus', to: 'memory', kind: 'data' },
    ],
    transitions: [
      { actor: 'CPU 4 cache', change: 'M -> I', note: 'Dirty line is written back and removed.' },
      { actor: 'Shared bus', change: 'Flush active', note: 'Writeback payload travels to memory.' },
      { actor: 'Main memory', change: '91 -> 91', note: 'Fresh value is committed in DRAM.' },
    ],
    cacheOverrides: {
      4: { '0x3F20': { state: 'I', value: '--' } },
    },
    memoryOverrides: { '0x3F20': '91' },
  },
]

function buildCacheRows(coreIndex: number, activeOperation: Operation): CacheRow[] {
  const overrides = activeOperation.cacheOverrides[coreIndex + 1] ?? {}

  return coreSeeds[coreIndex].map((row) => {
    const override = overrides[row.address]

    return override ? { ...row, ...override } : row
  })
}

function buildMemoryRows(activeOperation: Operation) {
  return memorySeeds.map((row) => ({
    ...row,
    value: activeOperation.memoryOverrides[row.address] ?? row.value,
  }))
}

export function HomePage() {
  const [step, setStep] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)

  useEffect(() => {
    if (!isPlaying) {
      return undefined
    }

    const timer = window.setInterval(() => {
      setStep((current) => (current + 1) % operations.length)
    }, 3200)

    return () => window.clearInterval(timer)
  }, [isPlaying])

  function showPreviousStep() {
    setIsPlaying(false)
    setStep((current) => (current - 1 + operations.length) % operations.length)
  }

  function showNextStep() {
    setIsPlaying(false)
    setStep((current) => (current + 1) % operations.length)
  }

  const activeOperation = operations[step]

  const cores = useMemo(
    () =>
      coreSeeds.map((_, index) => ({
        id: index + 1,
        cacheRows: buildCacheRows(index, activeOperation),
        isActive: activeOperation.coreId === index + 1,
      })),
    [activeOperation],
  )

  const memoryRows = useMemo(() => buildMemoryRows(activeOperation), [activeOperation])

  const activeCoreIds = useMemo(
    () =>
      new Set(
        activeOperation.packets.flatMap((packet) => {
          const ids: number[] = []

          if (packet.from.startsWith('core')) {
            ids.push(Number(packet.from.replace('core', '')))
          }

          if (packet.to.startsWith('core')) {
            ids.push(Number(packet.to.replace('core', '')))
          }

          return ids
        }),
      ),
    [activeOperation],
  )

  const memoryLinkActive = activeOperation.packets.some(
    (packet) => packet.from === 'memory' || packet.to === 'memory',
  )

  const packetAnimations = useMemo(
    () =>
      activeOperation.packets.map((packet, index) => ({
        ...packet,
        key: `${activeOperation.id}-${packet.from}-${packet.to}-${packet.kind}-${index}`,
        pathId: `${packet.from}-${packet.to}`,
        delay: `${index * 0.28}s`,
      })),
    [activeOperation],
  )

  return (
    <main className="app-shell simulator-page">
      <section className="simulator-shell">
        <div className="simulator-copy">
          <span className="simulator-copy__eyebrow">{appInfo.title}</span>
          <h1>2D cache coherence simulation board.</h1>
          <p>
            The view behaves like a lightweight schematic: processors, private caches, shared bus,
            and memory are drawn as blocks while requests, invalidations and data packets travel
            between them.
          </p>
        </div>

        <div className="simulator-status">
          <div>
            <span className="simulator-status__label">Scenario</span>
            <strong>{activeOperation.label}</strong>
          </div>
          <div>
            <span className="simulator-status__label">Bus event</span>
            <strong>{activeOperation.event}</strong>
          </div>
          <div>
            <span className="simulator-status__label">Protocol focus</span>
            <strong>{activeOperation.protocol}</strong>
          </div>
        </div>

        <div className="simulator-controls" aria-label="Simulation controls">
          <div className="simulator-controls__group">
            <button className="simulator-button" type="button" onClick={showPreviousStep}>
              Prev
            </button>
            <button
              className="simulator-button simulator-button--primary"
              type="button"
              onClick={() => setIsPlaying((current) => !current)}
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button className="simulator-button" type="button" onClick={showNextStep}>
              Next
            </button>
          </div>

          <div className="simulator-controls__meta">
            <span>
              Step {step + 1} / {operations.length}
            </span>
            <strong>{activeOperation.address}</strong>
          </div>
        </div>

        <section className="topology-board" aria-label="2D coherence simulation">
          <div className="topology-board__legend">
            <div className="topology-event">
              <span className="topology-event__eyebrow">Live bus message</span>
              <strong>{activeOperation.event}</strong>
              <p>{activeOperation.action}</p>
            </div>

            <div className="topology-flow-key">
              <span className="topology-flow-key__item topology-flow-key__item--request">Request</span>
              <span className="topology-flow-key__item topology-flow-key__item--data">Data</span>
              <span className="topology-flow-key__item topology-flow-key__item--invalidate">Invalidate</span>
              <span className="topology-flow-key__item topology-flow-key__item--flush">Flush</span>
            </div>
          </div>

          <div className="topology-board__labels" aria-hidden="true">
            <span className="topology-board__label topology-board__label--processors">
              Processor cluster
            </span>
            <span className="topology-board__label topology-board__label--bus">Shared coherence bus</span>
            <span className="topology-board__label topology-board__label--memory">Main memory channel</span>
          </div>

          <svg className="topology-board__wires" viewBox="0 0 1220 780" aria-hidden="true">
            <defs>
              <marker
                id="topology-arrow"
                markerWidth="12"
                markerHeight="12"
                refX="10"
                refY="6"
                orient="auto"
              >
                <path d="M0,0 L12,6 L0,12 z" fill="currentColor" />
              </marker>

              {Object.entries(packetPaths).map(([id, path]) => (
                <path key={id} id={id} d={path} />
              ))}
            </defs>

            <path d="M140 430 H930" className="topology-wire topology-wire--backbone" />
            <path d="M610 330 V530" className="topology-wire topology-wire--bus-spine" />

            {topologyLines.map((line) => (
              <path
                key={line.pathId}
                d={line.d}
                className={
                  activeCoreIds.has(line.coreId)
                    ? 'topology-wire topology-wire--active'
                    : 'topology-wire'
                }
                markerEnd="url(#topology-arrow)"
              />
            ))}

            <path
              d="M770 430 H930"
              className={
                memoryLinkActive
                  ? 'topology-wire topology-wire--active topology-wire--memory'
                  : 'topology-wire topology-wire--memory'
              }
              markerEnd="url(#topology-arrow)"
            />

            {packetAnimations.map((packet) => (
              <circle
                key={packet.key}
                className={`wire-particle wire-particle--${packet.kind}`}
                r="7"
              >
                <animateMotion dur="2.2s" begin={packet.delay} repeatCount="indefinite" rotate="auto">
                  <mpath href={`#${packet.pathId}`} />
                </animateMotion>
              </circle>
            ))}
          </svg>

          <div className="topology-cores">
            {cores.map((core) => (
              <article
                key={core.id}
                className={core.isActive ? `core-node core-node--${core.id} core-node--active` : `core-node core-node--${core.id}`}
              >
                <div className="core-node__header">
                  <div>
                    <span className="core-node__eyebrow">Processor</span>
                    <h2>CPU {core.id}</h2>
                  </div>
                  <span className="core-node__badge">{core.isActive ? 'Active' : 'Snoop'}</span>
                </div>

                <div className="core-node__body">
                  <div className="core-node__chip">Execution core</div>
                  <div className="core-node__cache-label">Private L1 cache</div>
                </div>

                <table className="cache-table">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>State</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {core.cacheRows.map((row) => (
                      <tr
                        key={row.address}
                        className={
                          row.address === activeOperation.address
                            ? 'cache-table__row cache-table__row--focus'
                            : 'cache-table__row'
                        }
                      >
                        <td>{row.address}</td>
                        <td>{row.state}</td>
                        <td>{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <span className="node-port" aria-hidden="true" />
              </article>
            ))}
          </div>

          <section className="bus-node">
            <span className="node-port node-port--left" aria-hidden="true" />
            <span className="node-port node-port--right" aria-hidden="true" />
            <span className="bus-node__eyebrow">Shared interconnect</span>
            <h2>Bus</h2>
            <div className="bus-node__event">{activeOperation.event}</div>
            <p>{activeOperation.phases[1]}</p>
          </section>

          <section className="memory-node">
            <span className="node-port node-port--left" aria-hidden="true" />
            <span className="memory-node__eyebrow">Main memory</span>
            <h2>DRAM</h2>
            <div className="memory-table">
              {memoryRows.map((row) => (
                <div
                  key={row.address}
                  className={
                    row.address === activeOperation.address
                      ? 'memory-table__row memory-table__row--focus'
                      : 'memory-table__row'
                  }
                >
                  <span>{row.address}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </section>
        </section>

        <section className="mechanics-grid">
          <article className="mechanics-card">
            <span className="mechanics-card__eyebrow">Flow phases</span>
            <h2>How the packet moves</h2>
            <div className="phase-list">
              {activeOperation.phases.map((phase) => (
                <div key={phase} className="phase-list__item">
                  {phase}
                </div>
              ))}
            </div>
          </article>

          <article className="mechanics-card">
            <span className="mechanics-card__eyebrow">State reactions</span>
            <h2>Who changes state</h2>
            <div className="transition-list">
              {activeOperation.transitions.map((transition) => (
                <div key={`${transition.actor}-${transition.change}`} className="transition-list__item">
                  <strong>{transition.actor}</strong>
                  <span>{transition.change}</span>
                  <p>{transition.note}</p>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="protocol-grid" aria-label="Protocol state mechanisms">
          {protocolFamilies.map((protocol) => (
            <article
              key={protocol.name}
              className={
                protocol.name === activeOperation.protocol
                  ? 'protocol-card protocol-card--active'
                  : 'protocol-card'
              }
            >
              <div className="protocol-card__header">
                <span className="protocol-card__name">{protocol.name}</span>
                <span className="protocol-card__tag">
                  {protocol.name === activeOperation.protocol ? 'Current focus' : 'Available'}
                </span>
              </div>
              <p>{protocol.description}</p>
              <div className="protocol-card__states">
                {protocol.states.map((state) => (
                  <span
                    key={`${protocol.name}-${state}`}
                    className={
                      activeOperation.focusStates.includes(state)
                        ? 'protocol-state protocol-state--highlight'
                        : 'protocol-state'
                    }
                  >
                    {state}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </section>
      </section>
    </main>
  )
}
