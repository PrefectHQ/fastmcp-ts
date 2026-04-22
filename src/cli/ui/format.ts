let jsonMode = false

export function setJsonMode(value: boolean): void {
  jsonMode = value
}

export function isJsonMode(): boolean {
  return jsonMode
}

export function output<T>(data: T, renderFn: (data: T) => void): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else {
    renderFn(data)
  }
}
