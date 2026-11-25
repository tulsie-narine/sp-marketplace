// Small request wrapper shared by the ControlMap client: serialized requests with a
// minimum gap, retry with backoff on 429 / 5xx, and JSON in and out.

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, path: string) {
    super(`HTTP ${status} from ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/** One request and its upstream result. The marketplace sends these through scalepad-proxy. */
export type Transport = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

export type HttpClient = {
  get: (path: string) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  post: (path: string, body?: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  patch: (path: string, body?: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export function createHttpClient({
  transport,
  minIntervalMs = 250,
  maxRetries = 4,
  sleep = defaultSleep,
}: {
  transport: Transport;
  /** Gap between requests, keeps us under rate limits. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}): HttpClient {
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequestAt = 0;

  async function send(method: string, path: string, body?: unknown) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      const res = await transport(method, path, body);
      if (res.status >= 200 && res.status < 300) return res.body;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) throw new HttpError(res.status, res.body, path);
      await sleep(500 * 2 ** attempt);
    }
  }

  // Serialize so concurrent callers share the rate limit.
  function request(method: string, path: string, body?: unknown) {
    const run = queue.then(() => send(method, path, body));
    queue = run.catch(() => {});
    return run;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
  };
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
