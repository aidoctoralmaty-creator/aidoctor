const LIMIT = 5;
const HOLD_MS = 3 * 60 * 1000;
const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Almaty", year: "numeric", month: "2-digit",
});

function monthKey(date = new Date()) {
  const parts = Object.fromEntries(calendar.formatToParts(date).map(p => [p.type, p.value]));
  return parts.year + "-" + parts.month;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function active(entries, now) {
  return entries.filter(e => e.done || e.until > now);
}

async function update(store, key, change) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const record = await store.getWithMetadata(key, { type: "json" });
    const entries = active(record?.data || [], Date.now());
    const result = change(entries);
    if (!result.write) return result.value;
    const condition = record ? { onlyIfMatch: record.etag } : { onlyIfNew: true };
    if ((await store.setJSON(key, entries, condition)).modified) return result.value;
  }
  throw new HttpError(503, "Не удалось обновить счётчик. Попробуй ещё раз.");
}

function remaining(store, key) {
  return update(store, key, entries => ({ value: LIMIT - entries.length }));
}

function reserve(store, key, request, thread) {
  return update(store, key, entries => {
    const previous = entries.find(e => e.request === request);
    if (previous?.done && previous.thread === thread) return { value: "completed" };
    if (previous || entries.some(e => !e.done && e.thread === thread)) {
      throw new HttpError(409, "Предыдущий запрос ещё обрабатывается.");
    }
    if (entries.length >= LIMIT) {
      throw new HttpError(429, "Все 5 разборов месяца использованы или уже обрабатываются. Лимит обновится 1-го числа по времени Алматы.");
    }
    entries.push({ request, thread, until: Date.now() + HOLD_MS });
    return { write: true, value: "reserved" };
  });
}

function settle(store, key, request, success) {
  return update(store, key, entries => {
    const index = entries.findIndex(e => e.request === request);
    if (index < 0 && success) throw new HttpError(503, "Время обработки истекло. Повтори запрос.");
    if (index < 0 || entries[index].done) return { value: LIMIT - entries.length };
    if (success) entries[index] = { request, thread: entries[index].thread, done: true };
    else entries.splice(index, 1);
    return { write: true, value: LIMIT - entries.length };
  });
}

module.exports = { HttpError, LIMIT, monthKey, remaining, reserve, settle };
