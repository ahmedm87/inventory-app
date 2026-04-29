import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import { prisma } from "~/db.server.js";

interface StockRow {
  sku: string;
  warehouses: Record<string, { quantity: number; lastSyncedAt: string }>;
  total: number;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.toUpperCase() || "";

  const stockLevels = await prisma.stockLevel.findMany({
    include: { warehouse: true },
    orderBy: { sku: "asc" },
  });

  const skuMap = new Map<string, StockRow>();

  for (const sl of stockLevels) {
    if (search && !sl.sku.toUpperCase().includes(search)) continue;

    let row = skuMap.get(sl.sku);
    if (!row) {
      row = { sku: sl.sku, warehouses: {}, total: 0 };
      skuMap.set(sl.sku, row);
    }
    row.warehouses[sl.warehouse.region] = {
      quantity: sl.quantity,
      lastSyncedAt: sl.lastSyncedAt.toISOString(),
    };
    row.total += sl.quantity;
  }

  const rows = Array.from(skuMap.values());

  const lastSync = stockLevels.length > 0
    ? stockLevels.reduce((latest, sl) =>
        sl.lastSyncedAt > latest ? sl.lastSyncedAt : latest,
      stockLevels[0].lastSyncedAt).toISOString()
    : null;

  return json({ rows, lastSync, search });
}

const cellStyle: React.CSSProperties = {
  padding: "0.5rem",
  borderBottom: "1px solid #eee",
};

const zeroCellStyle: React.CSSProperties = {
  ...cellStyle,
  backgroundColor: "#fff3cd",
  color: "#856404",
  fontWeight: 600,
};

export default function StockLevels() {
  const { rows, lastSync, search } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Stock Levels</h1>
      {lastSync && (
        <p style={{ color: "#6c757d", fontSize: "0.85rem" }}>
          Last synced: {new Date(lastSync).toLocaleString()}
        </p>
      )}

      <div style={{ marginBottom: "1rem" }}>
        <input
          type="text"
          placeholder="Filter by SKU..."
          defaultValue={search}
          onChange={(e) => {
            const val = e.target.value;
            if (val) {
              setSearchParams({ search: val });
            } else {
              setSearchParams({});
            }
          }}
          style={{
            padding: "0.5rem",
            border: "1px solid #ddd",
            borderRadius: "4px",
            width: "300px",
          }}
        />
      </div>

      {rows.length === 0 ? (
        <p>No stock data available. Run a stock sync first.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["SKU", "ShipBob US", "ShipBob EU", "ShipBob AU", "Fulfillmen CN", "Total"].map(
                (h) => (
                  <th
                    key={h}
                    style={{
                      borderBottom: "2px solid #ddd",
                      padding: "0.5rem",
                      textAlign: "left",
                    }}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const regions = ["US", "EU", "AU", "CN"];
              return (
                <tr key={row.sku}>
                  <td style={cellStyle}>
                    <strong>{row.sku}</strong>
                  </td>
                  {regions.map((region) => {
                    const data = row.warehouses[region];
                    const qty = data?.quantity ?? 0;
                    return (
                      <td
                        key={region}
                        style={qty === 0 ? zeroCellStyle : cellStyle}
                      >
                        {qty}
                      </td>
                    );
                  })}
                  <td style={{ ...cellStyle, fontWeight: 600 }}>{row.total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
