import { getConfig } from "~/config/app-config.js";

interface FulfillmenInventoryItem {
  SKU: string;
  TotalNumber: string | number;
}

interface FulfillmenResponse {
  success: string | boolean;
  Code: string | number;
  count: string | number;
  data: FulfillmenInventoryItem[];
}

interface StorageListResponse {
  success: string | boolean;
  Code: string | number;
  data: Array<{ ShortName: string; StorageID: string; FullName: string }>;
}

function log(level: string, message: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      level,
      timestamp: new Date().toISOString(),
      message,
      ...extra,
    }),
  );
}

export async function getWarehouseCodes(): Promise<string[]> {
  const config = getConfig();

  try {
    const url = `${config.fulfillmenBaseUrl}/GetStorageList.aspx?Key=${encodeURIComponent(config.fulfillmenApiKey)}`;
    const res = await fetch(url);
    const body = (await res.json()) as StorageListResponse;

    if (String(body.Code) === "103") {
      throw new Error("Fulfillmen auth failed (Code 103)");
    }

    if (String(body.Code) === "100" && body.data?.length > 0) {
      const codes = body.data.map((s) => s.ShortName);
      log("info", "Discovered warehouse codes from API", { codes });
      return codes;
    }
  } catch (err) {
    log("warn", "GetStorageList failed, falling back to env var", {
      error: String(err),
    });
  }

  if (config.fulfillmenStorage) {
    const codes = config.fulfillmenStorage
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (codes.length > 0) {
      log("info", "Using warehouse codes from FULFILLMEN_STORAGE env var", {
        codes,
      });
      return codes;
    }
  }

  throw new Error(
    "No warehouse codes available: GetStorageList failed and FULFILLMEN_STORAGE is empty",
  );
}

async function fetchInventoryPage(
  storageCode: string,
  page: number,
): Promise<FulfillmenResponse> {
  const config = getConfig();
  const url = `${config.fulfillmenBaseUrl}/getinventorylist.aspx?Key=${encodeURIComponent(config.fulfillmenApiKey)}&Storage=${encodeURIComponent(storageCode)}&page=${page}`;

  const res = await fetch(url);
  const body = (await res.json()) as FulfillmenResponse;

  if (String(body.Code) === "103") {
    throw new Error("Fulfillmen auth failed (Code 103)");
  }
  if (String(body.Code) === "101") {
    throw new Error(`Fulfillmen API failure (Code 101) for storage ${storageCode} page ${page}`);
  }
  // Code 105 = no inventory for this warehouse — return empty data
  if (String(body.Code) === "105") {
    return { ...body, data: [] };
  }

  return body;
}

const PAGE_SIZE = 20;
const PAGE_DELAY_MS = 200;

export async function fetchInventoryByWarehouse(
  storageCode: string,
): Promise<Map<string, number>> {
  const inventory = new Map<string, number>();
  let page = 1;
  let totalFetched = 0;
  let reportedCount: number | null = null;

  while (true) {
    const body = await fetchInventoryPage(storageCode, page);

    if (page === 1 && body.count != null) {
      reportedCount = parseInt(String(body.count), 10);
    }

    if (!body.data || body.data.length === 0) break;

    for (const item of body.data) {
      const qty = parseInt(String(item.TotalNumber), 10);
      if (isNaN(qty)) {
        log("error", "Skipping item with NaN TotalNumber", {
          sku: item.SKU,
          rawValue: item.TotalNumber,
          storageCode,
        });
        continue;
      }

      const current = inventory.get(item.SKU) || 0;
      inventory.set(item.SKU, current + qty);
      totalFetched++;
    }

    if (body.data.length < PAGE_SIZE) break;

    page++;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  if (
    reportedCount != null &&
    !isNaN(reportedCount) &&
    reportedCount > 0
  ) {
    const diff = Math.abs(totalFetched - reportedCount) / reportedCount;
    if (diff > 0.05) {
      log("warn", "Fulfillmen count mismatch", {
        storageCode,
        totalFetched,
        reportedCount,
        diffPercent: (diff * 100).toFixed(1),
      });
    }
  }

  log("info", `Fetched inventory for warehouse ${storageCode}`, {
    storageCode,
    totalFetched,
    pages: page,
  });

  return inventory;
}

export async function fetchAllInventory(): Promise<Map<string, number>> {
  const codes = await getWarehouseCodes();
  const inventory = new Map<string, number>();

  for (const storageCode of codes) {
    const warehouseInventory = await fetchInventoryByWarehouse(storageCode);
    for (const [sku, qty] of warehouseInventory) {
      const current = inventory.get(sku) || 0;
      inventory.set(sku, current + qty);
    }
  }

  log("info", `Total Fulfillmen inventory: ${inventory.size} unique SKUs`);
  return inventory;
}

// ─── Order operations ───

export interface FulfillmenOrderInput {
  referenceId: string;
  recipientName: string;
  recipientPhone?: string;
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

export interface FulfillmenOrderResult {
  orderId: string;
  status: string;
}

export interface FulfillmenTrackingResult {
  trackingNumber: string;
  carrier: string;
  trackingUrl: string | null;
  shippedAt: string | null;
}

export async function createFulfillmenOrder(
  order: FulfillmenOrderInput,
): Promise<FulfillmenOrderResult> {
  const config = getConfig();
  const url = `${config.fulfillmenBaseUrl}/CreateOrder.aspx`;

  const body = {
    Key: config.fulfillmenApiKey,
    ReferenceNo: order.referenceId,
    ConsigneeName: order.recipientName,
    ConsigneePhone: order.recipientPhone || "",
    ConsigneeAddress: order.shippingAddress.address1,
    ConsigneeAddress2: order.shippingAddress.address2 || "",
    ConsigneeCity: order.shippingAddress.city,
    ConsigneeState: order.shippingAddress.state,
    ConsigneeCountry: order.shippingAddress.country,
    ConsigneeZipCode: order.shippingAddress.zipCode,
    Items: order.lineItems.map((li) => ({
      SKU: li.sku,
      Quantity: li.quantity,
      ProductName: li.name,
    })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = (await res.json()) as {
    success: boolean;
    Code: string | number;
    data?: { OrderNo?: string };
  };

  if (String(result.Code) === "103") {
    throw new Error("Fulfillmen auth failed (Code 103)");
  }

  if (!result.success || String(result.Code) !== "100") {
    throw new Error(
      `Fulfillmen order creation failed: Code ${result.Code}`,
    );
  }

  const orderId = result.data?.OrderNo || order.referenceId;
  log("info", "Created Fulfillmen order", { orderId, referenceId: order.referenceId });

  return { orderId, status: "Created" };
}

export async function cancelFulfillmenOrder(
  orderId: string,
): Promise<void> {
  const config = getConfig();
  const url = `${config.fulfillmenBaseUrl}/CancelOrder.aspx`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Key: config.fulfillmenApiKey,
      OrderNo: orderId,
    }),
  });

  const result = (await res.json()) as {
    success: boolean;
    Code: string | number;
  };

  if (!result.success && String(result.Code) !== "100") {
    throw new Error(
      `Fulfillmen order cancellation failed: Code ${result.Code}`,
    );
  }

  log("info", "Cancelled Fulfillmen order", { orderId });
}

export async function getFulfillmenTracking(
  orderId: string,
): Promise<FulfillmenTrackingResult | null> {
  const config = getConfig();
  const url = `${config.fulfillmenBaseUrl}/GetOrderTracking.aspx?Key=${encodeURIComponent(config.fulfillmenApiKey)}&OrderNo=${encodeURIComponent(orderId)}`;

  const res = await fetch(url);
  const result = (await res.json()) as {
    success: boolean;
    Code: string | number;
    data?: {
      TrackingNo?: string;
      Carrier?: string;
      TrackingUrl?: string;
      ShipDate?: string;
    };
  };

  if (!result.success || !result.data?.TrackingNo) {
    return null;
  }

  return {
    trackingNumber: result.data.TrackingNo,
    carrier: result.data.Carrier || "Unknown",
    trackingUrl: result.data.TrackingUrl || null,
    shippedAt: result.data.ShipDate || null,
  };
}
