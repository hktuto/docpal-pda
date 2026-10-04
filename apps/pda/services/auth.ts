import type { User } from "./types";
import { createApiAuthService } from "./adapters/apiAuth";

export interface AuthService {
  login(username: string, password: string): Promise<User>;
  logout(): Promise<void>;
  getCurrentUser(): Promise<User | null>;
}

export interface CreateAuthServiceOptions {
  apiBaseUrl?: string;
}

export function createAuthService(options: CreateAuthServiceOptions): AuthService {
  return createApiAuthService(options);
}
