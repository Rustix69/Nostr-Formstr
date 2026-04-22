export interface ModelSelectorModel {
  name: string;
}

export interface ModelSelectorProps {
  model: string | undefined;
  setModel: (model: string) => void;
  availableModels: ModelSelectorModel[];
  fetching: boolean;
  disabled: boolean;
  style?: React.CSSProperties;
  placeholder?: string;
}
