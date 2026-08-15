import { createRemoteJWKSet, jwtVerify, errors as JoseErrors } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";

import {
  getAuth0Audience,
  getAuth0Issuer,
  getJwksUrl,
} from "../config";
import { extractPermissions } from "./permissions";

export class AuthValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_token"
      | "malformed_token"
      | "invalid_signature"
      | "expired"
      | "wrong_issuer"
      | "wrong_audience"
      | "not_before"
      | "invalid_claims",
  ) {
    super(message);
    this.name = "AuthValidationError";
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUrlCached: string | undefined;

function getJwks() {
  const url = getJwksUrl();
  if (!url) {
    throw new AuthValidationError("AUTH0_ISSUER is not configured", "invalid_claims");
  }
  if (!jwks || jwksUrlCached !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksUrlCached = url;
  }
  return jwks;
}

/** Reset JWKS cache (tests only). */
export function resetJwksCache(): void {
  jwks = undefined;
  jwksUrlCached = undefined;
}

export async function verifyAccessToken(bearerToken?: string): Promise<AuthInfo> {
  if (!bearerToken) {
    throw new AuthValidationError("Missing bearer token", "missing_token");
  }

  const issuer = getAuth0Issuer();
  const audience = getAuth0Audience();
  if (!issuer || !audience) {
    throw new AuthValidationError("Auth0 is not configured", "invalid_claims");
  }

  try {
    const { payload } = await jwtVerify(bearerToken, getJwks(), {
      issuer,
      audience,
      clockTolerance: 5,
    });

    const scopes = extractPermissions(payload as Record<string, unknown>);
    const clientId =
      (typeof payload.azp === "string" && payload.azp) ||
      (typeof payload.sub === "string" && payload.sub) ||
      "unknown";

    return {
      token: bearerToken,
      clientId,
      scopes,
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      extra: {
        sub: payload.sub,
        permissions: scopes,
      },
    };
  } catch (error) {
    if (error instanceof AuthValidationError) throw error;

    if (error instanceof JoseErrors.JWTExpired) {
      throw new AuthValidationError("Token has expired", "expired");
    }
    if (error instanceof JoseErrors.JWTClaimValidationFailed) {
      const claim = error.claim;
      if (claim === "iss") {
        throw new AuthValidationError("Wrong issuer", "wrong_issuer");
      }
      if (claim === "aud") {
        throw new AuthValidationError("Wrong audience", "wrong_audience");
      }
      if (claim === "nbf") {
        throw new AuthValidationError("Token not yet valid", "not_before");
      }
      throw new AuthValidationError(`Invalid claim: ${claim ?? "unknown"}`, "invalid_claims");
    }
    if (error instanceof JoseErrors.JWSSignatureVerificationFailed) {
      throw new AuthValidationError("Invalid token signature", "invalid_signature");
    }
    if (
      error instanceof JoseErrors.JWTInvalid ||
      error instanceof JoseErrors.JWSInvalid ||
      error instanceof JoseErrors.JWKSInvalid ||
      error instanceof SyntaxError
    ) {
      throw new AuthValidationError("Malformed token", "malformed_token");
    }

    throw new AuthValidationError("Invalid token", "malformed_token");
  }
}

export async function verifyTokenForMcp(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  try {
    return await verifyAccessToken(bearerToken);
  } catch (error) {
    if (error instanceof AuthValidationError) {
      // withMcpAuth treats undefined as missing/invalid → 401 when required=true
      return undefined;
    }
    throw error;
  }
}
