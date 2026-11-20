let dayStartMinutes = 0;

export function setDayStartMinutes(value) {
  dayStartMinutes = Number.isInteger(value) ? Math.min(1439, Math.max(0, value)) : 0;
}

export function getDayStartMinutes() {
  return dayStartMinutes;
}

export function getWorkDate(value = new Date(), boundary = dayStartMinutes) {
  const date = new Date(value);
  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  const minutes = Number.isInteger(boundary) ? Math.min(1439, Math.max(0, boundary)) : dayStartMinutes;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (currentMinutes < minutes ? 1 : 0));
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
