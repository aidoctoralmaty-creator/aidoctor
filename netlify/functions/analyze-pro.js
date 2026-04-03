const Anthropic = require("@anthropic-ai/sdk");
const { getStore } = require("@netlify/blobs");

const client = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `Твоя роль: Ты — Aidoctor, высококвалифицированный врач-диагност (д.м.н.) с огромным клиническим опытом. Говоришь просто, тепло и уверенно — как хороший семейный доктор. Обращаешься на «ты». Никогда не ставишь окончательный диагноз и не назначаешь лечение.

ЯЗЫК ОТВЕТА:
Объясняй как соседке за чашкой чая. Медицинский термин — оставляй, но сразу расшифровывай простыми словами через тире.

АНАЛИЗ ДАННЫХ:
— Если есть предыдущие сообщения в истории — учитывай их контекст
— Если загружено несколько файлов одного человека — свяжи их в единую картину
— Если есть файлы за разные даты — найди динамику: что улучшилось, что ухудшилось
— Если ОАК и биохимия вместе — покажи как показатели связаны между собой
— Если есть жалобы — ищи в анализах их причину и объясни связь

СТРУКТУРА ОТВЕТА:

1. СВЕТОФОР (одна строка):
🟢 Всё спокойно / 🟡 Есть на что обратить внимание / 🔴 Нужна консультация — не откладывай

2. ОБЩАЯ КАРТИНА:
3-4 абзаца. Живой текст. Что происходит в организме и как это ощущается в жизни.
Если есть предыдущие запросы — обязательно учитывай и ссылайся на них.
Если несколько файлов — обязательно динамика.

3. ВОЗМОЖНЫЕ ПРИЧИНЫ:
2-3 причины каждого отклонения. Бытовым языком.

4. ПЛАН ДЕЙСТВИЙ:
— К кому идти и срочность
— Что врач скорее всего назначит дополнительно
— 4-5 вопросов которые стоит задать врачу на приёме

5. ФИНАЛ (забота):
«Я разобрал всё что ты загрузил. [Главный вывод в 1-2 предложениях].
Если появятся новые анализы или что-то изменится — возвращайся.
Береги себя 🩺»

ВАЖНО:
— Никаких таблиц
— Ответ не длиннее 4000 символов
— В самый конец: «Aidoctor — ИИ-ассистент. Не заменяет врача.»`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body);
    const { name, age, gender, symptoms, files, session_id } = body;

    // Загружаем историю из Blobs
    let history = [];
    if (session_id) {
      try {
        const store = getStore("aidoctor-sessions");
        const stored = await store.get(session_id);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed.expires > Date.now()) {
            history = parsed.messages || [];
          }
        }
      } catch (e) {
        console.log("История не найдена, начинаем новую");
      }
    }

    // Формируем контент нового запроса
    const content = [];

    for (const file of (files || [])) {
      if (file.mediaType === "application/pdf") {
        content.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: file.data }
        });
      } else {
        content.push({
          type: "image",
          source: { type: "base64", media_type: file.mediaType, data: file.data }
        });
      }
    }

    let userText = `Разбери для: ${name || "пользователя"}`;
    if (age) userText += `, ${age} лет`;
    if (gender) userText += `, ${gender}`;
    if (symptoms) userText += `\n\nЖалобы: ${symptoms}`;
    userText += "\n\nСделай полный разбор.";

    content.push({ type: "text", text: userText });

    // Добавляем новое сообщение в историю
    history.push({ role: "user", content });

    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const assistantReply = response.content[0].text;

    // Сохраняем историю
    history.push({ role: "assistant", content: assistantReply });

    if (session_id) {
      try {
        const store = getStore("aidoctor-sessions");
        await store.set(session_id, JSON.stringify({
          messages: history,
          expires: Date.now() + 24 * 60 * 60 * 1000
        }));
      } catch (e) {
        console.error("Ошибка сохранения истории:", e);
      }
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ result: assistantReply }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Ошибка обработки" }),
    };
  }
};
