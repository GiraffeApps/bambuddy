"""Smart queue planner: starts inside office hours, longest job left overnight."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.smart_queue import (
    DEFAULT_JOB_SECONDS,
    OfficeSchedule,
    PlanJob,
    PlanPrinter,
    plan_queue,
)

H = 3600
# Monday 2026-11-16, 08:00 UTC.
MONDAY_8AM = datetime(2026, 11, 16, 8, 0, tzinfo=timezone.utc)


def _schedule(days=(0, 1, 2, 3, 4), start="09:00", end="17:00", tz="UTC") -> OfficeSchedule:
    schedule = OfficeSchedule.parse(json.dumps({"days": list(days), "start": start, "end": end, "timezone": tz}))
    assert schedule is not None
    return schedule


def _at(day_offset: int, hour: int, minute: int = 0) -> datetime:
    return MONDAY_8AM.replace(hour=hour, minute=minute) + timedelta(days=day_offset)


class TestOfficeSchedule:
    def test_empty_means_not_configured(self):
        assert OfficeSchedule.parse("") is None
        assert OfficeSchedule.parse(None) is None

    @pytest.mark.parametrize(
        "value",
        [
            {"days": [], "start": "09:00", "end": "17:00"},
            {"days": [7], "start": "09:00", "end": "17:00"},
            {"days": [0], "start": "9am", "end": "17:00"},
            {"days": [0], "start": "17:00", "end": "09:00"},
            {"days": [0], "start": "09:00", "end": "17:00", "timezone": "Mars/Olympus"},
            [0, 1],
        ],
    )
    def test_malformed_values_are_refused(self, value):
        with pytest.raises(ValueError):
            OfficeSchedule.parse(json.dumps(value))

    def test_inside_hours_the_window_starts_now(self):
        now = _at(0, 10, 30)
        assert _schedule().window_at_or_after(now) == (now, _at(0, 17))

    def test_before_opening_the_window_starts_at_opening(self):
        assert _schedule().window_at_or_after(_at(0, 6)) == (_at(0, 9), _at(0, 17))

    def test_after_friday_close_the_next_window_is_monday(self):
        friday_evening = _at(4, 18)
        assert _schedule().window_at_or_after(friday_evening) == (_at(7, 9), _at(7, 17))

    def test_hours_are_read_in_the_schedules_timezone(self):
        # 09:00 in Toronto (EST, UTC-5) is 14:00 UTC.
        schedule = _schedule(tz="America/Toronto")
        assert schedule.window_at_or_after(_at(0, 8)) == (_at(0, 14), _at(0, 22))


class TestPlanQueue:
    def test_every_start_is_inside_office_hours(self):
        schedule = _schedule()
        jobs = [PlanJob(id=i, duration_seconds=d * H, printer_id=1) for i, d in enumerate([2, 30, 1, 5, 12, 3], 1)]
        plan = plan_queue(jobs, [PlanPrinter(id=1)], schedule, MONDAY_8AM)

        assert len(plan.placements) == len(jobs)
        assert plan.unplaced == []
        for placement in plan.placements:
            assert schedule.is_open(placement.start), placement

    def test_short_jobs_fill_the_day_and_the_longest_goes_last(self):
        jobs = [
            PlanJob(id=1, duration_seconds=14 * H, printer_id=1),
            PlanJob(id=2, duration_seconds=2 * H, printer_id=1),
            PlanJob(id=3, duration_seconds=1 * H, printer_id=1),
            PlanJob(id=4, duration_seconds=10 * H, printer_id=1),
        ]
        plan = plan_queue(jobs, [PlanPrinter(id=1)], _schedule(), MONDAY_8AM)
        order = [(p.job_id, p.start, p.overnight) for p in plan.placements]

        # 09-10 and 10-12 are the short jobs; at 12:00 nothing else finishes by
        # 17:00, so the longest (14 h) starts and runs overnight to 02:00.
        # Tuesday 09:00 then takes the 10 h job.
        assert order == [
            (3, _at(0, 9), False),
            (2, _at(0, 10), False),
            (1, _at(0, 12), True),
            (4, _at(1, 9), True),
        ]

    def test_a_print_finishing_overnight_waits_for_the_morning(self):
        jobs = [PlanJob(id=1, duration_seconds=1 * H, printer_id=1)]
        busy_until_3am = PlanPrinter(id=1, free_at=_at(1, 3))
        plan = plan_queue(jobs, [busy_until_3am], _schedule(), MONDAY_8AM)
        assert plan.placements[0].start == _at(1, 9)

    def test_a_printer_free_now_during_office_hours_starts_now(self):
        now = _at(0, 11, 15)
        plan = plan_queue([PlanJob(id=1, duration_seconds=H, printer_id=1)], [PlanPrinter(id=1)], _schedule(), now)
        assert plan.placements[0].start == now

    def test_model_jobs_spread_over_printers_of_that_model(self):
        printers = [
            PlanPrinter(id=1, model="X1C"),
            PlanPrinter(id=2, model="X1C"),
            PlanPrinter(id=3, model="P1S"),
        ]
        jobs = [PlanJob(id=i, duration_seconds=2 * H, target_model="x1c") for i in (1, 2)]
        plan = plan_queue(jobs, printers, _schedule(), MONDAY_8AM)

        assert {p.printer_id for p in plan.placements} == {1, 2}
        assert all(p.start == _at(0, 9) for p in plan.placements)

    def test_model_jobs_respect_the_location(self):
        printers = [PlanPrinter(id=1, model="X1C", location="Lab"), PlanPrinter(id=2, model="X1C", location="Shop")]
        jobs = [PlanJob(id=1, duration_seconds=H, target_model="X1C", target_location="Shop")]
        plan = plan_queue(jobs, printers, _schedule(), MONDAY_8AM)
        assert plan.placements[0].printer_id == 2

    def test_jobs_no_printer_can_take_are_reported(self):
        jobs = [
            PlanJob(id=1, duration_seconds=H, target_model="H2D"),
            PlanJob(id=2, duration_seconds=H, printer_id=99),
            PlanJob(id=3, duration_seconds=H),
        ]
        plan = plan_queue(jobs, [PlanPrinter(id=1, model="X1C")], _schedule(), MONDAY_8AM)
        assert plan.placements == []
        assert sorted(plan.unplaced) == [1, 2, 3]

    def test_unknown_duration_is_planned_as_an_hour(self):
        plan = plan_queue(
            [PlanJob(id=1, duration_seconds=None, printer_id=1)], [PlanPrinter(id=1)], _schedule(), MONDAY_8AM
        )
        placement = plan.placements[0]
        assert placement.end - placement.start == timedelta(seconds=DEFAULT_JOB_SECONDS)

    def test_more_starts_than_first_in_first_out(self):
        """The planner beats running the queue in its given order."""
        durations = [16, 1, 1, 1, 1, 9, 2]
        jobs = [PlanJob(id=i, duration_seconds=d * H, printer_id=1) for i, d in enumerate(durations, 1)]
        plan = plan_queue(jobs, [PlanPrinter(id=1)], _schedule(), MONDAY_8AM)
        monday_starts = [p for p in plan.placements if p.start.date() == _at(0, 9).date()]
        # FIFO would start the 16 h job at 09:00 and nothing else on Monday.
        assert len(monday_starts) == 6
        assert monday_starts[-1].job_id == 1  # the 16 h job, overnight


class TestPlanQueueGuarantees:
    """Sadi's two rules, checked over many random queues and fleets."""

    @pytest.mark.parametrize("seed", range(40))
    def test_starts_in_office_hours_and_shortest_first_each_day(self, seed):
        import random

        rng = random.Random(seed)
        schedule = _schedule(tz="America/Toronto")
        printers = [
            PlanPrinter(id=p, model="X1C", free_at=MONDAY_8AM + timedelta(hours=rng.choice([0, 3, 11, 20])))
            for p in (1, 2, 3)
        ]
        jobs = [
            PlanJob(
                id=i,
                duration_seconds=int(rng.choice([0.25, 0.5, 1, 2, 3, 5, 7, 9, 12, 16, 22, 30]) * H),
                printer_id=rng.choice([None, 1, 2, 3]),
                target_model="X1C",
            )
            for i in range(1, rng.randint(5, 25))
        ]
        plan = plan_queue(jobs, printers, schedule, MONDAY_8AM + timedelta(minutes=rng.randint(0, 600)))

        assert plan.unplaced == []
        by_printer_day: dict[tuple, list] = {}
        for p in plan.placements:
            assert schedule.is_open(p.start), f"start outside office hours: {p}"
            day = p.start.astimezone(schedule.tz).date()
            by_printer_day.setdefault((p.printer_id, day), []).append(p)

        for starts in by_printer_day.values():
            starts.sort(key=lambda p: p.start)
            lengths = [(p.end - p.start).total_seconds() for p in starts]
            # Shortest first: each start of the day is no longer than the next.
            assert lengths == sorted(lengths), lengths
            # Only the day's last start may run past close (overnight).
            assert not any(p.overnight for p in starts[:-1])
