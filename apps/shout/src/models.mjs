// The models and reasoning efforts offered in the composer. A session keeps its choice (the model is fixed
// once the first message is sent); new sessions start on the default when its provider is available.
export const providers = [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude' }];
const standard = ['low', 'medium', 'high', 'xhigh'];
export const models = [
  { id: 'gpt-6-astra', label: '6 Astra', provider: 'codex', efforts: standard },
  { id: 'gpt-6-sol', label: '6 Sol', provider: 'codex', efforts: standard },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', provider: 'claude', efforts: [...standard, 'max'] },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'claude', efforts: [...standard, 'max'] },
];
export const efforts = [...new Set(models.flatMap(model => model.efforts))];
export const defaultModel = { model: 'gpt-6-astra', effort: 'medium' };
export const modelInfo = id => models.find(model => model.id === id) ?? null;
