export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const signal = AbortSignal.timeout(90_000);
  const recovery = method === "GET"
    ? "Please try again in a minute."
    : "The request may still have completed. Check case history before retrying.";
  const timeoutMessage = "The server took too long to respond. " + recovery;
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      signal,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      signal.aborted ? timeoutMessage : "The server could not be reached. " + recovery,
    );
  }
  const data = await response.json().catch(() => {
    if (signal.aborted) throw new Error(timeoutMessage);
    return null;
  });
  if (!response.ok) {
    const fallback = response.status === 429
      ? "The case server is temporarily limiting connections. Wait a minute, then retry."
      : [502, 503, 504].includes(response.status)
        ? "The case server is starting or temporarily unavailable. Please wait a minute, then retry."
        : "The request could not be completed. Please try again.";
    throw new ApiError(
      data?.error?.message || fallback,
      response.status,
    );
  }
  if (data === null)
    throw new Error(
      "The server returned an unexpected response. Please try again.",
    );
  return data as T;
}
