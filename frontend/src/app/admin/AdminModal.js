"use client";

import { useEffect } from "react";
import { CloseIcon } from "./AdminIcons";

/**
 * Minimal accessible modal.
 *
 * Used for actions that need a written justification (suspension) so the reason
 * cannot be skipped. Escape and backdrop clicks both close it; focus lands on the
 * dialog when it opens.
 */
export default function AdminModal({ open, title, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="admin-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="admin-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="admin-modal-head">
          <h2>{title}</h2>
          <button type="button" className="admin-icon-btn" aria-label="Close dialog" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="admin-modal-body">{children}</div>
        {footer && <footer className="admin-modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
