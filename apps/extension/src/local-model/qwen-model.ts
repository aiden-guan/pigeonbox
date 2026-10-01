import {
  getLocalModel,
  localModelBytes,
  localModelDtypes,
  type ChatExample,
  type LocalDtype,
  type LocalModel,
  type PromptOptions,
} from '@pigeonbox/ai';
import { cachedModelDtype, deleteCachedModel } from './cache';
import { modelFileStore } from './model-store';
import { createScheduler } from './scheduler';

type ProgressInfo = {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
};

type ChatTurn = { role: string; content?: string };

type Generator = {
  (
    messages: ChatTurn[],
    options: {
      max_new_tokens: number;
      do_sample: boolean;
      repetition_penalty?: number;
      tokenizer_encode_kwargs?: { enable_thinking: boolean };
    },
  ): Promise<Array<{ generated_text?: string | ChatTurn[] }>>;
  dispose: () => Promise<void>;
};

type GpuAdapter = { features?: { has(name: string): boolean } };

const DEFAULT_MAX_TOKENS = 256;

let configured = false;
const schedule = createScheduler();
let activeGenerator: Generator | null = null;
let activeModelId: string | null = null;

/** True only after this offscreen document has loaded and kept the model generator alive. */
export function isQwenModelReady(modelId: string): boolean {
  return Boolean(activeGenerator && activeModelId === modelId);
}

export function downloadQwenModel(modelId: string, onProgress: (fraction: number) => void): Promise<void> {
  return schedule('system', () => downloadModel(modelId, onProgress));
}

export function promptWithQwen(modelId: string, system: string, user: string, options?: PromptOptions): Promise<string> {
  return schedule(options?.priority ?? 'interactive', () => generate(modelId, system, user, options));
}

/** Load the model and compile its GPU shaders ahead of the first real prompt. */
export function warmQwen(modelId: string): Promise<void> {
  return schedule('background', async () => {
    const model = requireModel(modelId);
    if (activeGenerator && activeModelId === model.id) return;
    const dtype = await cachedModelDtype(model);
    if (!dtype) return;
    const generator = await loadedGenerator(model, dtype);
    await generator(chatMessages(model, 'Answer briefly.', 'Hi'), generationOptions(model, 1));
  });
}

export function releaseQwen(): Promise<void> {
  return schedule('system', releaseActive);
}

async function releaseActive(): Promise<void> {
  const generator = activeGenerator;
  activeGenerator = null;
  activeModelId = null;
  await generator?.dispose().catch(() => undefined);
}

async function downloadModel(modelId: string, onProgress: (fraction: number) => void): Promise<void> {
  const model = requireModel(modelId);
  const adapter = await requireAdapter();
  const cached = await cachedModelDtype(model);
  // Reuse whatever build is already on disk; otherwise take the faster q4f16 build when the GPU supports it.
  const candidates = cached ? [cached] : localModelDtypes(model, Boolean(adapter.features?.has('shader-f16')));
  let lastError: unknown = null;
  for (const dtype of candidates) {
    try {
      await downloadBuild(model, dtype, onProgress);
      onProgress(1);
      return;
    } catch (error) {
      lastError = error;
      await releaseActive();
      // A q4f16 build that cannot run here must not be picked up again on the next load.
      if (dtype !== model.dtype) await deleteCachedModel(model, dtype).catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not download the model.');
}

async function downloadBuild(model: LocalModel, dtype: LocalDtype, onProgress: (fraction: number) => void): Promise<void> {
  // Some models split weights into model_<dtype>.onnx and model_<dtype>.onnx_data; track both against the catalog size.
  const loadedByFile = new Map<string, number>();
  const total = localModelBytes(model, dtype);
  const generator = await loadedGenerator(model, dtype, (info: ProgressInfo) => {
    if (!info.file?.includes(`model_${dtype}.onnx`)) return;
    if (info.status === 'progress' && info.total) {
      loadedByFile.set(info.file, info.loaded ?? 0);
      const loaded = [...loadedByFile.values()].reduce((sum, value) => sum + value, 0);
      onProgress(clamp(loaded / total) * 0.95);
    }
  });
  onProgress(0.95);
  // A cached weight file alone does not establish that ONNX can load and run it.
  const check = await generator(chatMessages(model, 'Answer briefly.', 'Say ready.'), generationOptions(model, 12));
  if (!stripThinking(textFromGeneration(check))) {
    throw new Error('The downloaded model could not generate text. Try removing and downloading it again.');
  }
  // transformers.js ignores failed cache writes. Without the files on disk the model would download again on every load.
  if ((await cachedModelDtype(model)) !== dtype) {
    throw new Error('Chrome could not save the model files. Free up disk space and try again.');
  }
}

async function generate(modelId: string, system: string, user: string, options?: PromptOptions): Promise<string> {
  const model = requireModel(modelId);
  let generator = activeModelId === model.id ? activeGenerator : null;
  if (!generator) {
    const dtype = await cachedModelDtype(model);
    if (!dtype) throw new Error('Download this model in Settings.');
    generator = await loadedGenerator(model, dtype);
  }
  let output: Awaited<ReturnType<Generator>>;
  try {
    output = await generator(chatMessages(model, system, user, options?.examples), {
      ...generationOptions(model, options?.maxTokens ?? DEFAULT_MAX_TOKENS),
      ...(options?.repetitionPenalty ? { repetition_penalty: options.repetitionPenalty } : {}),
    });
  } catch (error) {
    // A failed run can leave the WebGPU session unusable (device lost, out of memory). Reload on the next prompt.
    await releaseActive();
    throw error;
  }
  const text = stripThinking(textFromGeneration(output));
  if (!text) throw new Error('On-device model returned an empty response.');
  return text;
}

function generationOptions(model: LocalModel, maxTokens: number) {
  return {
    max_new_tokens: maxTokens,
    do_sample: false,
    tokenizer_encode_kwargs: model.id === 'qwen3-0.6b' ? { enable_thinking: false } : undefined,
  };
}

async function loadedGenerator(
  model: LocalModel,
  dtype: LocalDtype,
  onProgress?: (info: ProgressInfo) => void,
): Promise<Generator> {
  if (activeGenerator && activeModelId === model.id) return activeGenerator;
  await releaseActive();
  await requireAdapter();
  await configureRuntime();
  const { pipeline } = await import('@huggingface/transformers');
  const generator = (await pipeline('text-generation', model.repo, {
    dtype,
    device: 'webgpu',
    progress_callback: onProgress,
  })) as unknown as Generator;
  activeGenerator = generator;
  activeModelId = model.id;
  return generator;
}

async function requireAdapter(): Promise<GpuAdapter> {
  const gpu = typeof navigator !== 'undefined'
    ? (navigator as Navigator & {
        gpu?: { requestAdapter(options?: { powerPreference?: 'high-performance' }): Promise<GpuAdapter | null> };
      }).gpu
    : undefined;
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new Error('This local model needs WebGPU. Enable WebGPU in Chrome or choose another AI provider.');
  }
  return adapter;
}

function chatMessages(model: LocalModel, system: string, user: string, examples: ChatExample[] = []): ChatTurn[] {
  const noThink = (text: string) => (model.id === 'qwen3-0.6b' ? `${text}\n/no_think` : text);
  return [
    { role: 'system', content: system },
    ...examples.flatMap((example) => [
      { role: 'user', content: noThink(example.user) },
      { role: 'assistant', content: example.assistant },
    ]),
    { role: 'user', content: noThink(user) },
  ];
}

async function configureRuntime(): Promise<void> {
  if (configured) return;
  const { env } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  env.useCustomCache = true;
  env.customCache = modelFileStore;
  env.useWasmCache = false;
  // Speed matters more than battery here: on laptops with two GPUs this picks the faster one.
  if (env.backends.onnx.webgpu) env.backends.onnx.webgpu.powerPreference = 'high-performance';
  const wasm = wasmConfig(env.backends.onnx);
  if (wasm) {
    wasm.numThreads = 1;
    wasm.proxy = false;
    wasm.wasmPaths = {
      mjs: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.asyncify.mjs'),
      wasm: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.asyncify.wasm'),
    };
  }
  configured = true;
}

function wasmConfig(onnx: unknown): { numThreads?: number; proxy?: boolean; wasmPaths?: unknown } | null {
  if (!onnx || typeof onnx !== 'object' || !('wasm' in onnx)) return null;
  const wasm = (onnx as { wasm?: unknown }).wasm;
  return wasm && typeof wasm === 'object' ? (wasm as { numThreads?: number; proxy?: boolean; wasmPaths?: unknown }) : null;
}

function textFromGeneration(output: Array<{ generated_text?: string | ChatTurn[] }>): string {
  const generated = output[0]?.generated_text;
  if (typeof generated === 'string') return generated.trim();
  if (!Array.isArray(generated)) return '';
  const last = generated[generated.length - 1];
  return typeof last?.content === 'string' ? last.content.trim() : '';
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/gi, '').trim();
}

function requireModel(modelId: string): LocalModel {
  const model = getLocalModel(modelId);
  if (!model) throw new Error('That model is not available.');
  return model;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
