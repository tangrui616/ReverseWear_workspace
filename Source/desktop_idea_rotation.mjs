import { getWorkDate } from './dist/date-boundary.mjs';

function dateSeed(date) {
  let hash = 2166136261;
  for (const character of date) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function createDesktopIdeaRotation(ideas, { now = () => new Date(), getDayStartMinutes = () => 0 } = {}) {
  return {
    async getTodayResurfacing() {
      const workDate = getWorkDate(now(), getDayStartMinutes());
      const fridge = (await ideas.listIdeas({ status: 'fridge' }))
        .filter(item => item.status === 'fridge' && typeof item.id === 'string')
        .sort((left, right) => left.id.localeCompare(right.id));
      if (!fridge.length) return { workDate, item: null };
      return { workDate, item: fridge[dateSeed(workDate) % fridge.length] };
    },
  };
}
