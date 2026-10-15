export interface FetchOpts {
  retries?: number; // additional attempts after the first (default 3)
  timeoutMs?: number; // default 15000
  baseDelayMs?: number; // exponential backoff base (default 1000)
  minIntervalMs?: number; // minimum gap between calls to the same host (client-side rate limit)
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 5 * 60_000;
const breakers = new Map<string, { fails: number; openUntil: number }>();
const lastCall = new Map<string, number>();

export function resetHttpState(): void {
  breakers.clear();
  lastCall.clear();
}

/** Never leak API keys into logs or UI. */
export function redact(text: string): string {
  return text.replace(/(api_key|apikey|registrationkey)=[^&\s"']+/gi, "$1=***");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const { retries = 3, timeoutMs = 15_000, baseDelayMs = 1000, minIntervalMs = 0, headers } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const host = new URL(url).host;

  const br = breakers.get(host);
  if (br && br.openUntil > Date.now()) {
    throw new Error(`Circuit breaker otvorený pre ${host} (opakované zlyhania) — skúsim neskôr`);
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastCall.get(host) ?? 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        breakers.set(host, { fails: 0, openUntil: 0 });
        return await res.text();
      }
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`HTTP ${res.status} ${host}`);
      if (!retryable) break;
    } catch (e) {
      lastErr = new Error(redact(e instanceof Error ? e.message : String(e)));
    }
    if (attempt < retries) await sleep(baseDelayMs * 2 ** attempt + Math.random() * (baseDelayMs / 2));
  }

  const cur = breakers.get(host) ?? { fails: 0, openUntil: 0 };
  cur.fails += 1;
  if (cur.fails >= BREAKER_THRESHOLD) cur.openUntil = Date.now() + BREAKER_OPEN_MS;
  breakers.set(host, cur);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
