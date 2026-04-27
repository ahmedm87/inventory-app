import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { prisma } from "~/db.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const runs = await prisma.syncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 10,
  });

  return json({ runs });
}

export default function SyncStatus() {
  const { runs } = useLoaderData<typeof loader>();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Inventory Sync Status</h1>
      {runs.length === 0 ? (
        <p>No sync runs recorded yet.</p>
      ) : (
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
          }}
        >
          <thead>
            <tr>
              {[
                "Status",
                "Source",
                "Triggered By",
                "Started",
                "Completed",
                "Updated",
                "Skipped",
                "Unmatched",
                "Errors",
              ].map((h) => (
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
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  <span
                    style={{
                      padding: "0.15rem 0.5rem",
                      borderRadius: "4px",
                      fontSize: "0.85rem",
                      fontWeight: 600,
                      backgroundColor:
                        run.status === "COMPLETED"
                          ? "#d4edda"
                          : run.status === "FAILED"
                            ? "#f8d7da"
                            : "#fff3cd",
                      color:
                        run.status === "COMPLETED"
                          ? "#155724"
                          : run.status === "FAILED"
                            ? "#721c24"
                            : "#856404",
                    }}
                  >
                    {run.status}
                  </span>
                </td>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  {run.source}
                </td>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  {run.triggeredBy}
                </td>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  {new Date(run.startedAt).toLocaleString()}
                </td>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  {run.completedAt
                    ? new Date(run.completedAt).toLocaleString()
                    : "—"}
                </td>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  {run.totalUpdated}
                </td>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  {run.totalSkipped}
                </td>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  {run.totalUnmatched}
                </td>
                <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                  {run.totalErrors}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
