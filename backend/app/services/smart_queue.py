"""Smart queue: lay queued jobs out on the printers around an office schedule.

Someone has to be in the building to start a print (or at least to clear the
plate the previous one left behind), so a job can only *start* inside office
hours. What happens after that is the printer's business, which makes the
evening slot special: a print started just before close runs through the night
for free, while the same print started at 09:00 would tie the printer up for
the whole working day.

The planner therefore, per printer and per office day:

* fills the day with the shortest jobs that still finish before close, which
  gives the most starts while people are around to make them, and
* when nothing else fits before close, starts the longest job left so that it
  runs overnight.

It is a greedy pass over printers in the order they become free, which is cheap
and predictable; the result is written to the queue as ``scheduled_time`` (the
scheduler's "not before") plus the printer each job goes to, so the existing
dispatcher carries it out and the timeline draws it.

All datetimes here are timezone-aware UTC; the schedule's own timezone is only
used to work out where its days begin and end.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# A job of unknown length is planned as an hour, the same guess the timeline
# makes when it draws one.
DEFAULT_JOB_SECONDS = 3600
# How far ahead the planner will look for a slot before giving up on a job.
PLANNING_HORIZON = timedelta(days=60)

_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


@dataclass(frozen=True)
class OfficeSchedule:
    """Working days (0 = Monday) and the daily window in which prints may start."""

    days: frozenset[int]
    start: time
    end: time
    tz: tzinfo
    timezone_name: str = "UTC"

    @classmethod
    def parse(cls, raw: str | dict | None) -> OfficeSchedule | None:
        """Parse the ``office_schedule`` setting. Empty means "not configured".

        Raises ``ValueError`` with a readable message for a malformed value.
        """
        if raw is None or raw == "":
            return None
        data = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(data, dict):
            raise ValueError("office_schedule must be a JSON object")

        days = data.get("days")
        if not isinstance(days, list) or not days:
            raise ValueError("office_schedule.days must list at least one working day")
        if any(not isinstance(d, int) or isinstance(d, bool) or not 0 <= d <= 6 for d in days):
            raise ValueError("office_schedule.days must be weekday numbers 0 (Monday) to 6 (Sunday)")

        start = _parse_hhmm(data.get("start"), "start")
        end = _parse_hhmm(data.get("end"), "end")
        if end <= start:
            raise ValueError("office_schedule.end must be later than office_schedule.start")

        tz_name = data.get("timezone") or "UTC"
        if not isinstance(tz_name, str):
            raise ValueError("office_schedule.timezone must be an IANA timezone name")
        try:
            tz: tzinfo = ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError(f"Unknown timezone: {tz_name}") from None

        return cls(days=frozenset(days), start=start, end=end, tz=tz, timezone_name=tz_name)

    def window_at_or_after(self, moment: datetime) -> tuple[datetime, datetime] | None:
        """The earliest start moment at or after ``moment`` and the close of that day.

        Returns ``(start, close)`` in UTC, where ``start`` is ``moment`` itself
        when the office is open then, else the next opening. None when no
        working day exists in the next fortnight (cannot happen with a valid
        schedule, but keeps the loop bounded).
        """
        local = moment.astimezone(self.tz)
        for offset in range(15):
            day: date = local.date() + timedelta(days=offset)
            if day.weekday() not in self.days:
                continue
            opens = datetime.combine(day, self.start, tzinfo=self.tz).astimezone(timezone.utc)
            closes = datetime.combine(day, self.end, tzinfo=self.tz).astimezone(timezone.utc)
            if closes <= moment:
                continue
            return max(opens, moment), closes
        return None

    def is_open(self, moment: datetime) -> bool:
        window = self.window_at_or_after(moment)
        return window is not None and window[0] == moment


def _parse_hhmm(value: object, name: str) -> time:
    if not isinstance(value, str) or not _HHMM.match(value):
        raise ValueError(f"office_schedule.{name} must be a time like 09:00")
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


@dataclass
class PlanPrinter:
    id: int
    model: str | None = None
    location: str | None = None
    # When the printer can take its next job (end of what it is printing now).
    free_at: datetime | None = None


@dataclass
class PlanJob:
    id: int
    duration_seconds: int | None
    printer_id: int | None = None
    target_model: str | None = None
    target_location: str | None = None

    @property
    def seconds(self) -> int:
        return self.duration_seconds if self.duration_seconds and self.duration_seconds > 0 else DEFAULT_JOB_SECONDS

    def can_run_on(self, printer: PlanPrinter) -> bool:
        if self.printer_id is not None:
            return self.printer_id == printer.id
        if self.target_model:
            if (printer.model or "").lower() != self.target_model.lower():
                return False
            return not self.target_location or self.target_location == printer.location
        return False


@dataclass
class Placement:
    job_id: int
    printer_id: int
    start: datetime
    end: datetime
    # True for the job that starts last in its office day and runs past close.
    overnight: bool = False


@dataclass
class Plan:
    placements: list[Placement] = field(default_factory=list)
    # Jobs no printer could take within the horizon (wrong model, no printers).
    unplaced: list[int] = field(default_factory=list)


def plan_queue(
    jobs: list[PlanJob],
    printers: list[PlanPrinter],
    schedule: OfficeSchedule,
    now: datetime,
) -> Plan:
    """Place ``jobs`` on ``printers`` so that every job starts inside office hours."""
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    horizon = now + PLANNING_HORIZON
    free_at = {p.id: max(_aware(p.free_at) or now, now) for p in printers}
    pending = list(jobs)
    plan = Plan()

    while pending:
        best: tuple[datetime, int, PlanPrinter, datetime, list[PlanJob]] | None = None
        for printer in printers:
            eligible = [job for job in pending if job.can_run_on(printer)]
            if not eligible:
                continue
            window = schedule.window_at_or_after(free_at[printer.id])
            if window is None or window[0] > horizon:
                continue
            start, closes = window
            key = (start, printer.id)
            if best is None or key < (best[0], best[1]):
                best = (start, printer.id, printer, closes, eligible)
        if best is None:
            break

        start, _, printer, closes, eligible = best
        office_left = (closes - start).total_seconds()
        fitting = [job for job in eligible if job.seconds <= office_left]
        if fitting:
            job = min(fitting, key=lambda j: (j.seconds, j.id))
            overnight = False
        else:
            # Nothing else finishes before close: this is the day's last start
            # on this printer, so give it the longest print to run overnight.
            job = max(eligible, key=lambda j: (j.seconds, -j.id))
            overnight = True

        end = start + timedelta(seconds=job.seconds)
        plan.placements.append(Placement(job.id, printer.id, start, end, overnight))
        free_at[printer.id] = end
        pending.remove(job)

    plan.unplaced = [job.id for job in pending]
    plan.placements.sort(key=lambda p: (p.start, p.printer_id))
    return plan


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
