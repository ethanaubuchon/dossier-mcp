import { useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { NoteReader } from './components/NoteReader';
import { MCPSetupPanel } from './components/MCPSetupPanel';
import { SettingsModal } from './components/SettingsModal';
import { NoteEditor } from './components/NoteEditor';
import type { NoteListItem } from './types';

type View = 'setup' | 'note' | 'edit';

export default function App() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [view, setView] = useState<View>('setup');
  const [showSettings, setShowSettings] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const refresh = useCallback(() => setRefreshTrigger((n) => n + 1), []);

  const handleSelectNote = (note: NoteListItem) => {
    setSelectedSlug(note.slug);
    setView('note');
  };

  const handleNewNote = () => {
    setSelectedSlug(null);
    setView('edit');
  };

  const handleEditNote = (slug: string) => {
    setSelectedSlug(slug);
    setView('edit');
  };

  const handleSaved = (slug: string) => {
    setSelectedSlug(slug);
    setView('note');
    refresh();
  };

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        activeSlug={selectedSlug}
        activeTag={activeTag}
        onSelectNote={handleSelectNote}
        onNewNote={handleNewNote}
        onSettings={() => setShowSettings(true)}
        onTagSelect={setActiveTag}
        refreshTrigger={refreshTrigger}
        onViewSetup={() => setView('setup')}
        currentView={view}
      />

      <main className="flex-1 overflow-hidden">
        {view === 'setup' && (
          <MCPSetupPanel
            onSelectNote={(slug) => {
              setSelectedSlug(slug);
              setView('note');
            }}
          />
        )}
        {view === 'note' && selectedSlug && (
          <NoteReader
            slug={selectedSlug}
            onEdit={handleEditNote}
            onSelectNote={(slug) => {
              setSelectedSlug(slug);
              setView('note');
            }}
          />
        )}
        {view === 'edit' && (
          <NoteEditor
            slug={selectedSlug}
            onSaved={handleSaved}
            onCancel={() => setView(selectedSlug ? 'note' : 'setup')}
          />
        )}
      </main>

      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
