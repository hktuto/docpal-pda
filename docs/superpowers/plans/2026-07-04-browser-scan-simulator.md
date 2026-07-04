> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-only prompt-based scan simulator in `useLabelScan.ts` so developers can paste a JSON string (OCR text + barcodes) and exercise the real parse/match/review pipeline without an Android device.

**Architecture:** A small utility `parseBrowserScanPromptJson` validates and converts prompt JSON into the existing `LabelScanCapture` shape. `useLabelScan.scan` extracts the native capture processing into a reusable `processCapture` helper and, in the browser fallback branch, calls `window.prompt()` and feeds the result through the same helper.

**Tech Stack:** Nuxt 3, Vue 3, TypeScript, Vitest.

---

## File structure

- `utils/parseBrowserScanPromptJson.ts` (create) — validates prompt JSON and returns `LabelScanCapture`.
- `tests/parseBrowserScanPromptJson.test.ts` (create) — unit tests for the utility.
- `composables/useLabelScan.ts` (modify) — extract `processCapture`, add prompt fallback.
- `docs/app-docs/flows/picking/label-scan.md` (modify) — document browser testing.
- `docs/app-docs/ai/code-map.md` (modify) — mention changed fallback.

---

### Task 1: Add prompt JSON parser utility

**Files:**
- Create: `utils/parseBrowserScanPromptJson.ts`
- Create: `tests/parseBrowserScanPromptJson.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseBrowserScanPromptJson } from '../utils/parseBrowserScanPromptJson';

describe('parseBrowserScanPromptJson', () => {
  it('returns a LabelScanCapture for valid input', () => {
    const result = parseBrowserScanPromptJson(JSON.stringify({
      text: 'PART: RK73B1JTTD181G\nQTY: 5000',
      barcodes: [{ value: 'RK73B1JTTD181G', format: 'CODE_128' }],
    }));

    expect(result).not.toBeNull();
    expect(result!.imagePath).toBe('');
    expect(result!.text).toBe('PART: RK73B1JTTD181G\nQTY: 5000');
    expect(result!.barcodes).toBe('[{"value":"RK73B1JTTD181G","format":"CODE_128"}]');
  });

  it('returns null for invalid JSON', () => {
    expect(parseBrowserScanPromptJson('not json')).toBeNull();
  });

  it('returns null when text is missing', () => {
    expect(parseBrowserScanPromptJson(JSON.stringify({
      barcodes: [{ value: 'X', format: 'CODE_128' }],
    }))).toBeNull();
  });

  it('returns null for a malformed barcode item', () => {
    expect(parseBrowserScanPromptJson(JSON.stringify({
      text: 'X',
      barcodes: [{ value: 'X' }],
    }))).toBeNull();
  });

  it('accepts an empty barcodes array', () => {
    const result = parseBrowserScanPromptJson(JSON.stringify({
      text: 'X',
      barcodes: [],
    }));
    expect(result).not.toBeNull();
    expect(result!.barcodes).toBe('[]');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/parseBrowserScanPromptJson.test.ts`

Expected: FAIL — `parseBrowserScanPromptJson` is not defined.

- [ ] **Step 3: Write minimal implementation**

Create `utils/parseBrowserScanPromptJson.ts`:

```ts
import type { LabelScanCapture } from '~/composables/useRectangleDetection';

export function parseBrowserScanPromptJson(raw: string): LabelScanCapture | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== 'string') return null;

  const barcodes = Array.isArray(obj.barcodes) ? obj.barcodes : [];
  const valid = barcodes.every(
    (b): b is { value: string; format: string } =>
      typeof b === 'object' &&
      b !== null &&
      typeof (b as Record<string, unknown>).value === 'string' &&
      typeof (b as Record<string, unknown>).format === 'string'
  );

  if (!valid) return null;

  return {
    imagePath: '',
    text: obj.text,
    barcodes: JSON.stringify(barcodes),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/parseBrowserScanPromptJson.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/parseBrowserScanPromptJson.ts tests/parseBrowserScanPromptJson.test.ts
git commit -m "feat: add browser scan prompt JSON parser"
```

---

### Task 2: Refactor useLabelScan.ts for browser prompt fallback

**Files:**
- Modify: `composables/useLabelScan.ts`

- [ ] **Step 1: Extract capture processor and add prompt fallback**

Modify `composables/useLabelScan.ts`:

Add import at the top:

```ts
import { parseBrowserScanPromptJson } from '~/utils/parseBrowserScanPromptJson';
```

Add `processCapture` helper after `createManualReview`:

```ts
async function processCapture(
  capture: LabelScanCapture,
  context: ScanTaskContext
): Promise<LabelScanResult> {
  const barcodes = parseBarcodes(capture.barcodes);
  const parsedResult = parseAndIdentify(
    { text: capture.text, barcodes },
    context.targets ?? []
  );
  const parsed = ocrResultToInput(parsedResult.parsed);

  const matchResult = await runScanMatcher(context, parsed);

  if (matchResult.type === 'error') {
    return { status: 'error', message: matchResult.message };
  }

  if (matchResult.type === 'single') {
    await matchResult.apply();
    return { status: 'applied' };
  }

  return {
    status: 'review',
    capture,
    parsed,
    options: parsedResult.options,
    matchResult,
  };
}
```

Update `scan` to use it and add the browser prompt fallback:

```ts
async function scan(context: ScanTaskContext): Promise<LabelScanResult> {
  scanning.value = true;

  try {
    const capture = await RectangleDetection.scanLabel();
    return await processCapture(capture, context);
  } catch (e: unknown) {
    if (isCancellationError(e)) {
      return { status: 'cancelled' };
    }
    if (isBrowserUnavailableError(e)) {
      const raw = window.prompt('Paste scan JSON (text + barcodes):');
      if (raw === null) {
        return { status: 'cancelled' };
      }
      const capture = parseBrowserScanPromptJson(raw);
      if (!capture) {
        return { status: 'error', message: 'Invalid scan JSON' };
      }
      return await processCapture(capture, context);
    }
    const message = e instanceof I18nError ? errorMessage(e) : (e instanceof Error ? e.message : String(e));
    return { status: 'error', message };
  } finally {
    scanning.value = false;
  }
}
```

- [ ] **Step 2: Run the tests**

Run: `pnpm test`

Expected: all tests pass, including the new ones.

- [ ] **Step 3: Run type check**

Run: `pnpm nuxt prepare`

Expected: completes without TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add composables/useLabelScan.ts
git commit -m "feat: use prompt JSON as browser scan fallback"
```

---

### Task 3: Update documentation

**Files:**
- Modify: `docs/app-docs/flows/picking/label-scan.md`
- Modify: `docs/app-docs/ai/code-map.md`

- [ ] **Step 1: Document browser testing in label-scan.md**

Add a short section:

```markdown
## Browser testing

When running the app in a browser, tapping Scan opens a `prompt()` instead of the camera. Paste a JSON string with `text` (OCR text) and `barcodes` (array of `{ value, format }`) to simulate a captured label:

```json
{
  "text": "PART: RK73B1JTTD181G\\nQTY: 5000",
  "barcodes": [{ "value": "RK73B1JTTD181G", "format": "CODE_128" }]
}
```

The app then runs the same parse, match, and review pipeline used on Android.
```

- [ ] **Step 2: Update code-map.md**

Add entries under the scan/review section:

```markdown
- `composables/useLabelScan.ts` — orchestrates native scan; in browsers falls back to `window.prompt()` + JSON.
- `utils/parseBrowserScanPromptJson.ts` — validates prompt JSON and converts it to `LabelScanCapture`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/app-docs/flows/picking/label-scan.md docs/app-docs/ai/code-map.md
git commit -m "docs: document browser scan simulator prompt"
```

---

### Task 4: Manual verification

- [ ] **Step 1: Start dev server**

Run: `pnpm dev`

- [ ] **Step 2: Exercise the browser fallback**

1. Log in as `operator` / `DocPal2026!`.
2. Navigate to a flow with a Scan button (e.g., Picking, Receiving).
3. Tap Scan.
4. Verify a browser prompt appears with the message `Paste scan JSON (text + barcodes):`.
5. Paste valid JSON and confirm.
6. Verify `LabelScanReviewModal` opens with parsed fields and candidate chips.
7. Cancel the prompt and verify the scan is cancelled.

- [ ] **Step 3: Record result**

If manual check passes, no code change is needed. If the prompt does not appear or parsing fails, debug and fix before finishing.

---

## Self-review

1. **Spec coverage**
   - Prompt JSON schema → Task 1.
   - Browser fallback in `useLabelScan.ts` → Task 2.
   - Reuse parse/match pipeline via `processCapture` → Task 2.
   - Docs → Task 3.
   - Manual browser check → Task 4.

2. **Placeholder scan**
   - No TBD/TODO/fill-in-details. Every step has exact file paths, code, commands, and expected outputs.

3. **Type consistency**
   - `LabelScanCapture` shape matches the existing interface from `useRectangleDetection.ts`.
   - `parseBrowserScanPromptJson` returns `LabelScanCapture | null`.
   - `processCapture` accepts `LabelScanCapture` and `ScanTaskContext`.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-browser-scan-simulator.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
