import { SERVICE_NAME, SERVICE_VERSION } from "@/lib/config";

export default function Home() {
  return (
    <main style={{ fontFamily: "Georgia, serif", padding: "2rem", maxWidth: 720 }}>
      <h1>{SERVICE_NAME}</h1>
      <p>Remote MCP persistence service (v{SERVICE_VERSION}).</p>
      <ul>
        <li>
          Health: <code>/api/health</code>
        </li>
        <li>
          MCP: <code>/api/mcp</code>
        </li>
        <li>
          OAuth metadata: <code>/.well-known/oauth-protected-resource</code>
        </li>
      </ul>
      <p>
        This service stores and retrieves jobs only. Scoring, duplicate detection, and
        persistence decisions belong to the Python job agent.
      </p>
    </main>
  );
}
