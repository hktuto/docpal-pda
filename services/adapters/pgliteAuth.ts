import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { useDb } from "~/composables/useDb";
import { I18nError } from "~/composables/i18nError";
import type { AuthService, User } from "../auth";

const STORAGE_KEY = "warehouse-user-id";

function toUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    createdAt: row.createdAt,
  };
}

export function createPgliteAuthService(): AuthService {
  return {
    async login(username: string, password: string): Promise<User> {
      const db = useDb();
      const user = await db.query.users.findFirst({
        where: eq(schema.users.username, username),
      });

      if (!user || user.passwordHash !== password) {
        throw new I18nError("invalid_username_or_password");
      }

      localStorage.setItem(STORAGE_KEY, user.id);
      return toUser(user);
    },

    async logout(): Promise<void> {
      localStorage.removeItem(STORAGE_KEY);
    },

    async getCurrentUser(): Promise<User | null> {
      const id = localStorage.getItem(STORAGE_KEY);
      if (!id) return null;

      const db = useDb();
      const user = await db.query.users.findFirst({
        where: eq(schema.users.id, id),
      });

      if (!user) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }

      return toUser(user);
    },
  };
}
