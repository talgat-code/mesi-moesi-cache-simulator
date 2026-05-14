import { SectionTitle } from '../../components/section-title/SectionTitle'
import { appInfo } from '../../shared/config/app-info'
import { StatCard } from '../../shared/ui/stat-card/StatCard'

const protocols = [
  {
    name: 'MSI',
    description: 'Base protocol for cache line states and invalidation flow.',
  },
  {
    name: 'MESI',
    description: 'Adds Exclusive state to reduce unnecessary memory writes.',
  },
  {
    name: 'MOESI',
    description: 'Extends sharing with Owned state for richer cache coordination.',
  },
]

const projectAreas = [
  'src/app - root application layer',
  'src/pages - screen-level pages',
  'src/components - reusable UI blocks',
  'src/shared - config, types and UI primitives',
]

export function HomePage() {
  return (
    <main className="app-shell hero">
      <div className="hero__inner">
        <section className="hero__content">
          <span className="hero__eyebrow">{appInfo.stack}</span>
          <h1 className="hero__title">Cache coherence simulator starter.</h1>
          <p className="hero__lead">
            The project is ready for feature development: TypeScript is configured, Vite powers
            local development, and the folder structure is split into app, pages, components and
            shared layers.
          </p>

          <div className="hero__actions">
            <a className="button-link button-link--primary" href="/">
              Start building
            </a>
            <a className="button-link button-link--secondary" href="#structure">
              View structure
            </a>
          </div>

          <div className="hero__meta">
            {protocols.map((protocol) => (
              <StatCard key={protocol.name} title={protocol.name} description={protocol.description} />
            ))}
          </div>
        </section>

        <aside className="hero__panel" id="structure">
          <SectionTitle
            eyebrow="Base structure"
            title="Prepared zones for the next steps"
            description="Use this scaffold to grow the simulator without mixing page, app and shared concerns."
          />

          <div className="hero__panel-list">
            {projectAreas.map((area) => {
              const [title, description] = area.split(' - ')

              return (
                <div className="hero__panel-item" key={area}>
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
              )
            })}
          </div>

          <p className="hero__panel-note">Project id: {appInfo.title}</p>
        </aside>
      </div>
    </main>
  )
}
