"""POST /queue/smart-schedule writes the planner's printers and start times."""

from __future__ import annotations

import json

import pytest
from httpx import AsyncClient

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

URL = "/api/v1/queue/smart-schedule"
# Every day, all day, so the test does not depend on when it runs.
ALWAYS_OPEN = json.dumps({"days": [0, 1, 2, 3, 4, 5, 6], "start": "00:00", "end": "23:59", "timezone": "UTC"})


async def _job(db_session, position: int, hours: float, **extra) -> int:
    item = PrintQueueItem(status="pending", position=position, print_time_seconds=int(hours * 3600), **extra)
    db_session.add(item)
    await db_session.commit()
    return item.id


async def _row(db_session, item_id: int) -> PrintQueueItem:
    db_session.expire_all()
    return await db_session.get(PrintQueueItem, item_id)


async def test_without_an_office_schedule_it_asks_for_one(async_client: AsyncClient):
    response = await async_client.post(URL, json={})
    assert response.status_code == 400
    assert "office schedule" in response.json()["detail"].lower()


async def test_it_schedules_pending_jobs_and_renumbers_them_in_start_order(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    db_session.add(Settings(key="office_schedule", value=ALWAYS_OPEN))
    printer_id = (await printer_factory(name="A")).id
    archive_id = (await archive_factory(printer_id)).id
    long_job = await _job(db_session, 1, 5, printer_id=printer_id, archive_id=archive_id)
    short_job = await _job(db_session, 2, 0.5, printer_id=printer_id, archive_id=archive_id)
    staged = await _job(db_session, 3, 1, printer_id=printer_id, archive_id=archive_id, manual_start=True)

    response = await async_client.post(URL, json={})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["applied"] is True
    assert [p["item_id"] for p in body["placements"]] == [short_job, long_job]

    short_row = await _row(db_session, short_job)
    short_start, short_position = short_row.scheduled_time, short_row.position
    long_row = await _row(db_session, long_job)
    assert short_start is not None and long_row.scheduled_time is not None
    assert short_start < long_row.scheduled_time
    assert (short_position, long_row.position) == (1, 2)
    # Staged jobs wait for a person by design and are left alone.
    assert (await _row(db_session, staged)).scheduled_time is None


async def test_model_jobs_are_pinned_to_the_planned_printer(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    db_session.add(Settings(key="office_schedule", value=ALWAYS_OPEN))
    printer_id = (await printer_factory(name="A", model="X1C", location="Lab")).id
    archive_id = (await archive_factory(printer_id)).id
    job = await _job(db_session, 1, 1, target_model="X1C", target_location="Lab", archive_id=archive_id)

    response = await async_client.post(URL, json={})

    assert response.status_code == 200, response.text
    row = await _row(db_session, job)
    assert (row.printer_id, row.target_model, row.target_location) == (printer_id, None, None)


async def test_a_dry_run_writes_nothing(async_client: AsyncClient, db_session, printer_factory, archive_factory):
    db_session.add(Settings(key="office_schedule", value=ALWAYS_OPEN))
    printer = await printer_factory(name="A")
    archive_id = (await archive_factory(printer.id)).id
    job = await _job(db_session, 1, 1, printer_id=printer.id, archive_id=archive_id)

    response = await async_client.post(URL, json={"dry_run": True})

    assert response.status_code == 200, response.text
    assert response.json()["applied"] is False
    assert len(response.json()["placements"]) == 1
    assert (await _row(db_session, job)).scheduled_time is None


async def test_jobs_for_a_model_nobody_has_are_reported_unplaced(
    async_client: AsyncClient, db_session, printer_factory, archive_factory
):
    db_session.add(Settings(key="office_schedule", value=ALWAYS_OPEN))
    printer = await printer_factory(name="A", model="X1C")
    archive_id = (await archive_factory(printer.id)).id
    job = await _job(db_session, 1, 1, target_model="H2D", archive_id=archive_id)

    response = await async_client.post(URL, json={})

    assert response.status_code == 200, response.text
    assert response.json()["unplaced_item_ids"] == [job]


async def test_the_office_schedule_setting_is_validated(async_client: AsyncClient):
    bad = json.dumps({"days": [0], "start": "18:00", "end": "09:00"})
    assert (await async_client.put("/api/v1/settings/", json={"office_schedule": bad})).status_code == 422

    good = json.dumps({"days": [0, 1, 2, 3, 4], "start": "09:00", "end": "17:00", "timezone": "America/Toronto"})
    response = await async_client.put("/api/v1/settings/", json={"office_schedule": good})
    assert response.status_code == 200, response.text
    assert json.loads(response.json()["office_schedule"])["start"] == "09:00"
    flags = (await async_client.get("/api/v1/settings/ui-flags")).json()
    assert json.loads(flags["office_schedule"])["timezone"] == "America/Toronto"
