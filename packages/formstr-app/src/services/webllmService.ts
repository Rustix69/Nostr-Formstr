export interface WebLlmModelOption {
  id: string;
  label: string;
  description: string;
}

export interface WebLlmGenerateParams {
  prompt: string;
  system?: string;
}

export interface WebLlmGenerateResult {
  success: boolean;
  response?: string;
  error?: string;
}

export interface WebLlmHealthResult {
  success: boolean;
  error?: string;
}

type WebLlmRole = "system" | "user";

interface WebLlmMessage {
  role: WebLlmRole;
  content: string;
}

interface WebLlmCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface WebLlmEngine {
  reload: (modelId: string | string[]) => Promise<void>;
  chat: {
    completions: {
      create: (params: {
        model?: string;
        messages: WebLlmMessage[];
        temperature?: number;
      }) => Promise<WebLlmCompletionResponse>;
    };
  };
}

interface WebLlmModuleLike {
  CreateMLCEngine?: (
    modelId: string,
    options?: { initProgressCallback?: (info: unknown) => void },
  ) => Promise<WebLlmEngine>;
  createMLCEngine?: (
    modelId: string,
    options?: { initProgressCallback?: (info: unknown) => void },
  ) => Promise<WebLlmEngine>;
  prebuiltAppConfig?: {
    model_list?: Array<{ model_id?: string }>;
  };
}

interface WebGpuAdapterLike {
  features: {
    has: (featureName: string) => boolean;
  };
}

interface WebGpuLike {
  requestAdapter: (options?: {
    powerPreference?: "high-performance" | "low-power";
  }) => Promise<WebGpuAdapterLike | null>;
}

const PREFERRED_MODEL_OPTIONS: WebLlmModelOption[] = [
  {
    id: "Phi-3.5-mini-instruct-q4f16_1-MLC-1k",
    label: "Phi-3.5-mini (q4f16_1, 1k)",
    description: "Primary quality model when shader-f16 is supported.",
  },
  {
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5-0.5B (q4f16_1)",
    description: "Low-memory fallback when shader-f16 is supported.",
  },
];

const COMPATIBLE_MODEL_OPTIONS: WebLlmModelOption[] = [
  {
    id: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC",
    label: "Qwen2.5-0.5B (q4f32_1)",
    description: "Most compatible starter model for mixed GPU support.",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
    label: "Llama-3.2-1B (q4f32_1)",
    description: "Fallback model that avoids shader-f16 dependency.",
  },
];

class WebLlmService {
  private modulePromise: Promise<WebLlmModuleLike> | null = null;

  private engine: WebLlmEngine | null = null;

  private loadedModelId: string | null = null;

  async checkRuntime(): Promise<WebLlmHealthResult> {
    if (typeof window === "undefined") {
      return { success: false, error: "BROWSER_ENV_REQUIRED" };
    }
    const navigatorWithGpu = navigator as Navigator & { gpu?: WebGpuLike };
    if (!navigatorWithGpu.gpu) {
      return { success: false, error: "WEBGPU_NOT_AVAILABLE" };
    }
    try {
      await this.getModule();
      const adapter = await this.requestAdapterWithFallback();
      if (!adapter) {
        return { success: false, error: "WEBGPU_ADAPTER_NOT_FOUND" };
      }
      return { success: true };
    } catch {
      return { success: false, error: "WEBLLM_IMPORT_FAILED" };
    }
  }

  async listModels(): Promise<WebLlmModelOption[]> {
    const shaderF16Supported = await this.supportsShaderF16();
    const preferredBaseOptions = shaderF16Supported
      ? PREFERRED_MODEL_OPTIONS
      : COMPATIBLE_MODEL_OPTIONS;

    try {
      const module = await this.getModule();
      const modelIds =
        module.prebuiltAppConfig?.model_list
          ?.map((item) => item.model_id)
          .filter((id): id is string => typeof id === "string") || [];
      if (!modelIds.length) {
        return preferredBaseOptions;
      }

      const preferred = preferredBaseOptions.filter((candidate) =>
        modelIds.includes(candidate.id),
      );

      if (preferred.length >= 2) {
        return preferred;
      }

      const discovered = modelIds.slice(0, 2).map((id) => ({
        id,
        label: id,
        description: "Available from WebLLM model catalog.",
      }));

      return preferred.length ? [...preferred, ...discovered] : discovered;
    } catch {
      return preferredBaseOptions;
    }
  }

  async generate(
    modelId: string,
    params: WebLlmGenerateParams,
  ): Promise<WebLlmGenerateResult> {
    const messages: WebLlmMessage[] = [];
    if (params.system) {
      messages.push({ role: "system", content: params.system });
    }
    messages.push({ role: "user", content: params.prompt });

    try {
      const engine = await this.getEngine(modelId);

      const completion = await engine.chat.completions.create({
        model: modelId,
        messages,
        temperature: 0.2,
      });
      return this.normalizeCompletion(completion);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes("Model not loaded before trying to complete")
      ) {
        try {
          if (!this.engine) {
            return { success: false, error: error.message };
          }
          await this.engine.reload(modelId);
          this.loadedModelId = modelId;
          const retried = await this.engine.chat.completions.create({
            model: modelId,
            messages,
            temperature: 0.2,
          });
          return this.normalizeCompletion(retried);
        } catch (retryError: unknown) {
          const retryMessage =
            retryError instanceof Error
              ? retryError.message
              : "WEBLLM_GENERATION_FAILED";
          return { success: false, error: retryMessage };
        }
      }
      const errorMessage =
        error instanceof Error ? error.message : "WEBLLM_GENERATION_FAILED";
      return { success: false, error: errorMessage };
    }
  }

  private async getEngine(modelId: string): Promise<WebLlmEngine> {
    if (!this.engine) {
      const module = await this.getModule();
      const createEngine = module.CreateMLCEngine || module.createMLCEngine;
      if (!createEngine) {
        throw new Error("WEBLLM_ENGINE_FACTORY_MISSING");
      }
      this.engine = await createEngine(modelId);
      this.loadedModelId = modelId;
      return this.engine;
    }

    if (this.loadedModelId !== modelId) {
      await this.engine.reload(modelId);
      this.loadedModelId = modelId;
    }

    return this.engine;
  }

  private async getModule(): Promise<WebLlmModuleLike> {
    if (!this.modulePromise) {
      this.modulePromise = import(
        "@mlc-ai/web-llm"
      ) as Promise<WebLlmModuleLike>;
    }
    return this.modulePromise;
  }

  private async supportsShaderF16(): Promise<boolean> {
    const adapter = await this.requestAdapterWithFallback();
    if (!adapter?.features) {
      return false;
    }
    return adapter.features.has("shader-f16");
  }

  private async requestAdapterWithFallback(): Promise<WebGpuAdapterLike | null> {
    const navigatorWithGpu = navigator as Navigator & { gpu?: WebGpuLike };
    if (!navigatorWithGpu.gpu) {
      return null;
    }

    const highPerfAdapter = await navigatorWithGpu.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (highPerfAdapter) {
      return highPerfAdapter;
    }

    return navigatorWithGpu.gpu.requestAdapter({
      powerPreference: "low-power",
    });
  }

  private normalizeCompletion(
    completion: WebLlmCompletionResponse,
  ): WebLlmGenerateResult {
    const content = completion.choices?.[0]?.message?.content;

    if (typeof content === "string" && content.trim()) {
      return { success: true, response: content };
    }

    if (Array.isArray(content)) {
      const joined = content
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (joined) {
        return { success: true, response: joined };
      }
    }

    return { success: false, error: "WEBLLM_EMPTY_RESPONSE" };
  }
}

export const webLlmService = new WebLlmService();
