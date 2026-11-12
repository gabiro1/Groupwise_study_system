/** Normalize a university registration number without assuming a programme prefix. */
export function normalizeRegistrationNumber(value) {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return normalized || null;
}

/** Normalize an optional institutional staff identifier. */
export function normalizeStaffIdentifier(value) {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return normalized || null;
}

/** Normalize the shared login identifier while preserving email semantics. */
export function normalizeLoginIdentifier(value) {
  const normalized = String(value ?? "").trim();
  return normalized.includes("@")
    ? normalized.toLowerCase()
    : normalizeRegistrationNumber(normalized);
}
