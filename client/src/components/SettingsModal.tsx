import { useState, useEffect } from 'react';
import { getSettings, saveSettings } from '../api';
import type { Config } from '../types';

interface SettingsModalProps {
  onClose: () => void;
}

const MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [config, setConfig] = useState<Partial<Config>>({});
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings()
      .then((c) => {
        setConfig(c);
        // Don't populate masked API key into input
        setApiKey('');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const update: Partial<Config> = { ...config };
      if (apiKey) update.apiKey = apiKey;
      await saveSettings(update);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-100">Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded"
          >
            <XIcon />
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-zinc-500">Loading…</div>
        ) : (
          <div className="p-6 space-y-4">
            {error && (
              <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm px-4 py-2 rounded-lg">
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Anthropic API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config.apiKey || 'sk-ant-…'}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-violet-500 font-mono text-sm"
              />
              <p className="text-xs text-zinc-500 mt-1">
                Leave blank to keep existing key. Stored server-side in config.json.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Model</label>
              <select
                value={config.model || 'claude-opus-4-6'}
                onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-violet-500"
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Notes Vault Directory</label>
              <input
                type="text"
                value={config.notesDir || ''}
                onChange={(e) => setConfig((c) => ({ ...c, notesDir: e.target.value }))}
                placeholder="/path/to/notes"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-violet-500 font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Frontmatter Template</label>
              <textarea
                value={config.frontmatterTemplate || ''}
                onChange={(e) => setConfig((c) => ({ ...c, frontmatterTemplate: e.target.value }))}
                rows={4}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-violet-500 font-mono text-xs resize-none"
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800">
          <span className={`text-sm transition-opacity ${saved ? 'text-emerald-400 opacity-100' : 'opacity-0'}`}>
            Settings saved!
          </span>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-white rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
