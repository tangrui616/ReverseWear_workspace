const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".mov", ".ogg"]);
const DB_NAME = "liubai-wallpaper-library";
const DB_STORE = "handles";
const ROOT_KEY = "selected-library-root";
const URLS = new Set();
let directoryScan = null;

function extensionOf(path) {
  const leaf = String(path ?? "").split(/[\\/]/).pop() ?? "";
  const dot = leaf.lastIndexOf(".");
  return dot < 0 ? "" : leaf.slice(dot).toLowerCase();
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return null;
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

function parseMetadata(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function stableId(metadata, fallback) {
  const candidate = metadata?.workshopid ?? metadata?.id ?? fallback;
  return String(candidate).slice(0, 160);
}

async function itemForDirectory(metadata, fallback, getFile) {
  const title = typeof metadata.title === "string" && metadata.title.trim()
    ? metadata.title.trim().slice(0, 160)
    : String(fallback).slice(0, 160);
  const projectType = typeof metadata.type === "string" ? metadata.type.toLowerCase() : "";
  const backgroundPath = safeRelativePath(metadata.file);
  const previewPath = safeRelativePath(metadata.preview);
  const backgroundExt = extensionOf(backgroundPath);
  const kind = projectType === "video" && VIDEO_EXTENSIONS.has(backgroundExt)
    ? "video"
    : projectType === "image" && IMAGE_EXTENSIONS.has(backgroundExt)
      ? "image"
      : "preview";
  const urls = new Map();
  const objectURL = async (key, relativePath, allowedExtensions) => {
    if (!relativePath || !allowedExtensions.has(extensionOf(relativePath))) return null;
    if (urls.has(key)) return urls.get(key);
    const file = await getFile(relativePath);
    if (!(file instanceof Blob)) return null;
    const url = URL.createObjectURL(file);
    urls.set(key, url);
    URLS.add(url);
    return url;
  };
  const item = {
    id: stableId(metadata, fallback),
    title,
    fileName: (backgroundPath || previewPath || title).split(/[\\/]/).pop(),
    type: projectType || "unknown",
    kind,
    live: false,
    createdAtMs: null,
    modifiedAtMs: null,
    sizeBytes: null,
    getPreview: () => objectURL("preview", previewPath, IMAGE_EXTENSIONS),
    getMedia: () => kind === "video"
      ? objectURL("media", backgroundPath, VIDEO_EXTENSIONS)
      : kind === "image"
        ? objectURL("media", backgroundPath, IMAGE_EXTENSIONS)
        : Promise.resolve(null),
  };
  const mainFile = backgroundPath ? await getFile(backgroundPath) : null;
  const packedScene = !mainFile && projectType === "scene" && !/\.pkg$/i.test(backgroundPath ?? "")
    ? await getFile("scene.pkg")
    : null;
  const file = mainFile ?? packedScene ?? (previewPath ? await getFile(previewPath) : null);
  if (file instanceof File) {
    item.modifiedAtMs = Number.isFinite(file.lastModified) ? file.lastModified : null;
    item.sizeBytes = file.size;
    item.fileName = file.name;
  }
  return item;
}

function newObjectURL(file) {
  const url = URL.createObjectURL(file);
  URLS.add(url);
  return url;
}

function projectTypeFromFile(file) {
  const ext = extensionOf(file.name);
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unknown";
}

export function fromFiles(inputFiles) {
  const files = Array.from(inputFiles ?? []).filter((file) => {
    return file instanceof Blob && (IMAGE_EXTENSIONS.has(extensionOf(file.name)) || VIDEO_EXTENSIONS.has(extensionOf(file.name)));
  });
  return files.map((file, index) => {
    const type = projectTypeFromFile(file);
    const kind = type === "video" ? "video" : "image";
    let mediaURL = null;
    const getMedia = async () => mediaURL ??= newObjectURL(file);
    const getPreview = async () => kind === "image" ? getMedia() : null;
    return {
      id: `local-${index}-${file.name}`,
      title: file.name.replace(/\.[^.]+$/, "").slice(0, 160),
      fileName: file.name,
      type,
      kind,
      createdAtMs: null,
      modifiedAtMs: Number.isFinite(file.lastModified) ? file.lastModified : null,
      sizeBytes: Number.isFinite(file.size) ? file.size : null,
      getPreview,
      getMedia,
    };
  });
}

export async function loadLocalLibrary() {
  try {
    const response = await fetch("/api/library", { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const value = await response.json();
    return Array.isArray(value?.items)
      ? { items: value.items.map(item => ({ ...item, live: item.live === true })), warnings: Array.isArray(value.warnings) ? value.warnings.filter(item => typeof item === 'string') : [] }
      : null;
  } catch {
    return null;
  }
}

function relativeFilesMap(files) {
  const map = new Map();
  for (const file of files) {
    const path = file.webkitRelativePath;
    if (typeof path === "string" && path.includes("/")) map.set(path.replace(/\\/g, "/"), file);
  }
  return map;
}

function fileFromMap(map, projectPrefix, relativePath) {
  const clean = safeRelativePath(relativePath);
  if (!clean) return null;
  return map.get(`${projectPrefix}${clean}`) ?? null;
}

async function scanFileMap(files, onProgress) {
  const fileMap = relativeFilesMap(files);
  const projects = [];
  const folders = new Map();
  const rootProjects = [];
  for (const path of fileMap.keys()) {
    if (!path.toLowerCase().endsWith("/project.json")) continue;
    const slash = path.lastIndexOf("/");
    const prefix = path.slice(0, slash + 1);
    if (prefix.split("/").filter(Boolean).length === 1) {
      rootProjects.push({ prefix, file: fileMap.get(path), name: prefix.split("/").filter(Boolean).pop() });
      continue;
    }
    folders.set(prefix, fileMap.get(path));
  }
  for (const entry of rootProjects) {
    try {
      const metadata = parseMetadata(await entry.file.text());
      if (metadata) projects.push(await itemForDirectory(metadata, entry.name, (relative) => {
        return Promise.resolve(fileFromMap(fileMap, entry.prefix, relative));
      }));
    } catch { /* unreadable metadata is skipped */ }
  }

  const work = Array.from(folders.entries());
  let finished = 0;
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const [prefix, metadataFile] = work[next++];
      try {
        const metadata = parseMetadata(await metadataFile.text());
        if (metadata) {
          projects.push(await itemForDirectory(metadata, prefix.split("/").filter(Boolean).pop(), (relative) => {
            return Promise.resolve(fileFromMap(fileMap, prefix, relative));
          }));
        }
      } catch {
        // An unreadable project's metadata does not prevent the other projects from loading.
      }
      finished += 1;
      if (finished % 50 === 0) onProgress?.(finished);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, work.length) }, worker));
  onProgress?.(finished);
  return projects;
}

async function readHandleFile(directory, relativePath) {
  const clean = safeRelativePath(relativePath);
  if (!clean) return null;
  let current = directory;
  const pieces = clean.split("/");
  try {
    for (const piece of pieces.slice(0, -1)) current = await current.getDirectoryHandle(piece);
    return await current.getFileHandle(pieces.at(-1));
  } catch {
    return null;
  }
}

async function itemFromHandle(directory, folderName) {
  let metadataHandle;
  try {
    metadataHandle = await directory.getFileHandle("project.json");
  } catch {
    return null;
  }
  try {
    const metadata = parseMetadata(await (await metadataHandle.getFile()).text());
    if (!metadata) return null;
    return await itemForDirectory(metadata, folderName, async (relativePath) => {
      const handle = await readHandleFile(directory, relativePath);
      if (!handle) return null;
      try { return await handle.getFile(); } catch { return null; }
    });
  } catch {
    return null;
  }
}

async function scanDirectory(root, onProgress) {
  const folders = [];
  try {
    const rootProject = await itemFromHandle(root, root.name || "Wallpaper");
    if (rootProject) folders.push({ handle: null, item: rootProject });
  } catch { /* the selected root can be a library containing project folders */ }

  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "directory" && !name.startsWith(".")) folders.push({ handle, name });
  }
  let finished = 0;
  let next = 0;
  const items = [];
  const worker = async () => {
    while (next < folders.length) {
      const entry = folders[next++];
      if (entry.item) items.push(entry.item);
      else {
        const item = await itemFromHandle(entry.handle, entry.name);
        if (item) items.push(item);
      }
      finished += 1;
      if (finished % 50 === 0) onProgress?.(finished);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, folders.length) }, worker));
  onProgress?.(finished);
  return items;
}

function openHandleDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rememberRoot(root) {
  let db;
  try {
    db = await openHandleDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).put(root, ROOT_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Browsers may decline to store file-system handles; selection still works for this session.
  } finally {
    db?.close();
  }
}

async function rememberedRoot() {
  let db;
  try {
    db = await openHandleDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(ROOT_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function restoreDirectory(onProgress) {
  const root = await rememberedRoot();
  if (!root || typeof root.queryPermission !== "function") return null;
  try {
    if (await root.queryPermission({ mode: "read" }) !== "granted") return null;
    directoryScan = await scanDirectory(root, onProgress);
    return directoryScan;
  } catch {
    return null;
  }
}

function selectDirectoryInput(onProgress) {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.style.position = "fixed";
    input.style.left = "-10000px";
    let settled = false;
    let pickerBlurred = false;
    let focusTimer = null;
    let timeout = null;
    const rejectCancelled = () => {
      if (settled) return;
      settled = true;
      clean();
      reject(new DOMException("Directory selection was cancelled.", "AbortError"));
    };
    const onWindowBlur = () => { pickerBlurred = true; };
    const onWindowFocus = () => {
      if (!pickerBlurred || settled) return;
      globalThis.clearTimeout(focusTimer);
      focusTimer = globalThis.setTimeout(() => {
        if (!settled && !(input.files?.length)) rejectCancelled();
      }, 500);
    };
    const clean = () => {
      input.remove();
      globalThis.clearTimeout(focusTimer);
      globalThis.clearTimeout(timeout);
      globalThis.removeEventListener("blur", onWindowBlur);
      globalThis.removeEventListener("focus", onWindowFocus);
    };
    globalThis.addEventListener("blur", onWindowBlur);
    globalThis.addEventListener("focus", onWindowFocus);
    input.addEventListener("change", async () => {
      settled = true;
      const files = Array.from(input.files ?? []);
      clean();
      try { resolve(await scanFileMap(files, onProgress)); } catch (error) { reject(error); }
    }, { once: true });
    input.addEventListener("cancel", () => {
      rejectCancelled();
    }, { once: true });
    document.body.append(input);
    input.click();
    // Older browsers may omit `cancel` and focus events, so eventually release the pending picker.
    timeout = globalThis.setTimeout(rejectCancelled, 60000);
  });
}

export async function pickDirectory(onProgress) {
  if (globalThis.showDirectoryPicker) {
    try {
      const root = await globalThis.showDirectoryPicker({ mode: "read" });
      await rememberRoot(root);
      directoryScan = await scanDirectory(root, onProgress);
      return directoryScan;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (!new Set(["SecurityError", "NotAllowedError"]).has(error?.name)) throw error;
    }
  }
  return selectDirectoryInput(onProgress);
}

export function cleanupLibrary(items = []) {
  for (const url of URLS) URL.revokeObjectURL(url);
  URLS.clear();
  for (const item of items) {
    if (item && typeof item.release === "function") item.release();
  }
}
