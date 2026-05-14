import type { StatCardData } from '../../types/stat-card'

export function StatCard({ title, description }: StatCardData) {
  return (
    <article className="stat-card">
      <h3 className="stat-card__title">{title}</h3>
      <p className="stat-card__description">{description}</p>
    </article>
  )
}
