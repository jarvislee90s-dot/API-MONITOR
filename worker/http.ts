type JsonBody = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function jsonResponse(body: JsonBody, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function successResponse<T>(data: T, init: ResponseInit = {}): Response {
  return jsonResponse({ ok: true, data }, init);
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

export async function readJsonBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    throw new Error("empty body");
  }
  return JSON.parse(text) as T;
}

export function clampNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toIsoString(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

export function parseHeadersCookie(rawCookie: string | undefined): string | undefined {
  if (!rawCookie) return undefined;
  const trimmed = rawCookie.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
