// Synthetic calendar and weather for one run (decisions D1, D3, D9). Mirrors build_calendar() in
// ml/src/generate_data.py: random weekday holidays, an optional exam block in the second half, festivals on other
// days, monsoon-like weather (40 % rainy days, gamma rainfall, slow seasonal temperature drift).

import { createRng, round } from './rng.js';

export const DEFAULT_CALENDAR = Object.freeze({ holidays: 2, festivals: 2, exam_days: 0 }); // D3
export const GENERATOR_CALENDAR = Object.freeze({ holidays: 4, festivals: 3, exam_days: 8 }); // calibration runs

const DAY_MS = 86_400_000;

export function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function buildCalendar({ seed, startDate, totalDays, calendar = DEFAULT_CALENDAR }) {
  const rng = createRng(seed, 'calendar');
  const days = Array.from({ length: totalDays }, (_, i) => {
    const date = addDays(startDate, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return { day_number: i + 1, date, is_weekend: dow === 0 || dow === 6,
      is_holiday: false, is_exam_day: false, is_festival: false };
  });

  const weekdays = days.filter((d) => !d.is_weekend).map((d) => d.day_number);
  const holidays = new Set(rng.sample(weekdays, Math.min(calendar.holidays, weekdays.length)));

  const examDays = new Set();
  if (calendar.exam_days > 0) {
    const half = Math.floor(totalDays / 2);
    const lastStart = Math.max(half + 1, totalDays - calendar.exam_days); // 0-based, like the generator
    const start = rng.integers(half, lastStart);
    for (let i = start; i < Math.min(start + calendar.exam_days, totalDays); i += 1) examDays.add(i + 1);
  }

  for (const d of days) {
    d.is_holiday = holidays.has(d.day_number);
    d.is_exam_day = examDays.has(d.day_number) && !d.is_holiday;
  }
  const festivalCandidates = days.filter((d) => !d.is_exam_day && !d.is_holiday).map((d) => d.day_number);
  const festivals = new Set(rng.sample(festivalCandidates, Math.min(calendar.festivals, festivalCandidates.length)));

  for (const d of days) {
    d.is_festival = festivals.has(d.day_number);
    const rainy = rng.random() < 0.40;
    const rainfall = rainy ? rng.gamma(1.5, 8.0) : 0;
    const progress = totalDays > 1 ? (d.day_number - 1) / (totalDays - 1) : 0;
    const seasonal = 31.0 - 2.0 * Math.sin(Math.PI * progress);
    d.rainfall = round(rainfall, 1);
    d.temperature = round(seasonal - 0.08 * rainfall + rng.normal(0, 1.2), 1);
  }
  return days;
}
