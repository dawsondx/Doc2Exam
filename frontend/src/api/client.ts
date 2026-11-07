import type { ApiErrorBody } from "../types/api";

export class ApiError extends Error {
  code: string;
  action: string;
  status: number;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error?.message ?? `请求失败(HTTP ${status})`);
    this.status = status;
    this.code = body?.error?.code ?? "UNKNOWN";
    this.action = body?.error?.action ?? "请重试";
  }
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    throw new ApiError(response.status, data as ApiErrorBody | null);
  }
  return data as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path);
  return parse<T>(response);
}

export async function apiPost<T>(path: string, body?: unknown, idempotency = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (idempotency) {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return parse<T>(response);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parse<T>(response);
}

export async function apiDelete<T>(path: string, token: string): Promise<T> {
  const response = await fetch(path, {
    method: "DELETE",
    headers: { "X-Deletion-Token": token },
  });
  if (response.status === 204) {
    return undefined as T;
  }
  return parse<T>(response);
}

export async function apiUpload<T>(path: string, files: File[]): Promise<T> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }
  const response = await fetch(path, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: form,
  });
  return parse<T>(response);
}
