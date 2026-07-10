import type { User } from "./types";
import { createPgliteAuthService } from "./adapters/pgliteAuth";
import { createApiAuthService } from "./adapters/apiAuth";

export interface AuthService {
  login(username: string, password: string): Promise<User>;
  logout(): Promise<void>;
  getCurrentUser(): Promise<User | null>;
}

export interface CreateAuthServiceOptions {
  adapter: "pglite" | "api";
  apiBaseUrl?: string;
}

export function createAuthService(options: CreateAuthServiceOptions): AuthService {
  if (options.adapter === "pglite") {
    return createPgliteAuthService();
  }
  return createApiAuthService(options);
}
