import React from 'react';
import ReactDOM from 'react-dom/client';
import { useSettings } from '../hooks/useSettings';
import { SettingsModal } from '../components/SettingsModal';
import '../index.css';

const OptionsPage: React.FC = () => {
  const { settings, updateSettings, updateAISettings } = useSettings();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-6">
      <SettingsModal
        isOpen={true}
        onClose={() => window.close()}
        settings={settings}
        onUpdateSettings={updateSettings}
        onUpdateAISettings={updateAISettings}
      />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OptionsPage />
  </React.StrictMode>
);
