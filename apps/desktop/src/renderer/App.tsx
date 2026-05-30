import { useState } from "react"
import { useProjects } from "./use-projects"

export const App = () => {
  const { projects, create } = useProjects()
  const [name, setName] = useState("")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (n) { create(n); setName("") }
  }
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Yodea — Projects ({projects.length})</h1>
      <form onSubmit={submit}>
        <input
          aria-label="project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new project name"
        />
        <button type="submit">Create</button>
      </form>
      <ul data-testid="project-list">
        {projects.map((p) => (
          <li key={p.id}>{p.name} <small style={{ opacity: 0.6 }}>{p.id}</small></li>
        ))}
      </ul>
    </main>
  )
}
