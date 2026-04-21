export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export async function toResult<T, E = Error>(
  fn: Promise<T> | (() => Promise<T>),
): Promise<Result<T, E>> {
  try {
    const value = await (typeof fn === 'function' ? fn() : fn)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error as E }
  }
}
