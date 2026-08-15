import type { AuthInfo } from "@modelcontextprotocol/server";

declare global {
  interface Request {
    auth?: AuthInfo;
  }
}

export {};
