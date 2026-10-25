import React, { useState } from 'react';
import { PHP_FILES, PhpFile } from '../services/phpBotSource';
import { Terminal, Download, Copy, Check, FileCode, Server } from 'lucide-react';
import JSZip from 'jszip';

export const PhpCodeViewer: React.FC = () => {
  const [selectedFilename, setSelectedFilename] = useState<string>(PHP_FILES[0].filename);
  const [copied, setCopied] = useState(false);
  const [isZipping, setIsZipping] = useState(false);

  const currentFile = PHP_FILES.find((f) => f.filename === selectedFilename) || PHP_FILES[0];

  const handleCopy = () => {
    navigator.clipboard.writeText(currentFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadZip = async () => {
    setIsZipping(true);
    try {
      const zip = new JSZip();
      PHP_FILES.forEach((f) => {
        zip.file(f.filename, f.content);
      });

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `autoscalp_h00k_bot_php_${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to create zip:', err);
    } finally {
      setIsZipping(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Overview Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-cyan-400" />
              <h2 className="text-base font-semibold text-slate-100">
                Повний набір PHP 8.1+ скриптів бота Формації для VPS
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Готовий до розгортання модульний код: парсинг точок входу з h00k.top, робота через Cron,
              обробка 503 помилок, реверс, підпис ордерів Binance та сповіщення в Telegram.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleDownloadZip}
              disabled={isZipping}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors cursor-pointer flex items-center gap-1.5 shadow-sm disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isZipping ? 'Підготовка ZIP...' : 'Завантажити всі файли (.zip)'}</span>
            </button>
          </div>
        </div>

        {/* Quick Instructions banner */}
        <div className="mt-4 p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono text-slate-300 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <span>Розгортання: curl/розпакуйте в /var/www/bot, запустіть chmod +x setup.sh && ./setup.sh</span>
          <span className="text-cyan-400">PHP 8.1 / 8.2 / 8.3 CLI</span>
        </div>
      </div>

      {/* Code Browser Grid */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl overflow-hidden flex flex-col md:flex-row">
        {/* Sidebar File List */}
        <div className="w-full md:w-64 border-b md:border-b-0 md:border-r border-slate-800 bg-slate-950/70 p-3 space-y-1">
          <div className="px-2 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider font-mono">
            Файли бота ({PHP_FILES.length})
          </div>
          {PHP_FILES.map((file) => (
            <button
              key={file.filename}
              onClick={() => setSelectedFilename(file.filename)}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition-colors flex items-center gap-2 cursor-pointer ${
                selectedFilename === file.filename
                  ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800/40 font-semibold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <FileCode className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{file.filename}</span>
            </button>
          ))}
        </div>

        {/* Main Code View */}
        <div className="flex-1 flex flex-col">
          {/* File toolbar */}
          <div className="px-4 py-3 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between">
            <div>
              <span className="text-xs font-mono font-bold text-slate-200">
                {currentFile.filename}
              </span>
              <span className="text-xs text-slate-400 ml-2 hidden sm:inline">
                — {currentFile.description}
              </span>
            </div>

            <button
              onClick={handleCopy}
              className="px-3 py-1 text-xs font-medium rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400">Скопійовано!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Копіювати код</span>
                </>
              )}
            </button>
          </div>

          {/* Syntax Highlighted Preformatted Area */}
          <div className="p-4 bg-slate-950 overflow-x-auto max-h-[620px] font-mono text-xs leading-relaxed text-slate-300">
            <pre>
              <code>{currentFile.content}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
