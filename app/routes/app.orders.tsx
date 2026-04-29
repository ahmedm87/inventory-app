import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useRevalidator } from "@remix-run/react";
import { prisma } from "~/db.server.js";
import { useState } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const attention = url.searchParams.get("attention") === "true";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const pageSize = 20;

  const where: Record<string, unknown> = {};
  if (status) {
    where.processingStatus = status;
  }
  if (attention) {
    where.requiresManualIntervention = true;
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        assignedWarehouse: true,
        lineItems: true,
        fulfillmentRequests: {
          include: { trackingUpdates: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  const warehouses = await prisma.warehouse.findMany({
    where: { isActive: true },
  });

  return json({
    orders: orders.map((o) => ({
      ...o,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      assignedAt: o.assignedAt?.toISOString() || null,
      fulfilledAt: o.fulfilledAt?.toISOString() || null,
    })),
    warehouses,
    total,
    page,
    pageSize,
    status,
    attention,
  });
}

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  PENDING: { bg: "#fff3cd", color: "#856404" },
  ASSIGNING: { bg: "#fff3cd", color: "#856404" },
  ASSIGNED: { bg: "#cce5ff", color: "#004085" },
  FULFILLMENT_SENT: { bg: "#d4edda", color: "#155724" },
  FULFILLED: { bg: "#d4edda", color: "#155724" },
  CANCELLED: { bg: "#e2e3e5", color: "#383d41" },
  REASSIGNING: { bg: "#fff3cd", color: "#856404" },
  REASSIGNMENT_FAILED: { bg: "#f8d7da", color: "#721c24" },
};

const cellStyle: React.CSSProperties = {
  padding: "0.5rem",
  borderBottom: "1px solid #eee",
  fontSize: "0.9rem",
};

export default function OrdersView() {
  const { orders, warehouses, total, page, pageSize, status, attention } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const [reassigning, setReassigning] = useState<string | null>(null);

  const totalPages = Math.ceil(total / pageSize);

  async function handleReassign(orderId: string, newWarehouseId: string) {
    setReassigning(orderId);
    try {
      const res = await fetch("/api/reassign-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, newWarehouseId }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`Reassignment failed: ${data.error || "Unknown error"}`);
      }
      revalidator.revalidate();
    } catch {
      alert("Reassignment request failed");
    } finally {
      setReassigning(null);
    }
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Orders</h1>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <select
          value={status}
          onChange={(e) => {
            const params: Record<string, string> = {};
            if (e.target.value) params.status = e.target.value;
            if (attention) params.attention = "true";
            setSearchParams(params);
          }}
          style={{ padding: "0.4rem", border: "1px solid #ddd", borderRadius: "4px" }}
        >
          <option value="">All Statuses</option>
          {Object.keys(STATUS_COLORS).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.9rem" }}>
          <input
            type="checkbox"
            checked={attention}
            onChange={(e) => {
              const params: Record<string, string> = {};
              if (status) params.status = status;
              if (e.target.checked) params.attention = "true";
              setSearchParams(params);
            }}
          />
          Needs Attention
        </label>

        <span style={{ color: "#6c757d", fontSize: "0.85rem", alignSelf: "center" }}>
          {total} orders
        </span>
      </div>

      {orders.length === 0 ? (
        <p>No orders found.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["Order #", "Country", "Warehouse", "Status", "Items", "Assigned", "Tracking", "Actions"].map(
                (h) => (
                  <th
                    key={h}
                    style={{
                      borderBottom: "2px solid #ddd",
                      padding: "0.5rem",
                      textAlign: "left",
                      fontSize: "0.85rem",
                    }}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const colors = STATUS_COLORS[order.processingStatus] || { bg: "#e2e3e5", color: "#383d41" };
              const tracking = order.fulfillmentRequests[0]?.trackingUpdates[0];
              const canReassign =
                order.processingStatus === "ASSIGNED" ||
                order.processingStatus === "FULFILLMENT_SENT";

              return (
                <tr key={order.id}>
                  <td style={cellStyle}>
                    <strong>{order.shopifyOrderNumber || order.shopifyOrderId}</strong>
                  </td>
                  <td style={cellStyle}>{order.destinationCountryCode || "—"}</td>
                  <td style={cellStyle}>
                    {order.assignedWarehouse?.name || "—"}
                  </td>
                  <td style={cellStyle}>
                    <span
                      style={{
                        padding: "0.15rem 0.5rem",
                        borderRadius: "4px",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                        backgroundColor: colors.bg,
                        color: colors.color,
                      }}
                    >
                      {order.processingStatus}
                    </span>
                    {order.requiresManualIntervention && (
                      <span
                        style={{
                          marginLeft: "0.3rem",
                          padding: "0.15rem 0.4rem",
                          borderRadius: "4px",
                          fontSize: "0.75rem",
                          fontWeight: 700,
                          backgroundColor: "#dc3545",
                          color: "#fff",
                        }}
                        title={order.manualInterventionReason || ""}
                      >
                        ATTENTION
                      </span>
                    )}
                  </td>
                  <td style={cellStyle}>{order.totalLineItems}</td>
                  <td style={cellStyle}>
                    {order.assignedAt
                      ? new Date(order.assignedAt).toLocaleString()
                      : "—"}
                  </td>
                  <td style={cellStyle}>
                    {tracking?.trackingNumber || "—"}
                  </td>
                  <td style={cellStyle}>
                    {canReassign && (
                      <select
                        disabled={reassigning === order.id}
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) {
                            handleReassign(order.id, e.target.value);
                            e.target.value = "";
                          }
                        }}
                        style={{
                          padding: "0.25rem",
                          fontSize: "0.8rem",
                          border: "1px solid #ddd",
                          borderRadius: "4px",
                        }}
                      >
                        <option value="">Reassign...</option>
                        {warehouses
                          .filter((w) => w.id !== order.assignedWarehouseId)
                          .map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                      </select>
                    )}
                    {order.processingStatus === "REASSIGNMENT_FAILED" && (
                      <span style={{ color: "#dc3545", fontSize: "0.8rem" }}>
                        {order.manualInterventionReason || "Reassignment failed"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => {
                const params: Record<string, string> = { page: String(p) };
                if (status) params.status = status;
                if (attention) params.attention = "true";
                setSearchParams(params);
              }}
              style={{
                padding: "0.3rem 0.6rem",
                border: "1px solid #ddd",
                borderRadius: "4px",
                backgroundColor: p === page ? "#007bff" : "#fff",
                color: p === page ? "#fff" : "#333",
                cursor: "pointer",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
