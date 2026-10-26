UPDATE "supplier_profiles"
SET
  "qr_template" = '^(?=.{28}$|.{32}$)(?<itemId>\d{6,10})(?:\d{3})?(?<lotCode>\d{7,13})\d{3}(?<qty>\d{5,6})(?<serialNo>\d{4})$',
  "date_code_encoding" = 'ncc_lot_ymmdd',
  "last_update_date" = now()
WHERE "supplier_code" = '23'
  AND "qr_template" = '^(?=.{28}$|.{32}$)(?<itemId>\d{6,10})\d{3}(?<lotCode>\d{7})\d{3}(?<qty>\d{5,6})(?<serialNo>\d{4})$';
