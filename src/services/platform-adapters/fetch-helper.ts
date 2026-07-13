/**
 * Thin wrapper around fetch for platform API calls.
 * Handles JSON parsing, error normalization, and timeouts.
 */

export interface FetchHelperOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiGet<T = unknown>(
  url: string,
  opts: FetchHelperOptions = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "AutoViral/1.0",
        Accept: "application/json",
        ...opts.headers,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(`GET ${url} failed: ${res.status}`, res.status, body);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function apiPost<T = unknown>(
  url: string,
  body: unknown,
  opts: FetchHelperOptions = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "AutoViral/1.0",
        "Content-Type": "application/json",
        Accept: "application/json",
        ...opts.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(`POST ${url} failed: ${res.status}`, res.status, text);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
