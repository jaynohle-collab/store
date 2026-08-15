# Jay Job MCP (remote_mcp)

Vercel-deployable Next.js MCP persistence service.

See the repository root [README.md](../README.md) for architecture, Auth0, Neon, and deployment docs.

## Scripts

```bash
npm install
npm run dev
npm test
npm run build
```

## Endpoints

- `GET /api/health` — public health
- `POST /api/mcp` — authenticated Streamable HTTP MCP
- `GET /.well-known/oauth-protected-resource` — OAuth protected-resource metadata
