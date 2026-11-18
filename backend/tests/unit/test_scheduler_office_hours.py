"""Jobs placed on the timeline only start inside office hours.

The smart queue plans every start inside the office schedule, but the plan
writes a "not before" time: a print that overruns would otherwise let the next
job start the moment the printer frees up, in the evening, with nobody there.
The scheduler therefore holds a placed job (one with a scheduled time) while the
office is closed. Jobs with no scheduled time are not the timeline's and go as
before.
"""

import json
import logging
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.tests.unit.test_scheduler_busy_reasons_3018 import (  # noqa: F401 - fixture
    SCHEDULER_LOGGER,
    _scheduler,
    one_printer,
)


async def _set_schedule(ctx, *, open_now: bool) -> None:
    today = datetime.now(timezone.utc).weekday()
    days = list(range(7)) if open_now else [(today + 3) % 7]
    value = json.dumps({"days": days, "start": "00:00", "end": "23:59", "timezone": "UTC"})
    async with ctx.session_maker() as db:
        db.add(Settings(key="office_schedule", value=value))
        await db.commit()


async def _status(ctx, item_id: int) -> str:
    async with ctx.session_maker() as db:
        return (await db.get(PrintQueueItem, item_id)).status


@pytest.mark.asyncio
async def test_a_placed_job_waits_while_the_office_is_closed(one_printer, caplog):  # noqa: F811
    await _set_schedule(one_printer, open_now=False)
    placed = await one_printer.add_item(scheduled_in=timedelta(minutes=-5), position=0)

    with caplog.at_level(logging.INFO, logger=SCHEDULER_LOGGER):
        async with _scheduler(one_printer, idle=True) as scheduler:
            await scheduler.check_queue()

    assert await _status(one_printer, placed) == "pending"
    assert any("outside_office_hours" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_a_placed_job_starts_while_the_office_is_open(one_printer):  # noqa: F811
    if datetime.now(timezone.utc).strftime("%H:%M") == "23:59":
        pytest.skip("the one minute the test schedule is closed")
    await _set_schedule(one_printer, open_now=True)
    placed = await one_printer.add_item(scheduled_in=timedelta(minutes=-5), position=0)

    async with _scheduler(one_printer, idle=True) as scheduler:
        await scheduler.check_queue()

    assert await _status(one_printer, placed) != "pending"


@pytest.mark.asyncio
async def test_an_unplaced_job_ignores_office_hours(one_printer):  # noqa: F811
    await _set_schedule(one_printer, open_now=False)
    asap = await one_printer.add_item(position=0)

    async with _scheduler(one_printer, idle=True) as scheduler:
        await scheduler.check_queue()

    assert await _status(one_printer, asap) != "pending"
