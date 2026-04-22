export const LOCAL_STORAGE_KEYS = {
  LOCAL_FORMS: "formstr:forms",
  LOCAL_FORMS_ENCRYPTED: "formstr:forms-encrypted",
  LOCAL_FORMS_META: "formstr:forms-meta",
  DRAFT_FORMS: "formstr:draftForms",
  DRAFT_RESPONSES: "formstr:draft-response",
  AUTO_SAVE_ENABLED: "formstr:auto-save-enabled",
  SUBMISSIONS: "formstr:submissions",
  PROFILE: "formstr:profile",
  OLLAMA_CONFIG: "formstr:ollama_config",
  LLM_RUNNER_CONFIG: "formstr:llm_runner_config",
  LLM_RUNNER_CACHE: "formstr:llm_runner_cache",
  APP_LOCALE: "formstr:locale",
};

export interface LocalFormsMeta {
  encrypted: boolean;
  encryptedBy?: string;
  encryptedAt?: string;
}

export function getItem<T>(key: string, { parseAsJson = true } = {}): T | null {
  const storedValue = localStorage.getItem(key);
  if (storedValue === null) {
    return null;
  }

  if (!parseAsJson) {
    return storedValue as T;
  }

  try {
    return JSON.parse(storedValue) as T;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

export const setItem = <T>(
  key: string,
  value: T,
  { parseAsJson = true }: { parseAsJson?: boolean } = {},
) => {
  const valueToBeStored = parseAsJson ? JSON.stringify(value) : String(value);
  try {
    localStorage.setItem(key, valueToBeStored);
    window.dispatchEvent(new Event("storage"));
  } catch (error) {
    console.log("Error in setItem: ", error);
  }
};
