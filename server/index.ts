import { join } from "node:path";
import { config, validateConfig } from "./config.js";
import { Store } from "./store.js";
import { ContextMesh } from "./service.js";
import { createApp } from "./app.js";
validateConfig();
const store = new Store(join(config.dataDir, "contextmesh.sqlite"));
const mesh = new ContextMesh(store);
const server = createApp(mesh).listen(
  config.port,
  process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
  () =>
    console.log(
      `ContextMesh API listening on port ${config.port} · ${config.mode}`,
    ),
);
const timer = setInterval(() => {
  void store
    .exclusive(async () => mesh.graph.sync(store.read()))
    .catch(() => {});
}, 15000);
timer.unref();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
