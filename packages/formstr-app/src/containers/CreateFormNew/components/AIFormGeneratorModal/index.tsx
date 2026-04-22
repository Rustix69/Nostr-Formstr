import React, { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Divider,
  message,
  Button,
  Typography,
  Select,
  Switch,
  Alert,
} from "antd";
import {
  llmRunnerService,
  LlmRunnerModel,
  LlmRunnerConfig,
  RunnerProvider,
} from "../../../../services/llmRunnerService";
import { processOllamaFormData, OllamaFormData } from "./aiProcessor";
import { AIFormGeneratorModalProps } from "./types";
import OllamaSettings from "../../../../components/OllamaSettings";
import ModelSelector from "../../../../components/ModelSelector";
import GenerationPanel from "./GenerationPanel";
import "./styles.css";

const FORM_GENERATION_SYSTEM_PROMPT = `You are an expert JSON generator. Based on the user's request, create a form structure.
Here is the required JSON schema for the form:
{
    "type": "object",
    "properties": {
        "title": { "type": "string" },
        "description": { "type": "string" },
        "fields": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": { "type": "string", "enum": ["ShortText", "LongText", "Email", "Number", "MultipleChoice", "SingleChoice", "Checkbox", "Dropdown", "Date", "Time", "Label"] },
                    "label": { "type": "string" },
                    "required": { "type": "boolean" },
                    "options": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["type", "label"]
            }
        }
    },
    "required": ["title", "fields"]
}
CRITICAL RULES:
- Your response MUST be ONLY the JSON object that validates against the schema above.
- Do NOT include any extra text, explanations, or markdown formatting like \`\`\`json.

For Example for output with one field:
"{
  "title": "Appropriate Form Title",
  "description": "Appropriate Form Description",
  "fields": [
    {
      "type": "ShortText",
      "label": "Name",
      "required": true
    }
  ]
}"
`;

const AIFormGeneratorModal: React.FC<AIFormGeneratorModalProps> = ({
  isOpen,
  onClose,
  onFormGenerated,
}) => {
  const [prompt, setPrompt] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<boolean | null>(
    null,
  );
  const [availableModels, setAvailableModels] = useState<LlmRunnerModel[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [statsLabel, setStatsLabel] = useState<string>("");
  const [runnerStatus, setRunnerStatus] = useState<{
    type: "info" | "success" | "error";
    text: string;
  }>({
    type: "info",
    text: "Select a provider and check runner readiness.",
  });
  const [config, setConfig] = useState<LlmRunnerConfig>(
    llmRunnerService.getConfig(),
  );

  const fetchModels = useCallback(async () => {
    setFetchingModels(true);
    const result = await llmRunnerService.fetchModels(config.provider);
    if (result.success && result.models) {
      setAvailableModels(result.models);
      if (
        !result.models.some((m) => m.name === config.modelName) &&
        result.models[0]
      ) {
        const fallbackModel = result.models[0].name;
        const updatedConfig = { ...config, modelName: fallbackModel };
        setConfig(updatedConfig);
        llmRunnerService.setConfig({ modelName: fallbackModel });
      }
    } else {
      setAvailableModels([]);
    }
    setFetchingModels(false);
  }, [config]);

  const testConnection = useCallback(async () => {
    setLoading(true);
    setRunnerStatus({
      type: "info",
      text: "Checking runtime and fetching available models...",
    });
    const result = await llmRunnerService.testConnection(config.provider);
    setLoading(false);
    if (result.success) {
      message.success("Runner is ready!");
      setConnectionStatus(true);
      setRunnerStatus({
        type: "success",
        text: "Runner is ready. You can now generate a form.",
      });
      fetchModels();
    } else {
      setConnectionStatus(false);
      setRunnerStatus({
        type: "error",
        text: getRunnerErrorMessage(result.error, config.provider),
      });
      if (result.error === "EXTENSION_NOT_FOUND") {
        message.error(
          <>
            Ollama Web Companion extension not found. Please install it to use
            the Ollama provider.
            <Button
              type="link"
              href="https://github.com/ashu01304/Ollama_Web"
              target="_blank"
            >
              Get Extension
            </Button>
          </>,
          10,
        );
      } else {
        message.error(`Runner failed: ${result.error ?? "Unknown error"}`);
      }
    }
  }, [config.provider, fetchModels]);

  useEffect(() => {
    if (isOpen) {
      testConnection();
    }
  }, [isOpen, testConnection]);

  const handleConfigChange = (newConfig: Partial<LlmRunnerConfig>) => {
    const updatedConfig = { ...config, ...newConfig };
    setConfig(updatedConfig);
    llmRunnerService.setConfig(updatedConfig);
  };

  const handleModelChange = (newModel: string) => {
    handleConfigChange({ modelName: newModel });
  };

  const handleProviderChange = (provider: RunnerProvider) => {
    const updatedConfig = { ...config, provider };
    setConfig(updatedConfig);
    llmRunnerService.setConfig({ provider });
    setConnectionStatus(null);
    setAvailableModels([]);
    setStatsLabel("");
    setRunnerStatus({
      type: "info",
      text: "Provider changed. Click Check Runner to initialize it.",
    });
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      message.error("Please enter a description for the form.");
      return;
    }
    setGenerating(true);
    setRunnerStatus({
      type: "info",
      text:
        config.provider === "webllm"
          ? "Generating form... first run may take longer while model is loaded."
          : "Generating form...",
    });
    try {
      const result = await llmRunnerService.generate({
        prompt: `USER REQUEST: "${prompt}"\nYOUR JSON RESPONSE:`,
        system: FORM_GENERATION_SYSTEM_PROMPT,
        format: "json",
      });

      if (result.success && result.data?.response) {
        const parsedData = parseGeneratedForm(result.data.response);
        if (!parsedData) {
          message.error("Model output was not valid form JSON.");
          return;
        }
        const processedData = processOllamaFormData(parsedData);
        onFormGenerated(processedData);
        if (result.stats) {
          setStatsLabel(
            `${result.stats.provider}/${result.stats.modelName} • ${
              result.stats.latencyMs
            }ms${result.stats.cached ? " • cached" : ""}`,
          );
        }
        message.success("Form generated successfully!");
        setRunnerStatus({
          type: "success",
          text: "Generation completed successfully.",
        });
        onClose();
      } else {
        setRunnerStatus({
          type: "error",
          text: getRunnerErrorMessage(result.error, config.provider),
        });
        message.error(
          result.error ?? "An unexpected error occurred during generation.",
        );
      }
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : "An unknown error occurred.";
      message.error(errorMessage);
      setRunnerStatus({ type: "error", text: errorMessage });
    } finally {
      setGenerating(false);
    }
  };

  const getButtonProps = () => {
    if (connectionStatus === true) {
      return { className: "ai-modal-button-success" };
    }
    if (connectionStatus === false) {
      return { className: "ai-modal-button-danger" };
    }
    return {};
  };

  return (
    <Modal
      title="AI Form Generator"
      open={isOpen}
      onCancel={onClose}
      footer={null}
      width={800}
    >
      <Typography.Text type="secondary">
        Local AI form generation for demo (WebLLM and Ollama providers).
      </Typography.Text>
      <Divider className="ai-modal-divider" />
      <div className="ai-modal-controls-container">
        <Select
          style={{ width: 170 }}
          value={config.provider}
          onChange={handleProviderChange}
          options={[
            { value: "webllm", label: "WebLLM (MLC)" },
            { value: "ollama", label: "Ollama" },
          ]}
        />
        <div className="ai-modal-model-selector-wrapper">
          <ModelSelector
            model={config.modelName}
            setModel={handleModelChange}
            availableModels={availableModels}
            fetching={fetchingModels}
            disabled={!connectionStatus}
            style={{ width: "100%" }}
          />
        </div>
        <Button
          onClick={() => {
            void testConnection();
          }}
          loading={loading}
          {...getButtonProps()}
        >
          Check Runner
        </Button>
      </div>
      <div style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">Cache responses</Typography.Text>
        <Switch
          style={{ marginLeft: 8 }}
          checked={config.cacheEnabled}
          onChange={(checked) => handleConfigChange({ cacheEnabled: checked })}
        />
      </div>
      <Alert
        showIcon
        type={runnerStatus.type}
        message={runnerStatus.text}
        style={{ marginBottom: 12 }}
      />
      {config.provider === "webllm" ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          WebLLM runs directly in the browser with WebGPU. The first generation
          can be slower because model assets are downloaded and initialized.
        </Typography.Paragraph>
      ) : null}
      {config.provider === "ollama" ? <OllamaSettings /> : null}
      {statsLabel ? (
        <Typography.Text type="secondary">{`Last run: ${statsLabel}`}</Typography.Text>
      ) : null}
      <Divider className="ai-modal-divider" />
      <GenerationPanel
        prompt={prompt}
        setPrompt={setPrompt}
        onGenerate={() => {
          void handleGenerate();
        }}
        loading={generating}
        disabled={!connectionStatus || availableModels.length === 0}
      />
    </Modal>
  );
};

const parseGeneratedForm = (raw: string): OllamaFormData | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const candidate = parsed as { title?: unknown; fields?: unknown };
    if (
      typeof candidate.title !== "string" ||
      !Array.isArray(candidate.fields)
    ) {
      return null;
    }
    return candidate as OllamaFormData;
  } catch {
    return null;
  }
};

export default AIFormGeneratorModal;

const getRunnerErrorMessage = (
  error: string | undefined,
  provider: RunnerProvider,
): string => {
  if (!error) {
    return "Runner failed for an unknown reason.";
  }

  if (provider === "webllm") {
    if (error === "WEBGPU_NOT_AVAILABLE") {
      return "WebGPU is not available in this browser. Use Chromium with WebGPU enabled.";
    }
    if (error === "WEBGPU_ADAPTER_NOT_FOUND") {
      return "No compatible WebGPU adapter was found for the selected model. Try a q4f32 model or switch to Ollama provider.";
    }
    if (error === "WEBLLM_IMPORT_FAILED") {
      return "WebLLM runtime failed to load. Please reload and try again.";
    }
    if (error.includes("Model not loaded before trying to complete")) {
      return "WebLLM model was not initialized yet. Click Check Runner, wait for model load, then retry.";
    }
    if (error === "WEBLLM_EMPTY_RESPONSE") {
      return "The model returned an empty response. Try a clearer prompt.";
    }
    return `WebLLM error: ${error}`;
  }

  if (provider === "ollama" && error === "EXTENSION_NOT_FOUND") {
    return "Ollama companion extension is required for the Ollama provider.";
  }

  return error;
};
