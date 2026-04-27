export function syncLog(
  level: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      level,
      timestamp: new Date().toISOString(),
      component: "sync",
      message,
      ...extra,
    }),
  );
}
