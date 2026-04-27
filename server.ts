import express from "express";
import { createRequestHandler } from "@remix-run/express";
import { loadConfig, getConfig } from "~/config/app-config.js";
import { initStaleRecovery } from "~/lib/stale-recovery.js";
import { initCron } from "~/lib/cron.js";

await loadConfig();
await initStaleRecovery();
initCron();

const config = getConfig();
const app = express();

const viteDevServer =
  config.nodeEnv !== "production"
    ? await import("vite").then((vite) =>
        vite.createServer({ server: { middlewareMode: true } }),
      )
    : undefined;

if (viteDevServer) {
  app.use(viteDevServer.middlewares);
} else {
  app.use(express.static("build/client"));
}

app.all(
  "*",
  createRequestHandler({
    build: viteDevServer
      ? () => viteDevServer.ssrLoadModule("virtual:remix/server-build")
      : // @ts-expect-error build path resolved at runtime
        await import("./build/server/index.js"),
  }),
);

const port = config.port;
app.listen(port, () => {
  console.log(
    JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      message: `Server started on port ${port}`,
    }),
  );
});
