export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const UNAUTHORIZED_EVENT = 'bi:unauthorized'

async function parseError(res: Response): Promise<ApiError> {
  let msg = `请求失败（${res.status}）`
  try {
    const body = await res.json()
    if (typeof body.detail === 'string') msg = body.detail
    else if (Array.isArray(body.detail)) msg = body.detail.map((d: { msg: string }) => d.msg).join('；')
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, msg)
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    }
    throw await parseError(res)
  }
  return res
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await request(path, init)
  return res.json() as Promise<T>
}

/** PATCH / DELETE / PUT (and POST) with a JSON body; errors throw like `api()`. */
export async function apiSend<T>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const res = await request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json() as Promise<T>
}

export async function upload<T>(path: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await request(path, { method: 'POST', body: fd })
  return res.json() as Promise<T>
}

/** POST a JSON body and save the response as a file. */
export async function download(path: string, body: unknown, fallbackName: string) {
  const res = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const cd = res.headers.get('Content-Disposition') || ''
  const name = /filename="([^"]+)"/.exec(cd)?.[1] || fallbackName
  saveBlob(await res.blob(), name)
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * POST and read a Server-Sent Events response, calling `onEvent` with each `data:` JSON payload.
 * Errors before the stream starts throw like `api()`; aborting via `signal` ends it quietly.
 */
export async function postEventStream(
  path: string,
  body: unknown,
  onEvent: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) onEvent(JSON.parse(line.slice(5)))
      }
    }
  }
}
