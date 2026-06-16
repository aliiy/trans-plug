/**
 * DeepSeek API translation client.
 * Sends batch text arrays, receives JSON array of translations.
 */

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';

const SYSTEM_PROMPT = `You are a translator. Detect if the input text is English or Japanese.
Translate it into Simplified Chinese.
If the input contains numbers, URLs, code, or is already Chinese, output it unchanged.
Return a valid JSON array only, matching the input order. No extra text.`;

/**
 * Translate a batch of text strings via DeepSeek API.
 * Returns translations in the same order as the input array.
 */
export async function translateBatch(
  texts: string[],
  apiKey: string
): Promise<string[]> {
  const userMessage = JSON.stringify(texts);

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown error');
    throw new Error(
      `DeepSeek API error ${response.status}: ${response.statusText} — ${errorBody}`
    );
  }

  const data: {
    choices: Array<{ message: { content: string } }>;
  } = await response.json();

  const raw = data.choices?.[0]?.message?.content ?? '';
  // Try to extract a JSON array from the response
  const parsed = extractJsonArray(raw);
  if (!parsed) {
    throw new Error(`Failed to parse translation response: ${raw}`);
  }
  return parsed;
}

/** Attempt to extract a JSON array from a string that may contain extra text. */
function extractJsonArray(raw: string): string[] | null {
  // Try direct parse first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to regex extraction
  }
  // Try to find a JSON array in the text
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // failed
    }
  }
  return null;
}
