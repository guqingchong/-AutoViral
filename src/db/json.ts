export function toJson<T>(value: T): string {
  return JSON.stringify(value ?? []);
}

export function fromJson<T>(value: string | null | undefined): T | null {
  if (value == null) return null;
  if (value === "") return null;
  return JSON.parse(value) as T;
}
