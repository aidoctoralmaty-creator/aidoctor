const { randomUUID, createHash } = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");
const Anthropic = require("@anthropic-ai/sdk");
const { HttpError, LIMIT, monthKey, remaining, reserve, settle } = require("./quota");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);
const SYSTEM = `Ты — aiDoctor, ИИ-ассистент. Отвечай на вопрос простым русским языком.
Разбирай все приложенные результаты одного человека вместе. Сравнивай сопоставимые показатели с учётом дат, единиц и референсов на каждом бланке. Назови исходное и новое значения и объясни изменение. Уточняй недостающие данные. Если бланк нечитаем, скажи об этом. Используй только предоставленные сведения. Отделяй данные от предположений. Не ставь окончательный диагноз и не назначай лечение.
Предлагай подходящего специалиста по показаниям. Только если человек сам спрашивает об очной помощи по подходящей для планового остеопатического приёма жалобе и не описывает тревожных симптомов, можешь добавить в конце отдельную строку [ЗАПИСЬ]. Если требуется срочная помощь, скажи об этом ясно. При обычном сравнении анализов запись не предлагай.`;

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" }, body: JSON.stringify(body) };
}

function parse(body) {
  let input;
  try { input = JSON.parse(body); } catch { throw new HttpError(400, "Не удалось прочитать запрос."); }
  if (!input || typeof input !== "object") throw new HttpError(400, "Нет данных для разбора.");
  const files = input.files ?? (input.fileData ? [{ data: input.fileData, mediaType: input.mediaType }] : []);
  if (!Array.isArray(files) || files.some(f => !f || !TYPES.has(f.mediaType) || typeof f.data !== "string" || !f.data.length)) {
    throw new HttpError(400, "Загрузи PDF или изображение JPEG, PNG, GIF или WebP.");
  }
  const symptoms = typeof input.symptoms === "string" ? input.symptoms.trim() : "";
  if (!files.length && !symptoms) throw new HttpError(400, "Добавь хотя бы один файл или вопрос.");
  const content = files.map(f => ({
    type: f.mediaType === "application/pdf" ? "document" : "image",
    source: { type: "base64", media_type: f.mediaType, data: f.data },
  }));
  const profile = [input.name, input.age, input.gender].filter(Boolean).join(", ");
  content.push({ type: "text", text: [profile, symptoms || "Разбери загруженные результаты."].filter(Boolean).join("\n") });
  const thread = createHash("sha256").update(JSON.stringify([input.session_id || randomUUID(), profile])).digest("hex");
  const request = input.request_id ?? randomUUID();
  if (!UUID.test(request)) throw new HttpError(400, "Некорректный ID запроса.");
  return { content, thread, request };
}

function makeHandler(openStores, ask, now = () => new Date()) {
  return async event => {
    try {
      if (!["GET", "POST"].includes(event.httpMethod)) return json(405, { error: "Метод не поддерживается." });
      const id = event.headers?.["x-aidoctor-id"];
      if (!UUID.test(id || "")) throw new HttpError(400, "Обнови страницу, чтобы получить ID браузера.");
      const parsed = event.httpMethod === "POST" ? parse(event.body) : null;
      const { quota, sessions } = openStores(event);
      const month = monthKey(now());
      const key = month + "/" + id;
      if (!parsed) return json(200, { limit: LIMIT, month, remaining: await remaining(quota, key) });

      const { content, thread, request } = parsed;
      const sessionKey = id + "/" + thread;
      const state = await reserve(quota, key, request, thread);
      try {
        const saved = await sessions.get(sessionKey, { type: "json" });
        const history = saved && saved.expires > Date.now() ? saved.messages : [];
        const replies = saved && saved.expires > Date.now() ? saved.replies : {};
        let result = replies[request];
        if (state === "completed" && !result) throw new HttpError(409, "Этот разбор уже выполнен.");
        if (!result) {
          history.push({ role: "user", content });
          result = await ask(history);
          if (typeof result !== "string" || !result.trim()) throw new Error("empty_response");
          history.push({ role: "assistant", content: result });
          replies[request] = result;
          await sessions.setJSON(sessionKey, { messages: history, replies, expires: Date.now() + 86400000 });
        }
        const left = await settle(quota, key, request, true);
        return json(200, { result, remaining: left, month, limit: LIMIT });
      } catch (error) {
        if (state === "reserved") await settle(quota, key, request, false);
        throw error;
      }
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      console.error("aiDoctor request failed", error.name, error.status);
      return json(503, { error: "Не удалось завершить разбор. Попробуй ещё раз." });
    }
  };
}

const handler = makeHandler(event => {
  if (event.blobs) connectLambda(event);
  return {
    quota: getStore({ name: "aidoctor-monthly", consistency: "strong" }),
    sessions: getStore({ name: "aidoctor-sessions", consistency: "strong" }),
  };
}, async messages => {
  const client = new Anthropic.default({ maxRetries: 0, timeout: 55000 });
  const response = await client.messages.create({ model: process.env.ANTHROPIC_MODEL || "claude-opus-4-5", max_tokens: 2000, system: SYSTEM, messages });
  return response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
});

module.exports = { handler, makeHandler };
