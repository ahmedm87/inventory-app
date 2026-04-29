import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { reassignOrder } from "~/sync/order-reassignment.js";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { orderId, newWarehouseId } = body;

    if (!orderId || !newWarehouseId) {
      return json(
        { success: false, error: "orderId and newWarehouseId are required" },
        { status: 400 },
      );
    }

    await reassignOrder(orderId, newWarehouseId);
    return json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, { status: 400 });
  }
}
