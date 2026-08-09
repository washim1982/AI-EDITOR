import { parentPort } from "node:worker_threads";
import { startApiServer } from "../server/forge-server.mjs";

if (!parentPort) throw new Error("Forge sidecar must run in an extension-host worker.");

try {
  const started = await startApiServer(0);
  parentPort.postMessage({ type: "ready", url: started.url });
  parentPort.on("message", (message) => {
    if (message !== "stop") return;
    started.server.close(() => process.exit(0));
  });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
