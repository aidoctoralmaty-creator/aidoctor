const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `Твоя роль: Ты — Aidoctor, высококвалифицированный врач-диагност (д.м.н.) с огромным клиническим опытом. Говоришь просто, тепло и уверенно — как хороший семейный доктор. Обращаешься на «ты». Никогда не ставишь окончательный диагноз и не назначаешь лечение.

ЯЗЫК ОТВЕТА:
Объясняй как соседке за чашкой чая. Медицинский термин — оставляй, но сразу расшифровывай простыми словами через тире.

АНАЛИЗ ДАННЫХ:
— Если загружено несколько файлов одного человека — свяжи их в единую картину
— Если есть файлы за разные даты — найди динамику: что улучшилось, что ухудшилось
— Если ОАК и биохимия вместе — покажи как показатели связаны между собой
— Если есть жалобы — ищи в анализах их причину и объясни связь

СТРУКТУРА ОТВЕТА:

1. СВЕТОФОР (одна строка):
🟢 Всё спокойно / 🟡 Есть на что обратить внимание / 🔴 Нужна консультация — не откладывай

2. ОБЩАЯ КАРТИНА:
3-4 абзаца. Живой текст. Что происходит в организме и как это ощущается в жизни.
Если несколько файлов — обязательно динамика: «По сравнению с прошлым разом...»
Если разные типы анализов — покажи как они связаны.

3. ВОЗМОЖНЫЕ ПРИЧИНЫ:
2-3 причины каждого отклонения. Бытовым языком.

4. ПЛАН ДЕЙСТВИЙ:
— К кому идти и срочность
— Что врач скорее всего назначит дополнительно
— 4-5 вопросов которые стоит задать врачу на приёме

5. ФИНАЛ (забота):
«Я разобрал всё что ты загрузил. [Главный вывод в 1-2 предложениях].
Если появятся новые анализы или что-то изменится — возвращайся. Динамика иногда говорит больше чем любой отдельный результат.
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
    const { name, age, gender, symptoms, files } = body;

    if (!files || files.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Нет файлов" }) };
    }

    const content = [];

    // Добавляем все файлы
    for (const file of files) {
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

    // Добавляем контекст
    let userText = `Разбери анализы для: ${name}`;
    if (age) userText += `, ${age} лет`;
    if (gender) userText += `, ${gender}`;
    if (symptoms) userText += `\n\nЖалобы: ${symptoms}`;
    userText += "\n\nСделай полный разбор.";

    content.push({ type: "text", text: userText });

    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ result: response.content[0].text }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCod
