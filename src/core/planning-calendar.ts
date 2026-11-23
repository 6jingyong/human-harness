export const dayMinutes = 1440;
const morning = 9 * 60;

export const dateMinute = (date: string) => Date.parse(date + 'T00:00:00Z') / 60000;
export const civilDate = (minute: number) => new Date(minute * 60000).toISOString().slice(0, 10);

/** UTC is used only as an arithmetic axis for local calendar dates and minutes. */
export function civilMinute(instant: Date | string, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const text = fmt.format(typeof instant === 'string' ? new Date(instant) : instant);
  return Date.parse(text.replace(' ', 'T') + ':00Z') / 60000;
}

function isWorkday(day: number) {
  const weekday = new Date(day * 60000).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

export function nextWorkingMinute(at: number, minutesPerDay: number): number {
  let day = Math.floor(at / dayMinutes) * dayMinutes;
  if (at >= day + morning + minutesPerDay) day += dayMinutes;
  while (!isWorkday(day)) day += dayMinutes;
  return Math.max(at, day + morning);
}

export function workWindow(start: number, effort: number, minutesPerDay: number) {
  const segments = [];
  let remaining = effort;
  let at = nextWorkingMinute(start, minutesPerDay);
  while (remaining > 0) {
    const close = Math.floor(at / dayMinutes) * dayMinutes + morning + minutesPerDay;
    const consumed = Math.min(remaining, close - at);
    segments.push({ start: at, finish: at + consumed });
    remaining -= consumed;
    at = remaining ? nextWorkingMinute(close, minutesPerDay) : at + consumed;
  }
  return { start: segments[0]?.start ?? at, finish: at, segments };
}

/** Latest working-minute start to leave the required working effort before a finish bound. */
export function latestWorkingStart(finish: number, effort: number, minutesPerDay: number): number {
  let end = finish;
  let remaining = effort;
  while (remaining > 0) {
    const day = Math.floor((end - 1) / dayMinutes) * dayMinutes;
    const open = day + morning;
    const close = Math.min(end, open + minutesPerDay);
    if (!isWorkday(day) || close <= open) {
      end = day;
      continue;
    }
    const used = Math.min(remaining, close - open);
    end = close - used;
    remaining -= used;
    if (remaining && end === open) end = day;
  }
  return end;
}

export function addWorkingDays(day: number, count: number): number {
  let date = Math.floor(day / dayMinutes) * dayMinutes;
  for (let i = 0; i < count;) {
    date += dayMinutes;
    if (isWorkday(date)) i++;
  }
  return date;
}
