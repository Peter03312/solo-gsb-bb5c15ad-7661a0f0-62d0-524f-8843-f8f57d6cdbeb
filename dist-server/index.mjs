// server/index.ts
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// shared/validation.ts
var KINDS = /* @__PURE__ */ new Set(["article", "paragraph", "item"]);
var KIND_LABEL = {
  article: "\u6761",
  paragraph: "\u6B3E",
  item: "\u9879"
};
var KIND_AT_DEPTH = ["article", "paragraph", "item"];
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function pathLabel(trail) {
  if (trail.length === 0) return "document.root";
  return trail.map((t) => `\u7B2C ${t.ordinal} ${KIND_LABEL[t.kind]}`).join("");
}
function validateTree(root, errors, seenIds, visiting, trail) {
  if (!Array.isArray(root)) {
    errors.push(`${pathLabel(trail)} \u7684 children \u5FC5\u987B\u662F\u6570\u7EC4\uFF08\u5C42\u7EA7\uFF1A\u6761 \u2192 \u6B3E \u2192 \u9879\uFF09`);
    return;
  }
  const depth = trail.length;
  const expectedKind = KIND_AT_DEPTH[depth];
  root.forEach((rawNode, index) => {
    const here2 = [...trail, { kind: expectedKind ?? "item", ordinal: index + 1 }];
    const label = pathLabel(here2);
    if (!isObject(rawNode)) {
      errors.push(`${label}\uFF1A\u8282\u70B9\u5FC5\u987B\u662F\u5BF9\u8C61`);
      return;
    }
    const id = rawNode.id;
    if (typeof id !== "string" || id.trim() === "") {
      errors.push(`${label}\uFF1A\u7F3A\u5C11\u5FC5\u9700\u5B57\u6BB5 id\uFF08\u975E\u7A7A\u5B57\u7B26\u4E32\uFF09\uFF0C\u8282\u70B9 ID \u7528\u4E8E\u5F15\u7528\u5B9A\u4F4D\u4E0E\u5BA1\u7B7E\u5173\u8054`);
    } else {
      const first = seenIds.get(id);
      if (first !== void 0) {
        errors.push(`${label}\uFF1A\u8282\u70B9 id\u300C${id}\u300D\u4E0E ${first} \u91CD\u590D\uFF0C\u5168\u6811\u8282\u70B9 ID \u5FC5\u987B\u552F\u4E00`);
      } else {
        seenIds.set(id, label);
      }
    }
    const kind = rawNode.kind;
    let kindOk = false;
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      errors.push(
        `${label}\uFF1Akind \u5FC5\u987B\u662F article / paragraph / item \u4E4B\u4E00${kind === void 0 ? "\uFF08\u5B57\u6BB5\u7F3A\u5931\uFF09" : `\uFF08\u5B9E\u9645\u4E3A ${JSON.stringify(kind)}\uFF09`}`
      );
    } else if (depth >= KIND_AT_DEPTH.length || kind !== expectedKind) {
      errors.push(
        `${label}\uFF1A\u5C42\u7EA7\u4E0D\u5408\u6CD5\uFF0C\u8BE5\u4F4D\u7F6E\u5E94\u4E3A\u300C${KIND_LABEL[expectedKind]}\u300D\u8282\u70B9\uFF08kind=${kind}\uFF09\uFF0C\u7ED3\u6784\u53EA\u5141\u8BB8 \u6761 \u2192 \u6B3E \u2192 \u9879`
      );
    } else {
      kindOk = true;
    }
    if (typeof rawNode.ordinal !== "number" || !Number.isFinite(rawNode.ordinal)) {
      errors.push(`${label}\uFF1A\u7F3A\u5C11\u5FC5\u9700\u5B57\u6BB5 ordinal\uFF08\u6570\u5B57\uFF09`);
    }
    if (typeof rawNode.text !== "string") {
      errors.push(`${label}\uFF1A\u7F3A\u5C11\u5FC5\u9700\u5B57\u6BB5 text\uFF08\u5B57\u7B26\u4E32\uFF0C\u53EF\u4E3A\u7A7A\u4E32\uFF09`);
    }
    if (rawNode.title !== void 0 && typeof rawNode.title !== "string") {
      errors.push(`${label}\uFF1Atitle \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
    }
    if (rawNode.suffix !== void 0 && typeof rawNode.suffix !== "string") {
      errors.push(`${label}\uFF1Asuffix \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
    }
    if (!Array.isArray(rawNode.children)) {
      errors.push(`${label}\uFF1A\u7F3A\u5C11\u5FC5\u9700\u5B57\u6BB5 children\uFF08\u6570\u7EC4\uFF0C\u53F6\u5B50\u8282\u70B9\u4E3A\u7A7A\u6570\u7EC4\uFF09`);
      return;
    }
    if (kind === "item" && rawNode.children.length > 0) {
      errors.push(`${label}\uFF1A\u9879\u8282\u70B9\u4E0D\u53EF\u518D\u5305\u542B\u5B50\u8282\u70B9\uFF08\u7ED3\u6784\u53EA\u5141\u8BB8 \u6761 \u2192 \u6B3E \u2192 \u9879 \u4E09\u5C42\uFF09`);
      return;
    }
    if (depth >= KIND_AT_DEPTH.length - 1) {
      return;
    }
    if (visiting.has(rawNode)) {
      errors.push(`${label}\uFF1A\u8282\u70B9\u6811\u5B58\u5728\u5FAA\u73AF\u5F15\u7528\uFF0C\u65E0\u6CD5\u6309\u6811\u7ED3\u6784\u5BFC\u5165`);
      return;
    }
    visiting.add(rawNode);
    if (kindOk) {
      validateTree(rawNode.children, errors, seenIds, visiting, here2);
    } else {
    }
    visiting.delete(rawNode);
  });
}
function validateClauseDocument(doc) {
  const errors = [];
  if (!isObject(doc)) {
    return { ok: false, errors: ["document \u5FC5\u987B\u662F\u5BF9\u8C61"] };
  }
  if (doc.title !== void 0 && typeof doc.title !== "string") {
    errors.push("document.title \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  }
  if (!Array.isArray(doc.root)) {
    return { ok: false, errors: ["MISSING_ROOT"] };
  }
  const seenIds = /* @__PURE__ */ new Map();
  validateTree(doc.root, errors, seenIds, /* @__PURE__ */ new WeakSet(), []);
  return {
    ok: errors.length === 0,
    errors,
    rootCount: doc.root.length
  };
}
function validateImportBundle(bundle) {
  if (!isObject(bundle)) {
    return { validation: { ok: false, errors: ["\u5BFC\u5165\u5185\u5BB9\u5FC5\u987B\u662F JSON \u5BF9\u8C61"] } };
  }
  const hasDocument = "document" in bundle;
  const hasDoc = "doc" in bundle;
  if (!hasDocument && !hasDoc) {
    return { validation: { ok: false, errors: ["MISSING_ROOT"] } };
  }
  const rawDoc = hasDocument ? bundle.document : bundle.doc;
  const validation = validateClauseDocument(rawDoc);
  return validation.ok ? { validation, doc: rawDoc } : { validation };
}
function isValidPersistedState(v) {
  if (!isObject(v)) return false;
  if (typeof v.confirmed !== "object" || v.confirmed === null || Array.isArray(v.confirmed)) {
    return false;
  }
  const doc = v.doc;
  if (!isObject(doc) || typeof doc.title !== "string") return false;
  return validateClauseDocument(doc).ok;
}

// server/index.ts
var here = path.dirname(fileURLToPath(import.meta.url));
var PORT = Number(process.env.PORT ?? 3e3);
var DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.env.HOME ?? process.cwd(), ".clause-reference-validator");
var DATA_FILE = path.join(DATA_DIR, "state.json");
var app = express();
app.use(express.json({ limit: "10mb" }));
async function readState() {
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return isValidPersistedState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function atomicWriteState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(state);
  const tmp = path.join(DATA_DIR, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fh = null;
  try {
    fh = await fsp.open(tmp, "wx");
    await fh.writeFile(payload, "utf8");
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, DATA_FILE);
  } catch (err) {
    if (fh) await fh.close().catch(() => void 0);
    await fsp.rm(tmp, { force: true }).catch(() => void 0);
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
  if (!isValidPersistedState(body)) {
    res.status(400).json({ error: "\u6570\u636E\u683C\u5F0F\u4E0D\u5408\u6CD5\uFF1A\u9700\u8981 { doc: { title, root }, confirmed }\uFF0C\u4E14 root \u9700\u6EE1\u8DB3 \u6761\u2192\u6B3E\u2192\u9879 \u5C42\u7EA7\u3001\u5FC5\u9700\u5B57\u6BB5\u9F50\u5168\u3001\u8282\u70B9 ID \u5168\u6811\u552F\u4E00" });
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
  const { validation } = validateImportBundle(bundle);
  if (!validation.ok) {
    const detail = validation.errors[0] === "MISSING_ROOT" ? "\u5BFC\u5165\u6587\u4EF6\u7F3A\u5C11 document.root" : validation.errors.join("\uFF1B");
    res.status(400).json({ error: detail });
    return;
  }
  const doc = bundle && typeof bundle === "object" && "document" in bundle ? bundle.document : bundle.doc;
  res.json({ ok: true, title: typeof doc.title === "string" ? doc.title : void 0, rootCount: validation.rootCount ?? 0 });
});
var distDir = path.resolve(here, "../dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) {
      res.sendFile(path.join(distDir, "index.html"));
    } else {
      next();
    }
  });
}
async function cleanupStaleTmpFiles() {
  try {
    const entries = await fs.promises.readdir(DATA_DIR);
    await Promise.all(
      entries.filter(
        (name) => name.startsWith(".state.") && name.endsWith(".tmp") || name === "state.json.tmp"
      ).map(
        (name) => fs.promises.rm(path.join(DATA_DIR, name), { force: true }).catch(() => void 0)
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
