import {
  SERVICE_NAME,
  SERVICE_VERSION,
  isAuthConfigured,
  isDatabaseConfigured,
} from "@/lib/config";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    status: "ok",
    service: SERVICE_NAME,
    databaseConfigured: isDatabaseConfigured(),
    authConfigured: isAuthConfigured(),
    version: SERVICE_VERSION,
  });
}
