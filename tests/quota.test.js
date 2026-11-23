const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { makeHandler } = require("../lib/analysis");
const { monthKey } = require("../lib/quota");

function memoryStore() {
  const rows = new Map();
  return {
    async getWithMetadata(key) { return structuredClone(rows.get(key)); },
    async get(key) { return structuredClone(rows.get(key)?.data); },
    async setJSON(key, data, options = {}) {
      const old = rows.get(key);
      if ((options.onlyIfNew && old) || (options.onlyIfMatch && old?.etag !== options.onlyIfMatch)) return { modified: false };
      rows.set(key, { etag: randomUUID(), data: structuredClone(data) });
      return { modified: true };
    },
  };
}
function fixture(ask = async () => "Ответ") {
  const stores = { quota: memoryStore(), sessions: memoryStore() };
  let date = new Date("2026-11-30T18:59:59Z");
  const handler = makeHandler(() => stores, ask, () => date);
  const id = randomUUID();
  function call(input, browser = id) {
    return handler({ httpMethod: input ? "POST" : "GET", headers: { "x-aidoctor-id": browser }, body: JSON.stringify(input) });
  }
  return { call, nextMonth: () => { date = new Date("2026-11-30T19:00:00Z"); } };
}

test("five simultaneous reservations per ID, reset at midnight in Almaty", async () => {
  const { call, nextMonth } = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => call({ symptoms: "Вопрос" })));
  assert.equal(results.filter(r => r.statusCode === 200).length, 5);
  assert.equal(results.filter(r => r.statusCode === 429).length, 3);
  assert.equal(JSON.parse((await call()).body).remaining, 0);
  assert.equal((await call({ symptoms: "Вопрос" }, randomUUID())).statusCode, 200);
  nextMonth();
  assert.equal(JSON.parse((await call()).body).remaining, 5);
  assert.equal(monthKey(new Date("2026-12-31T19:00:00Z")), "2027-01");
});

test("one request for multiple files, idempotent retry, follow-up sees history", async () => {
  const seen = [];
  const { call } = fixture(async history => { seen.push(structuredClone(history)); return "Ответ"; });
  const file = { mediaType: "application/pdf", data: "YQ==" };
  const input = { files: [file, file], symptoms: "Сравни", session_id: randomUUID(), request_id: randomUUID() };
  for (let i = 0; i < 2; i++) assert.equal(JSON.parse((await call(input)).body).remaining, 4);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].content.length, 3);
  await call({ session_id: input.session_id, symptoms: "Что изменилось?", request_id: randomUUID() });
  assert.equal(seen[1].length, 3);
  await call({ session_id: input.session_id, symptoms: "Мой анализ" }, randomUUID());
  assert.equal(seen[2].length, 1);
});

test("provider failure and invalid input do not consume quota; legacy format is metered", async () => {
  let attempts = 0;
  const { call } = fixture(async () => { if (!attempts++) throw new Error("provider"); return "Ответ"; });
  const input = { fileData: "YQ==", mediaType: "image/jpeg", session_id: randomUUID(), request_id: randomUUID() };
  assert.equal((await call({})).statusCode, 400);
  assert.equal((await call(input)).statusCode, 503);
  assert.equal(JSON.parse((await call()).body).remaining, 5);
  assert.equal(JSON.parse((await call(input)).body).remaining, 4);
  assert.equal(require("../netlify/functions/analyze-pro").handler, require("../netlify/functions/analyze").handler);
});
