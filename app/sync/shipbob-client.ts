import { getNamespacedConfig, type ShipBobConfig } from "~/config/app-config.js";

function log(level: string, message: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      level,
      timestamp: new Date().toISOString(),
      component: "shipbob",
      message,
      ...extra,
    }),
  );
}

// ─── Types ───

export interface ShipBobInventoryItem {
  id: number;
  name: string;
  sku: string;
  total_fulfillable_quantity: number;
}

export interface ShipBobOrderInput {
  referenceId: string;
  orderNumber: string;
  recipientName: string;
  recipientEmail: string;
  shippingAddress: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    country: string;
    zipCode: string;
  };
  lineItems: Array<{
    sku: string;
    quantity: number;
    name: string;
  }>;
}

export interface ShipBobOrderResult {
  orderId: number;
  referenceId: string;
  status: string;
}

export interface ShipBobTrackingResult {
  trackingNumber: string;
  carrier: string;
  trackingUrl: string | null;
  shippedAt: string | null;
}

// ─── Client ───

const BACKOFF_BASE_MS = 1000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 250;

function getShipBobConfig(): ShipBobConfig {
  const config = getNamespacedConfig();
  if (!config.shipbob) {
    throw new Error("ShipBob is not configured (SHIPBOB_ACCESS_TOKEN missing)");
  }
  return config.shipbob;
}

async function shipbobFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const config = getShipBobConfig();
  const url = `${config.baseUrl}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : BACKOFF_BASE_MS * Math.pow(2, attempt);
      log("warn", "ShipBob rate limited, backing off", {
        attempt,
        waitMs,
        path,
      });
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (res.status === 401) {
      throw new Error("ShipBob auth failed (401 Unauthorized)");
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `ShipBob API error: ${res.status} ${res.statusText} - ${body}`,
      );
    }

    return res;
  }

  throw new Error(`ShipBob rate limit exceeded after ${MAX_RETRIES} retries`);
}

// ─── Inventory ───

export async function fetchShipBobInventory(
  channelId: string,
): Promise<Map<string, number>> {
  const inventory = new Map<string, number>();
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await shipbobFetch(
      `/inventory?Page=${page}&Limit=${PAGE_SIZE}&IsFulfillable=true`,
    );
    const items: ShipBobInventoryItem[] = await res.json();

    for (const item of items) {
      if (item.sku && item.total_fulfillable_quantity >= 0) {
        inventory.set(item.sku, item.total_fulfillable_quantity);
      }
    }

    hasMore = items.length === PAGE_SIZE;
    page++;
  }

  log("info", `Fetched ShipBob inventory`, {
    channelId,
    totalSkus: inventory.size,
    pages: page - 1,
  });

  return inventory;
}

// ─── Orders ───

export async function createShipBobOrder(
  order: ShipBobOrderInput,
): Promise<ShipBobOrderResult> {
  const body = {
    reference_id: order.referenceId,
    order_number: order.orderNumber,
    recipient: {
      name: order.recipientName,
      email: order.recipientEmail,
      address: {
        address1: order.shippingAddress.address1,
        address2: order.shippingAddress.address2 || "",
        city: order.shippingAddress.city,
        state: order.shippingAddress.state,
        country: order.shippingAddress.country,
        zip_code: order.shippingAddress.zipCode,
      },
    },
    products: order.lineItems.map((li) => ({
      sku: li.sku,
      quantity: li.quantity,
      name: li.name,
    })),
    shipping_method: "Standard",
  };

  const res = await shipbobFetch("/order", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const result = await res.json();
  log("info", "Created ShipBob order", {
    orderId: result.id,
    referenceId: order.referenceId,
  });

  return {
    orderId: result.id,
    referenceId: result.reference_id || order.referenceId,
    status: result.status || "Processing",
  };
}

export async function cancelShipBobOrder(
  orderId: string,
): Promise<void> {
  try {
    await shipbobFetch(`/order/${orderId}/cancel`, {
      method: "POST",
    });
    log("info", "Cancelled ShipBob order", { orderId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already shipped") || message.includes("already cancelled")) {
      log("warn", "Cannot cancel ShipBob order (already shipped/cancelled)", {
        orderId,
        error: message,
      });
      throw err;
    }
    throw err;
  }
}

export async function getShipBobOrderTracking(
  orderId: string,
): Promise<ShipBobTrackingResult | null> {
  const res = await shipbobFetch(`/order/${orderId}`);
  const data = await res.json();

  if (!data.shipments || data.shipments.length === 0) {
    return null;
  }

  const shipment = data.shipments[0];
  if (!shipment.tracking?.tracking_number) {
    return null;
  }

  return {
    trackingNumber: shipment.tracking.tracking_number,
    carrier: shipment.tracking.carrier || "Unknown",
    trackingUrl: shipment.tracking.tracking_url || null,
    shippedAt: shipment.actual_fulfillment_date || null,
  };
}

// ─── Region helpers ───

export function getShipBobWarehouseId(
  region: "US" | "EU" | "AU",
): string {
  const config = getShipBobConfig();
  switch (region) {
    case "US":
      return config.usWarehouseId;
    case "EU":
      return config.euWarehouseId;
    case "AU":
      return config.auWarehouseId;
  }
}
