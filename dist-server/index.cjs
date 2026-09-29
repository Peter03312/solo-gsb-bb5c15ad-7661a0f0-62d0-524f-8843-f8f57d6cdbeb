"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server/index.ts
var import_express = __toESM(require("express"), 1);
var import_node_crypto = __toESM(require("node:crypto"), 1);
var import_node_fs = __toESM(require("node:fs"), 1);
var import_promises = __toESM(require("node:fs/promises"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");
var import_meta = {};
var here;
try {
  here = typeof __dirname !== "undefined" ? __dirname : import_node_path.default.dirname((0, import_node_url.fileURLToPath)(import_meta.url));
} catch {
  here = import_node_path.default.dirname(new URL(import_meta.url).pathname);
}
var PORT = Number(process.env.PORT ?? 3e3);
var DATA_DIR = process.env.DATA_DIR ? import_node_path.default.resolve(process.env.DATA_DIR) : import_node_path.default.join(process.env.HOME ?? process.cwd(), ".clause-reference-validator");
var DATA_FILE = import_node_path.default.join(DATA_DIR, "state.json");
var app = (0, import_express.default)();
app.use(import_express.default.json({ limit: "10mb" }));
function isPersistedState(v) {
  if (!v || typeof v !== "object") return false;
  const doc = v.doc;
  return Boolean(doc && Array.isArray(doc.root) && typeof doc.title === "string");
}
async function readState() {
  try {
    const raw = await import_promises.default.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return isPersistedState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function atomicWriteState(state) {
  await import_promises.default.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(state);
  const tmp = import_node_path.default.join(DATA_DIR, `.state.${process.pid}.${import_node_crypto.default.randomUUID()}.tmp`);
  let fh = null;
  try {
    fh = await import_promises.default.open(tmp, "wx");
    await fh.writeFile(payload, "utf8");
    await fh.sync();
    await fh.close();
    fh = null;
    await import_promises.default.rename(tmp, DATA_FILE);
  } catch (err) {
    if (fh) await fh.close().catch(() => void 0);
    await import_promises.default.rm(tmp, { force: true }).catch(() => void 0);
    throw err;
  }
}
var writeChain = Promise.resolve();
function enqueueWrite(state) {
  const next = writeChain.then(() => atomicWriteState(state));
  writeChain = next.then(
    () => void 0,
    () => void 0
  );
  return next;
}
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "clause-reference-validator" });
});
app.get("/api/state", async (_req, res) => {
  const state = await readState();
  res.json({ state });
});
app.put("/api/state", async (req, res) => {
  const body = req.body;
  if (!isPersistedState(body)) {
    res.status(400).json({ error: "\u6570\u636E\u683C\u5F0F\u4E0D\u5408\u6CD5\uFF1A\u9700\u8981 { doc: { title, root }, confirmed }" });
    return;
  }
  try {
    await enqueueWrite(body);
    res.json({ ok: true, savedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: `\u4FDD\u5B58\u5931\u8D25\uFF1A${err.message}` });
  }
});
app.post("/api/validate", (req, res) => {
  const bundle = req.body;
  if (!bundle || !bundle.document || !Array.isArray(bundle.document.root)) {
    res.status(400).json({ error: "\u5BFC\u5165\u6587\u4EF6\u7F3A\u5C11 document.root" });
    return;
  }
  res.json({ ok: true, title: bundle.document.title, rootCount: bundle.document.root.length });
});
var distDir = import_node_path.default.resolve(here, "../dist");
if (import_node_fs.default.existsSync(distDir)) {
  app.use(import_express.default.static(distDir));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) {
      res.sendFile(import_node_path.default.join(distDir, "index.html"));
    } else {
      next();
    }
  });
}
async function cleanupStaleTmpFiles() {
  try {
    const entries = await import_node_fs.default.promises.readdir(DATA_DIR);
    await Promise.all(
      entries.filter(
        (name) => name.startsWith(".state.") && name.endsWith(".tmp") || name === "state.json.tmp"
      ).map(
        (name) => import_node_fs.default.promises.rm(import_node_path.default.join(DATA_DIR, name), { force: true }).catch(() => void 0)
      )
    );
  } catch {
  }
}
void (async () => {
  await cleanupStaleTmpFiles();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\u6761\u6B3E\u5F15\u7528\u6821\u9A8C\u53F0\u5DF2\u542F\u52A8\uFF1A http://localhost:${PORT}`);
    console.log(`\u672C\u5730\u6570\u636E\u6587\u4EF6\uFF1A${DATA_FILE}`);
  });
})();
