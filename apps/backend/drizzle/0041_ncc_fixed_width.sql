UPDATE "supplier_profiles"
SET
  "qr_template" = '^(?=.{28}$|.{32}$)(?<itemId>\d{6}(?=.{22}$)|\d{10}(?=.{22}$))(?:(?<=^.{10})\d{3})?(?<lotCode>\d{13}(?=.{9}$)|\d{7}(?=.{12}$))(?:\d{2}(?=.{10}$))?(?<qty>\d{5,6})(?<serialNo>\d{4})$',
  "last_update_date" = now()
WHERE "supplier_code" = '23'
  AND "qr_template" = '^(?=.{28}$|.{32}$)(?<itemId>\d{6,10})(?:\d{3})?(?<lotCode>\d{7,13})\d{3}(?<qty>\d{5,6})(?<serialNo>\d{4})$';
