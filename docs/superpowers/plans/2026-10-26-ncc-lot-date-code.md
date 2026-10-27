# NCC lot/date-code implementation plan

1. Correct the NCC regex and set `dateCodeEncoding: "ncc_lot_ymmdd"` in the built-in supplier profile, SQL restore script, and template-consistency harness.
2. Add migration `0040_ncc_lot_date_code.sql` to update only the previous built-in NCC row and register it in the Drizzle journal.
3. Add mirrored backend/PDA NCC lot formatting and `YMMDD` → ISO week decoding, including configured `wwyy`/`yyww` output.
4. Add the encoding and preview behavior to the admin supplier-profile editor with en-US, zh-HK, and zh-CN labels.
5. Update schema/type comments and receiving behavior documentation.
6. Skip automated and manual scan tests as requested; run static checks and review the final diff.
7. Follow-up (2026-10-27): prevent 28/32-digit boundary backtracking, render 13-digit lots in 5–7–2 groups, add migration `0041_ncc_fixed_width.sql`, and cover `5928846030912801026002000460` in backend/PDA regression tests.
