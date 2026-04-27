import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { timingSafeEqual } from "node:crypto";
import { getConfig } from "~/config/app-config.js";
import { runSync } from "~/sync/orchestrator.js";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const config = getConfig();
  const authHeader = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${config.triggerSyncSecret}`;

  if (!safeCompare(authHeader, expected)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const syncRunId = await runSync("api");

  if (!syncRunId) {
    return json({
      success: false,
      message: "Sync already in progress",
    });
  }

  return json({
    success: true,
    syncRunId,
    status: "started",
  });
}
