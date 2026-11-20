const SCENE_ID = /^[A-Za-z0-9_-]{32}$/;
const MAX_SCENES = 16;
const MAX_RESOURCES = 128;

function describeRequest(url) {
  const scene = /^\/wallpapers\/scene\/([A-Za-z0-9_-]{32})\/asset$/.exec(url.pathname);
  const id = scene?.[1] ?? url.searchParams.get('id') ?? '';
  if (!SCENE_ID.test(id)) return null;
  if (scene) return [id, url.searchParams.get('name') ?? ''];
  if (url.pathname === '/wallpapers/properties') return [id, 'project.json（壁纸属性）'];
  if (url.pathname === '/wallpapers/particle-texture') {
    return [id, `materials/${url.searchParams.get('name') ?? ''}.tex`];
  }
  return null;
}

export function createSceneDiagnostics() {
  const sessions = new Map();
  return {
    begin(id) {
      if (SCENE_ID.test(id ?? '')) sessions.delete(id);
    },
    record(url, status) {
      const resource = describeRequest(url);
      if (!resource) return;
      const [id, name] = resource;
      let session = sessions.get(id);
      if (!session) {
        if (sessions.size >= MAX_SCENES) sessions.delete(sessions.keys().next().value);
        session = { requests: 0, errors: new Map(), omitted: false };
        sessions.set(id, session);
      }
      session.requests++;
      const key = name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
      if (status < 400) session.errors.delete(key);
      else if (session.errors.size < MAX_RESOURCES || session.errors.has(key)) session.errors.set(key, status);
      else session.omitted = true;
    },
    report(id) {
      const session = sessions.get(id);
      return {
        requests: session?.requests ?? 0,
        failures: session ? Array.from(session.errors, ([name, status]) => ({ name, status })) : [],
        omitted: session?.omitted ?? false,
      };
    },
  };
}
