export const SETTINGS_RUNTIME_MARKER_KEY = "lastChangelogVersion";

export function stripSettingsRuntimeMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next = { ...value };
  delete next[SETTINGS_RUNTIME_MARKER_KEY];
  return next;
}

export function stripSettingsRuntimeMarkerText(text) {
  try {
    return stableSettingsJson(stripSettingsRuntimeMarker(JSON.parse(String(text || "").replace(/^\uFEFF/, ""))));
  } catch {
    return String(text || "");
  }
}

export function stableSettingsJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
