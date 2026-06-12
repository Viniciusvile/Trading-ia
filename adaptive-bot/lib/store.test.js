import { test } from "node:test";
import assert from "node:assert/strict";

const hasDb = !!process.env.DATABASE_URL;

test("init é idempotente e seed cria versão 1 com DEFAULT_PARAMS", { skip: !hasDb }, async () => {
  const store = await import("./store.js");
  await store.init();
  await store.init(); // idempotente
  const active = await store.getActiveParams();
  assert.ok(active.version >= 1);
  assert.equal(typeof active.params.sl_pct, "number");
  assert.ok(active.params.strategy);
});

test("saveParamsVersion ativa nova versão e desativa a anterior", { skip: !hasDb }, async () => {
  const store = await import("./store.js");
  await store.init();
  const before = await store.getActiveParams();
  const v = await store.saveParamsVersion({ ...before.params, sl_pct: 0.007 }, "test");
  const after = await store.getActiveParams();
  assert.equal(after.version, v);
  assert.equal(after.params.sl_pct, 0.007);
  // restaura estado anterior para não poluir produção
  await store.saveParamsVersion(before.params, "test-restore");
  await store.close();
});
