"""Documented, leakage-aware graded relevance labels."""

from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class LabelPolicy:
    """Label precedence from explicit negative to long-term success."""

    positive_feedback_min_rating: int = 4
    long_term_sessions: int = 1

    def label(self, row: dict, as_of: datetime | None = None) -> int | None:
        def present(name: str) -> bool:
            value = row.get(name)
            if not value:
                return False
            if as_of is None:
                return True
            try:
                event = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            except ValueError:
                return False
            if event.tzinfo is None:
                event = event.replace(tzinfo=timezone.utc)
            return event <= as_of

        helpful = row.get("helpful")
        if present("rejected_at") or helpful is False:
            return 0
        retention_observed = row.get("retained") is True
        if (
            present("joined_at")
            and retention_observed
            and int(row.get("sessions_attended") or 0) >= self.long_term_sessions
            and int(row.get("overall_rating") or 0) >= self.positive_feedback_min_rating
        ):
            return 6
        if present("joined_at") and retention_observed:
            return 5
        if helpful is True or int(row.get("overall_rating") or 0) >= self.positive_feedback_min_rating:
            return 4
        if present("accepted_at"):
            return 3
        if present("clicked_at"):
            return 2
        if present("shown_at"):
            return 1
        return None


def label_stage(label: int | None) -> str | None:
    if label is None:
        return None
    if label >= 6:
        return "long_term"
    if label >= 5:
        return "medium_term"
    if label >= 2:
        return "immediate"
    return "observed"
