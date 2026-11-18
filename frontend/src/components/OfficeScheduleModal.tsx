import { useEffect, useState } from 'react';
import { Briefcase, Loader2 } from 'lucide-react';
import { Card, CardContent } from './Card';
import { Button } from './Button';
import { officeScheduleError, type OfficeSchedule } from '../utils/officeSchedule';

interface OfficeScheduleModalProps {
  initial: OfficeSchedule;
  isSaving?: boolean;
  onSave: (schedule: OfficeSchedule) => void;
  onCancel: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

// 2024-01-01 was a Monday, so day i of that week is weekday i (Monday = 0).
function weekdayLabel(day: number): string {
  return new Date(Date.UTC(2024, 0, 1 + day)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
}

/** Edit the working days and hours the smart queue plans print starts around. */
export function OfficeScheduleModal({ initial, isSaving = false, onSave, onCancel, t }: OfficeScheduleModalProps) {
  const [schedule, setSchedule] = useState<OfficeSchedule>(initial);
  const error = officeScheduleError(schedule);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, isSaving]);

  const toggleDay = (day: number) =>
    setSchedule((s) => ({
      ...s,
      days: s.days.includes(day) ? s.days.filter((d) => d !== day) : [...s.days, day].sort((a, b) => a - b),
    }));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={isSaving ? undefined : onCancel}>
      <Card className="w-full max-w-md" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="p-2 rounded-full bg-bambu-dark text-bambu-green">
              <Briefcase className="w-6 h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-white mb-1">{t('queue.smartQueue.schedule.title')}</h3>
              <p className="text-bambu-gray text-sm">{t('queue.smartQueue.schedule.description')}</p>
            </div>
          </div>

          <div className="mt-5">
            <div className="text-xs font-medium text-bambu-gray mb-2">{t('queue.smartQueue.schedule.days')}</div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('queue.smartQueue.schedule.days')}>
              {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                const on = schedule.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleDay(day)}
                    className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
                      on
                        ? 'bg-bambu-green/20 border-bambu-green text-bambu-green'
                        : 'bg-bambu-dark-secondary border-bambu-dark-tertiary text-bambu-gray hover:text-white'
                    }`}
                  >
                    {weekdayLabel(day)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="text-xs font-medium text-bambu-gray">
              {t('queue.smartQueue.schedule.start')}
              <input
                type="time"
                value={schedule.start}
                onChange={(e) => setSchedule((s) => ({ ...s, start: e.target.value }))}
                className="mt-1 w-full px-2 py-1.5 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-sm"
              />
            </label>
            <label className="text-xs font-medium text-bambu-gray">
              {t('queue.smartQueue.schedule.end')}
              <input
                type="time"
                value={schedule.end}
                onChange={(e) => setSchedule((s) => ({ ...s, end: e.target.value }))}
                className="mt-1 w-full px-2 py-1.5 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-sm"
              />
            </label>
          </div>

          <p className="mt-3 text-xs text-bambu-gray">
            {t('queue.smartQueue.schedule.timezone', { timezone: schedule.timezone })}
          </p>
          {error && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">
              {t(`queue.smartQueue.schedule.error.${error}`)}
            </p>
          )}

          <div className="flex gap-3 mt-6">
            <Button variant="secondary" onClick={onCancel} className="flex-1" disabled={isSaving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => onSave(schedule)} className="flex-1" disabled={isSaving || error != null}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.save')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
