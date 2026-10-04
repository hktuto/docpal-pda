// Minimal shared types for the Phase 1 shell. The full DTO catalog arrives
// with the WarehouseService adapter port in a later phase (until then the
// only typed payloads are the auth session and GET /config).

export interface User {
  id: string;
  username: string;
  displayName: string;
  /** Permission group codes from the JWT session (GET /auth/me). */
  groupCodes: string[];
  // Nullable: the HTTP API auth payload may omit createdDate.
  createdDate: Date | null;
}

export type FlowStep =
  | "receiving"
  | "put-away"
  | "picking"
  | "goods-verify"
  | "measuring"
  | "verify"
  | "stock-search";

export interface FlowConfig {
  flowSteps: Record<FlowStep, boolean>;
  /** Resolved steps.put-away section: autoCreateTasks switches the PDA
   *  put-away list from derived candidates to the task queue; suggestShelf
   *  is the backend's shelf-hint strategy ("existing-stock" | "off"). */
  putAway: { autoCreateTasks: boolean; suggestShelf: string };
  /** Resolved steps.picking.allocation section: allowDockStock=false means
   *  only put-away stock allocates — receiving and picking are decoupled. */
  pickingAllocation: { allowDockStock: boolean };
  /** Resolved pdaListTemplates section: per-list {title, meta} display
   *  templates for the six PDA list pages. Optional — backends predating the
   *  feature omit it and the defaults render. */
  listTemplates?: Partial<
    Record<"receiving" | "picking" | "put-away" | "goods-verify" | "verify" | "measuring", { title?: string; meta?: string }>
  >;
  /** Org partitions this warehouse accepts ([] = all). Informational — the
   *  backend filters list/detail queries server-side. */
  allowedOrgIds: number[];
  /** Picking shelf-scan mode ("off" | "require-match" | "require-any").
   *  Optional — backends predating the feature omit it (= "off"). */
  pickingShelfScan?: "off" | "require-match" | "require-any";
}
