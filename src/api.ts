let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const failure = (message: string) => Object.assign(new Error(message), { status: response.status });
  let result: any;
  try {
    result = await response.json();
  } catch {
    if (response.status === 401) throw failure("Сесію завершено. Увійдіть знову.");
    throw failure(response.ok
      ? "Сервер повернув порожню або неповну відповідь. Дані не оновлено."
      : `Сервер тимчасово недоступний (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw failure(typeof result?.error === "string" ? result.error : `HTTP ${response.status}`);
  }
  if (result === null || typeof result !== "object") throw failure("Сервер повернув некоректні дані.");
  return result;
}
