import { Fragment, useState, useMemo, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Briefcase, ChevronLeft, ChevronRight, Clock, Layers, Loader2, Lock, Printer as PrinterIcon, Sparkles } from 'lucide-react';
import { formatDuration, parseUTCDate } from '../utils/date';
import { compareQueueOrder, queueLaneKey } from '../utils/queueOrder';
import { isBusyOnlyWaitingReason } from '../utils/waitingReason';
import type { PrintQueueItem, Printer } from '../api/client';
import { queueItemThumbnailUrl } from '../utils/queueItemThumbnail';
import { Button } from './Button';
import { officeWindowsBetween, type OfficeSchedule } from '../utils/officeSchedule';

/** Gantt-style 24h-rolling timeline. One horizontal swimlane per printer
 *  (plus one per active target_model and one for unassigned items). Each
 *  pending or printing job is rendered as a colored bar positioned by its
 *  predicted start time, width = predicted duration. A vertical NOW line
 *  marks current time. Hover a bar for details, click to edit/stop. */

const HOUR_MS = 60 * 60 * 1000;
const RANGE_HOURS = 24;
const RANGE_MS = RANGE_HOURS * HOUR_MS;
// Minimum bar width — short prints (a few minutes) would otherwise render as
// 1-2px slivers and be unclickable. 32px keeps them at thumb size.
const MIN_BAR_PX = 32;
// Lane height for the bar row + label.
const LANE_BAR_HEIGHT_PX = 40;
// Dragged bars snap to quarter hours.
const SNAP_MS = 15 * 60 * 1000;
// Pointer travel below this is a click, not a drag.
const DRAG_THRESHOLD_PX = 4;

/** Where a dragged job was dropped: a printer (null = keep its own) and a start. */
export interface TimelineReschedule {
  printerId: number | null;
  scheduledTime: Date;
}

interface DragState {
  itemId: number;
  pointerId: number;
  originX: number;
  originY: number;
  dx: number;
  dy: number;
  trackWidthPx: number;
  originalStartMs: number;
  laneKey: string;
  moved: boolean;
}

interface ScheduleEvent {
  item: PrintQueueItem;
  estimatedStart: Date;
  estimatedEnd: Date;
  progress?: number;
  type: 'printing' | 'queued';
  /** Placed for a time (smart queue or drag) but held right now by something
   *  that needs a person; drawn so the placement isn't lost, flagged. */
  blockedReason?: string;
}

interface QueueTimelineViewProps {
  queueItems: PrintQueueItem[];
  printers: Printer[];
  printerStatuses: Record<number, { progress?: number; remaining_time?: number; state?: string }>;
  /** `queue_shortest_first`. The bars chain in dispatch order, and dispatch
   *  order depends on it, so without it the timeline drew a queue the
   *  scheduler had no intention of running (#3043). */
  sjfEnabled: boolean;
  onItemClick: (item: PrintQueueItem) => void;
  /** Drop handler for dragged queued jobs. Omit to make bars read-only. */
  onReschedule?: (item: PrintQueueItem, change: TimelineReschedule) => void;
  /** Smart queue: place every queued job around the office schedule. */
  onSmartQueue?: () => void;
  smartQueueBusy?: boolean;
  /** Office hours, shaded on the lanes. Null = not configured. */
  officeSchedule?: OfficeSchedule | null;
  onEditOfficeSchedule?: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

interface LaneDescriptor {
  key: string;
  label: string;
  /** null for model-based / unassigned lanes. */
  printerId: number | null;
  /** Set for model-based lanes (`Any X1C`). */
  targetModel: string | null;
}

function formatHour(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric' });
}

function formatTooltipTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function QueueTimelineView({
  queueItems,
  printers,
  printerStatuses,
  sjfEnabled,
  onItemClick,
  onReschedule,
  onSmartQueue,
  smartQueueBusy = false,
  officeSchedule = null,
  onEditOfficeSchedule,
  t,
}: QueueTimelineViewProps) {
  // Moves made by dragging, shown straight away and dropped once the queue
  // the parent passes in changes (i.e. the server has the new values).
  const [localMoves, setLocalMoves] = useState<Record<number, Partial<PrintQueueItem>>>({});
  useEffect(() => setLocalMoves({}), [queueItems]);
  const items = useMemo(
    () => queueItems.map((item) => (localMoves[item.id] ? { ...item, ...localMoves[item.id] } : item)),
    [queueItems, localMoves],
  );
  const [drag, setDrag] = useState<DragState | null>(null);
  // A drag ends with a click event on the bar; this swallows it.
  const suppressClickRef = useRef(false);

  // Tick "now" every minute so the NOW line and ETA labels stay live.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // User can shift the window forward/back in 12h steps. Default = current
  // time, so the timeline reads "next 24h from now."
  const [windowOffsetMs, setWindowOffsetMs] = useState(0);

  // Round the window start down to the previous full hour so the axis ticks
  // land on whole hours.
  const rangeStartMs = useMemo(() => {
    const target = now.getTime() + windowOffsetMs;
    return Math.floor(target / HOUR_MS) * HOUR_MS;
  }, [now, windowOffsetMs]);
  const rangeEndMs = rangeStartMs + RANGE_MS;
  const nowMs = now.getTime();

  // Build schedule events. Only committed schedules are rendered:
  //  • currently printing → always
  //  • pending with explicit scheduled_time → at that time
  //  • pending ASAP that chain behind a print actually running on the same
  //    lane → forecast
  // Staged (manual_start) and blocked items are not on the timeline because
  // they won't auto-dispatch — they'd be misleading bars. "Blocked" is not the
  // same as "has a waiting_reason": since #3074 an item queued behind a running
  // print carries one too ("Busy: X1C-01"), and that is the chain this view
  // exists to forecast. Only a reason that needs the user takes an item off.
  // Idle-printer ASAP queues also stay off until something starts on them.
  const events = useMemo<ScheduleEvent[]>(() => {
    const result: ScheduleEvent[] = [];
    const pendingByLaneKey = new Map<string, PrintQueueItem[]>();
    // Lanes that have an active print right now — only these qualify for
    // ASAP chain forecasting.
    const lanesWithActive = new Set<string>();
    // Chain-end timestamp per lane (where the next pending item's bar starts).
    const chainEndByLane = new Map<string, number>();

    for (const item of items) {
      if (item.status === 'printing') {
        const status = item.printer_id != null ? printerStatuses[item.printer_id] : undefined;
        const start = parseUTCDate(item.started_at) || new Date();
        let endTime: Date;
        if (status?.remaining_time != null && status.remaining_time > 0) {
          endTime = new Date(nowMs + status.remaining_time * 60 * 1000);
        } else if (item.print_time_seconds && status?.progress == null && item.started_at) {
          // No word from the printer yet: assume it runs to its slicer estimate
          // from when it started (and is at least a minute from done).
          endTime = new Date(Math.max(start.getTime() + item.print_time_seconds * 1000, nowMs + 60_000));
        } else if (item.print_time_seconds) {
          const progress = status?.progress || 0;
          const remainingFraction = Math.max(0, 1 - progress / 100);
          endTime = new Date(nowMs + item.print_time_seconds * remainingFraction * 1000);
        } else {
          endTime = new Date(nowMs + HOUR_MS);
        }
        // Progress bar under the card: the printer's own figure, else how far
        // through its estimated run the print is.
        const totalMs = endTime.getTime() - start.getTime();
        const progress = status?.progress
          ?? (totalMs > 0 ? Math.min(100, Math.max(0, ((nowMs - start.getTime()) / totalMs) * 100)) : undefined);
        result.push({
          item,
          estimatedStart: start,
          estimatedEnd: endTime,
          progress,
          type: 'printing',
        });
        const lk = queueLaneKey(item);
        lanesWithActive.add(lk);
        chainEndByLane.set(lk, Math.max(chainEndByLane.get(lk) ?? nowMs, endTime.getTime()));
      } else if (item.status === 'pending') {
        // Skip un-committed pending shapes — staged items and blocked items
        // won't auto-dispatch, so a bar would lie. An item merely waiting its
        // turn behind a print does auto-dispatch, and is the whole point of the
        // chain forecast below.
        if (item.manual_start) continue;
        // A job someone placed at a time stays on the timeline, flagged, so
        // a placement made by the smart queue or a drag doesn't vanish.
        if (item.waiting_reason && !isBusyOnlyWaitingReason(item.waiting_reason) && !item.scheduled_time) continue;
        const lk = queueLaneKey(item);
        if (!pendingByLaneKey.has(lk)) pendingByLaneKey.set(lk, []);
        pendingByLaneKey.get(lk)!.push(item);
      }
    }

    const sixMonthsFromNow = Date.now() + 180 * 24 * HOUR_MS;
    for (const [lk, laneItems] of pendingByLaneKey) {
      // Jobs due now (ASAP, or scheduled in the past) go in dispatch order;
      // a job scheduled for later can't start before its time, so the ones
      // the smart queue (or a drag) placed later follow in time order.
      const dueMs = (it: PrintQueueItem) => Math.max(nowMs, parseUTCDate(it.scheduled_time)?.getTime() ?? nowMs);
      laneItems.sort((a, b) => dueMs(a) - dueMs(b) || compareQueueOrder(a, b, sjfEnabled));
      const hasActive = lanesWithActive.has(lk);
      // A lane is timelineable when EITHER it has an active print (chain
      // forecast off its end) OR its first pending item is scheduled (a
      // committed anchor exists). Otherwise every chained ASAP item is just
      // a guess — drop the whole lane to keep the view honest.
      const firstScheduled = laneItems[0] ? parseUTCDate(laneItems[0].scheduled_time) : null;
      const firstScheduledOk = firstScheduled && firstScheduled.getTime() <= sixMonthsFromNow;
      if (!hasActive && !firstScheduledOk) continue;

      let chainEnd = chainEndByLane.get(lk) ?? nowMs;
      for (const item of laneItems) {
        const scheduled = parseUTCDate(item.scheduled_time);
        if (scheduled && scheduled.getTime() <= sixMonthsFromNow) {
          chainEnd = Math.max(chainEnd, scheduled.getTime());
        }
        const duration = (item.print_time_seconds || 3600) * 1000;
        result.push({
          item,
          estimatedStart: new Date(chainEnd),
          estimatedEnd: new Date(chainEnd + duration),
          type: 'queued',
          blockedReason:
            item.waiting_reason && !isBusyOnlyWaitingReason(item.waiting_reason) ? item.waiting_reason : undefined,
        });
        chainEnd += duration;
      }
    }
    return result;
  }, [items, printerStatuses, nowMs, sjfEnabled]);

  // Lanes: every printer + every distinct target_model with queue activity
  // + an "unassigned" lane if needed. Printers that have NO events queued
  // still get a lane so users see idle capacity.
  const lanes = useMemo<LaneDescriptor[]>(() => {
    const list: LaneDescriptor[] = [];
    for (const p of printers) {
      list.push({
        key: `printer:${p.id}`,
        label: p.name,
        printerId: p.id,
        targetModel: null,
      });
    }
    const modelLanesAdded = new Set<string>();
    let hasUnassigned = false;
    for (const ev of events) {
      if (ev.item.printer_id != null) continue;
      if (ev.item.target_model) {
        const k = `model:${ev.item.target_model}`;
        if (!modelLanesAdded.has(k)) {
          modelLanesAdded.add(k);
          list.push({
            key: k,
            label: `${t('queue.filter.any')} ${ev.item.target_model}`,
            printerId: null,
            targetModel: ev.item.target_model,
          });
        }
      } else {
        hasUnassigned = true;
      }
    }
    if (hasUnassigned) {
      list.push({
        key: 'unassigned',
        label: t('queue.filter.unassigned'),
        printerId: null,
        targetModel: null,
      });
    }
    return list;
  }, [printers, events, t]);

  const eventsByLane = useMemo(() => {
    const map = new Map<string, ScheduleEvent[]>();
    for (const ev of events) {
      let key: string;
      if (ev.item.printer_id != null) key = `printer:${ev.item.printer_id}`;
      else if (ev.item.target_model) key = `model:${ev.item.target_model}`;
      else key = 'unassigned';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    for (const laneEvents of map.values()) {
      laneEvents.sort((a, b) => a.estimatedStart.getTime() - b.estimatedStart.getTime());
    }
    return map;
  }, [events]);

  const hourTicks = useMemo(() => {
    const ticks: { ms: number; pct: number; label: string }[] = [];
    for (let h = 0; h <= RANGE_HOURS; h += 2) {
      const ms = rangeStartMs + h * HOUR_MS;
      ticks.push({
        ms,
        pct: (h / RANGE_HOURS) * 100,
        label: formatHour(new Date(ms)),
      });
    }
    return ticks;
  }, [rangeStartMs]);

  const nowPct = ((nowMs - rangeStartMs) / RANGE_MS) * 100;
  const nowInView = nowPct >= 0 && nowPct <= 100;

  // Aggregated "all done by" across the entire (un-windowed) event set.
  const allDoneBy = useMemo(() => {
    let latest = 0;
    for (const ev of events) latest = Math.max(latest, ev.estimatedEnd.getTime());
    return latest > 0 ? new Date(latest) : null;
  }, [events]);

  const trackRef = useRef<HTMLDivElement | null>(null);

  const officeWindows = useMemo(
    () => (officeSchedule ? officeWindowsBetween(officeSchedule, rangeStartMs, rangeEndMs) : []),
    [officeSchedule, rangeStartMs, rangeEndMs],
  );

  const laneByKey = useMemo(() => new Map(lanes.map((lane) => [lane.key, lane])), [lanes]);

  /** `startMs` moved forward out of any other card in the lane, so cards
   *  never overlap. Repeats in case a card's end lands inside the next one. */
  const clearOfOtherCards = (startMs: number, laneKey: string, itemId: number) => {
    const others = (eventsByLane.get(laneKey) ?? []).filter((ev) => ev.item.id !== itemId);
    for (let moved = true; moved; ) {
      moved = false;
      for (const ev of others) {
        if (startMs >= ev.estimatedStart.getTime() && startMs < ev.estimatedEnd.getTime()) {
          startMs = ev.estimatedEnd.getTime();
          moved = true;
        }
      }
    }
    return startMs;
  };

  /** Start time and target lane the current drag would drop on. */
  const dropTarget = (state: DragState) => {
    const deltaMs = (state.dx / state.trackWidthPx) * RANGE_MS;
    const snapped = Math.max(nowMs, Math.round((state.originalStartMs + deltaMs) / SNAP_MS) * SNAP_MS);
    return { startMs: clearOfOtherCards(snapped, state.laneKey, state.itemId), lane: laneByKey.get(state.laneKey) };
  };

  /** Where one nudge (a snap step) earlier or later would put a card, or null
   *  when it can't move that way (into the past, or into the card before). */
  const nudgeTarget = (ev: ScheduleEvent, direction: -1 | 1): number | null => {
    const current = ev.estimatedStart.getTime();
    const step = direction > 0
      ? Math.floor(current / SNAP_MS) * SNAP_MS + SNAP_MS
      : Math.ceil(current / SNAP_MS) * SNAP_MS - SNAP_MS;
    const target = clearOfOtherCards(Math.max(nowMs, step), queueLaneKey(ev.item), ev.item.id);
    return direction > 0 ? (target > current ? target : null) : (target < current ? target : null);
  };

  const commitMove = (item: PrintQueueItem, scheduledTime: Date, printerId: number | null) => {
    if (!onReschedule) return;
    setLocalMoves((moves) => ({
      ...moves,
      [item.id]: {
        scheduled_time: scheduledTime.toISOString(),
        ...(printerId != null ? { printer_id: printerId, target_model: null } : {}),
      },
    }));
    onReschedule(item, { printerId, scheduledTime });
  };

  const nudge = (ev: ScheduleEvent, direction: -1 | 1) => {
    const target = nudgeTarget(ev, direction);
    if (target != null) commitMove(ev.item, new Date(target), null);
  };

  const handleBarKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, ev: ScheduleEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    nudge(ev, e.key === 'ArrowLeft' ? -1 : 1);
  };

  // The card whose nudge arrows are showing (hovered or focused).
  const [activeCardId, setActiveCardId] = useState<number | null>(null);
  // Leaving a card for one of its arrows (drawn on top of it) fires a
  // mouseleave first, so hiding waits a moment for the arrow to claim it.
  const hideArrowsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showArrowsFor = (id: number) => {
    if (hideArrowsTimer.current) clearTimeout(hideArrowsTimer.current);
    hideArrowsTimer.current = null;
    setActiveCardId(id);
  };
  const hideArrowsSoon = (id: number) => {
    if (hideArrowsTimer.current) clearTimeout(hideArrowsTimer.current);
    hideArrowsTimer.current = setTimeout(() => setActiveCardId((cur) => (cur === id ? null : cur)), 150);
  };
  useEffect(() => () => {
    if (hideArrowsTimer.current) clearTimeout(hideArrowsTimer.current);
  }, []);

  const handleBarPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, ev: ScheduleEvent) => {
    if (!onReschedule || ev.type !== 'queued' || e.button !== 0) return;
    const track = e.currentTarget.parentElement;
    if (!track) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({
      itemId: ev.item.id,
      pointerId: e.pointerId,
      originX: e.clientX,
      originY: e.clientY,
      dx: 0,
      dy: 0,
      trackWidthPx: track.getBoundingClientRect().width || 1,
      originalStartMs: ev.estimatedStart.getTime(),
      laneKey: track.dataset.laneKey ?? queueLaneKey(ev.item),
      moved: false,
    });
  };

  const handleBarPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.originX;
    const dy = e.clientY - drag.originY;
    const moved = drag.moved || Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX;
    // Which lane the pointer is over; only printer lanes accept a drop.
    const hit = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(e.clientX, e.clientY).find((el) => (el as HTMLElement).dataset?.laneKey)
      : undefined;
    const hoveredKey = (hit as HTMLElement | undefined)?.dataset.laneKey;
    const laneKey = hoveredKey && laneByKey.get(hoveredKey)?.printerId != null ? hoveredKey : drag.laneKey;
    setDrag({ ...drag, dx, dy, moved, laneKey });
  };

  const handleBarPointerUp = (e: ReactPointerEvent<HTMLButtonElement>, ev: ScheduleEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    setDrag(null);
    if (!drag.moved || !onReschedule) return;
    suppressClickRef.current = true;
    const { startMs, lane } = dropTarget(drag);
    const printerId = lane?.printerId != null && lane.printerId !== ev.item.printer_id ? lane.printerId : null;
    commitMove(ev.item, new Date(startMs), printerId);
  };

  return (
    <div>
      {/* Window controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWindowOffsetMs((v) => v - 12 * HOUR_MS)}
            className="p-1.5"
            title={t('queue.timeline.window.back12h')}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm font-medium text-white min-w-[180px] text-center">
            {new Date(rangeStartMs).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {' → '}
            {new Date(rangeEndMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWindowOffsetMs((v) => v + 12 * HOUR_MS)}
            className="p-1.5"
            title={t('queue.timeline.window.forward12h')}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          {windowOffsetMs !== 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWindowOffsetMs(0)}
              className="text-xs text-bambu-green"
            >
              {t('queue.timeline.window.now')}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {allDoneBy && (
            <span className="text-xs text-bambu-gray flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {t('queue.timeline.allDoneBy', {
                time: allDoneBy.toLocaleString(undefined, {
                  weekday: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </span>
          )}
          {onEditOfficeSchedule && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onEditOfficeSchedule}
              title={t('queue.smartQueue.schedule.title')}
              className="text-xs"
            >
              <Briefcase className="w-3.5 h-3.5" />
              {officeSchedule
                ? `${officeSchedule.start}–${officeSchedule.end}`
                : t('queue.smartQueue.schedule.button')}
            </Button>
          )}
          {onSmartQueue && (
            <Button
              size="sm"
              onClick={onSmartQueue}
              disabled={smartQueueBusy}
              title={t('queue.smartQueue.tooltip')}
            >
              {smartQueueBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {t('queue.smartQueue.button')}
            </Button>
          )}
        </div>
      </div>

      {(onReschedule || officeSchedule) && (
        <div className="flex flex-wrap items-center gap-4 mb-3 text-[11px] text-bambu-gray">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-amber-500/30 border border-amber-400/70" aria-hidden />
            <Lock className="w-3 h-3" aria-hidden />
            {t('queue.smartQueue.legend.printing')}
          </span>
          {onReschedule && (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-bambu-green/20 border border-bambu-green/40" aria-hidden />
              {t('queue.smartQueue.legend.queued')}
            </span>
          )}
          {officeSchedule && (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-bambu-green/10 border border-dashed border-bambu-green/30" aria-hidden />
              {t('queue.smartQueue.legend.officeHours')}
            </span>
          )}
        </div>
      )}

      {/* Empty-state notice when the fleet is idle and no queued item is
          committed (no scheduled_time / no active print to chain off).
          Without this, users see striped lanes with no bars and assume the
          timeline is broken — common confusion from the GHSA-r2qv era. */}
      {lanes.length > 0 && events.length === 0 && (
        <div className="mb-4 p-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark/40 text-xs text-bambu-gray">
          {t('queue.timeline.nothingCommitted')}
        </div>
      )}

      {lanes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-bambu-gray">
          <Layers className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">{t('queue.timeline.noData')}</p>
        </div>
      ) : (
        <div className="bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary overflow-hidden">
          {/* Hour axis */}
          <div className="flex border-b border-bambu-dark-tertiary">
            <div className="w-32 sm:w-40 shrink-0 px-3 py-2 text-xs font-medium text-bambu-gray border-r border-bambu-dark-tertiary">
              {t('queue.timeline.printerColumnHeader')}
            </div>
            <div className="relative flex-1 h-9">
              {hourTicks.map((tick) => (
                <div
                  key={tick.ms}
                  className="absolute top-0 bottom-0 border-l border-bambu-dark-tertiary/40 text-[10px] sm:text-xs text-bambu-gray pl-1 flex items-center"
                  style={{ left: `${tick.pct}%` }}
                >
                  {tick.label}
                </div>
              ))}
            </div>
          </div>

          {/* Lanes */}
          <div ref={trackRef} className="relative">
            {lanes.map((lane) => {
              const laneEvents = eventsByLane.get(lane.key) ?? [];
              return (
                <div key={lane.key} className="flex border-b border-bambu-dark-tertiary/40 last:border-b-0">
                  <div className="w-32 sm:w-40 shrink-0 px-3 py-3 border-r border-bambu-dark-tertiary flex items-center gap-2">
                    <PrinterIcon className={`w-3.5 h-3.5 shrink-0 ${
                      lane.printerId == null && lane.targetModel == null
                        ? 'text-orange-600 dark:text-orange-400'
                        : lane.targetModel
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-bambu-green'
                    }`} />
                    <span className="text-sm text-white truncate">{lane.label}</span>
                  </div>
                  <div
                    className={`relative flex-1 ${
                      drag?.moved && drag.laneKey === lane.key ? 'ring-1 ring-inset ring-bambu-green/60' : ''
                    }`}
                    style={{ height: LANE_BAR_HEIGHT_PX + 16 }}
                    data-lane-key={lane.key}
                  >
                    {/* Office hours: when someone is in to start a print. */}
                    {officeWindows.map((w) => {
                      const from = Math.max(rangeStartMs, w.startMs);
                      const to = Math.min(rangeEndMs, w.endMs);
                      return (
                        <div
                          key={w.startMs}
                          className="absolute top-0 bottom-0 bg-bambu-green/10 pointer-events-none"
                          style={{
                            left: `${((from - rangeStartMs) / RANGE_MS) * 100}%`,
                            width: `${((to - from) / RANGE_MS) * 100}%`,
                          }}
                          aria-hidden
                        />
                      );
                    })}
                    {/* Hour grid lines */}
                    {hourTicks.map((tick) => (
                      <div
                        key={tick.ms}
                        className="absolute top-0 bottom-0 border-l border-bambu-dark-tertiary/30"
                        style={{ left: `${tick.pct}%` }}
                      />
                    ))}

                    {/* Idle background — diagonal stripes hint that the lane
                        is sittable. Rendered behind bars so they overlay it. */}
                    <div
                      className="absolute inset-0 opacity-30"
                      style={{
                        backgroundImage:
                          'repeating-linear-gradient(45deg, transparent, transparent 6px, rgba(255,255,255,0.04) 6px, rgba(255,255,255,0.04) 12px)',
                      }}
                      aria-hidden
                    />

                    {/* Job bars */}
                    {laneEvents.map((ev, index) => {
                      // Clip to the visible window.
                      const startMs = Math.max(rangeStartMs, ev.estimatedStart.getTime());
                      const endMs = Math.min(rangeEndMs, ev.estimatedEnd.getTime());
                      if (endMs <= rangeStartMs || startMs >= rangeEndMs) return null;
                      const leftPct = ((startMs - rangeStartMs) / RANGE_MS) * 100;
                      const widthPct = ((endMs - startMs) / RANGE_MS) * 100;
                      // Cards never overlap: a short job is widened to stay
                      // clickable, but only up to where the next card starts.
                      const next = laneEvents[index + 1];
                      const nextLeftPct = next
                        ? ((Math.max(rangeStartMs, next.estimatedStart.getTime()) - rangeStartMs) / RANGE_MS) * 100
                        : null;
                      const roomPct = nextLeftPct != null ? Math.max(widthPct, nextLeftPct - leftPct) : null;
                      const widthCss = roomPct != null
                        ? `min(max(${MIN_BAR_PX}px, ${widthPct}%), ${roomPct}%)`
                        : `max(${MIN_BAR_PX}px, ${widthPct}%)`;
                      const displayName = ev.item.archive_name
                        || ev.item.library_file_name
                        || `#${ev.item.id}`;
                      const thumbnailUrl = queueItemThumbnailUrl(ev.item);
                      const isPrinting = ev.type === 'printing';
                      const isBatched = ev.item.batch_id != null;
                      const draggable = !isPrinting && onReschedule != null;
                      const dragging = drag?.itemId === ev.item.id && drag.moved ? drag : null;
                      const dropStart = dragging ? dropTarget(dragging).startMs : null;
                      const tooltipParts = [
                        displayName,
                        `${formatTooltipTime(ev.estimatedStart)} → ${formatTooltipTime(ev.estimatedEnd)}`,
                        ev.item.print_time_seconds ? formatDuration(ev.item.print_time_seconds) : null,
                        isPrinting && ev.progress != null ? `${Math.round(ev.progress)}%` : null,
                        ev.item.batch_name ? `batch: ${ev.item.batch_name}` : null,
                        isPrinting && onReschedule ? t('queue.smartQueue.locked') : null,
                        ev.blockedReason ?? null,
                      ].filter(Boolean).join(' · ');
                      const showArrows = draggable && !dragging && activeCardId === ev.item.id;
                      const earlier = showArrows ? nudgeTarget(ev, -1) : null;
                      const later = showArrows ? nudgeTarget(ev, 1) : null;
                      const arrowClass =
                        'absolute z-20 w-5 h-6 rounded bg-bambu-dark/90 border border-bambu-dark-tertiary text-white flex items-center justify-center hover:bg-bambu-green hover:text-black disabled:opacity-30 disabled:pointer-events-none';
                      return (
                        <Fragment key={ev.item.id}>
                        <button
                          onMouseEnter={draggable ? () => showArrowsFor(ev.item.id) : undefined}
                          onMouseLeave={draggable ? () => hideArrowsSoon(ev.item.id) : undefined}
                          onFocus={draggable ? () => showArrowsFor(ev.item.id) : undefined}
                          onBlur={draggable ? () => hideArrowsSoon(ev.item.id) : undefined}
                          onKeyDown={draggable ? (e) => handleBarKeyDown(e, ev) : undefined}
                          onClick={() => {
                            if (suppressClickRef.current) {
                              suppressClickRef.current = false;
                              return;
                            }
                            onItemClick(ev.item);
                          }}
                          onPointerDown={draggable ? (e) => handleBarPointerDown(e, ev) : undefined}
                          onPointerMove={draggable ? handleBarPointerMove : undefined}
                          onPointerUp={draggable ? (e) => handleBarPointerUp(e, ev) : undefined}
                          onPointerCancel={draggable ? () => setDrag(null) : undefined}
                          title={tooltipParts}
                          data-testid={`timeline-bar-${ev.item.id}`}
                          data-locked={isPrinting ? 'true' : undefined}
                          className={`absolute rounded-md hover:brightness-110 hover:z-10 overflow-hidden flex items-center gap-1.5 px-1.5 text-left touch-none ${
                            dragging ? 'z-30 opacity-90 shadow-lg ring-2 ring-bambu-green cursor-grabbing' : 'transition-all'
                          } ${draggable && !dragging ? 'cursor-grab' : ''} ${
                            isPrinting
                              ? 'bg-amber-500/30 border border-amber-400/70'
                              : ev.blockedReason
                                ? 'bg-bambu-green/10 border border-dashed border-red-400/70'
                                : isBatched
                                  ? 'bg-cyan-500/20 border border-cyan-400/50'
                                  : 'bg-bambu-green/20 border border-bambu-green/40'
                          }`}
                          style={{
                            left: `${leftPct}%`,
                            width: widthCss,
                            top: 8,
                            height: LANE_BAR_HEIGHT_PX,
                            transform: dragging ? `translate(${dragging.dx}px, ${dragging.dy}px)` : undefined,
                          }}
                        >
                          {isPrinting && (
                            <Lock className="w-3 h-3 shrink-0 text-amber-300" aria-label={t('queue.smartQueue.locked')} />
                          )}
                          {thumbnailUrl && (
                            <img
                              src={thumbnailUrl}
                              alt=""
                              className="w-7 h-7 rounded object-cover shrink-0 bg-bambu-dark"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-white font-medium truncate leading-tight">
                              {displayName}
                            </div>
                            <div className="text-[10px] text-bambu-gray truncate leading-tight">
                              {ev.item.print_time_seconds ? formatDuration(ev.item.print_time_seconds) : ''}
                              {isPrinting && ev.progress != null ? ` · ${Math.round(ev.progress)}%` : ''}
                            </div>
                          </div>
                          {dropStart != null && (
                            <span className="absolute -top-0.5 right-1 text-[10px] font-medium text-white bg-bambu-dark/80 rounded px-1">
                              {formatTooltipTime(new Date(dropStart))}
                            </span>
                          )}
                          {isPrinting && ev.progress != null && (
                            <div
                              className="absolute bottom-0 left-0 h-1 bg-amber-300"
                              style={{ width: `${ev.progress}%` }}
                              data-testid={`timeline-progress-${ev.item.id}`}
                              aria-hidden
                            />
                          )}
                        </button>
                        {showArrows && (
                          <>
                            <button
                              type="button"
                              className={arrowClass}
                              style={{ left: `calc(${leftPct}% + 2px)`, top: 8 + (LANE_BAR_HEIGHT_PX - 24) / 2 }}
                              onMouseEnter={() => showArrowsFor(ev.item.id)}
                              onMouseLeave={() => hideArrowsSoon(ev.item.id)}
                              onFocus={() => showArrowsFor(ev.item.id)}
                              onBlur={() => hideArrowsSoon(ev.item.id)}
                              onClick={() => nudge(ev, -1)}
                              disabled={earlier == null}
                              title={t('queue.smartQueue.nudgeEarlier')}
                              aria-label={t('queue.smartQueue.nudgeEarlier')}
                              data-testid={`timeline-nudge-left-${ev.item.id}`}
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              className={arrowClass}
                              style={{ left: `calc(${leftPct}% + ${widthCss} - 22px)`, top: 8 + (LANE_BAR_HEIGHT_PX - 24) / 2 }}
                              onMouseEnter={() => showArrowsFor(ev.item.id)}
                              onMouseLeave={() => hideArrowsSoon(ev.item.id)}
                              onFocus={() => showArrowsFor(ev.item.id)}
                              onBlur={() => hideArrowsSoon(ev.item.id)}
                              onClick={() => nudge(ev, 1)}
                              disabled={later == null}
                              title={t('queue.smartQueue.nudgeLater')}
                              aria-label={t('queue.smartQueue.nudgeLater')}
                              data-testid={`timeline-nudge-right-${ev.item.id}`}
                            >
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* NOW line — drawn on top of all lanes. Use the same
                label-column offset (w-32 sm:w-40) as the lanes so the line
                aligns exactly with the time track. */}
            {nowInView && (
              <div className="absolute top-0 bottom-0 pointer-events-none z-20 flex inset-x-0">
                <div className="w-32 sm:w-40 shrink-0" />
                <div className="relative flex-1">
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]"
                    style={{ left: `${nowPct}%` }}
                  >
                    <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-red-400 rounded-full" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
