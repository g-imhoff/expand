import { useState } from "react"
import { useProjects } from "./use-projects"

export const App = () => {
  const { projects, error, create } = useProjects()
  const [name, setName] = useState("")
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    // Only clear the field once the project is actually created; on failure keep
    // the input so the user can retry, and the error is shown below.
    if (await create(n)) setName("")
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
      {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
      <ul data-testid="project-list">
        {projects.map((p) => (
          <li key={p.id}>{p.name} <small style={{ opacity: 0.6 }}>{p.id}</small></li>
        ))}
      </ul>
    </main>
  )
}
