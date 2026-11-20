/**
 * Loads MediaPipe's scripts and model/wasm files from the Python side of the
 * widget.
 *
 * Python downloads each file from a CDN the first time it's needed and keeps
 * it in a local cache, then sends it to the browser over the widget's
 * custom-message channel (which works in any anywidget host: Jupyter, marimo,
 * Shiny). Once cached, the widget works offline. We turn each file into a
 * blob URL before MediaPipe starts, so `locateFile` can stay synchronous.
 */

const REQUEST = "handwave:get_asset";
const RESPONSE = "handwave:asset";

const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".wasm": "application/wasm",
};

interface CustomMessage {
  type?: string;
  name?: string;
  error?: string;
}

export interface AssetModel {
  send(content: any, callbacks?: any, buffers?: ArrayBuffer[]): void;
  on(
    event: "msg:custom",
    callback: (msg: CustomMessage, buffers: DataView<ArrayBuffer>[]) => void
  ): void;
  off(event: "msg:custom", callback?: Function): void;
}

// Blob URLs are page-global, so share them across widget instances.
const cache = new Map<string, string>();

function mimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf("."));
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function requestAsset(model: AssetModel, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const handler = (msg: CustomMessage, buffers: DataView<ArrayBuffer>[]) => {
      if (msg?.type !== RESPONSE || msg.name !== name) return;
      model.off("msg:custom", handler);
      if (msg.error || !buffers?.length) {
        reject(new Error(msg.error ?? `handwave: failed to load ${name}`));
        return;
      }
      const blob = new Blob(buffers, { type: mimeType(name) });
      resolve(URL.createObjectURL(blob));
    };
    model.on("msg:custom", handler);
    model.send({ type: REQUEST, name });
  });
}

async function getAsset(model: AssetModel, name: string): Promise<string> {
  // Only finished downloads are shared. An in-flight request belongs to the
  // model that sent it, and never settles if that model is torn down (e.g.
  // its cell is re-run), so other widgets must not wait on it.
  let url = cache.get(name);
  if (!url) {
    url = await requestAsset(model, name);
    // Another widget may have finished the same file meanwhile.
    if (cache.has(name)) {
      URL.revokeObjectURL(url);
      url = cache.get(name)!;
    } else {
      cache.set(name, url);
    }
  }
  return url;
}

// Script execution always settles (onload/onerror), so these promises are
// safe to share; this keeps each script from running more than once.
const scripts = new Map<string, Promise<void>>();

function runScript(name: string, url: string): Promise<void> {
  let loaded = scripts.get(name);
  if (!loaded) {
    loaded = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error(`handwave: failed to run ${name}`));
      document.head.appendChild(script);
    });
    loaded.catch(() => scripts.delete(name));
    scripts.set(name, loaded);
  }
  return loaded;
}

/**
 * Runs one of MediaPipe's classic (non-module) scripts, which define their
 * API as globals on `window`.
 */
export async function loadScript(
  model: AssetModel,
  name: string
): Promise<void> {
  const loaded = scripts.get(name);
  if (loaded) return loaded;
  return runScript(name, await getAsset(model, name));
}

// Same probe MediaPipe Hands uses to choose between its SIMD and non-SIMD
// wasm builds; we must fetch the same variant it will ask for.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0,
  65, 0, 253, 15, 26, 11,
]);

async function supportsSimd(): Promise<boolean> {
  try {
    await WebAssembly.instantiate(SIMD_PROBE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches every file MediaPipe Hands will request for the given model
 * complexity and returns a `locateFile` function that maps each file name to
 * its blob URL.
 */
export async function loadHandsAssets(
  model: AssetModel,
  modelComplexity: number
): Promise<(file: string) => string> {
  const wasmBase = (await supportsSimd())
    ? "hands_solution_simd_wasm_bin"
    : "hands_solution_wasm_bin";
  const names = [
    "hands.binarypb",
    "hands_solution_packed_assets_loader.js",
    "hands_solution_packed_assets.data",
    `${wasmBase}.js`,
    `${wasmBase}.wasm`,
    modelComplexity === 1
      ? "hand_landmark_full.tflite"
      : "hand_landmark_lite.tflite",
  ];
  const urls = await Promise.all(names.map((name) => getAsset(model, name)));
  const lookup = new Map(names.map((name, i) => [name, urls[i]]));

  return (file: string) => {
    const url = lookup.get(file);
    if (!url) {
      console.warn(`handwave: MediaPipe requested unexpected file ${file}`);
      return file;
    }
    return url;
  };
}
