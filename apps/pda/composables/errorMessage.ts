import { I18nError } from "~/composables/i18nError";

export function useErrorMessage() {
  const { t } = useI18n();

  return function errorMessage(e: unknown): string {
    if (e instanceof I18nError) {
      return t(`errors.${e.code}`, e.params ?? {});
    }
    if (e instanceof Error) {
      return e.message;
    }
    return String(e);
  };
}
