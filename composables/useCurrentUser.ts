import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";

export async function useCurrentUser() {
  const db = await useDb();
  return db.query.users.findFirst({
    where: eq(schema.users.username, "operator"),
  });
}
