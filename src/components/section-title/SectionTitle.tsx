type SectionTitleProps = {
  eyebrow: string
  title: string
  description: string
}

export function SectionTitle({ eyebrow, title, description }: SectionTitleProps) {
  return (
    <header>
      <p className="section-title__eyebrow">{eyebrow}</p>
      <h2 className="section-title__heading">{title}</h2>
      <p className="section-title__description">{description}</p>
    </header>
  )
}
