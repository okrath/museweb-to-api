import type { Effort, MuseMode } from "../core/types.js";

export interface ModelEntry {
  id: string;
  mode: MuseMode;
  label: string;
}

/** Model ids accepted on the wire and the Muse composer mode each one selects. */
export const MODELS: ModelEntry[] = [
  { id: "muse", mode: "default", label: "Muse (mode currently selected in the web UI)" },
  { id: "muse-spark", mode: "instant", label: "Muse Spark — Instant" },
  { id: "muse-spark-thinking", mode: "thinking", label: "Muse Spark — Thinking" },
  { id: "muse-spark-contemplating", mode: "contemplating", label: "Muse Spark — Contemplating" },
];

export function findModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * A client effort refines the `muse` default model only; an explicit mode model always wins,
 * so `muse-spark-thinking` with `reasoning_effort: low` still runs in Thinking mode.
 */
export function resolveMode(model: ModelEntry, effort: Effort | undefined): MuseMode {
  if (model.mode !== "default" || effort === undefined) return model.mode;
  if (effort === "none" || effort === "low") return "instant";
  if (effort === "high") return "thinking";
  if (effort === "xhigh") return "contemplating";
  return "default";
}

export function listOpenAiModels() {
  const created = 1_758_412_800;
  return {
    object: "list",
    data: MODELS.map((m) => ({ id: m.id, object: "model", created, owned_by: "museweb-to-api" })),
  };
}

export function listAnthropicModels() {
  return {
    data: MODELS.map((m) => ({
      type: "model",
      id: m.id,
      display_name: m.label,
      created_at: "2026-09-21T00:00:00Z",
    })),
    has_more: false,
    first_id: MODELS[0]!.id,
    last_id: MODELS[MODELS.length - 1]!.id,
  };
}
