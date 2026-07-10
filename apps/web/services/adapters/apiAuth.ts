import type { AuthService, CreateAuthServiceOptions } from "../auth";

export function createApiAuthService(_options: CreateAuthServiceOptions): AuthService {
  return {
    async login(): Promise<never> {
      throw new Error("not implemented");
    },
    async logout(): Promise<never> {
      throw new Error("not implemented");
    },
    async getCurrentUser(): Promise<never> {
      throw new Error("not implemented");
    },
  };
}
