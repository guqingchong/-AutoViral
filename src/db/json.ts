export function toJson<T>(value: T): string {
  return JSON.stringify(value ?? []);
}

export function fromJson<T>(value: string | null | undefined): T {
  if (!value) return [] as unknown as T;
  return JSON.parse(value) as T;
}
