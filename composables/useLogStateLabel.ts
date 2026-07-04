export function useLogStateLabel() {
  const { t } = useI18n();
  return (code: string | null | undefined) =>
    code ? t(`logStates.${code}`) : t("common.stateNone");
}
