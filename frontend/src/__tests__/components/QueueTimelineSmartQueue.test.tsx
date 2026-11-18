/**
 * Smart queue on the timeline: printing jobs are locked, queued jobs can be
 * dragged to a new start time or another printer, and jobs the smart queue
 * scheduled for later are drawn at their time rather than in queue order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueueTimelineView } from '../../components/QueueTimelineView';
import type { PrintQueueItem, Printer } from '../../api/client';

const HOUR = 3600;
const HOUR_MS = HOUR * 1000;
// The track is mocked 2400 px wide for the 24 h window: 100 px per hour.
const TRACK_PX = 2400;

const printers = [
  { id: 1, name: 'Workshop X1C', model: 'X1C' },
  { id: 2, name: 'Lab P1S', model: 'P1S' },
] as unknown as Printer[];

const running = {
  id: 100,
  printer_id: 1,
  status: 'printing',
  position: 0,
  archive_name: 'Running now',
  print_time_seconds: HOUR,
  started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
} as unknown as PrintQueueItem;

const pending = (id: number, name: string, position: number, over: Partial<PrintQueueItem> = {}) =>
  ({
    id,
    printer_id: 1,
    status: 'pending',
    position,
    archive_name: name,
    print_time_seconds: HOUR,
    scheduled_time: null,
    manual_start: false,
    waiting_reason: null,
    ...over,
  }) as unknown as PrintQueueItem;

// jsdom has no PointerEvent, so fireEvent.pointer* would drop clientX/pointerId.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const statuses = { 1: { progress: 50, remaining_time: 30, state: 'RUNNING' } };
const t = (key: string) => key;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: TRACK_PX,
    height: 56,
    top: 0,
    left: 0,
    right: TRACK_PX,
    bottom: 56,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => vi.restoreAllMocks());

function barsLeftToRight(): string[] {
  return screen
    .getAllByRole('button')
    .filter((el) => el.style.left.endsWith('%'))
    .sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left))
    .map((el) => (el.getAttribute('title') ?? '').split(' · ')[0]);
}

describe('QueueTimelineView smart queue', () => {
  it('locks printing jobs and marks them in a different colour', () => {
    const onReschedule = vi.fn();
    render(
      <QueueTimelineView
        queueItems={[running, pending(1, 'Queued job', 1)]}
        printers={printers}
        printerStatuses={statuses}
        sjfEnabled={false}
        onItemClick={() => {}}
        onReschedule={onReschedule}
        t={t}
      />,
    );
    const locked = screen.getByTestId('timeline-bar-100');
    const queued = screen.getByTestId('timeline-bar-1');
    expect(locked).toHaveAttribute('data-locked', 'true');
    expect(locked.className).toContain('amber');
    expect(queued).not.toHaveAttribute('data-locked');
    expect(queued.className).not.toContain('amber');
    expect(locked.getAttribute('title')).toContain('queue.smartQueue.locked');

    // Dragging the printing job does nothing.
    fireEvent.pointerDown(locked, { pointerId: 1, button: 0, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(locked, { pointerId: 1, clientX: 400, clientY: 10 });
    fireEvent.pointerUp(locked, { pointerId: 1, clientX: 400, clientY: 10 });
    expect(onReschedule).not.toHaveBeenCalled();
  });

  it('reschedules a queued job dragged later, snapped to the quarter hour', () => {
    const onReschedule = vi.fn();
    const onItemClick = vi.fn();
    render(
      <QueueTimelineView
        queueItems={[running, pending(1, 'Queued job', 1)]}
        printers={printers}
        printerStatuses={statuses}
        sjfEnabled={false}
        onItemClick={onItemClick}
        onReschedule={onReschedule}
        t={t}
      />,
    );
    const bar = screen.getByTestId('timeline-bar-1');
    const before = Date.now();
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 400, clientY: 10 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 400, clientY: 10 });
    // The click that ends a drag must not open the edit dialog.
    fireEvent.click(bar);

    expect(onItemClick).not.toHaveBeenCalled();
    expect(onReschedule).toHaveBeenCalledTimes(1);
    const [item, change] = onReschedule.mock.calls[0];
    expect(item.id).toBe(1);
    expect(change.printerId).toBeNull();
    const startMs = (change.scheduledTime as Date).getTime();
    expect(startMs % (15 * 60 * 1000)).toBe(0);
    // It was chained to start ~30 min from now; 300 px later is ~3 h on top.
    expect(startMs).toBeGreaterThan(before + 3 * HOUR_MS);
    expect(startMs).toBeLessThan(before + 4 * HOUR_MS);
  });

  it('a plain click still opens the job', () => {
    const onReschedule = vi.fn();
    const onItemClick = vi.fn();
    render(
      <QueueTimelineView
        queueItems={[running, pending(1, 'Queued job', 1)]}
        printers={printers}
        printerStatuses={statuses}
        sjfEnabled={false}
        onItemClick={onItemClick}
        onReschedule={onReschedule}
        t={t}
      />,
    );
    const bar = screen.getByTestId('timeline-bar-1');
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 100, clientY: 10 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 101, clientY: 10 });
    fireEvent.click(bar);
    expect(onReschedule).not.toHaveBeenCalled();
    expect(onItemClick).toHaveBeenCalledTimes(1);
  });

  it('draws jobs the smart queue scheduled for later at their time, not in queue order', () => {
    const inFive = new Date(Date.now() + 5 * HOUR_MS).toISOString();
    const inTwo = new Date(Date.now() + 2 * HOUR_MS).toISOString();
    render(
      <QueueTimelineView
        queueItems={[
          pending(1, 'Overnight job', 1, { scheduled_time: inFive, print_time_seconds: 12 * HOUR }),
          pending(2, 'Short job', 2, { scheduled_time: inTwo }),
        ]}
        printers={printers}
        printerStatuses={{}}
        sjfEnabled={false}
        onItemClick={() => {}}
        t={t}
      />,
    );
    expect(barsLeftToRight()).toEqual(['Short job', 'Overnight job']);
  });

  it('offers Smart queue and the office hours editor', () => {
    const onSmartQueue = vi.fn();
    const onEditOfficeSchedule = vi.fn();
    render(
      <QueueTimelineView
        queueItems={[running]}
        printers={printers}
        printerStatuses={statuses}
        sjfEnabled={false}
        onItemClick={() => {}}
        onSmartQueue={onSmartQueue}
        onEditOfficeSchedule={onEditOfficeSchedule}
        officeSchedule={{ days: [0, 1, 2, 3, 4], start: '09:00', end: '17:00', timezone: 'UTC' }}
        t={t}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /queue.smartQueue.button/ }));
    fireEvent.click(screen.getByRole('button', { name: /09:00.17:00/ }));
    expect(onSmartQueue).toHaveBeenCalledTimes(1);
    expect(onEditOfficeSchedule).toHaveBeenCalledTimes(1);
  });

  it('shows no smart queue controls when the caller cannot use them', () => {
    render(
      <QueueTimelineView
        queueItems={[running]}
        printers={printers}
        printerStatuses={statuses}
        sjfEnabled={false}
        onItemClick={() => {}}
        t={t}
      />,
    );
    expect(screen.queryByRole('button', { name: /queue.smartQueue.button/ })).toBeNull();
  });
});

describe('QueueTimelineView placed jobs that are held', () => {
  it('keeps a placed job on the timeline, flagged with why it is held', () => {
    const inTwo = new Date(Date.now() + 2 * HOUR_MS).toISOString();
    render(
      <QueueTimelineView
        queueItems={[
          running,
          pending(1, 'Placed job', 1, { scheduled_time: inTwo, waiting_reason: 'Offline, no Auto On smart plug: X1C' }),
        ]}
        printers={printers}
        printerStatuses={statuses}
        sjfEnabled={false}
        onItemClick={() => {}}
        t={t}
      />,
    );
    const bar = screen.getByTestId('timeline-bar-1');
    expect(bar.className).toContain('border-dashed');
    expect(bar.getAttribute('title')).toContain('Offline, no Auto On smart plug');
  });
});

describe('QueueTimelineView cards', () => {
  it('keeps the progress bar on an in-progress card even before the printer reports progress', () => {
    render(
      <QueueTimelineView
        queueItems={[running]}
        printers={printers}
        printerStatuses={{}}
        sjfEnabled={false}
        onItemClick={() => {}}
        onReschedule={() => {}}
        t={t}
      />,
    );
    // Started 30 min into a one-hour print.
    const bar = screen.getByTestId('timeline-progress-100');
    expect(parseFloat(bar.style.width)).toBeGreaterThan(40);
    expect(parseFloat(bar.style.width)).toBeLessThan(60);
  });

  it('uses the printer-reported progress when there is one', () => {
    render(
      <QueueTimelineView
        queueItems={[running]}
        printers={printers}
        printerStatuses={{ 1: { progress: 72, remaining_time: 20, state: 'RUNNING' } }}
        sjfEnabled={false}
        onItemClick={() => {}}
        t={t}
      />,
    );
    expect(screen.getByTestId('timeline-progress-100').style.width).toBe('72%');
  });

  it('never widens a short card into the next one', () => {
    render(
      <QueueTimelineView
        queueItems={[
          running,
          pending(1, 'Tiny job', 1, { print_time_seconds: 60 }),
          pending(2, 'Next job', 2),
        ]}
        printers={printers}
        printerStatuses={statuses}
        sjfEnabled={false}
        onItemClick={() => {}}
        t={t}
      />,
    );
    const tiny = screen.getByTestId('timeline-bar-1');
    const next = screen.getByTestId('timeline-bar-2');
    const tinyLeft = parseFloat(tiny.style.left);
    const nextLeft = parseFloat(next.style.left);
    // The width is capped at the gap to the next card's left edge.
    const cap = tiny.style.width.match(/,\s*([\d.]+)%\)$/);
    expect(cap).not.toBeNull();
    expect(tinyLeft + parseFloat(cap![1])).toBeLessThanOrEqual(nextLeft + 1e-9);
  });

  it('a job dropped onto another card starts when that card ends', () => {
    const onReschedule = vi.fn();
    render(
      <QueueTimelineView
        queueItems={[running, pending(1, 'First', 1), pending(2, 'Second', 2)]}
        printers={printers}
        printerStatuses={statuses}
        sjfEnabled={false}
        onItemClick={() => {}}
        onReschedule={onReschedule}
        t={t}
      />,
    );
    // Second is chained 30 min + 1 h from now; drag it 50 px (30 min) left,
    // into the middle of First.
    const bar = screen.getByTestId('timeline-bar-2');
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 500, clientY: 10 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 450, clientY: 10 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 450, clientY: 10 });

    const firstEnd = Date.now() + 30 * 60 * 1000 + HOUR_MS;
    const start = (onReschedule.mock.calls[0][1].scheduledTime as Date).getTime();
    expect(Math.abs(start - firstEnd)).toBeLessThan(5000);
  });
});
