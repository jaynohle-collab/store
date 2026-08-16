import Link from "next/link";

import { SERVICE_NAME, SERVICE_VERSION } from "@/lib/config";

export default function Home() {
  return (
    <main style={{ fontFamily: "var(--font-ui)", padding: "2rem", maxWidth: 720 }}>
      <h1>{SERVICE_NAME}</h1>
      <p>Remote MCP persistence + personal dashboard (v{SERVICE_VERSION}).</p>
      <ul>
        <li>
          <Link href="/dashboard">Dashboard</Link>
        </li>
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
      <p className="muted">
        Scoring, lifecycle classification, and persistence decisions belong to the Python job
        agent. MCP and the dashboard store/query only.
      </p>
    </main>
  );
}
