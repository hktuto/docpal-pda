export function useStatusLabel() {
  const { t } = useI18n();

  return {
    receiving: (code: string) => t(`status.receiving.${code}`),
    picking: (code: string) => t(`status.picking.${code}`),
    allocation: (code: string) => t(`status.allocation.${code}`),
    box: (code: string) => t(`status.box.${code}`),
    measuring: (code: string) => t(`status.measuring.${code}`),
    verify: (code: string) => t(`status.verify.${code}`),
    goodsVerify: (code: string) => t(`status.goodsVerify.${code}`),
  };
}
