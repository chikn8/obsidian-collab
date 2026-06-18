import { requestUrl } from "obsidian";

export async function getJson<T = any>(url: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const res = await requestUrl({ url, method: "GET", throw: false });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.json as T };
}

export async function postJson<T = any>(
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ ok: boolean; status: number; body: T | null }> {
  const res = await requestUrl({
    url,
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...(headers || {}) },
    throw: false,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.json as T };
}
