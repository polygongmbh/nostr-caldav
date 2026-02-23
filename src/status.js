export const ISSUE_KIND = 1621;
export const COMMENT_KIND = 1622;

export const STATUS_KIND_TO_INTERNAL = {
  1630: "open",
  1631: "completed",
  1632: "cancelled",
  1633: "draft"
};

export const INTERNAL_TO_VTODO_STATUS = {
  open: "NEEDS-ACTION",
  completed: "COMPLETED",
  cancelled: "CANCELLED",
  draft: "IN-PROCESS"
};

export const VTODO_STATUS_TO_INTERNAL = {
  "NEEDS-ACTION": "open",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  "IN-PROCESS": "draft"
};

export const INTERNAL_TO_STATUS_KIND = {
  open: 1630,
  completed: 1631,
  cancelled: 1632,
  draft: 1633
};

export function normalizeVtodoStatus(status) {
  return String(status || "").trim().toUpperCase();
}

export function toInternalFromVtodo(status) {
  return VTODO_STATUS_TO_INTERNAL[normalizeVtodoStatus(status)] || null;
}

export function toVtodoFromInternal(status) {
  return INTERNAL_TO_VTODO_STATUS[status] || "NEEDS-ACTION";
}

export function statusKindToInternal(kind) {
  return STATUS_KIND_TO_INTERNAL[kind] || null;
}

export function internalStatusToKind(status) {
  return INTERNAL_TO_STATUS_KIND[status] || null;
}
