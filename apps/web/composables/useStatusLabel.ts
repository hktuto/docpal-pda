export function useStatusLabel() {
  const { t } = useI18n();

  return {
    receiving: (code: string) => t(`status.receiving.${code}`),
    picking: (code: string) => t(`status.picking.${code}`),
    box: (code: string) => t(`status.box.${code}`),
    measuring: (code: string) => t(`status.measuring.${code}`),
  };
}
