import { getItem, setItem, LOCAL_STORAGE_KEYS } from "../utils/localStorage";
import { webLlmService } from "./webllmService";

export type RunnerProvider = "ollama" | "webllm";

export interface LlmRunnerConfig {
  provider: RunnerProvider;
  modelName: string;
  cacheEnabled: boolean;
}

export interface LlmRunnerModel {
  name: string;
  provider: RunnerProvider;
  description?: string;
}

export interface RunnerGenerateParams {
  prompt: string;
  system?: string;
  format?: "json";
  modelName?: string;
}

export interface RunnerStats {
  latencyMs: number;
  cached: boolean;
  provider: RunnerProvider;
  modelName: string;
}

export interface RunnerGenerateResult {
  success: boolean;
  data?: { response: string };
  error?: string;
  stats?: RunnerStats;
}

export interface RunnerTestResult {
  success: boolean;
  error?: string;
}

export interface RunnerModelsResult {
  success: boolean;
  models?: LlmRunnerModel[];
  error?: string;
}

interface RunnerCacheEntry {
  key: string;
  response: string;
  provider: RunnerProvider;
  modelName: string;
  createdAt: number;
}

interface OllamaApi {
  getModels: () => Promise<{
    success: boolean;
    data?: { models?: Array<{ name: string }> };
    error?: string;
  }>;
  generate: (params: {
    model: string;
    prompt: string;
    system?: string;
    format?: "json";
    stream?: boolean;
  }) => Promise<{
    success: boolean;
    data?: { response?: string };
    error?: string;
  }>;
  testConnection: () => Promise<RunnerTestResult>;
}

const getOllamaApi = (): OllamaApi | null => {
  const maybeOllama = (window as unknown as { ollama?: unknown }).ollama;
  if (!maybeOllama || typeof maybeOllama !== "object") {
    return null;
  }
  return maybeOllama as OllamaApi;
};

const CACHE_LIMIT = 25;
const DEFAULT_WEBLLM_MODEL = "Qwen2.5-0.5B-Instruct-q4f32_1-MLC";
const VALID_PROVIDERS: RunnerProvider[] = ["webllm", "ollama"];

class LlmRunnerService {
  private config: LlmRunnerConfig;

  constructor() {
    this.config = this.getConfig();
  }

  getConfig(): LlmRunnerConfig {
    const saved = getItem<LlmRunnerConfig>(
      LOCAL_STORAGE_KEYS.LLM_RUNNER_CONFIG,
    );
    if (!saved) {
      return {
        provider: "webllm",
        modelName: DEFAULT_WEBLLM_MODEL,
        cacheEnabled: true,
      };
    }

    const provider = VALID_PROVIDERS.includes(saved.provider)
      ? saved.provider
      : "webllm";
    const modelName =
      typeof saved.modelName === "string" && saved.modelName.trim()
        ? saved.modelName
        : DEFAULT_WEBLLM_MODEL;

    return {
      provider,
      modelName,
      cacheEnabled: Boolean(saved.cacheEnabled),
    };
  }

  setConfig(next: Partial<LlmRunnerConfig>) {
    this.config = { ...this.config, ...next };
    setItem(LOCAL_STORAGE_KEYS.LLM_RUNNER_CONFIG, this.config);
  }

  async testConnection(
    provider = this.config.provider,
  ): Promise<RunnerTestResult> {
    if (provider === "webllm") {
      return webLlmService.checkRuntime();
    }

    const ollama = getOllamaApi();
    if (!ollama) {
      return { success: false, error: "EXTENSION_NOT_FOUND" };
    }

    return ollama.testConnection();
  }

  async fetchModels(
    provider = this.config.provider,
  ): Promise<RunnerModelsResult> {
    if (provider === "webllm") {
      const runtime = await webLlmService.checkRuntime();
      if (!runtime.success) {
        return { success: false, error: runtime.error };
      }
      const models = await webLlmService.listModels();
      return {
        success: true,
        models: models.map((model) => ({
          name: model.id,
          provider: "webllm" as const,
          description: model.description,
        })),
      };
    }

    const ollama = getOllamaApi();
    if (!ollama) {
      return { success: false, error: "EXTENSION_NOT_FOUND" };
    }

    const response = await ollama.getModels();
    const models = (response.data?.models || []).map(
      (model: { name: string }) => ({
        name: model.name,
        provider: "ollama" as const,
      }),
    );
    return { success: response.success, models, error: response.error };
  }

  async generate(params: RunnerGenerateParams): Promise<RunnerGenerateResult> {
    const startedAt = performance.now();
    const provider = this.config.provider;
    const modelName = params.modelName || this.config.modelName;
    const cacheKey = this.createCacheKey(
      provider,
      modelName,
      params.prompt,
      params.system,
    );

    if (this.config.cacheEnabled) {
      const cached = this.getCachedResponse(cacheKey);
      if (cached) {
        return {
          success: true,
          data: { response: cached.response },
          stats: {
            latencyMs: Math.round(performance.now() - startedAt),
            cached: true,
            provider,
            modelName,
          },
        };
      }
    }

    let responseText = "";
    if (provider === "webllm") {
      const result = await webLlmService.generate(modelName, {
        prompt: params.prompt,
        system: params.system,
      });
      if (!result.success || !result.response) {
        return {
          success: false,
          error: result.error || "WEBLLM_GENERATION_FAILED",
        };
      }
      responseText = result.response;
    } else {
      const ollama = getOllamaApi();
      if (!ollama) {
        return { success: false, error: "EXTENSION_NOT_FOUND" };
      }
      try {
        const result = await ollama.generate({
          model: modelName,
          prompt: params.prompt,
          system: params.system,
          format: params.format,
          stream: false,
        });
        if (!result.success || !result.data?.response) {
          return { success: false, error: result.error || "Generation failed" };
        }
        responseText = result.data.response;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Generation failed";
        return { success: false, error: message };
      }
    }

    if (this.config.cacheEnabled) {
      this.writeCacheEntry({
        key: cacheKey,
        response: responseText,
        provider,
        modelName,
        createdAt: Date.now(),
      });
    }

    return {
      success: true,
      data: { response: responseText },
      stats: {
        latencyMs: Math.round(performance.now() - startedAt),
        cached: false,
        provider,
        modelName,
      },
    };
  }

  private createCacheKey(
    provider: RunnerProvider,
    modelName: string,
    prompt: string,
    system?: string,
  ) {
    return `${provider}::${modelName}::${(
      system || ""
    ).trim()}::${prompt.trim()}`;
  }

  private getCache(): RunnerCacheEntry[] {
    return (
      getItem<RunnerCacheEntry[]>(LOCAL_STORAGE_KEYS.LLM_RUNNER_CACHE) || []
    );
  }

  private getCachedResponse(key: string): RunnerCacheEntry | null {
    const cache = this.getCache();
    return cache.find((entry) => entry.key === key) || null;
  }

  private writeCacheEntry(entry: RunnerCacheEntry) {
    const cache = this.getCache();
    const deduplicated = cache.filter((item) => item.key !== entry.key);
    const next = [entry, ...deduplicated].slice(0, CACHE_LIMIT);
    setItem(LOCAL_STORAGE_KEYS.LLM_RUNNER_CACHE, next);
  }
}

export const llmRunnerService = new LlmRunnerService();
