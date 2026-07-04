import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "~/db/schema";
import { I18nError } from "~/composables/i18nError";

const STORAGE_KEY = "warehouse-user-id";

export function useAuth() {
  const currentUser = useState<typeof schema.users.$inferSelect | null>(
    "auth-user",
    () => null
  );

  async function login(
    db: PgliteDatabase<typeof schema>,
    username: string,
    password: string
  ) {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.username, username),
    });

    if (!user || user.passwordHash !== password) {
      throw new I18nError("invalid_username_or_password");
    }

    currentUser.value = user;
    localStorage.setItem(STORAGE_KEY, user.id);
    return user;
  }

  function logout() {
    currentUser.value = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  async function restore(db: PgliteDatabase<typeof schema>) {
    const id = localStorage.getItem(STORAGE_KEY);
    if (!id) return;

    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, id),
    });

    if (user) {
      currentUser.value = user;
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  return {
    currentUser: readonly(currentUser),
    login,
    logout,
    restore,
  };
}
