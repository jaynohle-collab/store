import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

declare global {
  interface Request {
    auth?: AuthInfo;
  }
}

export {};
