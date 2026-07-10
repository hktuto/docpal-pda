export class I18nError extends Error {
  constructor(
    public code: string,
    public params?: Record<string, unknown>
  ) {
    super(code);
  }
}
