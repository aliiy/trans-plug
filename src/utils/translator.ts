/**
 * DeepSeek API translation client.
 * Sends batch text arrays, receives JSON array of translations.
 *
 * Reliability features:
 * - Exponential backoff retry: 3 attempts (1s → 2s → 4s) on 429/5xx errors
 * - Circuit breaker: after 5 consecutive failures, pauses 30s before retrying
 * - 4xx client errors are NOT retried (retry won't help)
 */

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

const SYSTEM_PROMPT = `You are a professional translator. The input is a JSON array of strings.
For each string, auto-detect its source language (English, Japanese, Russian, Korean, or any other) and translate it into natural, fluent Simplified Chinese.
Rules:
- Keep numbers, URLs, email addresses, file paths, code, and @mentions unchanged.
- If a string is already entirely Simplified Chinese, return it unchanged.
- Translate the full meaning; never add explanations, notes, or romanization.
- Output ONLY a valid JSON array of strings, with the same length and order as the input. No markdown, no extra text.`;

// --- Retry & Circuit Breaker State ---

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000; // 1s base, doubles each retry
const CIRCUIT_BREAKER_THRESHOLD = 5; // consecutive failures before opening
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000; // 30s cooldown

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/**
 * Translate a batch of text strings via DeepSeek API.
 * Returns translations in the same order as the input array.
 * Falls back to returning originals on persistent failure.
 */
export async function translateBatch(
  texts: string[],
  apiKey: string
): Promise<string[]> {
  // Circuit breaker check
  if (circuitOpenUntil > 0) {
    if (Date.now() < circuitOpenUntil) {
      console.warn(`[translator] Circuit breaker open — returning originals (cooldown ${Math.ceil((circuitOpenUntil - Date.now()) / 1000)}s remaining)`);
      return texts;
    }
    // Cooldown expired — reset and try again
    circuitOpenUntil = 0;
  }

  const userMessage = JSON.stringify(texts);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await doRequest(userMessage, apiKey);
      // Success — reset failure counter
      consecutiveFailures = 0;
      circuitOpenUntil = 0;
      return result;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const isRetryable = status === 429 || status >= 500;

      if (attempt < MAX_RETRIES && isRetryable) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[translator] Retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms (HTTP ${status})`);
        await sleep(delay);
        continue;
      }

      // Non-retryable error or out of retries
      consecutiveFailures++;
      console.error(`[translator] API failed after ${attempt + 1} attempt(s):`, err);

      // Check circuit breaker
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
        console.error(`[translator] Circuit breaker OPEN for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s (${consecutiveFailures} consecutive failures)`);
      }

      // Return originals as fallback
      return texts;
    }
  }

  return texts;
}

/** Perform a single DeepSeek API request (no retry logic). */
async function doRequest(
  userMessage: string,
  apiKey: string
): Promise<string[]> {
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
    const err = new Error(
      `DeepSeek API error ${response.status}: ${response.statusText} — ${errorBody}`
    ) as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const data: {
    choices: Array<{ message: { content: string } }>;
  } = await response.json();

  const raw = data.choices?.[0]?.message?.content ?? '';
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

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
